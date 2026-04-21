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
    const createResult = parseTextPayload(await requester.callTool({
      name: 'atel_order_create',
      arguments: {
        executorDid,
        capabilityType,
        description: `MCP dispute smoke ${Date.now()}: provide a short gold trend view.`,
        priceUsdc: 0,
      },
    }));

    const orderId = createResult?.orderId;
    if (!orderId) throw new Error(`Missing orderId in create result: ${JSON.stringify(createResult)}`);

    const acceptResult = parseTextPayload(await executor.callTool({
      name: 'atel_order_accept',
      arguments: { orderId },
    }));

    const disputeResult = parseTextPayload(await requester.callTool({
      name: 'atel_dispute_create',
      arguments: {
        orderId,
        reason: 'quality',
      },
    }));
    const disputeId = String(disputeResult?.disputeId ?? '').trim();
    if (!disputeId) throw new Error(`Missing disputeId in dispute result: ${JSON.stringify(disputeResult)}`);

    const disputeDetail = parseTextPayload(await requester.callTool({
      name: 'atel_dispute_get',
      arguments: { disputeId },
    }));
    const disputeList = parseTextPayload(await requester.callTool({ name: 'atel_dispute_list', arguments: {} }));
    const order = parseTextPayload(await requester.callTool({
      name: 'atel_order_get',
      arguments: { orderId },
    }));
    const timeline = parseTextPayload(await requester.callTool({
      name: 'atel_order_timeline',
      arguments: { orderId },
    }));
    const orderAudit = parseTextPayload(await requester.callTool({
      name: 'atel_audit_order_get',
      arguments: { orderId, limit: 50 },
    }));

    if (String(disputeResult?.status ?? '').toLowerCase() !== 'open') {
      throw new Error(`Expected dispute status=open, got ${JSON.stringify(disputeResult)}`);
    }
    if (String(disputeDetail?.disputeId ?? '') !== disputeId) {
      throw new Error(`Dispute detail did not match disputeId=${disputeId}: ${JSON.stringify(disputeDetail)}`);
    }
    if (String(disputeDetail?.orderId ?? '') !== orderId) {
      throw new Error(`Dispute detail did not match orderId=${orderId}: ${JSON.stringify(disputeDetail)}`);
    }

    const disputeItems = Array.isArray(disputeList?.disputes)
      ? disputeList.disputes
      : Array.isArray(disputeList)
        ? disputeList
        : [];
    if (!disputeItems.some((item: any) => String(item?.disputeId ?? '') === disputeId)) {
      throw new Error(`Dispute list did not include disputeId=${disputeId}`);
    }

    const timelineEvents = Array.isArray(timeline?.events) ? timeline.events : [];
    const orderAuditEvents = Array.isArray(orderAudit?.events) ? orderAudit.events : [];
    if (timelineEvents.length === 0) {
      throw new Error(`Expected timeline events for disputed order ${orderId}`);
    }
    if (!orderAuditEvents.some((event: any) => String(event?.type ?? '').toLowerCase() === 'dispute.created')) {
      throw new Error(`Expected dispute.created in order audit for ${orderId}`);
    }

    console.log(JSON.stringify({
      ok: true,
      orderId,
      disputeId,
      createResult,
      acceptResult,
      disputeResult,
      disputeDetail,
      disputeList,
      order,
      timeline,
      orderAudit,
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
