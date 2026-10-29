#!/usr/bin/env node
// npm run chain:platform — one-shot: registers Autopad as a Raydium LaunchLab
// PLATFORM, so Autopad earns a fee share on every trade of every token it
// launches. Writes PLATFORM_ID into .env. Costs a small amount of SOL (rent+fee).
import "dotenv/config";
import fs from "fs";
import { createPlatform } from "../chain.js";

const bps = parseInt(process.env.PLATFORM_FEE_BPS || "100", 10); // 100 bps = 1%
const name = process.env.PLATFORM_NAME || "Autopad";
const web = process.env.PUBLIC_URL || "";

console.log(`\nCreating LaunchLab platform "${name}" — fee ${bps / 100}% on every curve trade…`);
try {
  const res = await createPlatform({ feeRateBps: bps, name, web });
  console.log("  ✔ platform created:", res.platformId);
  console.log("  ✔ tx:", res.txIds.join(", "));
  let env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  if (/^\s*PLATFORM_ID=.*$/m.test(env)) env = env.replace(/^\s*PLATFORM_ID=.*$/m, "PLATFORM_ID=" + res.platformId);
  else env += (env.endsWith("\n") || env === "" ? "" : "\n") + "PLATFORM_ID=" + res.platformId + "\n";
  fs.writeFileSync(".env", env, { mode: 0o600 });
  console.log("  ✔ .env ← PLATFORM_ID — restart the server; every launch from now on routes your fee share.");
  console.log("  collect accrued fees any time with: npm run chain:claim\n");
} catch (e) {
  console.error("  ✖ " + e.message + "\n");
  process.exit(1);
}
