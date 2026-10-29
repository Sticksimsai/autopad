# Autopad

An autonomous, community-built launchpad concept. A plain white site, built live in
front of visitors by a crew of 2D hard-hat agents. Visitors post suggestions to a
feed, everyone votes, and whatever tops the queue gets **designed by Claude and
installed on the site automatically** — no redeploy, no human in the loop:

- Suggestions **with a `$TICKER`** become launchpad tokens (name, tagline, lore and
  accent color designed by Claude; simulated bonding curve that "graduates to Raydium").
- Everything else becomes a **site module**: Claude designs real content and the
  agents construct it into the Community Build Zone, live, for every visitor.

## Run it

```bash
npm install
cp .env.example .env     # add your ANTHROPIC_API_KEY
npm start                # http://localhost:3000
```

No key? It still runs — a deterministic mock designer stands in, and the UI tells
visitors mock mode is on. Add the key and restart to switch the crew to Claude.

Quick local demo with fast builds:

```bash
BUILD_SECONDS=8 MIN_VOTES=1 npm run dev
```

## How it works

```
visitor ──POST /api/suggest──▶ feed (JSON store)
visitor ──POST /api/vote─────▶ one vote per visitor per suggestion
                 │
   worker loop (every 2s, in-process)
                 │ picks top-voted queued item
                 ▼
   Claude (Messages API, claude-haiku-5-5) designs the build as strict JSON
                 │ "constructs" for BUILD_SECONDS
                 ▼
   shipped → token on the launchpad, or module in the Build Zone
                 ▼
   every open browser polls /api/state every 2.5s; an agent walks to the
   new element, hammers it with sparks, and it pops into the page
```

Because the agent's output is stored server-side and rendered dynamically, every
shipped build is **live on the web instantly** for all visitors — the site rebuilds
itself without a deploy.

### Files

| file | what |
|---|---|
| `server.js` | Express app: static site + `/api/state`, `/api/suggest`, `/api/vote`, rate limits |
| `worker.js` | The crew: queue logic, Claude designer (+ mock fallback), output sanitizer |
| `store.js`  | Tiny persistent JSON store with atomic writes (`data/store.json`) |
| `chain.js`  | Solana mainnet layer: Helius RPC connection, live chain status, pre-wired (disarmed) token-launch path |
| `public/index.html` | The whole frontend: construction intro, roaming agents, feed, queue, launchpad, build zone |

## Deploy (always-on web)

The worker is a long-running loop, so deploy to a host that runs a persistent Node
process (serverless platforms like Vercel/Netlify functions won't keep the crew alive):

**Railway / Render / Fly.io (recommended)**
1. Push this folder to a GitHub repo.
2. Create a new service from the repo; build = `npm install`, start = `npm start`.
3. Set env vars: `ANTHROPIC_API_KEY`, and optionally `ANTHROPIC_MODEL`, `MIN_VOTES`,
   `BUILD_SECONDS`, `CURVE_SECONDS`.
4. Attach a persistent volume and set `DATA_DIR` to its mount path (e.g. `/data`)
   so the feed survives restarts.

**Any VPS**
```bash
git clone <your repo> && cd autopad && npm install
ANTHROPIC_API_KEY=sk-... node server.js   # put behind nginx/caddy + systemd/pm2
```

Keep the API key on the server only — it never reaches the browser.

## Safety rails built in

- Claude's output is parsed as strict JSON and sanitized (lengths, color format,
  allowed fields) before it touches the page; the page renders it as text, never HTML.
- Suggestion text is passed to Claude as data with an explicit instruction that it
  cannot change the rules or output format.
- Per-IP rate limits on posting and voting; one vote per visitor id per suggestion
  (browser-level — swap in Solana wallet signatures for sybil resistance).

## Solana mainnet (Helius) — automated from the terminal

Status: set `HELIUS_API_KEY` in `.env` and restart — the server heartbeats
mainnet every 15s, the nav badge shows `MAINNET · SLOT …`, `/api/chain` exposes
safe status (the key never leaves the server).

On-chain setup is one command:

```bash
npm run chain:setup     # generates .keys/launcher.json, wires .env,
                        # gitignores the key, checks Helius, checks balance
npm run chain:status    # one-glance readout any time
```

Then, in order:
1. **Fund** the printed launcher address with ~0.1–0.5 SOL (each mint costs ~0.004).
2. **Rehearse on devnet**: `SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=KEY`
   and `SOLANA_CLUSTER=devnet`, airdrop devnet SOL, ship a `$TICKER` and watch it mint.
3. **Arm**: `ENABLE_ONCHAIN_LAUNCH=true` in `.env`, restart.

Once armed, the loop is fully automatic: a `$TICKER` suggestion hits `MIN_VOTES`
(default **5**) → Claude designs it → the crew builds it → **a real Token-2022
SPL token is minted on mainnet** with its name + symbol stored on-chain, full 1B
fixed supply minted to the launcher vault, mint authority revoked — and the token
card on the site shows the live mint address with a Solscan link. A failed mint
(e.g. underfunded launcher) is logged and the token stays on the simulated curve.

The **bonding curve + Raydium graduation** remain simulated until you deploy the
Anchor curve program and set `LAUNCHPAD_PROGRAM` (the Raydium CPMM id is already
pinned as the graduation target).

Back up `.keys/launcher.json` offline — it IS the treasury. Don't arm mainnet
until you've rehearsed on devnet and had legal advice: an armed launcher is a hot
wallet that mints from public votes.

## Launches, trading & platform fees (v0.12)

Real launches run through **Raydium LaunchLab**: a shipped `$TICKER` creates the
token and its live bonding curve in one shot; trading opens on raydium.io
instantly and the pool auto-migrates to a Raydium AMM at full raise. The site
reads the real curve state every 45s.

- **In-site trading**: every launched token's page has BUY/SELL via Phantom.
  The server only builds unsigned transactions for the viewer's own pubkey;
  users sign in their own wallet — Autopad never holds keys or funds.
- **Self-hosted metadata**: set `PUBLIC_URL` and every launch's on-chain `uri`
  points at `/api/meta/<id>.json` (name, lore, pfp image, reward mechanism),
  so wallets and explorers display tokens properly. Zero IPFS setup.
- **Platform fee share**: `npm run chain:platform` registers Autopad as a
  LaunchLab platform (default 1%, `PLATFORM_FEE_BPS`); every subsequent launch
  routes that share of all trading to you. Sweep it with `npm run chain:claim`.
- **One-command rehearsal**: `npm run chain:rehearse` fires a full test launch
  (refuses mainnet unless `--mainnet`). Do this on devnet before arming mainnet.

Go-live order: `chain:setup` → fund launcher → devnet env → `chain:rehearse` →
`chain:platform` → switch env to mainnet → `ENABLE_ONCHAIN_LAUNCH=true` → restart.

## Running continuously

The crew runs inside the server process and works the queue back-to-back with no
idle gap. Railway/Render/Fly auto-restart it; on a bare VPS use pm2:

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

## Roadmap to the real on-chain launchpad

1. **Wallet voting** — connect Phantom, sign a message, one vote per wallet
   (optionally weighted by platform-token balance).
2. **Token mint** — backend service with a keypair mints the SPL token + Metaplex
   metadata when a `$TICKER` proposal ships.
3. **Bonding curve program** — Anchor program (pump.fun-style), graduation deposits
   liquidity into a Raydium CPMM pool and burns LP tokens.
4. **Bigger builds** — let Claude propose richer module types (charts, mini-games)
   through the same sanitized-JSON pipeline.

Get legal advice before taking real SOL — auto-launching tokens sits in regulated
territory in most jurisdictions.
