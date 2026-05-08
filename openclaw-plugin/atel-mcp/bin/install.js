#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);

// Subcommand: `npx atel-mcp-openclaw upload-seed [--identity ...] [--platform ...]`
// Re-uploads the local identity's seed to platform's managed-seed store
// after a fresh wash / when install was run with --no-managed-seed.
// Reuses install.js arg parsing for --identity and --platform overrides.
const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : null;

function valueOf(name) {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : "";
}
function has(name) {
  return args.includes(name);
}
function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
function firstFile(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME || process.env.USERPROFILE || ".";
const openclawHome = valueOf("--openclaw-home") || process.env.OPENCLAW_HOME || path.join(home, ".openclaw");
const configPath = valueOf("--config") || process.env.OPENCLAW_CONFIG_PATH || path.join(openclawHome, "openclaw.json");
const extensionsDir = valueOf("--extensions-dir") || process.env.OPENCLAW_EXTENSIONS_DIR || path.join(openclawHome, "extensions");
// Extension dir is named after the plugin id so a fresh install lands on
// the canonical path. Older installs at <extensionsDir>/atel-mcp are left
// in place to avoid breaking OpenClaw runtimes mid-restart; the next
// install run cleans them up via the legacy-id removal below.
const extensionDir = path.join(extensionsDir, "atel-mcp-openclaw");
const legacyExtensionDir = path.join(extensionsDir, "atel-mcp");
const identityPath = valueOf("--identity") || process.env.ATEL_IDENTITY_PATH || firstFile([
  path.join(process.cwd(), ".atel", "identity.json"),
  path.join(home, ".atel", "identity.json"),
  path.join(openclawHome, "workspace", ".atel", "identity.json"),
  path.join(openclawHome, "workspace", "atel-sdk", ".atel", "identity.json"),
]);
const serverBaseUrl = valueOf("--server") || process.env.ATEL_MCP_SERVER_BASE_URL || "https://atelai.xyz";
const platformBaseUrl = valueOf("--platform") || process.env.ATEL_PLATFORM_BASE_URL || "https://api.atelai.xyz";

// Friendly agent name written to platform's agents.name. Without this we'd
// fall back to whatever the SDK seeded (often "agent-${hostname}" — that
// shows up as "agent-racknerd-cc01b4c-2806462" in the dashboard, which is
// useless to humans searching by name).
//
// Resolution order:
//   1. --name CLI arg
//   2. ATEL_AGENT_NAME env var
//   3. interactive prompt (TTY only) with hostname-derived default
//   4. hostname (last-resort, headless install)
function promptAgentName(defaultName) {
  if (!process.stdin.isTTY) return defaultName;
  // Light synchronous prompt so this stays a single-file install. Avoids
  // pulling in readline-sync as a new dep.
  process.stdout.write(`Agent display name (shown on dashboard / search) [${defaultName}]: `);
  try {
    const buf = Buffer.alloc(1024);
    const fd = fs.openSync("/dev/tty", "r");
    const len = fs.readSync(fd, buf, 0, buf.length);
    fs.closeSync(fd);
    const input = buf.slice(0, len).toString("utf8").trim();
    return input || defaultName;
  } catch {
    return defaultName;
  }
}
const hostBased = (() => {
  try {
    const os = require("os");
    return `agent-${os.hostname().replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40)}`;
  } catch { return "atel-agent"; }
})();
const agentName = (
  valueOf("--name")
  || process.env.ATEL_AGENT_NAME
  || promptAgentName(hostBased)
  || hostBased
).slice(0, 64);

if (!fs.existsSync(configPath)) die(`OpenClaw config not found: ${configPath}`);

// Auto-generate ed25519 identity if --identity points to a missing file
// (or no path was supplied at all). This is what makes the install
// "zero-state friendly" — a brand-new operator with no SDK CLI can run
// `npx atel-mcp-openclaw --name foo` and end up registered. The
// generated identity uses the same on-disk schema as `atel init`
// (agent_id, did, publicKey hex32, secretKey hex64) so it stays
// interchangeable with SDK CLI installs if the operator later mixes
// the two.
// ensureIdentity is defined here but not invoked yet. We need
// extensionDir/node_modules to exist (cpSync + npm install must run
// first) so the function can pull tweetnacl + bs58 — these are runtime
// deps that may not exist in packageRoot if the operator unpacked the
// plugin without `npm install`. Calling this AFTER the plugin install
// block below also keeps zero-state semantics: a missing identity is
// only a problem at write time, not parse time.
async function ensureIdentity(targetPath, depsRoot) {
  // Default location: ~/atel-workspace/.atel/identity.json — matches SDK
  // CLI convention so the file persists across reboots and stays
  // discoverable by other ATEL tooling. Earlier we used cwd, but that
  // landed identity in /tmp/<install-extract-dir>/.atel which evaporates.
  const resolvedPath = targetPath || path.join(home, "atel-workspace", ".atel", "identity.json");
  if (fs.existsSync(resolvedPath)) return resolvedPath;
  console.log(`No identity at ${resolvedPath} — generating a fresh ed25519 keypair…`);
  // bs58 cjs interop varies — handle both default and named exports.
  const naclMod = await import(path.join(depsRoot, "node_modules", "tweetnacl", "nacl.js")).catch(() => import("tweetnacl"));
  const nacl = naclMod.default || naclMod;
  const bs58Mod = await import(path.join(depsRoot, "node_modules", "bs58", "src", "esm", "index.js")).catch(() => import("bs58"));
  const bs58 = bs58Mod.default || bs58Mod;
  const kp = nacl.sign.keyPair();
  const did = "did:atel:ed25519:" + bs58.encode(kp.publicKey);
  const id = {
    agent_id: "agent-" + (process.env.HOSTNAME || "host").replace(/[^a-z0-9-]/gi, "").slice(0, 40),
    did,
    publicKey: Buffer.from(kp.publicKey).toString("hex"),
    secretKey: Buffer.from(kp.secretKey).toString("hex"),
  };
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(id, null, 2) + "\n");
  console.log(`  wrote identity → ${resolvedPath}`);
  console.log(`  DID = ${did}`);
  return resolvedPath;
}

