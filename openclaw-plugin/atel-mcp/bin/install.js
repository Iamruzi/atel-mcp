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

try {
  execFileSync("openclaw", ["config", "validate"], { stdio: "inherit" });
} catch {
  die("OpenClaw config validation failed; restore backup if needed: " + backup);
}

if (!has("--no-restart")) {
  try {
    execFileSync("systemctl", ["--user", "restart", "openclaw-gateway.service"], { stdio: "inherit" });
  } catch {
    console.error("warn: could not restart openclaw-gateway.service; restart OpenClaw manually.");
  }
}

console.log("ATEL MCP OpenClaw plugin installed.");
console.log(`config=${configPath}`);
console.log(`backup=${backup}`);
console.log(`extension=${extensionDir}`);
console.log(`serverBaseUrl=${serverBaseUrl}`);
console.log(`platformBaseUrl=${platformBaseUrl}`);
console.log(`identityPath=${identityPath}`);
