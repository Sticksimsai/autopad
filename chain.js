// Solana mainnet connectivity (Helius RPC) + the automated on-chain launch path.
//
// Status: set HELIUS_API_KEY and the server connects to mainnet and reports
// live chain status to the site. The key never reaches the browser.
//
// Launches: run `npm run chain:setup` once to generate the launcher keypair and
// wire your .env. When ARMED (see launchConfig below), every shipped $TICKER
// build automatically mints a REAL Token-2022 SPL token on mainnet — name and
// symbol stored on-chain via the token metadata extension — and the site shows
// the live mint address. The bonding curve itself stays simulated until your
// Anchor curve program is deployed (LAUNCHPAD_PROGRAM).

import fs from "fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, TYPE_SIZE, LENGTH_SIZE,
  createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createMintToInstruction, createSetAuthorityInstruction, AuthorityType
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import BN from "bn.js";
import {
  Raydium, TxVersion, LAUNCHPAD_PROGRAM, DEVNET_PROGRAM_ID,
  getPdaLaunchpadConfigId, getPdaLaunchpadPoolId, getPdaPlatformId, getCpmmPdaAmmConfigId,
  LaunchpadConfig, LaunchpadPool, PlatformConfig, toTransferFeeConfig
} from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
export const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "");
export const CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";

// Raydium CPMM program (mainnet) — graduation target for the bonding curve.
export const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

const TOKEN_DECIMALS = 9;
const TOKEN_SUPPLY = 1_000_000_000n; // 1B, pump-style

/* SDK errors come in many shapes (Error, string, array, {logs}) — flatten them */
export function fmtErr(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  const parts = [];
  if (e.message) parts.push(typeof e.message === "string" ? e.message : JSON.stringify(e.message));
  if (e.error) { try { parts.push(JSON.stringify(e.error).slice(0, 220)); } catch {} }
  if (e.data) { try { parts.push(JSON.stringify(e.data).slice(0, 220)); } catch {} }
  if (e.logs) parts.push("logs: " + [].concat(e.logs).slice(-6).join(" ; "));
  if (e.signature) parts.push("sig: " + e.signature);
  if (!parts.length) { try { parts.push(JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 400)); } catch { parts.push(String(e)); } }
  return parts.join(" | ");
}

let connection = null;
export function getConnection() {
  if (!RPC_URL) return null;
  if (!connection) connection = new Connection(RPC_URL, { commitment: "confirmed" });
  return connection;
}

/* ---------------- launcher keypair ---------------- */
// LAUNCHER_KEYPAIR may be a path to a solana-keygen style JSON file (preferred;
// `npm run chain:setup` creates .keys/launcher.json) or an inline JSON array.

let _launcher;
export function getLauncher() {
  if (_launcher !== undefined) return _launcher;
  _launcher = null;
  const raw = process.env.LAUNCHER_KEYPAIR;
  if (!raw) return null;
  try {
    const arr = raw.trim().startsWith("[") ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, "utf8"));
    _launcher = Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch (e) {
    console.error("[chain] LAUNCHER_KEYPAIR unreadable:", e.message);
  }
  return _launcher;
}

/* ---------------- status (cached, safe to expose) ---------------- */

let cache = {
  configured: !!RPC_URL, connected: false, cluster: CLUSTER,
  provider: HELIUS_KEY ? "helius" : (RPC_URL ? "custom" : null),
  slot: null, blockTime: null, launcherSol: null, checkedAt: 0,
  error: RPC_URL ? null : "no RPC configured"
};
let checking = false;

export async function refreshChainStatus() {
  const conn = getConnection();
  if (!conn || checking) return cache;
  checking = true;
  try {
    const slot = await conn.getSlot("confirmed"); // 1 credit per heartbeat — keep this lean
    let launcherSol = cache.launcherSol;
    const kp = getLauncher();
    if (kp && Date.now() - (cache._balAt || 0) > 10 * 60 * 1000) { // balance at most every 10 min
      try { launcherSol = +((await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL).toFixed(4); cache._balAt = Date.now(); } catch {}
    }
    cache = { ...cache, configured: true, connected: true, slot, launcherSol, checkedAt: Date.now(), error: null, _cooldown: 0 };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 120);
    // on rate limiting, back off hard instead of hammering a capped key
    const cooldown = /429|max usage|rate/i.test(msg) ? Math.min((cache._cooldown || 60) * 2, 3600) : 0;
    cache = { ...cache, connected: false, checkedAt: Date.now(), error: msg, _cooldown: cooldown };
  } finally {
    checking = false;
  }
  return cache;
}
export function chainCooldownMs() { return (cache._cooldown || 0) * 1000; }
export function chainStatus() { return cache; }

