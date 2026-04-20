import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function createClient(token: string, serverUrl: string) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'atel-mcp-auto-arbitration-smoke', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function parseTextPayload(result: any): any {
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return result; }
}

async function main() {
  const serverUrl = process.env.ATEL_MCP_URL ?? 'http://127.0.0.1:8787/mcp';
  const requesterToken = required('ATEL_MCP_REQUESTER_TOKEN');
  const executorToken = required('ATEL_MCP_EXECUTOR_TOKEN');
  const executorDid = required('ATEL_MCP_EXECUTOR_DID');
  const capabilityType = required('ATEL_MCP_CAPABILITY_TYPE');
  const expectedOutcome = (process.env.ATEL_MCP_ARBITRATION_EXPECTED ?? 'failed').trim().toLowerCase();
  if (!['failed', 'passed'].includes(expectedOutcome)) {
    throw new Error(`Invalid ATEL_MCP_ARBITRATION_EXPECTED: ${expectedOutcome}`);
  }

  const requester = await createClient(requesterToken, serverUrl);
  const executor = await createClient(executorToken, serverUrl);
  try {
    const createResult = parseTextPayload(await requester.callTool({
      name: 'atel_order_create',
      arguments: {
        executorDid,
        capabilityType,
        description: `MCP auto-arbitration smoke ${Date.now()}: respond with exactly one of bullish, bearish, or sideways, then give exactly 3 short reasons.`,
        priceUsdc: 0,
      },
    }));
    const orderId = createResult?.orderId;
    if (!orderId) throw new Error(`Missing orderId: ${JSON.stringify(createResult)}`);

    const acceptResult = parseTextPayload(await executor.callTool({ name: 'atel_order_accept', arguments: { orderId } }));
    const milestones = parseTextPayload(await requester.callTool({ name: 'atel_milestone_list', arguments: { orderId } }));
    const submitResults: any[] = [];
    const rejects: any[] = [];
    const goodContent = [
      'sideways',
      '1. Price action remains range-bound without a breakout.',
      '2. Bullish and bearish catalysts currently offset each other.',
      '3. Mixed momentum favors consolidation over trend extension.',
    ].join('\n');
    const badContent = 'Allowed output must be exactly one of bullish, bearish, or sideways, followed by exactly 3 short reasons. No files, no inbox, no other order IDs.';

    for (let i = 0; i < 3; i += 1) {
      const content = expectedOutcome === 'passed' ? goodContent : `${badContent} attempt=${i + 1}`;
      const submitResult = parseTextPayload(await executor.callTool({
        name: 'atel_milestone_submit',
        arguments: { orderId, index: 0, content },
      }));
      submitResults.push(submitResult);
      const result = parseTextPayload(await requester.callTool({
        name: 'atel_milestone_reject',
        arguments: { orderId, index: 0, content: `arbitration smoke reject ${i + 1}` },
      }));
      rejects.push(result);
    }

    const timeline = parseTextPayload(await requester.callTool({ name: 'atel_order_timeline', arguments: { orderId } }));
    const finalOrder = parseTextPayload(await requester.callTool({ name: 'atel_order_get', arguments: { orderId } }));
    const finalMilestones = parseTextPayload(await requester.callTool({ name: 'atel_milestone_list', arguments: { orderId } }));
    const orderAudit = parseTextPayload(await requester.callTool({ name: 'atel_audit_order_get', arguments: { orderId, limit: 50 } }));
    const requesterSessionAudit = parseTextPayload(await requester.callTool({ name: 'atel_audit_session_get', arguments: { limit: 30 } }));

    const outcomes = rejects.map((r) => r?.status).filter(Boolean);
    const hasAutoArbitration = outcomes.includes('arbitration_passed') || outcomes.includes('arbitration_failed');
    if (!hasAutoArbitration) throw new Error(`Expected auto-arbitration outcome, got ${JSON.stringify(outcomes)}`);
    const finalOutcome = outcomes.find((x) => x === 'arbitration_passed' || x === 'arbitration_failed');
    if (expectedOutcome === 'passed' && finalOutcome !== 'arbitration_passed') {
      throw new Error(`Expected arbitration_passed, got ${finalOutcome}`);
    }
    if (expectedOutcome === 'failed' && finalOutcome !== 'arbitration_failed') {
      throw new Error(`Expected arbitration_failed, got ${finalOutcome}`);
    }

    const finalStatus = String(finalOrder?.status ?? finalOrder?.Status ?? '').toLowerCase();
    const currentMilestone = Number(finalMilestones?.currentMilestone ?? -1);
    const timelineEvents = Array.isArray(timeline?.events) ? timeline.events : [];
    const timelineEventTypes = timelineEvents.map((event: any) => String(event?.eventType ?? '').toLowerCase());
    const auditEvents = Array.isArray(orderAudit?.events) ? orderAudit.events : [];
    const auditEventTypes = auditEvents.map((event: any) => String(event?.type ?? '').toLowerCase());

    if (expectedOutcome === 'passed') {
      if (finalStatus !== 'executing') {
        throw new Error(`Expected executing order after arbitration_passed, got ${finalStatus}`);
      }
      if (currentMilestone !== 1) {
        throw new Error(`Expected currentMilestone=1 after arbitration_passed, got ${currentMilestone}`);
      }
      if (!auditEventTypes.includes('milestone.arbitration_passed')) {
        throw new Error(`Expected milestone.arbitration_passed in order audit, got ${JSON.stringify(auditEventTypes)}`);
      }
    }

    if (expectedOutcome === 'failed') {
      if (finalStatus !== 'cancelled') {
        throw new Error(`Expected cancelled order after arbitration_failed, got ${finalStatus}`);
      }
      if (!timelineEventTypes.includes('order.cancelled')) {
        throw new Error(`Expected order.cancelled in timeline, got ${JSON.stringify(timelineEventTypes)}`);
      }
      if (!auditEventTypes.includes('milestone.arbitration_failed')) {
        throw new Error(`Expected milestone.arbitration_failed in order audit, got ${JSON.stringify(auditEventTypes)}`);
      }
    }

    console.log(JSON.stringify({
      ok: true,
      expectedOutcome,
      orderId,
      createResult,
      acceptResult,
      milestones,
      finalOrder,
      finalMilestones,
      submitResults,
      rejects,
      timeline,
      orderAudit,
      requesterSessionAudit,
    }, null, 2));
  } finally {
    await requester.close();
    await executor.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

