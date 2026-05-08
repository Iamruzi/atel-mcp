// Standalone listener entry — runs as a systemd --user unit installed
// by bin/install.js (atel-mcp-listener.service).
//
// Why separate from the gateway-driven plugin register():
// the in-process startListener() inside register() silently degraded to
// pull mode whenever the port was held by a stale plugin generation OR
// when the gateway crashed. Operators saw no transfer_received cards
// and had no signal that anything was wrong. A dedicated systemd unit
// gives the listener its own crash domain (Restart=always brings it
// back), is observable via `systemctl --user status atel-mcp-listener`,
// and is decoupled from gateway lifecycle so platform pushes keep
// landing during a gateway restart.

import { startListener } from "./listener.js";
import { startHeartbeat } from "./heartbeat.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

function readStateField(name) {
  try {
    const statePath = path.join(_here, "..", "atel-state.json");
    if (fs.existsSync(statePath)) {
      const d = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return d?.[name];
    }
  } catch {}
  return undefined;
}

const HOST = process.env.ATEL_LISTENER_HOST || "0.0.0.0";
const PORT = Number(process.env.ATEL_LISTENER_PORT || 3101);
const platformBaseUrl = process.env.ATEL_PLATFORM_BASE_URL
  || readStateField("platformBaseUrl")
  || "https://api.atelai.xyz";
const identityPath = process.env.ATEL_IDENTITY_PATH
  || path.join(process.env.HOME || "/root", "atel-workspace", ".atel", "identity.json");

console.log(`[atel-listener] starting on ${HOST}:${PORT}, platform=${platformBaseUrl}`);

await startListener({ host: HOST, port: PORT });
console.log("[atel-listener] bound");

startHeartbeat({
  platformBaseUrl,
  identityPath,
  intervalMs: Number(process.env.ATEL_HEARTBEAT_INTERVAL_MS || 90_000),
});

// Surface unhandled errors loudly so systemd Restart=always picks us up.
process.on("uncaughtException", (e) => {
  console.error("[atel-listener] uncaught:", e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("[atel-listener] unhandled rejection:", e);
  process.exit(1);
});
process.on("SIGTERM", () => {
  console.log("[atel-listener] SIGTERM");
  process.exit(0);
});

console.log("[atel-listener] ready");
