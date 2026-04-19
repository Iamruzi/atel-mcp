import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function getRequiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function main() {
  const serverUrl = getRequiredEnv('ATEL_MCP_URL', 'http://127.0.0.1:8787/mcp');
  const bearer = process.env.ATEL_MCP_BEARER_TOKEN;

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: bearer
      ? {
          headers: {
            authorization: `Bearer ${bearer}`,
          },
        }
      : undefined,
  });

  const client = new Client(
    {
      name: 'atel-mcp-smoke',
      version: '0.1.0',
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    console.log(JSON.stringify({
      ok: true,
      serverUrl,
      toolCount: tools.tools.length,
      tools: tools.tools.map((tool) => tool.name),
    }, null, 2));

    if (!bearer) {
      console.log(JSON.stringify({
        ok: true,
        note: 'Skipping atel_whoami because ATEL_MCP_BEARER_TOKEN is not set.',
      }, null, 2));
      return;
    }

    const whoami = await client.callTool({
      name: 'atel_whoami',
      arguments: {},
    });

    console.log(JSON.stringify({
      ok: true,
      whoami,
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
