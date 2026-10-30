#!/usr/bin/env node
// npm run chain:claim — sweeps Buildpad's accrued LaunchLab platform fees
// (from every token's trades) into the launcher/treasury wallet.
import "dotenv/config";
import { claimPlatformFees } from "../chain.js";

try {
  const res = await claimPlatformFees();
  console.log("\n  ✔ platform fees claimed to the treasury. tx:", res.txIds.join(", ") || "(nothing to claim)", "\n");
} catch (e) {
  console.error("\n  ✖ " + e.message + "\n");
  process.exit(1);
}
