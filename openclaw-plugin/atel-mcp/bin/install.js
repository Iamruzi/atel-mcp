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
  // Plan 2: install owns user-facing failure notification. emergencyFinalize
  // is a function declaration referenced by hoisting via const-style
  // assignment below — it may not be defined yet at the very first die()
  // call (config-missing line ~207 runs after helpers, so this is fine in
  // practice; guard with try/catch in case of refactor regressions).
  try {
    if (typeof sendTelegramCardSync === "function") {
      sendTelegramCardSync(
        `❌ ATEL 注册失败\n` +
        `\n` +
        `<code>${String(message).slice(0, 500)}</code>\n` +
        `\n` +
        `稍后重试同样的注册命令即可。多次失败请把错误发给管理员。`
      );
    }
  } catch {}
  try { if (typeof clearInProgressSync === "function") clearInProgressSync(); } catch {}
  process.exit(1);
}
function firstFile(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
}

// Detect whether the local OpenClaw runtime supports the `mcp.servers`
// config key (introduced in 2026.5.x). Older runtimes (2026.2.25,
// 2026.3.13 verified) hard-reject the whole openclaw.json with
// "Unrecognized key: mcp" at gateway start, which is much worse than
// just not having the native MCP path — it kills the gateway entirely.
//
// Subtlety: when this script runs under `npx atel-mcp-openclaw@<v>`,
// npx may install openclaw (peerDep with a wide range) into its own
// temp dir and prepend that dir's node_modules/.bin to PATH. A naive
// `openclaw --version` in that subprocess hits the npx-local copy
// (e.g. 2026.5.7) instead of the user's runtime (e.g. 2026.2.25),
// which gives a false "supported" answer and writes a config the
// real gateway will reject.
//
// So we resolve the runtime version the same way the gateway does:
//   1. Read `npm root -g`, look for openclaw/package.json there.
//   2. Fall back to `openclaw --version` but with our npx-local bin
//      and any node_modules/.bin pruned from PATH.
//
// Override: ATEL_FORCE_MCP_SERVERS=1 forces the supported path (for
// development / patched builds whose version string doesn't match).
const MIN_MCP_SERVERS_VERSION = { year: 2026, month: 5 };
function detectMcpServersSupport() {
  if (process.env.ATEL_FORCE_MCP_SERVERS === "1") {
    return { supported: true, version: "forced", reason: "ATEL_FORCE_MCP_SERVERS=1" };
  }

  let version = "";
  let probedFrom = "";

  // 1. Resolve via global npm root — this is where the gateway lives
  //    (verified on 龙虾甲/乙: gateway uses /usr/lib/node_modules/openclaw,
  //    which is exactly `npm root -g`).
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).toString().trim();
    const pjPath = path.join(npmRoot, "openclaw", "package.json");
    if (fs.existsSync(pjPath)) {
      const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
      if (pj.version) {
        version = pj.version;
        probedFrom = pjPath;
      }
    }
  } catch { /* fall through to PATH lookup */ }

  // 2. Fallback: spawn openclaw with PATH stripped of npx and local
  //    node_modules/.bin — those would shadow the global runtime
  //    binary inside an npx subprocess.
  if (!version) {
    try {
      const cleanPath = (process.env.PATH || "")
        .split(path.delimiter)
        .filter((p) => !p.includes("/.npm/_npx/") && !p.endsWith("/node_modules/.bin"))
        .join(path.delimiter);
      const raw = execFileSync("openclaw", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        env: { ...process.env, PATH: cleanPath },
      }).toString().trim();
      const m = raw.match(/(\d{4})\.(\d{1,2})(?:\.(\d{1,3}))?/);
      if (m) {
        version = m[3] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`;
        probedFrom = "PATH (npx-bin pruned)";
      }
    } catch (err) {
      return { supported: false, version: "", reason: `cannot resolve runtime openclaw: ${err && err.message ? err.message.split("\n")[0] : err}` };
    }
  }

  if (!version) {
    return { supported: false, version: "", reason: "openclaw runtime version unknown" };
  }

  const m = version.match(/(\d{4})\.(\d{1,2})/);
  if (!m) return { supported: false, version, reason: `cannot parse "${version}"` };
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const supported =
    year > MIN_MCP_SERVERS_VERSION.year ||
    (year === MIN_MCP_SERVERS_VERSION.year && month >= MIN_MCP_SERVERS_VERSION.month);
  return {
    supported,
    version,
    reason: supported
      ? `>= ${MIN_MCP_SERVERS_VERSION.year}.${MIN_MCP_SERVERS_VERSION.month} (from ${probedFrom})`
      : `< ${MIN_MCP_SERVERS_VERSION.year}.${MIN_MCP_SERVERS_VERSION.month} (from ${probedFrom})`,
  };
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
// 2026-05-11: tester report 4.3 — Ubuntu user had identity at
// `/home/ubuntu/atel-workspace/.atel/identity.json` but firstFile() returned
// null because the candidate list missed this canonical SDK workspace path
// under $HOME. dashboard_auth then failed because plugin config wrote
// identityPath as undefined / empty object. Now we both (1) add the path
// to the candidate list and (2) supply a fallback default so we never end
// up with a missing identityPath in plugin config.
const identityPath = valueOf("--identity") || process.env.ATEL_IDENTITY_PATH || firstFile([
  path.join(process.cwd(), ".atel", "identity.json"),
  path.join(home, ".atel", "identity.json"),
  path.join(home, "atel-workspace", ".atel", "identity.json"),
  path.join(openclawHome, "workspace", ".atel", "identity.json"),
  path.join(openclawHome, "workspace", "atel-sdk", ".atel", "identity.json"),
]) || path.join(home, "atel-workspace", ".atel", "identity.json");
const serverBaseUrl = valueOf("--server") || process.env.ATEL_MCP_SERVER_BASE_URL || "https://atelai.xyz";
const platformBaseUrl = valueOf("--platform") || process.env.ATEL_PLATFORM_BASE_URL || "https://api.atelai.xyz";

// ---- Plan 2 (2026-05-12): in-progress marker + direct TG completion ----
// The host LLM is taken out of the 60-120s install loop. bootstrap.sh writes
// the marker as its first action; this script keeps it fresh while running,
// and removes it (plus pushes a TG card to the user) on success OR failure.
// plugin/poll_events short-circuits while the marker exists so the LLM
// never wakes inside the install window and cannot hallucinate progress.
const inProgressMarker = path.join(openclawHome, ".atel-install-in-progress");
function writeInProgress(stage, extra) {
  try {
    fs.mkdirSync(openclawHome, { recursive: true });
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(inProgressMarker, "utf8")); } catch {}
    const next = {
      ...cur,
      started_at: cur.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pid: process.pid,
      stage,
      ...(extra || {}),
    };
    const tmp = inProgressMarker + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, inProgressMarker);
  } catch (e) {
    console.warn(`[atel-mcp/install] cannot update ${inProgressMarker}: ${e.message}`);
  }
}
function clearInProgressSync() {
  try { fs.unlinkSync(inProgressMarker); } catch {}
}

// Walk openclaw.json for any `botToken` value, resolving ${VAR} placeholders.
function resolveBotToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const stack = [cfg];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (typeof cur.botToken === "string" && cur.botToken) {
        let tok = cur.botToken;
        const m = tok.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
        if (m) tok = process.env[m[1]] || "";
        if (tok && /^\d+:/.test(tok)) return tok;
      }
      for (const v of Object.values(cur)) if (v && typeof v === "object") stack.push(v);
    }
  } catch {}
  return "";
}

// Resolve target TG chat id for the install card. Order:
//   1. --tg-chat-id / --tg-chat CLI arg
//   2. ATEL_USER_TG_CHAT env var
//   3. tg_chat_id seeded into the marker by bootstrap.sh
function resolveTgChatId() {
  const fromArg = valueOf("--tg-chat-id") || valueOf("--tg-chat");
  if (fromArg) return String(fromArg);
  if (process.env.ATEL_USER_TG_CHAT) return String(process.env.ATEL_USER_TG_CHAT);
  try {
    const m = JSON.parse(fs.readFileSync(inProgressMarker, "utf8"));
    if (m && m.tg_chat_id) return String(m.tg_chat_id);
  } catch {}
  return "";
}

// Synchronous TG card push via curl. We use sync to keep die() simple and
// guarantee delivery before process.exit. Failures are logged but do not
// block exit — stdout still has the same info for the operator.
function sendTelegramCardSync(text) {
  const token = resolveBotToken();
  const chatId = resolveTgChatId();
  if (!token || !chatId) {
    console.warn(`[atel-mcp/install] TG card not sent (token=${token ? "ok" : "missing"} chat=${chatId || "missing"})`);
    return false;
  }
  try {
    execFileSync("curl", [
      "-fsS", "-X", "POST",
      `https://api.telegram.org/bot${token}/sendMessage`,
      "-H", "content-type: application/json",
      "--data", JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    ], { stdio: ["ignore", "ignore", "ignore"], timeout: 8000 });
    return true;
  } catch (e) {
    console.warn(`[atel-mcp/install] TG sendMessage failed: ${e.message}`);
    return false;
  }
}

