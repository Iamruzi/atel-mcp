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
const extensionDir = path.join(extensionsDir, "atel-mcp");
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
if (!allow.includes("atel-mcp")) allow.push("atel-mcp");
config.plugins.allow = allow;
config.plugins.entries = config.plugins.entries && typeof config.plugins.entries === "object" ? config.plugins.entries : {};
config.plugins.installs = config.plugins.installs && typeof config.plugins.installs === "object" ? config.plugins.installs : {};
config.plugins.entries["atel-mcp"] = {
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
config.plugins.installs["atel-mcp"] = {
  source: "npm",
  spec: "atel-mcp-openclaw",
  installPath: extensionDir,
  version: "0.1.3",
  resolvedName: "atel-mcp-openclaw",
  resolvedVersion: "0.1.3",
  resolvedSpec: "atel-mcp-openclaw@0.1.3",
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

// Register a recurring cron job that drives poll_events. This is the only
// way for plugin to reach into the agent — OpenClaw doesn't expose a
// "trigger turn" API to plugins (verified 2026-05-04). Cron persists in
// ~/.openclaw/cron/jobs.json so plugin restart doesn't lose it.
//
// Idempotent: if a cron with name "atel-mcp-poll" already exists, we
// don't add a duplicate.
if (!has("--no-cron")) {
  const intervalSec = Number(process.env.ATEL_RELAY_CRON_INTERVAL_SEC || 30);
  const cronName = "atel-mcp-poll";
  let existsAlready = false;
  try {
    const list = execFileSync("openclaw", ["cron", "list", "--json"], { encoding: "utf-8" });
    const parsed = JSON.parse(list);
    if (Array.isArray(parsed?.jobs) && parsed.jobs.some((j) => j.name === cronName)) {
      existsAlready = true;
    }
  } catch {
    // CLI/parse error — fall through and try add. If add ALSO fails the
    // user can manually run the command from the install summary below.
  }

  if (existsAlready) {
    console.log(`cron job '${cronName}' already present — keeping it.`);
  } else {
    try {
      execFileSync(
        "openclaw",
        [
          "cron", "add",
          "--name", cronName,
          "--every", `${intervalSec}s`,
          "--session", "isolated",
          "--message",
          // Message is short on purpose. The agent's job is just to poll
          // and either noop (no events) or react. Long prompts here
          // would inflate input tokens on every cron tick.
          "Call atel_mcp action=poll_events. If the result has noEvents:true, just stop — do not summarize. Otherwise process each event in the result and take the appropriate next action (e.g. submit the next milestone if a previous one was just verified).",
          "--no-deliver",
          "--light-context",
        ],
        { stdio: "inherit" },
      );
      console.log(`cron job '${cronName}' registered (every ${intervalSec}s).`);
    } catch {
      console.error(`warn: could not register cron job '${cronName}'. Reverse channel will not auto-trigger.`);
      console.error(`      Run manually: openclaw cron add --name ${cronName} --every ${intervalSec}s --session isolated --message "Call atel_mcp action=poll_events..." --no-deliver --light-context`);
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
