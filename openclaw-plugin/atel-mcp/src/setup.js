// Plugin lifecycle setup — runs once at register():
//   1. Detect public URL (config override OR env-detected outbound IP)
//   2. Start HTTP listener (push mode) — falls back to pull mode if bind fails
//   3. Call atel_register_endpoint to advertise URL to platform
//
// Idempotency: register_endpoint platform-side is INSERT ... ON CONFLICT
// UPDATE, so calling on every plugin start is fine. Listener bind retry
// is one-shot (no retry loop) — if port is taken once, treat as pull mode.

import { startListener } from "./listener.js";
import { startHeartbeat } from "./heartbeat.js";
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

async function ensureAgentName(runtime) {
  // Friendly agent name pushed to platform's agents.name on every plugin
  // start. Idempotent — atel_agent_register is INSERT ... ON CONFLICT
  // UPDATE on platform side.
  //
  // Source of truth (priority order):
  //   1. ATEL_AGENT_NAME env var (override for headless / CI)
  //   2. <extensionDir>/atel-state.json (.name field — modern, atomic)
  //   3. <extensionDir>/agent-name.txt (legacy single-file)
  let name = process.env.ATEL_AGENT_NAME || "";
  if (!name) {
    try {
      const fsMod = await import("node:fs");
      const pathMod = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const here = pathMod.dirname(fileURLToPath(import.meta.url));
      const stateFile = pathMod.resolve(here, "..", "atel-state.json");
      if (fsMod.existsSync(stateFile)) {
        const st = JSON.parse(fsMod.readFileSync(stateFile, "utf8"));
        if (typeof st?.name === "string" && st.name.trim()) name = st.name.trim();
      }
      if (!name) {
        const namePath = pathMod.resolve(here, "..", "agent-name.txt");
        if (fsMod.existsSync(namePath)) {
          name = fsMod.readFileSync(namePath, "utf8").trim();
        }
      }
    } catch { /* fall through */ }
  }
  if (!name) return;
  // atel_agent_register schema requires capabilities (>=1). For an
  // OpenClaw agent we don't always know the right capability list — but
  // we DO want to preserve whatever is already registered. Strategy:
  //   1. read current registration via atel_whoami / agent search
  //   2. if missing, default to ["coding"] (the OpenClaw default agent)
  //   3. send name + existing capabilities
  // Capability resolution priority:
  //   1. atel-state.json (.capabilities — modern, atomic)
  //   2. agent-capabilities.txt (legacy)
  //   3. existing platform record (preserve what's there)
  //   4. ["coding"] (legacy default — wrong for non-engineers)
  let existingCaps = ["coding"];
  let capsFromInstaller = false;
  try {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = pathMod.dirname(fileURLToPath(import.meta.url));
    const stateFile = pathMod.resolve(here, "..", "atel-state.json");
    if (fsMod.existsSync(stateFile)) {
      const st = JSON.parse(fsMod.readFileSync(stateFile, "utf8"));
      if (Array.isArray(st?.capabilities) && st.capabilities.length) {
        existingCaps = st.capabilities.filter((s) => typeof s === "string" && s);
        if (existingCaps.length) capsFromInstaller = true;
      }
    }
    if (!capsFromInstaller) {
      const capsPath = pathMod.resolve(here, "..", "agent-capabilities.txt");
      if (fsMod.existsSync(capsPath)) {
        const declared = fsMod.readFileSync(capsPath, "utf8").trim().split(",").map((s) => s.trim()).filter(Boolean);
        if (declared.length) {
          existingCaps = declared;
          capsFromInstaller = true;
        }
      }
    }
  } catch { /* fall through to platform-record fallback */ }
  let existingDesc;
  try {
    const whoami = await _sendMcpRequestForRuntime(runtime, "tools/call", { name: "atel_whoami", arguments: {} });
    const txt = whoami?.content?.[0]?.text;
    if (txt) {
      const me = JSON.parse(txt);
      const did = me?.did;
      if (did) {
        const search = await _sendMcpRequestForRuntime(runtime, "tools/call", { name: "atel_agent_search", arguments: { query: did } });
        const stxt = search?.content?.[0]?.text;
        if (stxt) {
          const sj = JSON.parse(stxt);
          const found = (sj?.agents || []).find((a) => a.did === did);
          if (found) {
            // Only inherit platform's caps when installer didn't declare any —
            // otherwise the operator's explicit `--capabilities` flag would
            // be silently overridden on every gateway start, which defeats
            // the purpose of letting them configure caps at install time.
            if (!capsFromInstaller && Array.isArray(found.capabilities) && found.capabilities.length) {
              existingCaps = found.capabilities.map((c) => typeof c === "string" ? c : c?.type).filter(Boolean);
              if (!existingCaps.length) existingCaps = ["coding"];
            }
            if (typeof found.description === "string") existingDesc = found.description;
          }
        }
      }
    }
  } catch (e) {
    // Best-effort: if discovery fails, fall back to capabilities=["coding"].
  }
  try {
    const args = { name, capabilities: existingCaps };
    if (existingDesc) args.description = existingDesc;
    const result = await _sendMcpRequestForRuntime(runtime, "tools/call", {
      name: "atel_agent_register",
      arguments: args,
    });
    if (result?.isError) {
      console.warn(`[atel-mcp/setup] agent_register name='${name}' failed: ${JSON.stringify(result).slice(0, 200)}`);
    } else {
      console.log(`[atel-mcp/setup] agent registered as '${name}' (caps=${existingCaps.join(",")})`);
    }
  } catch (err) {
    console.warn(`[atel-mcp/setup] agent_register threw: ${err && err.message}`);
  }
}

