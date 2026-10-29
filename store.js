// Simple persistent JSON store with atomic writes. Zero native deps so it
// deploys anywhere Node runs. Swap for Postgres/SQLite when you outgrow it.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "store.json");

const DEFAULT = {
  suggestions: {},   // id -> {text, author, createdAt, status, votes:{voterId:1|-1}, buildStartedAt, shippedAt, build:{...}}
  modules: [],       // shipped site modules [{id, suggestionId, title, blurb, items:[{h,p}], builtBy, shippedAt}]
  siteConfig: {},    // voted site-wide settings the crew has applied (whitelisted keys)
  hooks: [],         // voted automations [{on, action, template}] (max 10)
  mods: [],          // voted site mods: real css/js applied to the live page for everyone (max 20)
  modsRev: 0,        // bumped whenever mods change, so open pages pick them up
  log: [],           // ring buffer of events [{t, msg}]
  meta: { createdAt: Date.now() }
};

let state = load();
let writeTimer = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      return { ...structuredClone(DEFAULT), ...raw };
    }
  } catch (e) {
    console.error("[store] failed to load, starting fresh:", e.message);
  }
  return structuredClone(DEFAULT);
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error("[store] write failed:", e.message);
    }
  }, 250);
}

export function get() { return state; }

export function mutate(fn) {
  fn(state);
  persist();
  return state;
}

export function log(msg) {
  state.log.push({ t: Date.now(), msg: String(msg).slice(0, 140) });
  if (state.log.length > 40) state.log.shift();
  persist();
}