// `wash` subcommand: zero-state wipe before re-installing fresh.
// Reverses everything install creates so a follow-up `npx atel-mcp-openclaw`
// truly starts from nothing. Order matters — kill processes first so we
// don't write to live data; then unlink files; then strip openclaw config.
if (subcommand === "wash") {
  console.log("ATEL plugin: zero-state wash starting…");
  const { execFileSync, spawnSync } = await import("node:child_process");

  // 1. Stop gateway (best-effort — service may not be installed under user
  //    units). Kill any lingering openclaw helpers from previous installs
  //    so they release Telegram getUpdates / file locks.
  try { execFileSync("systemctl", ["--user", "stop", "openclaw-gateway"], { stdio: "ignore" }); } catch {}
  for (const pat of ["openclaw-cron", "node bin/install.js"]) {
    spawnSync("pkill", ["-9", "-f", pat], { stdio: "ignore" });
  }
  // Don't pkill bare "openclaw" — that would also kill openclaw-gateway,
  // and pkill -f matches the full cmdline; leaving it untouched keeps
  // gateway running through the wash if user later re-installs.

  // 2. Wipe filesystem state
  const wipePaths = [
    extensionDir,
    legacyExtensionDir,
    path.join(openclawHome, "workspace", "skills", "atel-agent"),
    path.join(openclawHome, "cron", "jobs.json"),
    path.join(openclawHome, "atel-mcp-did-sig-cache.json"),
    path.join(openclawHome, "atel-mcp-inbox"),
    // identity is wiped in default location only — if user passed --identity,
    // that's their custody, don't touch.
    !valueOf("--identity") ? path.join(home, "atel-workspace", ".atel", "identity.json") : null,
  ].filter(Boolean);
  for (const p of wipePaths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  // Sessions (jsonl + sessions.json index)
  try {
    const sessionsDir = path.join(openclawHome, "agents", "main", "sessions");
    if (fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (f.endsWith(".jsonl") || f === "sessions.json") {
          fs.rmSync(path.join(sessionsDir, f), { force: true });
        }
      }
    }
  } catch {}
  // npx cache for old plugin versions
  try { fs.rmSync(path.join(home, ".npm", "_npx"), { recursive: true, force: true }); } catch {}

  // 3. Strip plugin entries from openclaw.json (additive, don't touch
  //    other plugins / channels).
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const plugins = cfg.plugins || {};
      for (const k of Object.keys(plugins.entries || {})) {
        if (k.includes("atel-mcp")) delete plugins.entries[k];
      }
      for (const k of Object.keys(plugins.installs || {})) {
        if (k.includes("atel-mcp")) delete plugins.installs[k];
      }
      plugins.allow = (plugins.allow || []).filter((a) => !String(a).includes("atel-mcp"));
      cfg.plugins = plugins;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
    }
  } catch (e) {
    console.error(`warn: openclaw config strip failed: ${e.message}`);
  }

  console.log("✅ Wash complete. Next: `npx atel-mcp-openclaw --name <X> --capabilities <csv>`");
  console.log("   (Note: platform-side records — agent registry entry, contacts, mcp_managed_seeds — are NOT cleared by this wash. Those are platform state and require ops to reset.)");
  process.exit(0);
}

