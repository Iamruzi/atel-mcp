import { createAtelMcpTool } from "../openclaw-plugin/atel-mcp/src/tool.js";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export function createRuntimeFromEnv(identityPathEnv) {
  return {
    config: {
      loadConfig: () => ({
        plugins: {
          entries: {
            "atel-mcp": {
              config: {
                serverBaseUrl: process.env.ATEL_PLUGIN_REMOTE_BASE_URL ?? "https://43-160-230-129.sslip.io",
                platformBaseUrl: process.env.ATEL_PLUGIN_PLATFORM_BASE_URL ?? "https://api.atelai.org",
                identityPath: required(identityPathEnv),
                sdkDistPath: required("ATEL_PLUGIN_SDK_DIST_PATH"),
                naclPath: required("ATEL_PLUGIN_NACL_PATH"),
              },
            },
          },
        },
      }),
    },
  };
}

export function createTool(identityPathEnv) {
  return createAtelMcpTool(createRuntimeFromEnv(identityPathEnv));
}

export async function callTool(tool, remoteTool, args = {}) {
  const result = await tool.execute("smoke", {
    action: "call",
    tool: remoteTool,
    args,
  });
  const outerText = result?.content?.[0]?.text;
  if (!outerText) {
    return result;
  }
  const outer = JSON.parse(outerText);
  const innerText = outer?.content?.[0]?.text;
  if (!innerText) {
    return outer;
  }
  try {
    return JSON.parse(innerText);
  } catch {
    return outer;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForMilestonePhase(tool, orderId, expectedPhase, attempts = 20) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await callTool(tool, "atel_milestone_list", { orderId });
    if (String(last?.phase ?? "").toLowerCase() === expectedPhase.toLowerCase()) {
      return last;
    }
    await sleep(1000);
  }
  return last;
}

