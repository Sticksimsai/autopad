#!/usr/bin/env node
// npm run chain:rehearse — fires ONE real test launch through the full pipeline
// (mint + LaunchLab bonding curve) and prints the trade link. Refuses to run on
// mainnet unless you pass --mainnet, so rehearsals stay on devnet.
//
// Devnet setup (in .env):
//   SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOURKEY
//   SOLANA_CLUSTER=devnet
//   ENABLE_ONCHAIN_LAUNCH=true
// Then fund the launcher with devnet SOL:  solana airdrop 2 <ADDRESS> -u devnet
import "dotenv/config";
import util from "util";
import { launchToken, launchConfig, fetchOnchainCurve, refreshChainStatus, fmtErr } from "../chain.js";

const cfg = launchConfig();
console.log("\nAUTOPAD LAUNCH REHEARSAL — cluster:", cfg.cluster, "| backend:", cfg.backend);

if (cfg.cluster !== "devnet" && !process.argv.includes("--mainnet")) {
  console.error("  ✖ refusing to rehearse on " + cfg.cluster + ". Point .env at devnet (see header of this script), or pass --mainnet if you truly mean it.\n");
  process.exit(1);
}
if (!cfg.armed) {
  console.error("  ✖ not armed. Needs HELIUS_API_KEY/SOLANA_RPC_URL + LAUNCHER_KEYPAIR (npm run chain:setup) + ENABLE_ONCHAIN_LAUNCH=true in .env.\n");
  process.exit(1);
}
const st = await refreshChainStatus();
console.log("  rpc:", st.connected ? "connected, slot " + st.slot : "UNREACHABLE (" + st.error + ")");
if (!st.connected) process.exit(1);
console.log("  launcher:", cfg.launcherPubkey, "| balance:", st.launcherSol, "SOL");
if ((st.launcherSol ?? 0) < 0.06) {
  console.error("  ✖ fund the launcher with ~0.1 SOL first (devnet: solana airdrop 2 " + cfg.launcherPubkey + " -u devnet)\n");
  process.exit(1);
}

const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
const build = {
  kind: "token", symbol: "$REH" + tag, name: "Rehearsal " + tag,
  tagline: "dress rehearsal, full pipeline", lore: "If you can read this on-chain, Autopad launches work.",
  color: "#0b9e68", curveTargetSol: 30, reward: "dividend", pfp: null
};
console.log("  launching", build.symbol, "…");
try {
  const res = await launchToken(build, null);
  console.log("  ✔ status:", res.status);
  console.log("    mint   :", res.mint);
  console.log("    pool   :", res.poolId || "-");
  console.log("    trade  :", res.tradeUrl || "-");
  console.log("    explore:", res.explorer);
  if (res.poolId) {
    const curve = await fetchOnchainCurve(res.poolId);
    console.log("    curve  :", curve ? JSON.stringify(curve) : "not readable yet (try again in a few seconds)");
  }
  console.log("\n  Rehearsal passed. Flip the same env vars on mainnet when you're ready.\n");
} catch (e) {
  console.error("  ✖ launch failed:", fmtErr(e));
  console.error("\n  full error for debugging:");
  console.error(util.inspect(e, { depth: 4 }).slice(0, 2500), "\n");
  process.exit(1);
}