/* ---------------- arming ---------------- */
// ALL of these must hold before a real mainnet mint happens:
//   HELIUS_API_KEY (or SOLANA_RPC_URL)     — RPC
//   LAUNCHER_KEYPAIR                        — funded hot wallet
//   ENABLE_ONCHAIN_LAUNCH=true              — the explicit arm switch
// The curve additionally needs LAUNCHPAD_PROGRAM (your Anchor program) and is
// simulated until then.

export function launchConfig() {
  const kp = getLauncher();
  return {
    rpcConfigured: !!RPC_URL,
    launcherPubkey: kp ? kp.publicKey.toBase58() : null,
    armed: !!(RPC_URL && kp && process.env.ENABLE_ONCHAIN_LAUNCH === "true"),
    backend: LAUNCH_BACKEND,
    curveProgram: LAUNCH_BACKEND === "raydium" ? launchpadProgramId().toBase58() : (process.env.LAUNCHPAD_PROGRAM || null),
    raydiumCpmm: RAYDIUM_CPMM_PROGRAM,
    cluster: CLUSTER
  };
}

/* ---------------- Raydium LaunchLab: the real launch system ----------------
   Creates the token AND its on-chain bonding curve in one shot through
   Raydium's own launchpad program. People buy/sell on the live curve on
   raydium.io immediately, and at full raise the pool auto-migrates to a
   Raydium AMM. No custom program, nothing to audit ourselves. */

const LAUNCH_BACKEND = process.env.LAUNCH_BACKEND || "raydium"; // "raydium" | "token2022"
const DEV_BUY_SOL = Math.max(0, parseFloat(process.env.DEV_BUY_SOL || "0")); // optional creator first-buy

let _raydium = null;
async function getRaydium() {
  if (_raydium) return _raydium;
  _raydium = await Raydium.load({
    connection: getConnection(),
    owner: getLauncher(),
    cluster: CLUSTER === "devnet" ? "devnet" : "mainnet",
    disableFeatureCheck: true,
    disableLoadToken: true
  });
  return _raydium;
}
function launchpadProgramId() {
  return CLUSTER === "devnet" ? DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM : LAUNCHPAD_PROGRAM;
}

