import { createAtelMcpTool } from "./src/tool.js";

const plugin = {
  id: "atel-mcp",
  name: "ATEL MCP",
  description: "Bridge OpenClaw to the remote ATEL MCP server",
  register(api) {
    api.registerTool(createAtelMcpTool(api.runtime), { name: "atel_mcp" });
  },
};

export default plugin;
