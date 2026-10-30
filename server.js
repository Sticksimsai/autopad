import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { get, mutate, log } from "./store.js";
import { workerTick, publicState, usingClaude, netScore, marketFor } from "./worker.js";
import { refreshChainStatus, chainStatus, chainCooldownMs, launchConfig, RPC_URL, CLUSTER, buildTradeTx, buildLaunchTx, poolExists, isValidAddress } from "./chain.js";
import { REWARDS } from "./worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = "0.14.3";
const app = express();
app.use(express.json({ limit: "64kb" })); // launch submissions can carry a small pfp data URI
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

/* crude per-IP rate limiting */
const hits = new Map();
function limited(req, key, perMin) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const k = key + ":" + ip, nowT = Date.now();
  const arr = (hits.get(k) || []).filter(t => nowT - t < 60_000);
  if (arr.length >= perMin) return true;
  arr.push(nowT); hits.set(k, arr);
  return false;
}

const validVoter = id => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);

app.get("/api/state", (req, res) => {
  const st = publicState();
  st.chain = { ...chainStatus(), launch: launchConfig() };
  st.config.version = VERSION;
  res.json(st);
});

app.get("/api/chain", (req, res) => res.json({ ...chainStatus(), launch: launchConfig() }));

app.post("/api/suggest", (req, res) => {
  if (limited(req, "suggest", 6)) return res.status(429).json({ error: "Slow down — max 6 suggestions a minute." });
  const text = String(req.body?.text || "").trim().slice(0, 180);
  const voterId = req.body?.voterId;
  if (text.length < 3) return res.status(400).json({ error: "Suggestion too short." });
  if (!validVoter(voterId)) return res.status(400).json({ error: "Missing voter id." });
  const id = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  mutate(st => {
    st.suggestions[id] = {
      text, author: "anon", createdAt: Date.now(), status: "queued",
      votes: { [voterId]: 1 } // posting counts as your own upvote
    };
  });
  log(`new suggestion: ${text.slice(0, 40)}`);
  res.json({ ok: true, id });
});

/* creator-pays on-chain launch: build the tx for the creator's wallet */
app.post("/api/launch/build", async (req, res) => {
  if (limited(req, "launchb", 6)) return res.status(429).json({ error: "Slow down." });
  if (!RPC_URL) return res.status(503).json({ error: "On-chain launches aren't enabled on this server yet." });
  const b = req.body || {};
  if (!isValidAddress(b.owner || "")) return res.status(400).json({ error: "Connect a wallet first." });
  const ticker = ("$" + String(b.ticker || "").replace(/^\$/, "")).toUpperCase();
  if (!/^\$[A-Z][A-Z0-9]{1,9}$/.test(ticker)) return res.status(400).json({ error: "Ticker must be 2-10 letters/numbers, starting with a letter." });
  const name = String(b.name || "").trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: "Give the token a name." });
  const tagline = String(b.tagline || "").trim().slice(0, 80);
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#8a3ffc";
  const reward = ["dividend", "buyback", "lottery", "multiplier"].includes(b.reward) ? b.reward : (get().siteConfig?.defaultReward || "dividend");
  const pfp = (typeof b.pfp === "string" && b.pfp.length <= 40000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.pfp)) ? b.pfp : null;
  const buySol = Math.min(10, Math.max(0, Number(b.buySol) || 0));

  const id = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  mutate(st => {
    st.suggestions[id] = {
      text: `${ticker} — ${name}${tagline ? ": " + tagline : ""}`.slice(0, 180),
      author: "anon", createdAt: Date.now(), status: "draft", votes: {},
      build: { kind: "token", symbol: ticker, name, tagline, lore: "Creator-launched from the Launch tab. The feed watches; the curve decides.", color, curveTargetSol: 85, reward, pfp }
    };
  });
  try {
    const out = await buildLaunchTx({ ownerPubkey: b.owner, name, symbol: ticker, uri: `${base}/api/meta/${id}.json`, buySol });
    mutate(st => { if (st.suggestions[id]) st.suggestions[id].pendingLaunch = { mint: out.mint, poolId: out.poolId, owner: b.owner }; });
    res.json({ ok: true, id, ...out });
  } catch (e) {
    mutate(st => { delete st.suggestions[id]; });
    console.error("[launch/build]", e.message);
    res.status(503).json({ error: "Couldn't build the launch: " + String(e.message).slice(0, 140) });
  }
});