// Best-effort gateway restart so the LLM sees the freshly registered
// mcp.servers.atel tools in its next turn. Try user-level systemd, system
// systemd, then pm2 — first success wins.
function restartGatewayBestEffort() {
  for (const [bin, argv] of [
    ["systemctl", ["--user", "restart", "openclaw-gateway"]],
    ["systemctl", ["restart", "openclaw-gateway"]],
    ["pm2", ["restart", "openclaw-gateway"]],
  ]) {
    try {
      execFileSync(bin, argv, { stdio: "ignore", timeout: 10000 });
      console.log(`[atel-mcp/install] restarted gateway via ${bin} ${argv.join(" ")}`);
      return true;
    } catch {}
  }
  console.warn("[atel-mcp/install] could not restart openclaw-gateway via systemctl/pm2 — operator must restart manually");
  return false;
}

// Crash-net: any uncaught error pushes the failure card and clears marker.
// Without this, an exception in npm install / fetch / config parse would
// leave the marker stuck and never tell the user anything went wrong.
function emergencyFinalize(label, err) {
  const msg = err && err.message ? err.message : String(err || "unknown");
  console.error(`[atel-mcp/install] ${label}: ${msg}`);
  try {
    sendTelegramCardSync(
      `❌ ATEL 注册失败\n` +
      `\n` +
      `阶段: <code>${label}</code>\n` +
      `错误: <code>${msg.slice(0, 500)}</code>\n` +
      `\n` +
      `稍后重试同样的注册命令即可。多次失败请把错误发给管理员。`
    );
  } catch {}
  clearInProgressSync();
}
// Only attach the handlers + write the marker for the install path. wash
// and upload-seed subcommands must NOT touch the marker (wash explicitly
// undoes state, upload-seed is independent). They also don't push TG
// cards because there's no user-facing onboarding event to report.
const isInstallRun = !subcommand;
if (isInstallRun) {
  process.on("uncaughtException", (err) => { emergencyFinalize("uncaughtException", err); process.exit(1); });
  process.on("unhandledRejection", (err) => { emergencyFinalize("unhandledRejection", err); process.exit(1); });
  // First marker write — picks up the JSON that bootstrap.sh seeded if it
  // exists, augments with pid + stage. Idempotent re-entry.
  writeInProgress("install.js:starting");
}

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
// Read existing atel-state.json so re-install without --name preserves
// the operator's chosen name. Without this, "npx atel-mcp-openclaw" with
// no --name silently rewrote the agent display to hostname-based junk
// like "agent-VM-0-13-ubuntu" — and the platform's UPDATE then accepted
// it because the new value was a real string (fix 1's atel-agent-only
// guard didn't catch it). Empty / placeholder ("atel-agent") values are
// ignored so this only preserves *intentional* names.
const existingStateName = (() => {
  try {
    const sf = path.join(extensionsDir, "atel-mcp-openclaw", "atel-state.json");
    if (!fs.existsSync(sf)) return "";
    const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
    const n = (cur?.name || "").trim();
    if (n && n !== "atel-agent") return n;
  } catch {}
  return "";
})();
const agentName = (
  valueOf("--name")
  || process.env.ATEL_AGENT_NAME
  || existingStateName
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
  //    so they release Telegram getUpdates / file locks. Also stop +
  //    disable the dedicated listener unit so the next install starts
  //    from clean state (we'll rewrite + re-enable it).
  try { execFileSync("systemctl", ["--user", "stop", "atel-mcp-listener.service"], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["--user", "disable", "atel-mcp-listener.service"], { stdio: "ignore" }); } catch {}
  try { fs.rmSync(path.join(home, ".config", "systemd", "user", "atel-mcp-listener.service"), { force: true }); } catch {}
  try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["--user", "stop", "openclaw-gateway"], { stdio: "ignore" }); } catch {}
  for (const pat of ["openclaw-cron", "node bin/install.js", "atel-listener-main"]) {
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
    // Plan 2 marker — wash should leave the system in a clean state, no
    // stale install marker that would short-circuit poll_events later.
    path.join(openclawHome, ".atel-install-in-progress"),
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

// Robust dir nuke. fs.rmSync chokes with ENOTEMPTY on deeply nested
// node_modules paths (verified 2026-05-12 on racknerd vps with the
// @mariozechner/pi-coding-agent/examples/extensions tree). Cascade
// through fs.rmSync (with retries) → shell `rm -rf` → `find -depth
// -delete`. The shell tools succeed in cases node's rimraf gives up.
function nukeDir(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (!fs.existsSync(dir)) return;
  } catch (e) {
    console.warn(`[atel-mcp/install] fs.rmSync ${dir} failed (${e.code || e.message}); falling back to rm -rf`);
  }
  try {
    execFileSync("rm", ["-rf", dir], { stdio: "ignore" });
    if (!fs.existsSync(dir)) return;
  } catch (e) {
    console.warn(`[atel-mcp/install] rm -rf failed (${e.message}); falling back to find -depth -delete`);
  }
  try {
    execFileSync("find", [dir, "-depth", "-delete"], { stdio: "ignore" });
  } catch (e) {
    console.warn(`[atel-mcp/install] find -delete also failed: ${e.message}`);
  }
}