async function launchViaRaydium(build, metaUri) {
  const conn = getConnection();
  const payer = getLauncher();
  const raydium = await getRaydium();
  const programId = launchpadProgramId();

  const mintKp = Keypair.generate();
  const name = String(build.name || build.symbol || "Buildpad Token").slice(0, 32);
  const symbol = String(build.symbol || "$PAD").replace(/^\$/, "").slice(0, 10);
  // metadata: the site serves each token's Metaplex JSON itself (/api/meta/:id.json)
  const uri = metaUri || process.env.TOKEN_METADATA_URI || "https://raydium.io";

  const configId = getPdaLaunchpadConfigId(programId, NATIVE_MINT, 0, 0).publicKey;
  const configAcc = await conn.getAccountInfo(configId);
  if (!configAcc) throw new Error("LaunchLab config not found on " + CLUSTER + " — check cluster/program");
  const configInfo = LaunchpadConfig.decode(configAcc.data);
  const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB);

  const buyLamports = DEV_BUY_SOL > 0 ? new BN(Math.floor(DEV_BUY_SOL * LAMPORTS_PER_SOL)) : new BN(1);

  // platform resolution: your own (verified on THIS cluster) → else the
  // cluster's default. The SDK's silent default is the MAINNET platform, which
  // doesn't exist on devnet — so on devnet we must pass the devnet default.
  let platformId;
  if (process.env.PLATFORM_ID) {
    const p = await platformOnchain();
    if (p.exists) platformId = new PublicKey(process.env.PLATFORM_ID);
    else console.warn("[launch] PLATFORM_ID set but not found on " + CLUSTER + " — using the cluster default platform (no fee share)");
  }
  if (!platformId && CLUSTER === "devnet") platformId = DEVNET_PROGRAM_ID.LAUNCHPAD_PLATFORM;

  const { execute, extInfo, transactions: madeTxs } = await raydium.launchpad.createLaunchpad({
    programId,
    ...(platformId ? { platformId } : {}),
    mintA: mintKp.publicKey,
    decimals: 6,
    name, symbol, uri,
    migrateType: process.env.MIGRATE_TYPE || "cpmm", // platform requires CPMM graduation (error 6007 otherwise)
    configId,
    configInfo,
    mintBDecimals: mintBInfo.decimals,
    txVersion: TxVersion.V0,
    slippage: new BN(100), // 1%
    buyAmount: buyLamports,
    createOnly: DEV_BUY_SOL <= 0, // SDK requires buyAmount > 0 even when createOnly
    extraSigners: [mintKp],
    computeBudgetConfig: { units: 600000, microLamports: 100000 }
  });
  let sent;
  try {
    sent = await execute({ sequentially: true, sendAndConfirm: true });
  } catch (e) {
    let detail = fmtErr(e);
    // pull the on-chain program logs so the real failure is visible
    try {
      const txs = madeTxs;
      if (txs && txs.length) {
        const sim = await conn.simulateTransaction(txs[0], { sigVerify: false, replaceRecentBlockhash: true });
        if (sim?.value?.err) detail += " | simErr: " + JSON.stringify(sim.value.err);
        if (sim?.value?.logs?.length) detail += " | logs: " + sim.value.logs.slice(-8).join(" ;; ");
      }
    } catch (se) { detail += " | (simulate also failed: " + fmtErr(se).slice(0, 120) + ")"; }
    throw new Error("launch send failed: " + detail.slice(0, 900));
  }
  const txIds = sent?.txIds || sent?.txId ? [].concat(sent.txIds || sent.txId) : [];
  const poolId = extInfo?.address?.poolId?.toBase58?.() || getPdaLaunchpadPoolId(programId, mintKp.publicKey, NATIVE_MINT).publicKey.toBase58();

  // confirm the pool actually exists before declaring the launch live
  const landed = await waitForAccount(poolId, 10, 2000);
  if (!landed) throw new Error("launch transaction did not land (pool account not found) — check launcher balance; token stays on the simulated curve");

  const mint = mintKp.publicKey.toBase58();
  return {
    armed: true, status: "launched", backend: "raydium-launchlab",
    mint, poolId, signature: txIds[0] || "",
    tradeUrl: `https://raydium.io/launchpad/token/?mint=${mint}`,
    explorer: `https://solscan.io/token/${mint}${CLUSTER !== "mainnet-beta" ? "?cluster=" + CLUSTER : ""}`,
    note: DEV_BUY_SOL > 0 ? `live on the LaunchLab curve (dev-buy ${DEV_BUY_SOL} SOL)` : "live on the LaunchLab bonding curve — trading open on raydium.io"
  };
}

/* ---------------- creator-pays launches: user's wallet signs & pays ----------
   Builds the LaunchLab create tx with the CREATOR as payer. The server signs
   only with the fresh mint keypair (required signer it just generated), the
   creator signs and sends in Phantom, and the server verifies the pool exists
   before the token appears on the site. The treasury pays nothing. */

