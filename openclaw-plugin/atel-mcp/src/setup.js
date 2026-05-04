// Plugin lifecycle setup — runs once at register():
//   1. Detect public URL (config override OR env-detected outbound IP)
//   2. Start HTTP listener (push mode) — falls back to pull mode if bind fails
//   3. Call atel_register_endpoint to advertise URL to platform
//
// Idempotency: register_endpoint platform-side is INSERT ... ON CONFLICT
// UPDATE, so calling on every plugin start is fine. Listener bind retry
// is one-shot (no retry loop) — if port is taken once, treat as pull mode.

import { startListener } from "./listener.js";
// Lazy-import tool.js to avoid the tool.js ↔ setup.js cycle. tool.js
// imports getMode() from setup.js at module load time; if we statically
// imported tool.js here we'd race the partial-module hazard.
async function _sendMcpRequestForRuntime(runtime, method, params) {
  const mod = await import("./tool.js");
  return mod.sendMcpRequestForRuntime(runtime, method, params);
}

let pluginMode = "uninitialized"; // "push" | "pull" | "uninitialized" | "error"

export function getMode() {
  return pluginMode;
}

async function detectPublicUrl(config, port) {
  // We register the BASE URL only — platform appends "/atel/v1/relay-message"
  // when pushing (see platform's notifyAgent → relay.SendMessage). Listener
  // serves that path.
  if (config.relayPublicUrl) {
    return config.relayPublicUrl.replace(/\/+$/, "");
  }
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    if (j && j.ip) {
      return `http://${j.ip}:${port}`;
    }
  } catch (_e) {
    // ipify unreachable; fall through
  }
  return null;
}

async function callRegisterEndpoint(runtime, url) {
  // Calls platform's atel_register_endpoint MCP tool. Schema requires:
  //   - endpoint (string, must be https:// in prod)
  //   - label (optional string)
  // For testnet/dev where lobster doesn't have TLS, the platform admin
  // can update agents.endpoint directly in DB or relax MCP schema —
  // not the plugin's concern.
  return await _sendMcpRequestForRuntime(runtime, "tools/call", {
    name: "atel_register_endpoint",
    arguments: { endpoint: url, label: "atel-mcp-openclaw plugin" },
  });
}

export async function setupReverseChannel(runtime, config) {
  const port = Number(config.relayListenPort || 3101);
  const host = config.relayListenHost || "0.0.0.0";
  const hmacSecret = config.relayHmacSecret || process.env.ATEL_RELAY_HMAC_SECRET || null;

  // Step 1: try to bind the listener.
  //
  // Important: OpenClaw plugins are loaded in TWO process contexts:
  //   1. The long-running gateway (where bind succeeds first)
  //   2. Each isolated agent turn (a fresh child process)
  // The 2nd context's setup will see EADDRINUSE because the gateway
  // already owns the port. That is FINE — push mode is still active
  // (the gateway-side listener writes to the file-backed inbox; the
  // agent's poll_events tool reads from it). We treat EADDRINUSE as
  // "push mode is alive in another process" instead of falling back.
  try {
    await startListener({ host, port, hmacSecret });
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      console.log(`[atel-mcp/setup] listener already bound by another process (likely the gateway) — using shared file-backed inbox`);
      pluginMode = "push";
      return { mode: "push", reason: "listener_owned_by_gateway" };
    }
    console.warn(`[atel-mcp/setup] listener bind failed (${err && err.message}) — falling back to pull mode`);
    pluginMode = "pull";
    return { mode: "pull", reason: `bind_failed: ${err && err.message}` };
  }

  // Step 2: detect a publicly reachable URL.
  const url = await detectPublicUrl(config, port);
  if (!url) {
    console.warn("[atel-mcp/setup] could not detect public URL — falling back to pull mode (listener still running but unreachable)");
    pluginMode = "pull";
    return { mode: "pull", reason: "no_public_url" };
  }

  // Step 3: register endpoint with platform. If the platform reachability
  // probe fails (e.g. firewall blocks 3101 inbound), the platform will
  // return an error and we fall back to pull mode.
  try {
    const result = await callRegisterEndpoint(runtime, url);
    if (result?.isError) {
      console.warn(`[atel-mcp/setup] register_endpoint failed: ${JSON.stringify(result)} — falling back to pull mode`);
      pluginMode = "pull";
      return { mode: "pull", reason: "register_endpoint_failed", url };
    }
    console.log(`[atel-mcp/setup] reverse channel armed (push mode) — endpoint=${url}`);
    pluginMode = "push";
    return { mode: "push", url };
  } catch (err) {
    console.warn(`[atel-mcp/setup] register_endpoint threw (${err && err.message}) — falling back to pull mode`);
    pluginMode = "pull";
    return { mode: "pull", reason: `register_endpoint_error: ${err && err.message}` };
  }
}
