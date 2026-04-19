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
    { name: 'atel-mcp-p2p-smoke', version: '0.1.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}

async function main() {
  const serverUrl = process.env.ATEL_MCP_URL ?? 'http://127.0.0.1:8787/mcp';
  const senderToken = required('ATEL_MCP_SENDER_TOKEN');
  const recipientToken = required('ATEL_MCP_RECIPIENT_TOKEN');
  const recipientDid = required('ATEL_MCP_RECIPIENT_DID');
  const probeText = `mcp-p2p-smoke-${Date.now()}`;

  const sender = await createClient(senderToken, serverUrl);
  const recipient = await createClient(recipientToken, serverUrl);

  try {
    const sendResult = await sender.callTool({
      name: 'atel_send_message',
      arguments: {
        peerDid: recipientDid,
        text: probeText,
      },
    });

    const inboxResult = await recipient.callTool({
      name: 'atel_inbox_list',
      arguments: {},
    });

    console.log(JSON.stringify({
      ok: true,
      probeText,
      sendResult,
      inboxResult,
    }, null, 2));
  } finally {
    await sender.close();
    await recipient.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