// `upload-seed` subcommand: standalone path that re-uploads the seed
// without touching plugin / OpenClaw config. Useful after `--no-managed-seed`
// install or after a wash cleared mcp_managed_seeds. Resolves identity
// path, finds tweetnacl in any reachable node_modules (extensionDir if
// installed, else falls back to atel-workspace/atel-sdk-new), signs +
// posts to /auth/v1/managed-seed.
if (subcommand === "upload-seed") {
  const idPath = identityPath || path.join(home, "atel-workspace", ".atel", "identity.json");
  if (!fs.existsSync(idPath)) die(`identity not found at ${idPath}; run plugin install first or pass --identity`);
  // Find a tweetnacl reachable from disk. Prefer the installed plugin's deps.
  const candidates = [
    path.join(extensionDir, "node_modules"),
    path.join(home, "atel-workspace", "node_modules"),
    path.join(home, "atel-workspace", "atel-sdk-new", "node_modules"),
  ];
  const depsRoot = candidates
    .map((d) => path.dirname(d))
    .find((d) => fs.existsSync(path.join(d, "node_modules", "tweetnacl")));
  if (!depsRoot) die("tweetnacl not found anywhere; run install first or `npm install tweetnacl` somewhere reachable");
  const naclMod = await import(path.join(depsRoot, "node_modules", "tweetnacl", "nacl.js"));
  const nacl = naclMod.default || naclMod;

  const idObj = JSON.parse(fs.readFileSync(idPath, "utf8"));
  const sk = Buffer.from(idObj.secretKey, "hex");
  const ts = new Date().toISOString();
  const payload = { secretKey: idObj.secretKey, source: "atel-mcp-openclaw upload-seed CLI" };
  const ser = (o) => JSON.stringify(o, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) {
      const s = {};
      for (const k of Object.keys(v).sort()) s[k] = v[k];
      return s;
    }
    return v;
  });
  const signable = ser({ did: idObj.did, payload, timestamp: ts });
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(signable), sk)).toString("base64");
  const envelope = { did: idObj.did, payload, timestamp: ts, signature };
  const r = await fetch(`${platformBaseUrl.replace(/\/$/, "")}/auth/v1/managed-seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const body = await r.text();
  if (r.ok) {
    console.log(`✅ seed uploaded for ${idObj.did}`);
    console.log(body.slice(0, 300));
    process.exit(0);
  } else {
    console.error(`❌ upload failed (${r.status}): ${body.slice(0, 300)}`);
    process.exit(1);
  }
}

fs.mkdirSync(extensionsDir, { recursive: true });
const backup = `${configPath}.bak-atel-mcp-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
fs.copyFileSync(configPath, backup);
fs.rmSync(extensionDir, { recursive: true, force: true });
// Wipe any pre-rename install at the legacy path so OpenClaw doesn't
// load the same plugin twice (once under each id) on next gateway start.
if (fs.existsSync(legacyExtensionDir)) {
  fs.rmSync(legacyExtensionDir, { recursive: true, force: true });
}
fs.cpSync(packageRoot, extensionDir, { recursive: true });

try {
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: extensionDir,
    stdio: "inherit",
  });
} catch (error) {
  die(`npm install failed in ${extensionDir}: ${error.message}`);
}

