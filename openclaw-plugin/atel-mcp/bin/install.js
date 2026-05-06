#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
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

if (!fs.existsSync(configPath)) die(`OpenClaw config not found: ${configPath}`);
if (!identityPath || !fs.existsSync(identityPath)) die("ATEL identity not found. Pass --identity /path/to/.atel/identity.json");

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
    identityPath,
    scopes: [
      "identity.read",
      "contacts.read",
      "messages.read",
      "messages.write",
      "orders.read",
      "orders.write",
      "milestones.read",
      "milestones.write",
      "audit.read"
    ]
  }
};
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

// Skip config validate — the CLI shape varies across OpenClaw releases
// (`config validate` vs `config validate <path>`), and our changes are
// strictly additive (one plugin entry + allowlist). Failure here would
// be a false negative on installs that ARE valid.
try {
  execFileSync("openclaw", ["doctor"], { stdio: "inherit" });
} catch {
  console.error("warn: openclaw doctor reported issues (non-fatal); review with `openclaw doctor` after install.");
}

if (!has("--no-restart")) {
  try {
    execFileSync("systemctl", ["--user", "restart", "openclaw-gateway.service"], { stdio: "inherit" });
  } catch {
    console.error("warn: could not restart openclaw-gateway.service; restart OpenClaw manually.");
  }
}

// Wait for the gateway socket to come back up. The cron CLI talks to the
// gateway via its UNIX/TCP RPC, so calling `openclaw cron list` immediately
// after a systemctl restart races the gateway boot and intermittently
// fails. We give it up to ~10s of grace, polling at 250ms intervals.
//
// Skipped if --no-restart is set (in which case the gateway might be
// owned by the user and may or may not be up — caller's responsibility).
function waitForGatewayReady(maxAttempts = 40, delayMs = 250) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync("openclaw", ["cron", "list", "--json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      return true;
    } catch {
      // sleep — synchronous, since execFileSync is already sync.
      const start = Date.now();
      while (Date.now() - start < delayMs) { /* spin briefly */ }
    }
  }
  return false;
}
if (!has("--no-restart") && !has("--no-cron")) {
  if (!waitForGatewayReady()) {
    console.error("warn: openclaw gateway not responding after restart — cron registration may fail; rerun install or run cron command from summary below.");
  }
}

// Register a recurring cron job that drives poll_events. This is the only
// way for plugin to reach into the agent — OpenClaw doesn't expose a
// "trigger turn" API to plugins (verified 2026-05-04). Cron persists in
// ~/.openclaw/cron/jobs.json so plugin restart doesn't lose it.
//
// Idempotent: if a cron with name "atel-mcp-poll" already exists, we
// don't add a duplicate. Each operation is retried up to 3 times with
// 1s backoff because the gateway can be momentarily busy right after a
// fresh restart.
function tryWithRetry(label, fn, maxAttempts = 3, delayMs = 1000) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      lastErr = e;
      if (i < maxAttempts - 1) {
        const start = Date.now();
        while (Date.now() - start < delayMs) { /* spin briefly */ }
      }
    }
  }
  return { ok: false, error: lastErr, label };
}

// Cron message — runs every 30s. Two cost+correctness goals:
//   (1) inflated by 1 event per tick, the message must stay short or
//       input tokens explode (~15K with full ATEL tool catalog already
//       in scope).
//   (2) the agent must NOT chatter about "no events"; the noEvents
//       short-circuit keeps cron silent at idle.
// Decision rules per event type are summarized inline so the agent
// doesn't need to reload SKILL.md just to handle a standard A2A
// milestone progression event.
const CRON_MESSAGE = [
  "Call atel_mcp action=poll_events.",
  "",
  "STOP IMMEDIATELY (no response, no summary, no message to user) if ANY of:",
  "- result.noEvents is true",
  "- result.error is set (transient — next tick will retry)",
  "- result.events is empty array",
  "- all events are about orders with status in {settled, completed, cancelled, expired} (stale)",
  "- all events have _receivedAt older than 5 minutes (stale catch-up from offline period)",
  "",
  "ONLY when there's at least one fresh event for an active order, take action:",
  "- order_accepted / order_milestones_proposed → if I'm the requester, review the milestone plan; if the price + scope look right, call atel_milestone_plan_feedback approved=true; else approved=false with feedback.",
  "- milestone_submitted → if I'm the requester, review the deliverable; if it satisfies the milestone, call atel_milestone_verify; else atel_milestone_revise with feedback.",
  "- milestone_verified → if I'm the executor and there's a next milestone, call atel_milestone_submit for it.",
  "- order_completed / order_settled / dispute_* → log only via tool call, no announce.",
  "",
  "If unsure, stop without announce — better to do nothing than spam the user."
].join("\n");