// Concurrency lock. Reason: bootstrap.sh launches `npx -y` in a detached
// background process. If the LLM panics on a transient output and re-runs
// bootstrap (or the user reruns), multiple `npm install` processes hit
// the same extensionDir, stomp each other's node_modules tree, and
// produce ENOTEMPTY everywhere. The lock detects an in-progress install
// and aborts cleanly so the LLM gets a clear "another install is
// running" signal instead of corrupting fs.
const lockPath = path.join(extensionsDir, ".atel-mcp-install.lock");
function acquireLock() {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      let stalePid = -1;
      try { stalePid = parseInt(fs.readFileSync(lockPath, "utf8"), 10); } catch {}
      let alive = false;
      if (stalePid > 0) {
        try { process.kill(stalePid, 0); alive = true; } catch {}
      }
      if (alive) {
        console.error(`[atel-mcp/install] another install is in progress (pid=${stalePid}); aborting to avoid fs corruption. If you believe this is stuck, run: rm ${lockPath}`);
        process.exit(2);
      }
      console.warn(`[atel-mcp/install] stale lock from dead pid=${stalePid}; clearing`);
      try { fs.unlinkSync(lockPath); } catch {}
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    } else { throw e; }
  }
  const cleanup = () => { try { fs.unlinkSync(lockPath); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}
acquireLock();

const backup = `${configPath}.bak-atel-mcp-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
fs.copyFileSync(configPath, backup);
nukeDir(extensionDir);
if (fs.existsSync(legacyExtensionDir)) {
  nukeDir(legacyExtensionDir);
}
fs.cpSync(packageRoot, extensionDir, { recursive: true });

// npm install with one retry. First-attempt failures are almost always
// ENOTEMPTY from a half-extracted extensionDir (npm's own rimraf hits
// the same nested-dir issue). We nuke + recopy + retry once. If both
// fail, die with an actionable hint pointing the operator at the exact
// commands to recover by hand.
function runNpmInstall() {
  try {
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: extensionDir,
      stdio: "inherit",
    });
    return;
  } catch (firstError) {
    console.warn(`[atel-mcp/install] first npm install attempt failed (${firstError.message}); cleaning extensionDir + retrying once`);
  }
  nukeDir(extensionDir);
  fs.cpSync(packageRoot, extensionDir, { recursive: true });
  try {
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: extensionDir,
      stdio: "inherit",
    });
  } catch (secondError) {
    die(`npm install failed twice (final: ${secondError.message}). Recovery: rm -rf ${extensionDir} ~/.npm/_cacache && npx -y atel-mcp-openclaw@latest ...`);
  }
}
runNpmInstall();

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
// 2026-05-13: also accept --tg-chat-id (bootstrap.sh's canonical flag
// since Plan 2). Earlier code only read --tg-chat which left
// atel-state.json.tgChat empty on every bootstrap-driven install, falling
// back to sessions.json-derived chat ids — fragile when the user switches
// TG accounts. Both forms are accepted; --tg-chat-id wins if both passed.
const tgChat = valueOf("--tg-chat-id") || valueOf("--tg-chat") || process.env.ATEL_USER_TG_CHAT || "";
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
// 0.6.15: Configure ATEL as an OpenClaw native MCP server (mcp.servers.atel).
// This bypasses the OpenClaw plugin tool registration path (which silently
// drops atel_mcp tool because OpenClaw's installs.json cache doesn't
// persist contracts.tools — verified empirically). With mcp.servers, the
// LLM sees atel_whoami / atel_balance / atel_milestone_submit / etc. as
// first-class tools (prefixed `atel__atel_whoami` in OpenClaw's view) and
// invokes them via streamable-http transport. No exec hack, no contract
// dance, no OpenClaw plugin loader compatibility surprises.
//
// JWT is fetched from platform /auth/v1/did-sig at install time (7d TTL
// from platform; user re-installs after expiry to refresh).
//
// 0.6.18 R12: gate on OpenClaw version. mcp.servers config schema landed
// in OpenClaw 2026.5.x. Older runtimes (verified: 2026.2.25 龙虾乙,
// 2026.3.13 龙虾甲) reject the whole config with "Unrecognized key: mcp"
// at gateway start, which silently breaks every downstream tool path.
// Detect via `openclaw --version` and skip mcp.servers write on older
// versions; plugin still works via the legacy cron+tool path on those.
const mcpServersSupport = detectMcpServersSupport();
if (!mcpServersSupport.supported) {
  // Strip any pre-existing mcp.servers.atel that a previous install
  // (or a manual edit, or a same-machine OpenClaw downgrade) may have
  // left behind. Without this, the older runtime would still hit
  // "Unrecognized key: mcp" on next gateway start, defeating the
  // whole point of the version gate.
  let stripped = false;
  if (config.mcp?.servers?.atel) {
    delete config.mcp.servers.atel;
    stripped = true;
  }
  if (config.mcp?.servers && Object.keys(config.mcp.servers).length === 0) {
    delete config.mcp.servers;
  }
  if (config.mcp && Object.keys(config.mcp).length === 0) {
    delete config.mcp;
  }
  console.log(`Skipping mcp.servers.atel write — OpenClaw ${mcpServersSupport.version || "version unknown"} does not support mcp.servers (need >= 2026.5.0). Plugin will use cron + tool path. Reason: ${mcpServersSupport.reason}${stripped ? " (stripped stale mcp.servers.atel from existing config)" : ""}`);
} else try {
  const idJson = JSON.parse(fs.readFileSync(resolvedIdentityPath, "utf8"));
  const skRaw = idJson.secretKey;
  const sk = /^[0-9a-fA-F]+$/.test(skRaw) ? Buffer.from(skRaw, "hex") : Buffer.from(skRaw, "base64");
  const naclMod = await import(path.join(extensionDir, "node_modules", "tweetnacl", "nacl.js"));
  const nacl = naclMod.default ?? naclMod;
  const sortKeys = (o) => JSON.stringify(o, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) {
      const s = {};
      for (const k of Object.keys(v).sort()) s[k] = v[k];
      return s;
    }
    return v;
  });
  const ts = new Date().toISOString();
  const tokPayload = { scopes: [
    "identity.read", "wallet.read", "wallet.transfer", "wallet.withdraw",
    "contacts.read", "contacts.write", "messages.read", "messages.write",
    "orders.read", "orders.write", "milestones.read", "milestones.write",
    "a2b.read", "a2b.write", "disputes.read", "disputes.write", "audit.read"
  ]};
  const signable = sortKeys({ payload: tokPayload, did: idJson.did, timestamp: ts });
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(signable), sk)).toString("base64");
  const envBody = JSON.stringify({ did: idJson.did, payload: tokPayload, timestamp: ts, signature: sig });
  const tokRes = await fetch(`${platformBaseUrl.replace(/\/+$/, "")}/auth/v1/did-sig`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: envBody,
  });
  const tokData = await tokRes.json();
  if (tokData?.token) {
    config.mcp = config.mcp || {};
    config.mcp.servers = config.mcp.servers || {};
    config.mcp.servers.atel = {
      url: `${serverBaseUrl.replace(/\/+$/, "")}/mcp`,
      transport: "streamable-http",
      headers: { Authorization: `Bearer ${tokData.token}` },
    };
    console.log(`mcp.servers.atel configured — LLM will see ATEL tools (atel__atel_whoami etc.) via OpenClaw native MCP transport (token expires ${new Date((tokData.expiresAt || 0) * 1000).toISOString()})`);
  } else {
    console.warn(`warn: did-sig token fetch returned no token (${JSON.stringify(tokData).slice(0, 200)}). Skipping mcp.servers.atel; LLM will fall back to plugin/exec-hack path.`);
  }
} catch (err) {
  console.warn(`warn: failed to configure mcp.servers.atel: ${err && err.message}. Plugin still works via cron + tool path; LLM may not see atel_xxx tools directly.`);
}

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

// ─── Listener as a dedicated systemd --user unit ─────────────────────
//
// Why dedicated unit instead of in-process startListener() inside the
// gateway register() hook (the 0.4/0.5 design):
//   * In-process bind silently swallows EADDRINUSE on every gateway
//     restart, leaving the lobster in pull mode with no operator signal.
//   * Listener died with the gateway — any gateway crash window meant
//     pushes were lost.
//   * Multiple plugin generations (gateway fork + agent forks) raced for
//     port 3101.
// A standalone systemd --user unit fixes all three: own crash domain
// with Restart=always, observable via `systemctl --user status`, and
// decoupled from gateway lifecycle. SDK + official-bot users had this
// equivalent (long-running poller process) — MCP path now matches.
function detectTelegramBotToken() {
  // OpenClaw's openclaw.json stores `${TELEGRAM_BOT_TOKEN}` as a
  // placeholder; the real token sits in env (loaded by gateway from
  // ~/.bashrc on its systemd start) OR in OpenClaw's secret store. We
  // try env first (cheapest), then a couple of known on-disk locations.
  const envTok = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (envTok && /^\d{8,}:[A-Za-z0-9_-]{30,}$/.test(envTok)) return envTok;
  // Scan ~/.bashrc and openclaw home for a TG-shaped token. The pattern
  // is bot-id (8-12 digits) + colon + 30+ chars of base64url. False
  // positives are negligible at that length.
  const candidates = [
    path.join(home, ".bashrc"),
    path.join(home, ".profile"),
    path.join(home, ".bash_profile"),
    path.join(openclawHome, ".env"),       // canonical OpenClaw env file
    path.join(openclawHome, "openclaw.json"),
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const body = fs.readFileSync(c, "utf8");
      const m = body.match(/\b(\d{8,12}:[A-Za-z0-9_-]{30,})\b/);
      if (m) return m[1];
    } catch {}
  }
  return "";
}
const SYSTEMD_USER_DIR = path.join(home, ".config", "systemd", "user");
const SYSTEMD_UNIT_FILE = path.join(SYSTEMD_USER_DIR, "atel-mcp-listener.service");
try {
  fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  fs.mkdirSync(path.join(openclawHome, "logs"), { recursive: true });
  const nodeBin = process.execPath;
  const listenerEntry = path.join(extensionDir, "src", "listener-main.js");
  const tgToken = detectTelegramBotToken();
  const tgEnvLine = tgToken ? `Environment=TELEGRAM_BOT_TOKEN=${tgToken}\n` : "";
  if (!tgToken) {
    console.warn("warn: TELEGRAM_BOT_TOKEN not auto-detected. Add `Environment=TELEGRAM_BOT_TOKEN=<your-token>` to ~/.config/systemd/user/atel-mcp-listener.service if push notifications stay silent.");
  }
  const unitText = `[Unit]
Description=ATEL MCP plugin listener (platform push receiver)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${extensionDir}
Environment=ATEL_PLATFORM_BASE_URL=${platformBaseUrl}
Environment=ATEL_IDENTITY_PATH=${identityPath}
${tgEnvLine}ExecStart=${nodeBin} ${listenerEntry}
Restart=always
RestartSec=3
StandardOutput=append:${path.join(openclawHome, "logs", "atel-mcp-listener.log")}
StandardError=append:${path.join(openclawHome, "logs", "atel-mcp-listener.log")}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(SYSTEMD_UNIT_FILE, unitText);
  // Free the port before (re)starting in case a stale 0.4/0.5 in-process
  // listener still holds 3101 — otherwise systemd's start fails with
  // EADDRINUSE and silently retries forever.
  try { execFileSync("fuser", ["-k", "-9", "-n", "tcp", "3101"], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["--user", "enable", "atel-mcp-listener.service"], { stdio: "ignore" }); } catch {}
  try { execFileSync("systemctl", ["--user", "restart", "atel-mcp-listener.service"], { stdio: "ignore" }); } catch (e) {
    console.warn(`warn: could not (re)start atel-mcp-listener.service: ${e && e.message}. Run manually: systemctl --user restart atel-mcp-listener`);
  }
  console.log(`atel-mcp-listener.service installed + enabled + started (logs: ~/.openclaw/logs/atel-mcp-listener.log)`);
} catch (e) {
  console.warn(`warn: could not install systemd listener unit: ${e && e.message}. Plugin still functional in pull mode but transfer_received / P2P chat cards won't dispatch to TG.`);
}

