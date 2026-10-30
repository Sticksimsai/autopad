#!/usr/bin/env node
// npm run chain:status — one-glance terminal readout of the chain side.
import "dotenv/config";
import { refreshChainStatus, launchConfig, platformOnchain } from "../chain.js";

const s = await refreshChainStatus();
const l = launchConfig();
const p = await platformOnchain();
console.log("\nBUILDPAD CHAIN STATUS");
console.log("  cluster   :", s.cluster);
console.log("  rpc       :", s.configured ? (s.provider + (s.connected ? " · connected, slot " + s.slot.toLocaleString() : " · UNREACHABLE (" + s.error + ")")) : "not configured");
console.log("  launcher  :", l.launcherPubkey || "not set (run npm run chain:setup)");
if (s.launcherSol != null) console.log("  balance   :", s.launcherSol + " SOL");
console.log("  launches  :", l.armed ? "ARMED — real mints on ship" : "disarmed (simulated curve)");
console.log("  curve prog:", l.curveProgram || "pending (simulated until deployed)");
console.log("  platform  :", !p.configured ? "not set (npm run chain:platform)" : p.exists ? p.id + " · ON-CHAIN ✔" : p.id + " · NOT FOUND on " + s.cluster + " — remove PLATFORM_ID from .env or rerun chain:platform with a funded launcher");
console.log("");
