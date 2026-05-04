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

const plugin = {
  id: "atel-mcp",
  name: "ATEL MCP",
  description: "Bridge OpenClaw to the remote ATEL MCP server",
  register(api) {
    api.registerTool(createAtelMcpTool(api.runtime));

    // Reverse channel setup runs async — we don't block plugin
    // registration on it. Failures degrade to pull mode silently.
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