export async function buildLaunchTx({ ownerPubkey, name, symbol, uri, buySol = 0 }) {
  const conn = getConnection();
  if (!conn) throw new Error("RPC not configured on the server");
  const owner = new PublicKey(ownerPubkey);
  const programId = launchpadProgramId();
  const r = await Raydium.load({
    connection: conn, owner,
    cluster: CLUSTER === "devnet" ? "devnet" : "mainnet",
    disableFeatureCheck: true, disableLoadToken: true
  });

  const mintKp = Keypair.generate();
  const configId = getPdaLaunchpadConfigId(programId, NATIVE_MINT, 0, 0).publicKey;
  const configAcc = await conn.getAccountInfo(configId);
  if (!configAcc) throw new Error("LaunchLab config not found on " + CLUSTER);
  const configInfo = LaunchpadConfig.decode(configAcc.data);
  const mintBInfo = await r.token.getTokenInfo(configInfo.mintB);

  let platformId;
  if (process.env.PLATFORM_ID) {
    const p = await platformOnchain();
    if (p.exists) platformId = new PublicKey(process.env.PLATFORM_ID);
  }
  if (!platformId && CLUSTER === "devnet") platformId = DEVNET_PROGRAM_ID.LAUNCHPAD_PLATFORM;

  const made = await r.launchpad.createLaunchpad({
    programId,
    ...(platformId ? { platformId } : {}),
    mintA: mintKp.publicKey,
    decimals: 6,
    name: String(name).slice(0, 32),
    symbol: String(symbol).replace(/^\$/, "").slice(0, 10),
    uri: uri || "https://raydium.io",
    migrateType: process.env.MIGRATE_TYPE || "cpmm",
    configId, configInfo,
    mintBDecimals: mintBInfo.decimals,
    txVersion: TxVersion.V0,
    slippage: new BN(100),
    buyAmount: buySol > 0 ? new BN(Math.floor(buySol * LAMPORTS_PER_SOL)) : new BN(1),
    createOnly: buySol <= 0,
    extraSigners: [mintKp],
    computeBudgetConfig: { units: 600000, microLamports: 100000 }
  });
  const txs = made.transactions || (made.transaction ? [made.transaction] : []);
  if (!txs.length) throw new Error("SDK returned no transaction");
  const serialized = txs.map(tx => {
    try { tx.sign([mintKp]); } catch { /* mint not a required signer on this tx */ }
    return Buffer.from(tx.serialize()).toString("base64");
  });
  const poolId = getPdaLaunchpadPoolId(programId, mintKp.publicKey, NATIVE_MINT).publicKey.toBase58();
  return { txs: serialized, mint: mintKp.publicKey.toBase58(), poolId };
}

export async function poolExists(poolId) {
  try { return !!(await getConnection()?.getAccountInfo(new PublicKey(poolId))); } catch { return false; }
}

/* ---------------- in-site trading: build unsigned txs for the user's wallet ----
   The server BUILDS the LaunchLab buy/sell transaction for the viewer's own
   pubkey; the viewer signs and sends it with Phantom. User keys never touch
   the server, and the server never signs user trades. */

export async function buildTradeTx({ ownerPubkey, mint, side, amountSol, amountTokens }) {
  const conn = getConnection();
  if (!conn) throw new Error("RPC not configured on the server");
  const owner = new PublicKey(ownerPubkey);
  const programId = launchpadProgramId();
  const mintA = new PublicKey(mint);
  const poolId = getPdaLaunchpadPoolId(programId, mintA, NATIVE_MINT).publicKey;

  const r = await Raydium.load({
    connection: conn, owner,
    cluster: CLUSTER === "devnet" ? "devnet" : "mainnet",
    disableFeatureCheck: true, disableLoadToken: true
  });
  const poolInfo = await r.launchpad.getRpcPoolInfo({ poolId });

  let platformFeeRate;
  try {
    const acc = await conn.getAccountInfo(poolInfo.platformId);
    if (acc) platformFeeRate = PlatformConfig.decode(acc.data).feeRate;
  } catch { /* SDK falls back */ }

  const mintB = poolInfo.configInfo?.mintB || NATIVE_MINT;
  const mintBInfo = await r.token.getTokenInfo(mintB);
  const mintAInfo = await r.token.getTokenInfo(mintA).catch(() => null);
  const epoch = await conn.getEpochInfo();

  const common = {
    programId, mintA,
    ...(mintAInfo ? { mintAProgram: new PublicKey(mintAInfo.programId) } : {}),
    poolInfo, mintB, mintBProgram: new PublicKey(mintBInfo.programId),
    transferFeeConfigB: toTransferFeeConfig(mintBInfo, epoch.epoch),
    configInfo: poolInfo.configInfo,
    ...(platformFeeRate ? { platformFeeRate } : {}),
    slippage: new BN(150), // 1.5%
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600000, microLamports: 100000 }
  };

  let made;
  if (side === "buy") {
    made = await r.launchpad.buyToken({ ...common, buyAmount: new BN(Math.floor(amountSol * LAMPORTS_PER_SOL)) });
  } else {
    const decimals = mintAInfo?.decimals ?? 6;
    made = await r.launchpad.sellToken({ ...common, sellAmount: new BN(Math.floor(amountTokens)).mul(new BN(10).pow(new BN(decimals))) });
  }
  const tx = made.transaction;
  const expected = made.extInfo?.decimalOutAmount?.toString?.() || made.extInfo?.outAmount?.toString?.() || null;
  return { tx: Buffer.from(tx.serialize()).toString("base64"), expected, poolId: poolId.toBase58() };
}

