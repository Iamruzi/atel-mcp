import { readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const runtimeLinksPath = '/root/.openclaw/deploy/atel-mcp/.runtime/runtime-links.json';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function parseToolText(result: unknown): any {
  const text = Array.isArray((result as { content?: Array<{ type?: string; text?: string }> })?.content)
    ? (result as { content: Array<{ type?: string; text?: string }> }).content.find((item) => item.type === 'text')?.text
    : undefined;
  return text ? JSON.parse(text) : null;
}

function createClient(name: string, serverUrl: string, bearer: string, extraHeaders: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${bearer}`,
        ...extraHeaders,
      },
    },
  });
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
  return { client, transport };
}

async function main() {
  const serverUrl = requiredEnv('ATEL_MCP_URL');
  const requesterToken = process.env.ATEL_MCP_REQUESTER_TOKEN ?? requiredEnv('ATEL_MCP_BEARER_TOKEN');
  const executorToken = requiredEnv('ATEL_MCP_EXECUTOR_TOKEN');
  const executorDid = requiredEnv('ATEL_MCP_EXECUTOR_DID');
  const capabilityType = requiredEnv('ATEL_MCP_CAPABILITY_TYPE');

  let original: string | null = null;
  try {
    original = await readFile(runtimeLinksPath, 'utf8');
  } catch {
    original = null;
  }

  const requester = createClient('atel-mcp-requester-order', serverUrl, requesterToken);
  const executor = createClient('atel-mcp-executor-order', serverUrl, executorToken);
  const executorLinked = createClient('atel-mcp-executor-linked-accept', serverUrl, executorToken, {
    'x-atel-runtime-backend': 'linked-runtime',
    'x-atel-user-mode': 'mcp-plus-runtime',
  });

  try {
    await requester.client.connect(requester.transport);
    await executor.client.connect(executor.transport);
    await executorLinked.client.connect(executorLinked.transport);

    const bind = parseToolText(await executor.client.callTool({
      name: 'atel_runtime_link_bind',
      arguments: {
        runtimeDid: 'did:atel:ed25519:self-runtime-smoke',
        backend: 'linked-runtime',
        endpoint: serverUrl,
        authToken: executorToken,
      },
    }));

    const create = parseToolText(await requester.client.callTool({
      name: 'atel_order_create',
      arguments: {
        executorDid,
        capabilityType,
        description: `linked-runtime-order-accept-smoke-${Date.now()}`,
        priceUsdc: 0,
      },
    }));

    const orderId = create?.orderId;
    if (!orderId) throw new Error('Missing orderId from order create');

    const accept = parseToolText(await executorLinked.client.callTool({
      name: 'atel_order_accept',
      arguments: { orderId },
    }));

    const order = parseToolText(await requester.client.callTool({
      name: 'atel_order_get',
      arguments: { orderId },
    }));

    const unbind = parseToolText(await executor.client.callTool({
      name: 'atel_runtime_link_unbind',
      arguments: {},
    }));

    const accepted = String(order?.status ?? '').toLowerCase() !== 'created';
    console.log(JSON.stringify({ ok: Boolean(orderId) && accepted, bind, create, accept, order, unbind }, null, 2));
    if (!accepted) process.exitCode = 1;
  } finally {
    await requester.client.close().catch(() => {});
    await executor.client.close().catch(() => {});
    await executorLinked.client.close().catch(() => {});
    if (original === null) {
      await rm(runtimeLinksPath, { force: true }).catch(() => {});
    } else {
      await writeFile(runtimeLinksPath, original, 'utf8');
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