/* after the creator signs & sends: verify the pool exists, then go live on-site */
app.post("/api/launch/confirm", async (req, res) => {
  if (limited(req, "launchc", 30)) return res.status(429).json({ error: "Slow down." });
  const { id } = req.body || {};
  const s = get().suggestions[id];
  if (!s?.pendingLaunch) return res.status(404).json({ error: "No pending launch with that id." });
  if (s.status === "shipped") return res.json({ ok: true, launched: true });
  const live = await poolExists(s.pendingLaunch.poolId);
  if (!live) return res.json({ ok: true, launched: false });
  mutate(st => {
    const v = st.suggestions[id];
    v.status = "shipped"; v.shippedAt = Date.now();
    v.onchain = {
      armed: true, status: "launched", backend: "raydium-launchlab",
      mint: v.pendingLaunch.mint, poolId: v.pendingLaunch.poolId,
      tradeUrl: `https://raydium.io/launchpad/token/?mint=${v.pendingLaunch.mint}`,
      explorer: `https://solscan.io/token/${v.pendingLaunch.mint}${CLUSTER !== "mainnet-beta" ? "?cluster=" + CLUSTER : ""}`,
      note: "creator-launched from their own wallet"
    };
    delete v.pendingLaunch;
  });
  log(`LAUNCHED by creator: ${s.build.symbol} — live on the curve`);
  res.json({ ok: true, launched: true });
});

/* structured submissions from the Launch tab — they enter the same voted queue */
app.post("/api/launch", (req, res) => {
  if (limited(req, "suggest", 6)) return res.status(429).json({ error: "Slow down — max 6 launches a minute." });
  const b = req.body || {};
  if (!validVoter(b.voterId)) return res.status(400).json({ error: "Missing voter id." });
  const ticker = ("$" + String(b.ticker || "").replace(/^\$/, "")).toUpperCase();
  if (!/^\$[A-Z][A-Z0-9]{1,9}$/.test(ticker)) return res.status(400).json({ error: "Ticker must be 2-10 letters/numbers, starting with a letter." });
  const name = String(b.name || "").trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: "Give the token a name." });
  const tagline = String(b.tagline || "").trim().slice(0, 80);
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#8a3ffc";
  const curveTargetSol = Math.min(85, Math.max(30, parseInt(b.curveTargetSol, 10) || 50));
  const pfp = (typeof b.pfp === "string" && b.pfp.length <= 40000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.pfp)) ? b.pfp : null;
  const reward = ["dividend", "buyback", "lottery", "multiplier"].includes(b.reward) ? b.reward : (get().siteConfig?.defaultReward || "dividend");
  const text = `${ticker} — ${name}${tagline ? ": " + tagline : ""}`.slice(0, 180);
  const id = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  mutate(st => {
    st.suggestions[id] = {
      text, author: "anon", createdAt: Date.now(), status: "queued",
      votes: { [b.voterId]: 1 },
      meta: { launch: { ticker, name, tagline, color, curveTargetSol, reward, pfp } }
    };
  });
  log(`launch proposal: ${ticker} ${name}`);
  res.json({ ok: true, id });
});

app.post("/api/vote", (req, res) => {
  if (limited(req, "vote", 60)) return res.status(429).json({ error: "Too many votes, breathe." });
  const { id, dir, voterId } = req.body || {};
  if (!validVoter(voterId)) return res.status(400).json({ error: "Missing voter id." });
  if (![1, -1, 0].includes(dir)) return res.status(400).json({ error: "dir must be 1, -1 or 0." });
  let ok = false;
  mutate(st => {
    const s = st.suggestions[id];
    if (!s) return;
    s.votes = s.votes || {};
    if (dir === 0) delete s.votes[voterId]; else s.votes[voterId] = dir;
    ok = true;
  });
  if (!ok) return res.status(404).json({ error: "No such suggestion." });
  res.json({ ok: true });
});