// Identity generation now runs AFTER npm install so that tweetnacl + bs58
// are guaranteed present in extensionDir/node_modules.
const resolvedIdentityPath = await ensureIdentity(identityPath, extensionDir);

// Managed-seed opt-in. Without this, fast_transfer / wallet_transfer /
// wallet_withdraw all fail at the platform level with "no managed seed
// for did:...". Reason: those flows have platform sign BCS / EVM meta-tx
// on behalf of the user (the user's smart wallet contract owner is the
// platform's relayer key), which requires the user's ed25519 seed to be
// KEK-encrypted at rest in mcp_managed_seeds.
//
// Default: upload. The MCP-only path means the user has no SDK CLI to
// sign things directly; without managed seed, half the wallet flows are
// dead. We still allow opt-out (--no-managed-seed) for users who want
// to keep secretKey purely local — they accept that fast/EVM transfer
// won't work until they manually upload.
const skipManagedSeed = has("--no-managed-seed");
async function uploadManagedSeed(idPath, depsRoot, platformBaseUrl) {
  const naclMod = await import(path.join(depsRoot, "node_modules", "tweetnacl", "nacl.js")).catch(() => import("tweetnacl"));
  const nacl = naclMod.default || naclMod;

  const idObj = JSON.parse(fs.readFileSync(idPath, "utf8"));
  const sk = Buffer.from(idObj.secretKey, "hex");
  const ts = new Date().toISOString();
  // Platform expects: secretKey hex64 inside payload, sig over canonical
  // {did, payload, timestamp}. Reuses VerifySignedRequest.
  const payload = { secretKey: idObj.secretKey, source: "atel-mcp-openclaw install" };
  const ser = (o) => JSON.stringify(o, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) {
      const s = {};
      for (const k of Object.keys(v).sort()) s[k] = v[k];
      return s;
    }
    return v;
  });
  const signable = ser({ did: idObj.did, payload, timestamp: ts });
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(signable), sk)).toString("base64");
  const envelope = { did: idObj.did, payload, timestamp: ts, signature };

  const r = await fetch(`${platformBaseUrl.replace(/\/$/, "")}/auth/v1/managed-seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body };
}

if (skipManagedSeed) {
  console.log("Managed seed opt-in: SKIPPED (--no-managed-seed)");
  console.log("  → fast_transfer / wallet_transfer / wallet_withdraw will fail until you opt in.");
  console.log("  → re-run with `npx atel-mcp-openclaw upload-seed` if you change your mind.");
} else {
  try {
    const r = await uploadManagedSeed(resolvedIdentityPath, extensionDir, platformBaseUrl);
    if (r.ok) {
      console.log("Managed seed opt-in: ✅ uploaded (platform can now sign Fast/EVM transfers on your behalf)");
    } else {
      console.error(`warn: managed seed upload failed (${r.status}): ${r.body.slice(0, 200)}`);
      console.error("  install will continue, but fast_transfer / wallet_* will be blocked until you re-upload.");
    }
  } catch (e) {
    console.error(`warn: managed seed upload threw: ${e.message}`);
  }
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.plugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
const allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : [];
// Plugin id MUST match the npm package name so OpenClaw's plugin loader
// stops warning about "manifest uses atel-mcp, entry hints atel-mcp-openclaw"
// every time it lists plugins. Migration: drop the legacy "atel-mcp" id and
// re-add the canonical one. Keeps any other allowed plugin entries intact.
const PLUGIN_ID = "atel-mcp-openclaw";
const LEGACY_ID = "atel-mcp";
const migratedAllow = allow.filter((entry) => entry !== LEGACY_ID && entry !== PLUGIN_ID);
migratedAllow.push(PLUGIN_ID);
config.plugins.allow = migratedAllow;
config.plugins.entries = config.plugins.entries && typeof config.plugins.entries === "object" ? config.plugins.entries : {};
config.plugins.installs = config.plugins.installs && typeof config.plugins.installs === "object" ? config.plugins.installs : {};
// Drop legacy id entries before writing the canonical one — otherwise both
// would coexist and OpenClaw would load the plugin twice.
delete config.plugins.entries[LEGACY_ID];
delete config.plugins.installs[LEGACY_ID];
config.plugins.entries[PLUGIN_ID] = {
  enabled: true,
  config: {
    serverBaseUrl,
    platformBaseUrl,
    identityPath: resolvedIdentityPath,
    scopes: [
      // Identity / discovery
      "identity.read",
      // P2P messaging + contacts
      "contacts.read",
      "messages.read",
      "messages.write",
      // A2A orders + milestones
      "orders.read",
      "orders.write",
      "milestones.read",
      "milestones.write",
      // Wallet (balance / transfer / withdraw). Without these, atel_balance
      // / atel_fast_transfer / atel_wallet_transfer / atel_wallet_withdraw
      // all silently 403 with "missing scope" — was the 0.3.2 regression.
      "wallet.read",
      "wallet.transfer",
      "wallet.withdraw",
      // A2B Bitrefill gift cards. Same regression as wallet.* — 0.3.2 didn't
      // claim these so the entire a2b tool family was unreachable.
      "a2b.read",
      "a2b.write",
      // Disputes (raise + read; resolve is arbitrator-only and platform
      // enforces ATEL_ARBITRATOR_DIDS even if scope present, so claiming it
      // is harmless for non-arbitrators).
      "disputes.read",
      "disputes.write",
      "dispute.resolve",
      // Audit trails for own orders / sessions / requests.
      "audit.read"
    ]
  }
};
// All plugin-side state lives in a single atel-state.json file (one
// atomic write per upgrade). Replaces the older
// agent-name.txt / agent-capabilities.txt / tg-chat.txt trio which had
// no atomicity guarantee — partial writes between updates left setup.js
// reading an inconsistent mix.
//
// Schema (versioned for forward compat):
//   { v: 1,
//     name: <friendly>,
//     capabilities: [<csv>],
//     tgChat: <chatId>?,
//     installedAt: <iso>,
//     installedVersion: <plugin pkg version> }
const capabilitiesCSV = (
  valueOf("--capabilities")
  || process.env.ATEL_AGENT_CAPABILITIES
  || ""
).trim();
const capabilitiesArr = capabilitiesCSV
  ? capabilitiesCSV.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const stateFile = path.join(extensionDir, "atel-state.json");
const stateDocVersion = "1";
let pluginVersion = "0.0.0";
try {
  pluginVersion = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8")).version || "0.0.0";
} catch { /* fine */ }
const atelState = {
  v: stateDocVersion,
  name: agentName,
  capabilities: capabilitiesArr,
  installedAt: new Date().toISOString(),
  installedVersion: pluginVersion,
};
fs.writeFileSync(stateFile + ".tmp", JSON.stringify(atelState, null, 2));
fs.renameSync(stateFile + ".tmp", stateFile);

// Backward-compat: also write the legacy .txt files so older setup.js
// (in installs that haven't been upgraded) can still find them. New
// setup.js reads atel-state.json first and falls back to .txt only if
// the JSON file is missing.
fs.writeFileSync(path.join(extensionDir, "agent-name.txt"), agentName + "\n", "utf8");
if (capabilitiesArr.length) {
  fs.writeFileSync(path.join(extensionDir, "agent-capabilities.txt"), capabilitiesArr.join(",") + "\n", "utf8");
}

// SKILL.md — bundled with the plugin under skills/atel-agent/SKILL.md.
// OpenClaw discovers skills by scanning <openclawHome>/workspace/skills/*/SKILL.md
// at gateway start. Without this file the LLM has no idea the atel_mcp
// tool exists and silently falls back to `exec atel ...` (SDK CLI). Since
// "MCP-only" is the whole point, copying it into the workspace at install
// time is mandatory. We mirror, not symlink: openclaw's skill loader has
// historically had trouble with symlinks across npm-upgrade cycles.
const skillSrcPath = path.join(extensionDir, "skills", "atel-agent", "SKILL.md");
if (fs.existsSync(skillSrcPath)) {
  const skillDestDir = path.join(openclawHome, "workspace", "skills", "atel-agent");
  fs.mkdirSync(skillDestDir, { recursive: true });
  fs.copyFileSync(skillSrcPath, path.join(skillDestDir, "SKILL.md"));
  console.log(`SKILL.md installed → ${skillDestDir}/SKILL.md`);
} else {
  console.error(`warn: SKILL.md missing in plugin source (${skillSrcPath}). Agent will not know how to use atel_mcp.`);
}

// User TG chat id for listener-driven card dispatch (also persisted in
// atel-state.json above).
const tgChat = valueOf("--tg-chat") || process.env.ATEL_USER_TG_CHAT || "";
if (tgChat) {
  // Re-read state and merge tgChat (we wrote it above without tgChat
  // because we hadn't checked for the flag yet)
  const cur = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  cur.tgChat = tgChat;
  fs.writeFileSync(stateFile + ".tmp", JSON.stringify(cur, null, 2));
  fs.renameSync(stateFile + ".tmp", stateFile);
  fs.writeFileSync(path.join(extensionDir, "tg-chat.txt"), tgChat + "\n", "utf8"); // legacy fallback
}
config.plugins.installs[PLUGIN_ID] = {
  source: "npm",
  spec: "atel-mcp-openclaw",
  installPath: extensionDir,
  version: "0.2.1",
  resolvedName: "atel-mcp-openclaw",
  resolvedVersion: "0.2.1",
  resolvedSpec: "atel-mcp-openclaw@0.2.1",
  installedAt: new Date().toISOString()
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

// We DON'T run `openclaw doctor` here. Reasons:
//   1. doctor spawns a detached `openclaw` helper that survives after our
//      process exits — it grabs Telegram getUpdates polling and starves
//      the real gateway, exactly the bug user hit on 2026-05-07
//   2. doctor surfaces unrelated config drift (e.g. core OpenClaw schema
//      changes in channels.telegram.streaming) that has nothing to do
//      with our plugin install
//   3. our changes here are strictly additive, validated by the gateway
//      itself when it starts; if there's a real config issue, gateway
//      restart will surface it cleanly.
// Operator can still run `openclaw doctor` manually if they want a
// holistic config check.

if (!has("--no-restart")) {
  // Restart in 5 seconds, detached, so install.js can finish first.
  // Reason: when an OpenClaw agent triggers the install via its `exec`
  // tool, the agent runs INSIDE the gateway. A synchronous restart kills
  // the agent mid-turn before it can relay the install summary back to
  // TG — the user sees the bot go silent and assumes failure even though
  // install actually succeeded.
  //
  // 5s is empirically enough for: install.js → exit → agent receives
  // exec result → agent generates final TG message → TG send queued.
  // Then gateway dies + respawns; TG message arrives ~the same moment.
  try {
    const { spawn } = await import("node:child_process");
    spawn("sh", [
      "-c",
      "sleep 5 && systemctl --user restart openclaw-gateway.service",
    ], {
      detached: true,
      stdio: "ignore",
    }).unref();
    console.log("(gateway will restart in 5 seconds — pause to let install summary reach the chat first)");
  } catch {
    console.error("warn: could not schedule openclaw-gateway restart; run manually: systemctl --user restart openclaw-gateway");
  }
}

// (cron registration via direct jobs.json write — no gateway WS dependency.
// History: tried `openclaw cron list/add` CLI, but those go through the
// gateway WS RPC, which (a) races with our detached restart, and (b) gets
// blocked when an unrelated config schema drift makes the gateway refuse
// RPC calls until the user fixes the config. Direct file write is robust
// against both: gateway loads jobs.json on next start regardless.)

// Cron message — runs every 30s. Goals:
//   (1) Token-frugal: ATEL tool catalog already in scope; this prompt is
//       the per-tick instruction layer.
//   (2) NO_REPLY sentinel must be the ONLY content for OpenClaw runner
//       to suppress delivery — verified in cron-jobs.md "If the isolated
//       run returns only the silent token (NO_REPLY / no_reply), OpenClaw
//       suppresses direct outbound delivery". So agent must reply EXACTLY
//       `NO_REPLY` (no narration, no prefix) when nothing actionable.
//   (3) When acting, the final reply IS the user's TG card; format must
//       match atel-tg-bot's canonical layout (see relay-poller.ts) so
//       OpenClaw-MCP path UX is indistinguishable from official bot.
// Prompt design notes:
// - Pure action prompt. Notification cards to TG are handled by
//   src/tg-dispatch.js on the listener side (deterministic, runs on
//   every platform push). The agent's only job is state mutation:
//   accept order, approve plan, submit milestone, verify milestone.
// - cron delivery.mode is "none" — assistant text never reaches TG.
//   So narration is harmless but still discouraged for token cost.
// - State-driven (not event-driven) so progress continues even when
//   events were missed (consumed by an earlier tick or lost on restart).
const CRON_MESSAGE = [
  "You are an ATEL agent. The plugin listener handles all user-facing TG notifications — your job is purely state mutation. Your assistant text is NOT delivered anywhere. Reply NO_REPLY or anything terse; nobody sees it.",
  "",
  "Each tick:",
  "",
  "1. atel_mcp action=poll_events (drains pending events; primarily for ack).",
  "",
  "2. Sweep your active orders for action work:",
  "",
  "   A. atel_mcp action=call tool=atel_order_list args={\"role\":\"executor\",\"status\":\"created\"}",
  "      For each order: atel_mcp action=call tool=atel_order_accept args={\"orderId\":\"<orderId>\"}.",
  "",
  "   B. atel_mcp action=call tool=atel_order_list args={\"role\":\"executor\",\"status\":\"milestone_review\"}",
  "      Then again with {\"role\":\"requester\",\"status\":\"milestone_review\"}.",
  "      For each unique order: atel_mcp action=call tool=atel_milestone_plan_feedback args={\"orderId\":\"<orderId>\",\"approved\":true}.",
  "",
  "   C. atel_mcp action=call tool=atel_order_list args={\"role\":\"executor\",\"status\":\"executing\"}",
  "      For each order: atel_mcp action=call tool=atel_milestone_list args={\"orderId\":\"<orderId>\"}. Find the LOWEST milestone with status=\"draft\". If found:",
  "        - Read milestones[M].title and atel_mcp action=call tool=atel_order_get args={\"orderId\":\"<orderId>\"} for the order description.",
  "        - WRITE THE ACTUAL DELIVERABLE TEXT in the language the order asks for. Real content. Not \"TBD\", not placeholder.",
  "        - atel_mcp action=call tool=atel_milestone_submit args={\"orderId\":\"<orderId>\",\"index\":<M>,\"content\":\"<your deliverable>\"}.",
  "",
  "   D. atel_mcp action=call tool=atel_order_list args={\"role\":\"requester\",\"status\":\"executing\"}",
  "      For each order: atel_milestone_list. For each milestone with status=\"submitted\":",
  "        - Read result_summary. If length >= 10 chars and clearly relates to the order description: atel_mcp action=call tool=atel_milestone_verify args={\"orderId\":\"<orderId>\",\"index\":<N>}.",
  "        - If empty or wholly unrelated: atel_milestone_reject args={\"orderId\":\"<orderId>\",\"index\":<N>,\"content\":\"<short reason>\"}.",
  "",
  "3. Reply NO_REPLY (or anything; not delivered).",
  "",
  "Rules:",
  "- Never invent a milestone index that doesn't appear in atel_milestone_list output.",
  "- args is a JSON string (action=call tool=<name> args=<json>).",
  "- Take real action, don't simulate. Tool results are ground truth."
].join("\n");

if (!has("--no-cron")) {
  const intervalSec = Number(process.env.ATEL_RELAY_CRON_INTERVAL_SEC || 30);
  const cronName = "atel-mcp-poll";
  const cronDir = path.join(openclawHome, "cron");
  const cronFile = path.join(cronDir, "jobs.json");
  fs.mkdirSync(cronDir, { recursive: true });

  let store = { jobs: [] };
  if (fs.existsSync(cronFile)) {
    try { store = JSON.parse(fs.readFileSync(cronFile, "utf8")); } catch { store = { jobs: [] }; }
    if (!Array.isArray(store.jobs)) store.jobs = [];
  }

  // Find existing entry by name and preserve its id/state to avoid losing
  // run history. Update message if drifted.
  const existingIdx = store.jobs.findIndex((j) => j?.name === cronName);
  const existing = existingIdx >= 0 ? store.jobs[existingIdx] : null;

  const nowMs = Date.now();
  const job = {
    id: existing?.id || randomUUID(),
    name: cronName,
    enabled: true,
    createdAtMs: existing?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: intervalSec * 1000, anchorMs: existing?.schedule?.anchorMs || nowMs },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: CRON_MESSAGE, lightContext: true },
    delivery: { mode: "none", channel: "last", bestEffort: true },
    state: existing?.state || { nextRunAtMs: nowMs + intervalSec * 1000 },
  };

  if (existingIdx >= 0) store.jobs[existingIdx] = job;
  else store.jobs.push(job);

  // Atomic write: tmp + rename (fs.writeFileSync rename is on most fs)
  const tmpFile = cronFile + ".tmp-" + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, cronFile);
  console.log(`cron job '${cronName}' ${existing ? "updated" : "registered"} in ${cronFile} (every ${intervalSec}s, delivery=none)`);
}

// Onboarding summary — friendlier than the old debug dump. Reads back
// the now-active identity + the bot username so the operator knows the
// exact next step. Bot username discovery is best-effort (we resolve via
// Telegram getMe when openclaw config has a bot token); silently skipped
// in headless / no-TG setups so the install still ends "clean".
let identityDID = "";
try {
  identityDID = JSON.parse(fs.readFileSync(resolvedIdentityPath, "utf8")).did;
} catch { /* nothing useful */ }
let botUsername = "";
try {
  const ocCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  // Walk for any `botToken` value (channels.* or telegram.*). Resolve
  // ${VAR} placeholders against process.env so .env-loaded tokens work.
  const stack = [ocCfg];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (typeof cur.botToken === "string" && cur.botToken) {
      let tok = cur.botToken;
      const m = tok.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
      if (m) tok = process.env[m[1]] || "";
      if (tok && /^\d+:/.test(tok)) {
        const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          if (j?.result?.username) { botUsername = j.result.username; break; }
        }
      }
    }
    for (const v of Object.values(cur)) if (v && typeof v === "object") stack.push(v);
  }
} catch { /* skip */ }

console.log("");
console.log("=================================================================");
console.log(`✅ ATEL agent '${agentName}' is installed and registering.`);
console.log("");
console.log(`   DID:      ${identityDID || "(unreadable; check " + resolvedIdentityPath + ")"}`);
if (capabilitiesCSV) console.log(`   Capabilities: ${capabilitiesCSV}`);
console.log(`   Platform: ${platformBaseUrl}`);
console.log("");
console.log("Next steps:");
if (botUsername) {
  console.log(`   1. Open Telegram and send any message to @${botUsername} (binds your chat for event cards).`);
} else {
  console.log("   1. Open the Telegram bot bound to this OpenClaw runtime and send any message");
  console.log("      (binds your chat so platform push events become TG cards).");
}
console.log("   2. Check registration:  curl '" + platformBaseUrl + "/registry/v1/agent/" + (identityDID || "<your-did>") + "'");
console.log("   3. Send a natural-language order request, e.g.: \"找 someone 帮我做 X，预算 0.001 USDC\"");
console.log("=================================================================");
console.log("");
console.log(`(debug: config=${configPath}  backup=${backup}  extension=${extensionDir})`);