// Restart the gateway by default (0.6.10): new plugin code (especially
// register()-time tool registration like atel_mcp) is held in the gateway
// process's memory and is NOT picked up just by replacing files on disk.
// Skipping this restart caused 0.6.8/0.6.9-installed boxes to log
// "unknown method: atel_mcp" and the agent to silently NO_REPLY because
// the LLM tried calling a tool the running gateway hadn't loaded.
//
// Why not stay on the 0.6.8 default-off: cron message + SKILL.md DO
// reload from disk, but plugin tool registration only runs at
// gateway.register() time. Without restart, an upgrade silently leaves
// the agent half-working — old tool surface, new docs.
//
// Why 30s and not 5s: the original 5s window let the agent send its
// install summary card before SIGTERM, but if the agent was mid-LLM-turn
// (writing milestone content, etc.) 5s wasn't enough and SIGTERM cut it
// off. 30s covers a full LLM round trip + TG send. Anyone wanting the
// instant-restart behavior can pass `--restart-fast`. `--no-restart`
// still honored for headless/CI/test paths that manage gateway lifecycle
// themselves.
if (!has("--no-restart")) {
  const restartDelay = has("--restart-fast") ? 5 : 30;
  try {
    const { spawn } = await import("node:child_process");
    spawn("sh", [
      "-c",
      `sleep ${restartDelay} && systemctl --user restart openclaw-gateway.service`,
    ], {
      detached: true,
      stdio: "ignore",
    }).unref();
    console.log(`(gateway will restart in ${restartDelay}s so the new plugin code is actually loaded — pause is to let your current TG reply finish; pass --no-restart to skip, --restart-fast for 5s)`);
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
  "      For each order: atel_mcp action=call tool=atel_milestone_list args={\"orderId\":\"<orderId>\"}. Find the LOWEST milestone whose status is one of: \"draft\", \"pending\", \"rejected\". If found:",
  "        - Read milestones[M].title and atel_mcp action=call tool=atel_order_get args={\"orderId\":\"<orderId>\"} for the order description.",
  "        - If status is \"rejected\": read milestones[M].result_summary or the most recent milestone_rejected event in your inbox to see the reject reason, then fix what was wrong. NEVER resubmit the same content.",
  "        - WRITE THE ACTUAL DELIVERABLE TEXT in the language the order asks for. Real content. Not \"TBD\", not placeholder text, not \"I understand the requirement\". Reject reason \"Content is empty or placeholder\" means the platform's verifier saw filler — write substantive deliverable.",
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

// Plan 2 finalization: push success card to the user's TG chat directly,
// clear the in-progress marker, restart the gateway. After this point the
// host LLM is allowed to wake again (poll_events will start returning
// real data). We do this *after* the stdout summary so failures here
// don't lose the operator-visible info.
const successCard =
  `✅ ATEL 注册完成\n` +
  `\n` +
  `名称: <b>${agentName}</b>\n` +
  (capabilitiesCSV ? `能力: <code>${capabilitiesCSV}</code>\n` : "") +
  `DID: <code>${identityDID || "(待生成)"}</code>\n` +
  `Platform: ${platformBaseUrl}\n` +
  `\n` +
  `~30 秒内自动启用,可直接发自然语言命令(例:"查余额","找人帮我做 X").`;
sendTelegramCardSync(successCard);
restartGatewayBestEffort();
clearInProgressSync();