/* a shipped applet's code, served once and cached by the browser */
app.get("/api/applet/:id", (req, res) => {
  const m = get().modules.find(x => x.id === req.params.id && x.kind === "applet");
  if (!m) return res.status(404).send("not found");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.type("text/plain").send(m.html);
});

/* site mods: voted css/js that runs on the live page for every visitor */
app.get("/api/mods", (req, res) => {
  const s = get();
  res.json({
    rev: s.modsRev || 0,
    mods: (s.mods || []).filter(m => m.enabled).map(m => ({ id: m.id, title: m.title, css: m.css, js: m.js }))
  });
});

/* circuit-breaker: browsers report misbehaving mods. severity "core" = the mod
   broke protected UI (launch form, feed, voting…) — disabled at 2 distinct
   reporters; plain crashes at 3. */
const modErrors = new Map(); // modId+sev -> Set(voterId)
app.post("/api/mod-error", (req, res) => {
  const { id, voterId, severity } = req.body || {};
  if (typeof id !== "string" || !validVoter(voterId)) return res.status(400).json({ error: "bad report" });
  const sev = severity === "core" ? "core" : "crash";
  const key = sev + ":" + id;
  const set = modErrors.get(key) || new Set();
  set.add(voterId); modErrors.set(key, set);
  let disabled = false;
  if (set.size >= (sev === "core" ? 2 : 3)) {
    mutate(st => {
      const m = (st.mods || []).find(x => x.id === id && x.enabled);
      if (m) { m.enabled = false; st.modsRev = Date.now(); disabled = true; }
    });
    if (disabled) log(sev === "core"
      ? `site mod auto-removed — it broke core UI: ${id}`
      : `site mod auto-disabled after crash reports: ${id}`);
  }
  // already disabled earlier counts as disabled for the reporter
  if (!disabled) disabled = !((get().mods || []).find(x => x.id === id)?.enabled);
  res.json({ ok: true, reports: set.size, disabled });
});

/* owner kill switch: DELETE /api/mods/:id?key=ADMIN_KEY */
app.delete("/api/mods/:id", (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "forbidden" });
  let found = false;
  mutate(st => {
    const m = (st.mods || []).find(x => x.id === req.params.id);
    if (m) { m.enabled = false; st.modsRev = Date.now(); found = true; }
  });
  if (found) log(`site mod removed by owner: ${req.params.id}`);
  res.status(found ? 200 : 404).json({ ok: found });
});

/* per-token market data: price series + recent trades (simulated until on-chain) */
app.get("/api/trades/:id", (req, res) => {
  const s = get().suggestions[req.params.id];
  if (!s || s.status !== "shipped" || s.build?.kind !== "token") return res.status(404).json({ error: "no such token" });
  res.set("Cache-Control", "public, max-age=20");
  res.json(marketFor(req.params.id, s));
});

/* Metaplex-style token metadata, self-hosted — set PUBLIC_URL and every launch
   points its on-chain uri here, so wallets/explorers show name + image */
app.get("/api/meta/:id.json", (req, res) => {
  const s = get().suggestions[req.params.id];
  const b = s?.build;
  if (!b || b.kind !== "token") return res.status(404).json({ error: "no such token" });
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    name: b.name, symbol: String(b.symbol || "").replace(/^\$/, ""),
    description: `${b.tagline ? b.tagline + " — " : ""}${b.lore || ""} Launched on Buildpad, the launchpad the agents build.`.trim(),
    image: b.pfp ? `${base}/api/pfp/${req.params.id}` : undefined,
    external_url: base,
    attributes: [{ trait_type: "reward_mechanism", value: b.reward || "dividend" }, { trait_type: "built_by", value: "buildpad-crew" }]
  });
});