/* ---------------- platform config: Buildpad's fee share on every trade ---------- */

async function waitForAccount(pubkey, tries = 8, delayMs = 2000) {
  const conn = getConnection();
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(new PublicKey(pubkey)).catch(() => null);
    if (acc) return true;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

export async function createPlatform({ feeRateBps = 100, name = "Buildpad", web = "", img = "" } = {}) {
  const payer = getLauncher();
  if (!payer) throw new Error("run npm run chain:setup first");
  const conn = getConnection();
  const bal = await conn.getBalance(payer.publicKey);
  if (bal < 0.03 * LAMPORTS_PER_SOL) {
    throw new Error(`launcher has ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL — fund ${payer.publicKey.toBase58()} with at least 0.05 SOL first, then rerun`);
  }
  const raydium = await getRaydium();
  const programId = launchpadProgramId();

  let cpConfigId;
  if (CLUSTER === "devnet") {
    cpConfigId = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, 0).publicKey;
  } else {
    try {
      const cfgs = await raydium.api.getCpmmConfigs();
      cpConfigId = new PublicKey(cfgs[0].id);
    } catch (e) {
      throw new Error("could not fetch a Raydium CPMM fee config (needed for graduation): " + e.message);
    }
  }

  const made = await raydium.launchpad.createPlatformConfig({
    programId,
    platformAdmin: payer.publicKey,
    platformClaimFeeWallet: payer.publicKey,
    platformLockNftWallet: payer.publicKey,
    platformVestingWallet: payer.publicKey,
    cpConfigId,
    // program requires creator/burn scales = 0 (RequireEqViolated otherwise):
    // the graduation LP lock NFT goes 100% to the platform
    migrateCpLockNftScale: { platformScale: new BN(1000000), creatorScale: new BN(0), burnScale: new BN(0) },
    transferFeeExtensionAuth: payer.publicKey,
    creatorFeeRate: new BN(0),
    feeRate: new BN(Math.round(feeRateBps * 100)), // 1_000_000 = 100%
    name: String(name).slice(0, 32),
    web: String(web).slice(0, 64),
    img: String(img).slice(0, 128),
    platformVestingScale: new BN(0),
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 400000, microLamports: 100000 }
  });
  let sent;
  try { sent = await made.execute({ sendAndConfirm: true }); }
  catch (e) {
    let detail = fmtErr(e);
    try {
      const txs = made.transactions || (made.transaction ? [made.transaction] : []);
      if (txs.length) {
        const sim = await conn.simulateTransaction(txs[0], { sigVerify: false, replaceRecentBlockhash: true });
        if (sim?.value?.err) detail += " | simErr: " + JSON.stringify(sim.value.err);
        if (sim?.value?.logs?.length) detail += " | logs: " + sim.value.logs.slice(-10).join(" ;; ");
      }
    } catch (se) { detail += " | (simulate failed: " + fmtErr(se).slice(0, 120) + ")"; }
    throw new Error("platform tx failed: " + detail.slice(0, 1200));
  }
  const platformId = getPdaPlatformId(programId, payer.publicKey).publicKey.toBase58();
  // never trust a returned signature alone — confirm the platform account exists
  const landed = await waitForAccount(platformId);
  if (!landed) throw new Error("transaction did not land on-chain (platform account not found) — check launcher balance and RPC, then rerun");
  return { platformId, txIds: [].concat(sent?.txIds || sent?.txId || []), verified: true };
}

/* does the configured PLATFORM_ID actually exist on the current cluster? */
export async function platformOnchain() {
  const id = process.env.PLATFORM_ID;
  if (!id) return { configured: false };
  try {
    const acc = await getConnection()?.getAccountInfo(new PublicKey(id));
    return { configured: true, id, exists: !!acc };
  } catch { return { configured: true, id, exists: false }; }
}

export async function claimPlatformFees() {
  const payer = getLauncher();
  if (!payer || !process.env.PLATFORM_ID) throw new Error("needs LAUNCHER_KEYPAIR and PLATFORM_ID");
  const raydium = await getRaydium();
  const { execute } = await raydium.launchpad.claimAllPlatformFee({
    programId: launchpadProgramId(),
    platformId: new PublicKey(process.env.PLATFORM_ID),
    platformClaimFeeWallet: payer.publicKey,
    txVersion: TxVersion.V0
  });
  const sent = await execute({ sequentially: true });
  return { txIds: [].concat(sent?.txIds || sent?.txId || []) };
}