if (!has("--no-cron")) {
  const intervalSec = Number(process.env.ATEL_RELAY_CRON_INTERVAL_SEC || 30);
  const cronName = "atel-mcp-poll";
  let existing = null;
  const listResult = tryWithRetry("cron list", () => {
    const out = execFileSync("openclaw", ["cron", "list", "--json"], { encoding: "utf-8" });
    return JSON.parse(out);
  });
  if (listResult.ok) {
    const parsed = listResult.value;
    if (Array.isArray(parsed?.jobs)) {
      existing = parsed.jobs.find((j) => j.name === cronName) || null;
    }
  }
  // Note: if listResult.ok is false we still fall through to add — the add
  // call will either succeed or print the manual fallback below.

  // Detect whether the existing job is stale (message diverged from the
  // current bundled prompt). If so, edit it in place. Without this,
  // prompt improvements shipped via plugin upgrade would never reach
  // already-installed runtimes. We use `cron edit --message` (not
  // remove+add) so cron run history + schedule continuity are preserved.
  let editedExisting = false;
  if (existing) {
    const currentMsg = existing?.payload?.message ?? "";
    if (currentMsg !== CRON_MESSAGE) {
      console.log(`cron job '${cronName}' message is stale (older plugin version) — patching message.`);
      const editResult = tryWithRetry("cron edit", () => {
        execFileSync(
          "openclaw",
          ["cron", "edit", existing.id, "--message", CRON_MESSAGE],
          { stdio: "inherit" },
        );
      });
      if (editResult.ok) {
        editedExisting = true;
        console.log(`cron job '${cronName}' message updated.`);
      } else {
        console.error(`warn: cron edit ${existing.id} failed; keeping old message. Run manually: openclaw cron edit ${existing.id} --message "..."`);
        editedExisting = true; // treat as handled — we won't try cron add (would create duplicate name)
      }
    }
  }

  if (existing && !editedExisting) {
    console.log(`cron job '${cronName}' already present with current message — keeping it.`);
  } else if (existing && editedExisting) {
    // already handled via edit — don't fall through to cron add (it would
    // either duplicate the name or fail)
  } else {
    const addResult = tryWithRetry("cron add", () => {
      execFileSync(
        "openclaw",
        [
          "cron", "add",
          "--name", cronName,
          "--every", `${intervalSec}s`,
          "--session", "isolated",
          "--message", CRON_MESSAGE,
          // --announce makes the agent's turn output flow to the
          // configured chat channel (Telegram default). This is what
          // lets the user actually SEE event-driven notifications
          // ("订单 ord-X 已接受", "milestone Y 已 verify", ...) from a
          // background-cron-driven loop instead of them silently
          // accumulating in inbox.jsonl. Pairs with the cron prompt's
          // explicit "noEvents:true → stop, do not summarize" rule so
          // idle ticks don't spam the channel.
          "--announce",
          "--best-effort-deliver",
          "--light-context",
        ],
        { stdio: "inherit" },
      );
    });
    if (addResult.ok) {
      console.log(`cron job '${cronName}' registered (every ${intervalSec}s).`);
    } else {
      console.error(`warn: could not register cron job '${cronName}' after 3 retries. Reverse channel will not auto-trigger.`);
      console.error(`      Run manually:`);
      console.error(`      openclaw cron add --name ${cronName} --every ${intervalSec}s --session isolated --message "Call atel_mcp action=poll_events. If noEvents:true stop, otherwise process events and announce to user." --announce --best-effort-deliver --light-context`);
    }
  }
}

console.log("ATEL MCP OpenClaw plugin installed.");
console.log(`config=${configPath}`);
console.log(`backup=${backup}`);
console.log(`extension=${extensionDir}`);
console.log(`serverBaseUrl=${serverBaseUrl}`);
console.log(`platformBaseUrl=${platformBaseUrl}`);
console.log(`identityPath=${identityPath}`);