/* build an UNSIGNED LaunchLab buy/sell tx for the viewer's own wallet to sign */
app.post("/api/trade/build", async (req, res) => {
  if (limited(req, "trade", 20)) return res.status(429).json({ error: "Too many trade requests, breathe." });
  const { mint, side, amount, owner } = req.body || {};
  if (!isValidAddress(owner || "")) return res.status(400).json({ error: "Connect a wallet first." });
  if (!isValidAddress(mint || "")) return res.status(400).json({ error: "Bad mint." });
  if (!["buy", "sell"].includes(side)) return res.status(400).json({ error: "side must be buy or sell." });
  const amt = Number(amount);
  if (side === "buy" && !(amt >= 0.001 && amt <= 100)) return res.status(400).json({ error: "Buy amount must be 0.001–100 SOL." });
  if (side === "sell" && !(amt >= 1 && amt <= 1e12)) return res.status(400).json({ error: "Sell amount must be at least 1 token." });
  // only tokens this site launched
  const known = Object.values(get().suggestions).some(v => v.onchain?.mint === mint);
  if (!known) return res.status(404).json({ error: "Not an Buildpad token." });
  try {
    const out = await buildTradeTx({ ownerPubkey: owner, mint, side, amountSol: amt, amountTokens: amt });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("[trade]", e.message);
    res.status(503).json({ error: "Couldn't build the trade: " + String(e.message).slice(0, 120) });
  }
});

/* a token's pfp, served once and cached by the browser */
app.get("/api/pfp/:id", (req, res) => {
  const s = get().suggestions[req.params.id];
  const pfp = s?.build?.pfp;
  if (!pfp) return res.status(404).send("not found");
  const m = pfp.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!m) return res.status(404).send("not found");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.type(m[1]).send(Buffer.from(m[2], "base64"));
});

/* one-glance diagnosis: curl -s localhost:3000/api/debug */
app.get("/api/debug", (req, res) => {
  const s = get();
  const builds = Object.entries(s.suggestions)
    .filter(([, v]) => v.status === "shipped")
    .sort((a, b) => (b[1].shippedAt || 0) - (a[1].shippedAt || 0)).slice(0, 6)
    .map(([id, v]) => ({ text: v.text.slice(0, 60), became: v.build?.kind || "?", note: v.build?.note || null }));
  res.json({
    version: VERSION,
    designer: usingClaude ? (process.env.ANTHROPIC_MODEL || "claude-haiku-5-5") : "MOCK (no ANTHROPIC_API_KEY)",
    codeBuilds: process.env.ENABLE_CODE_BUILDS !== "false",
    minVotes: process.env.MIN_VOTES || "5",
    modsEnabled: (s.mods || []).filter(m => m.enabled).map(m => ({ id: m.id, title: m.title })),
    hooks: (s.hooks || []).length,
    siteConfig: s.siteConfig || {},
    lastBuilds: builds
  });
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Buildpad v${VERSION} on :${PORT} — agent designer: ${usingClaude ? "Claude (" + (process.env.ANTHROPIC_MODEL || "claude-haiku-5-5") + ")" : "MOCK (set ANTHROPIC_API_KEY to enable Claude)"}`);
  console.log(`Solana RPC: ${RPC_URL ? `${CLUSTER} via ${process.env.HELIUS_API_KEY ? "Helius" : "custom URL"}` : "not configured (set HELIUS_API_KEY)"}`);
});

/* the autonomous crew */
setInterval(() => workerTick().catch(e => console.error("[worker]", e.message)), 2000);

/* chain heartbeat — refresh mainnet status every 15s when configured */
refreshChainStatus().catch(() => {});
setInterval(() => {
  if (chainCooldownMs() > Date.now() - chainStatus().checkedAt) return; // backing off after 429
  refreshChainStatus().catch(() => {});
}, 60000); // 1 heartbeat/min ≈ 45k credits/month, well inside Helius free tier