/* read the REAL curve state for a launched token (fundraise progress) */
export async function fetchOnchainCurve(poolId) {
  try {
    const conn = getConnection();
    if (!conn || !poolId) return null;
    const acc = await conn.getAccountInfo(new PublicKey(poolId));
    if (!acc) return null;
    const pool = LaunchpadPool.decode(acc.data);
    const real = pool.realB ?? pool.realQuote ?? null;
    const total = pool.totalFundRaisingB ?? pool.totalQuoteFundRaising ?? null;
    if (real == null || total == null) return null;
    const realSol = Number(real.toString()) / LAMPORTS_PER_SOL;
    const targetSol = Number(total.toString()) / LAMPORTS_PER_SOL;
    return {
      solRaised: +realSol.toFixed(2),
      targetSol: +targetSol.toFixed(2),
      pct: Math.min(100, Math.round(realSol / Math.max(targetSol, 0.000001) * 100)),
      migrated: !!(pool.status && Number(pool.status.toString?.() ?? pool.status) >= 2),
      at: Date.now()
    };
  } catch { return null; }
}

/* ---------------- the automated launch ---------------- */
// Mints a Token-2022 SPL token with on-chain metadata (name + symbol), mints
// the full supply to the launcher's ATA (the future curve vault), and revokes
// the mint authority so supply is fixed. Costs ~0.004 SOL in rent + fees.

export async function launchToken(build, metaUri) {
  const cfg = launchConfig();
  if (!cfg.armed) {
    return {
      armed: false, status: "simulated",
      note: cfg.rpcConfigured
        ? "launches disarmed (ENABLE_ONCHAIN_LAUNCH not true) — token stays on the simulated curve"
        : "no RPC configured — token stays on the simulated curve"
    };
  }
  const conn = getConnection();
  const payer = getLauncher();

  const needSol = LAUNCH_BACKEND === "raydium" ? 0.05 + DEV_BUY_SOL : 0.01;
  const balance = await conn.getBalance(payer.publicKey);
  if (balance < needSol * LAMPORTS_PER_SOL) {
    throw new Error(`launcher ${payer.publicKey.toBase58()} underfunded (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, needs ~${needSol}) — fund it and the next shipped token will launch`);
  }

  if (LAUNCH_BACKEND === "raydium") return launchViaRaydium(build, metaUri);

  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const name = String(build.name || build.symbol || "Buildpad Token").slice(0, 32);
  const symbol = String(build.symbol || "$PAD").replace(/^\$/, "").slice(0, 10);

  const metadata = {
    mint, name, symbol,
    uri: metaUri || process.env.TOKEN_METADATA_URI || "",
    additionalMetadata: [["builtBy", "buildpad-crew"], ["reward", String(build.reward || "dividend")]]
  };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);

  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint,
      space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID
    }),
    createInitializeMetadataPointerInstruction(mint, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, TOKEN_DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: payer.publicKey,
      mint, mintAuthority: payer.publicKey, name, symbol, uri: metadata.uri
    }),
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, ata, payer.publicKey, TOKEN_SUPPLY * 10n ** BigInt(TOKEN_DECIMALS), [], TOKEN_2022_PROGRAM_ID),
    // fixed supply: nobody (us included) can mint more
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID)
  );

  const sig = await sendAndConfirmTransaction(conn, tx, [payer, mintKp], { commitment: "confirmed" });
  return {
    armed: true, status: "minted",
    mint: mint.toBase58(), signature: sig,
    supply: TOKEN_SUPPLY.toString(), decimals: TOKEN_DECIMALS,
    vault: ata.toBase58(),
    explorer: `https://solscan.io/token/${mint.toBase58()}${CLUSTER !== "mainnet-beta" ? "?cluster=" + CLUSTER : ""}`,
    note: cfg.curveProgram ? "minted; curve init pending program integration" : "minted; curve simulated until LAUNCHPAD_PROGRAM is deployed"
  };
}

export function isValidAddress(a) {
  try { new PublicKey(a); return true; } catch { return false; }
}
