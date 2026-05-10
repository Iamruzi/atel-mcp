// Plugin entry point.
//
// Registers ONE OpenClaw tool (`atel_mcp`) with three actions:
//   - list:        enumerate ATEL MCP tools
//   - call:        invoke an ATEL MCP tool
//   - poll_events: drain platform → plugin push notifications
//
// At register() time the plugin also tries to start an HTTP listener
// (default 0.0.0.0:3101) for platform pushes and registers a public URL
// via atel_register_endpoint. If that fails (NAT, port taken, no public
// IP), plugin transparently falls back to pull mode where poll_events
// fetches from /relay/v1/inbox-jwt instead.
//
// The cron job that drives poll_events on a schedule is registered by
// `bin/install.js` at install time, persisted in ~/.openclaw/cron/jobs.json.

import { createAtelMcpTool, readPluginConfig } from "./src/tool.js";
import { setupReverseChannel } from "./src/setup.js";

// As of 0.6.15 the primary tool surface is `mcp.servers.atel` configured
// in openclaw.json by bin/install.js — OpenClaw's native MCP-client
// transport gives the LLM direct access to atel_whoami / atel_balance /
// atel_milestone_submit etc. as `atel__atel_whoami` etc. We still attempt
// the legacy plugin-tool registration of `atel_mcp` here as a fallback
// surface (cron prompts that explicitly say "atel_mcp action=..." can
// still find it on the rare runtime where MCP-server config didn't
// hydrate). OpenClaw's loader silently drops this registration on
// 2026.5.7 due to an installs.json contracts cache bug — that's
// acceptable now since mcp.servers.atel is the real path.
const plugin = {
  id: "atel-mcp-openclaw",
  name: "ATEL MCP",
  description: "Bridge OpenClaw to the remote ATEL MCP server",
  register(api) {
    try { api.registerTool(createAtelMcpTool(api.runtime)); } catch {}
    setTimeout(() => {
      try {
        const config = readPluginConfig(api.runtime);
        setupReverseChannel(api.runtime, config).catch((err) => {
          console.warn("[atel-mcp] reverse channel setup error:", err && err.message);
        });
      } catch (err) {
        console.warn("[atel-mcp] reverse channel skipped (config error):", err && err.message);
      }
    }, 100);
  },
};

export default plugin;
