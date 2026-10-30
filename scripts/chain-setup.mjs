#!/usr/bin/env node
// One-shot terminal setup for the on-chain half:
//   npm run chain:setup
// Generates the launcher keypair (if missing), wires .env, verifies the Helius
// RPC, and tells you exactly what's left (funding + the arm switch).
// It never sends a transaction and never prints the secret key.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";

const ROOT = process.cwd();
const KEY_DIR = path.join(ROOT, ".keys");
const KEY_FILE = path.join(KEY_DIR, "launcher.json");
const ENV_FILE = path.join(ROOT, ".env");

const ok = s => console.log("  ✔ " + s);
const todo = s => console.log("  ○ " + s);
const warn = s => console.log("  ✖ " + s);

console.log("\nBUILDPAD CHAIN SETUP — Solana " + (process.env.SOLANA_CLUSTER || "mainnet-beta") + "\n");

/* 1. launcher keypair */
let created = false;
if (fs.existsSync(KEY_FILE)) {
  ok("launcher keypair exists: .keys/launcher.json");
} else {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(KEY_FILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  created = true;
  ok("generated launcher keypair → .keys/launcher.json (chmod 600)");
}
const launcher = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_FILE, "utf8"))));
console.log("    address: " + launcher.publicKey.toBase58());

/* 2. wire .env */
let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
function ensureEnv(key, value) {
  const re = new RegExp("^\\s*" + key + "=.*$", "m");
  if (re.test(env)) {
    const current = env.match(re)[0].split("=").slice(1).join("=").trim();
    if (current) { ok(`.env already sets ${key}`); return; }
    env = env.replace(re, `${key}=${value}`);
  } else {
    env += (env.endsWith("\n") || env === "" ? "" : "\n") + `${key}=${value}\n`;
  }
  ok(`.env ← ${key}=${value}`);
}
ensureEnv("LAUNCHER_KEYPAIR", ".keys/launcher.json");
if (!/^\s*HELIUS_API_KEY=.+$/m.test(env) && !process.env.HELIUS_API_KEY && !process.env.SOLANA_RPC_URL) {
  env += (env.endsWith("\n") ? "" : "\n") + "HELIUS_API_KEY=\n";
  todo("HELIUS_API_KEY is empty in .env — paste your key from dashboard.helius.dev");
}
fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });

/* 3. keep secrets out of git */
const GI = path.join(ROOT, ".gitignore");
let gi = fs.existsSync(GI) ? fs.readFileSync(GI, "utf8") : "";
if (!gi.includes(".keys")) { fs.writeFileSync(GI, gi + (gi.endsWith("\n") ? "" : "\n") + ".keys/\n"); ok(".gitignore ← .keys/"); }

/* 4. verify RPC + balance */
const HELIUS = process.env.HELIUS_API_KEY || (env.match(/^HELIUS_API_KEY=(.+)$/m) || [])[1];
const RPC = process.env.SOLANA_RPC_URL || (HELIUS ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS.trim()}` : "");
if (!RPC) {
  todo("RPC check skipped — set HELIUS_API_KEY, then rerun npm run chain:setup");
} else {
  try {
    const conn = new Connection(RPC, "confirmed");
    const slot = await conn.getSlot();
    ok("Helius RPC reachable — slot " + slot.toLocaleString());
    const bal = await conn.getBalance(launcher.publicKey) / LAMPORTS_PER_SOL;
    if (bal >= 0.05) ok(`launcher funded: ${bal} SOL`);
    else todo(`fund the launcher with ~0.1–0.5 SOL (has ${bal}) → send to ${launcher.publicKey.toBase58()}`);
  } catch (e) {
    warn("RPC unreachable from here: " + String(e.message).slice(0, 80));
  }
}

/* 5. arm state */
console.log("");
if (process.env.ENABLE_ONCHAIN_LAUNCH === "true") {
  ok("ARMED — shipped $TICKER builds will mint real tokens on " + (process.env.SOLANA_CLUSTER || "mainnet-beta"));
} else {
  todo("disarmed (safe). To go live after funding: add ENABLE_ONCHAIN_LAUNCH=true to .env and restart.");
  todo("tip: rehearse on devnet first — SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=KEY  SOLANA_CLUSTER=devnet");
}
todo("launches run through Raydium LaunchLab (real curve + trading). Rehearse: npm run chain:rehearse (devnet). Fee share: npm run chain:platform (after funding).");
console.log("\nDone." + (created ? " Back up .keys/launcher.json somewhere offline — it IS the treasury." : "") + "\n");
