import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function createClient(token: string, serverUrl: string) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  });

  const client = new Client(
    { name: 'atel-mcp-dispute-smoke', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

function parseTextPayload(result: any): any {
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return result;
  }
}

async function main() {
  const serverUrl = process.env.ATEL_MCP_URL ?? 'http://127.0.0.1:8787/mcp';
  const requesterToken = required('ATEL_MCP_REQUESTER_TOKEN');
  const executorToken = required('ATEL_MCP_EXECUTOR_TOKEN');
  const executorDid = required('ATEL_MCP_EXECUTOR_DID');
  const capabilityType = required('ATEL_MCP_CAPABILITY_TYPE');

  const requester = await createClient(requesterToken, serverUrl);
  const executor = await createClient(executorToken, serverUrl);

  try {
    const createResult = await requester.callTool({
      name: 'atel_order_create',
      arguments: {
        executorDid,
        capabilityType,
        description: `MCP dispute smoke ${Date.now()}: provide a short gold trend view.`,
        priceUsdc: 0,
      },
    });

    const created = parseTextPayload(createResult);
    const orderId = created?.orderId;
    if (!orderId) throw new Error(`Missing orderId in create result: ${JSON.stringify(created)}`);

    const acceptResult = await executor.callTool({
      name: 'atel_order_accept',
      arguments: { orderId },
    });

    const disputeResult = await requester.callTool({
      name: 'atel_dispute_create',
      arguments: {
        orderId,
        reason: 'quality',
      },
    });

    console.log(JSON.stringify({
      ok: true,
      orderId,
      createResult,
      acceptResult,
      disputeResult,
    }, null, 2));
  } finally {
    await requester.close();
    await executor.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