export async function setupReverseChannel(runtime, config) {
  const port = Number(config.relayListenPort || 3101);
  // 0.6.0+: listener + heartbeat run as a dedicated systemd --user unit
  // (atel-mcp-listener.service, installed by bin/install.js). This
  // function no longer spawns either in-process. We only push the agent
  // identity to platform and register the public endpoint. Side benefit:
  // the gateway/agent fork distinction (which was the root cause of the
  // 0.4/0.5 "EADDRINUSE → silent pull mode" bug) becomes irrelevant —
  // every fork's setupReverseChannel() simply (re-)registers the same
  // endpoint with platform.
  pluginMode = "push";

  // Step 1: push friendly agent name (atel_agent_register) FIRST. Platform
  // creates the agent row with a placeholder endpoint (mcp://remote/<did>)
  // when this is the agent's first registration. We deliberately do this
  // BEFORE register_endpoint so the next step's real URL ends up as the
  // final write — avoids a write-then-overwrite race where agent_register
  // would clobber a freshly-registered endpoint with the placeholder.
  await ensureAgentName(runtime);

  // Step 2: detect a publicly reachable URL.
  const url = await detectPublicUrl(config, port);
  if (!url) {
    console.warn("[atel-mcp/setup] could not detect public URL — falling back to pull mode (listener still running but unreachable)");
    pluginMode = "pull";
    return { mode: "pull", reason: "no_public_url" };
  }

  // Step 3: register the real endpoint with platform, overwriting the
  // placeholder set by agent_register. If platform's reachability probe
  // fails (e.g. ufw blocks 3101 inbound) the call returns isError and we
  // fall back to pull mode (listener still running, just not reachable).
  let endpointOk = false;
  let registerFailReason = "";
  try {
    const result = await callRegisterEndpoint(runtime, url);
    if (result?.isError) {
      const detail = JSON.stringify(result).slice(0, 400);
      registerFailReason = detail.includes("must start with https") ? "https_required" : "register_rejected";
      console.warn(`[atel-mcp/setup] register_endpoint failed: ${detail} — falling back to pull mode`);
      pluginMode = "pull";
    } else {
      console.log(`[atel-mcp/setup] reverse channel armed (push mode) — endpoint=${url}`);
      pluginMode = "push";
      endpointOk = true;
    }
  } catch (err) {
    registerFailReason = "register_threw";
    console.warn(`[atel-mcp/setup] register_endpoint threw (${err && err.message}) — falling back to pull mode`);
    pluginMode = "pull";
  }

  if (endpointOk) return { mode: "push", url };

  // 2026-05-13 tester report 10A.2: in production, register_endpoint
  // rejects http:// URLs. Plugin correctly falls back to pull mode, but
  // the user is left with Dashboard Auth failing ("listener_unreachable")
  // with no idea what to do. Surface the next-step guidance into the
  // logs (install.js / TG success card will mirror it) so a non-ops
  // user knows their options.
  if (registerFailReason === "https_required") {
    console.warn("[atel-mcp/setup] production requires an https:// endpoint for Dashboard Auth and platform → plugin push.");
    console.warn("[atel-mcp/setup] options for getting one:");
    console.warn("  (a) Cloudflare named tunnel (persistent) — `cloudflared tunnel route dns ... && cloudflared tunnel run`");
    console.warn("  (b) Caddy / nginx HTTPS reverse proxy in front of the local listener");
    console.warn("  (c) Tailscale Funnel (`tailscale funnel http://127.0.0.1:" + port + "`)");
    console.warn(`  Then set ATEL_RELAY_PUBLIC_URL=https://your-public-host and re-run \`npx atel-mcp-openclaw@latest\` (or just restart the gateway).`);
    console.warn("  Until an https endpoint is set, the agent runs in pull-only mode — fine for P2P/A2A/A2B, but Dashboard Auth + low-latency push events will not work.");
  }
  return { mode: "pull", reason: registerFailReason || "register_endpoint_failed_or_threw", url };
}
