import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function createClient(token: string, serverUrl: string, name: string, extraHeaders: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...extraHeaders } },
  });
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
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

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  return parseTextPayload(await client.callTool({ name, arguments: args ?? {} }));
}

function milestoneContent(index: number): string {
  if (index === 0) {
    return [
      'Allowed final output: exactly one of bullish, bearish, or sideways.',
      'The final answer must include exactly 3 short numbered reasons.',
      'No files, no inbox, no other order IDs.',
    ].join('\n');
  }
  if (index === 1) {
    return [
      'sideways',
      '1. Gold remains range-bound without a confirmed breakout.',
      '2. Bullish and bearish macro drivers are offsetting each other.',
      '3. Short-term momentum favors consolidation over extension.',
    ].join('\n');
  }
  if (index === 2) {
    return [
      'sideways',
      '1. Recent price action is still trapped inside a short-term range.',
      '2. Risk-off demand and profit-taking are balancing one another.',
      '3. Momentum signals are mixed, which favors sideways movement.',
    ].join('\n');
  }
  if (index === 3) {
    return [
      'sideways',
      '1. Gold has not broken out of its near-term trading range.',
      '2. Competing macro signals are preventing a clean directional move.',
      '3. Mixed momentum and positioning keep the short-term outlook neutral.',
    ].join('\n');
  }
  return [
    'sideways',
    '1. Price is still consolidating inside a near-term range.',
    '2. Supportive and restrictive macro forces remain balanced.',
    '3. Mixed momentum supports a sideways short-term view.',
  ].join('\n');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSettled(client: Client, orderId: string, attempts = 20) {
  let last: any = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await call(client, 'atel_order_get', { orderId });
    const status = String(last?.status ?? last?.Status ?? '').toLowerCase();
    if (status === 'settled') return last;
    await sleep(1000);
  }
  return last;
}

async function main() {
  const serverUrl = process.env.ATEL_MCP_URL ?? 'http://127.0.0.1:8787/mcp';
  const requesterToken = required('ATEL_MCP_REQUESTER_TOKEN');
  const executorToken = required('ATEL_MCP_EXECUTOR_TOKEN');
  const executorDid = required('ATEL_MCP_EXECUTOR_DID');
  const capabilityType = required('ATEL_MCP_CAPABILITY_TYPE');
  const requesterName = process.env.ATEL_MCP_REQUESTER_NAME ?? 'MCP Dev Requester';
  const executorName = process.env.ATEL_MCP_EXECUTOR_NAME ?? 'MCP Dev Executor';

  const requester = await createClient(requesterToken, serverUrl, 'atel-mcp-happy-requester');
  const executor = await createClient(executorToken, serverUrl, 'atel-mcp-happy-executor');
  let requesterCreate: Client | null = null;

  try {
    const requesterWhoami = await call(requester, 'atel_whoami');
    const executorWhoami = await call(executor, 'atel_whoami');

    const requesterRegister = await call(requester, 'atel_agent_register', {
      name: requesterName,
      description: 'Remote MCP requester smoke identity',
      capabilities: ['research', 'analysis'],
      discoverable: true,
    });
    const executorRegister = await call(executor, 'atel_agent_register', {
      name: executorName,
      description: 'Remote MCP executor smoke identity',
      capabilities: [capabilityType, 'analysis'],
      discoverable: true,
    });

    const searchResult = await call(requester, 'atel_agent_search', { query: executorName, capability: capabilityType });
    const p2pText = `mcp-happy-p2p-${Date.now()}`;
    const sendResult = await call(requester, 'atel_send_message', { peerDid: executorDid, text: p2pText });
    const inboxResult = await call(executor, 'atel_inbox_list');

    const createRequestId = `mcp-happy-create-${Date.now()}`;
    requesterCreate = await createClient(requesterToken, serverUrl, 'atel-mcp-happy-requester-create', { 'x-request-id': createRequestId });
    const createResult = await call(requesterCreate, 'atel_order_create', {
      executorDid,
      capabilityType,
      description: `Happy path smoke ${Date.now()}: choose exactly one of bullish, bearish, or sideways, then give exactly 3 short reasons.`,
      priceUsdc: 0,
    });
    const orderId = createResult?.orderId;
    if (!orderId) throw new Error(`Missing orderId in create result: ${JSON.stringify(createResult)}`);

    const acceptResult = await call(executor, 'atel_order_accept', { orderId });
    const milestones = await call(requester, 'atel_milestone_list', { orderId });
    const milestoneItems = Array.isArray(milestones?.milestones) ? milestones.milestones : (Array.isArray(milestones) ? milestones : []);
    if (!milestoneItems.length) throw new Error(`No milestones returned for ${orderId}`);

    const submissions: any[] = [];
    const verifications: any[] = [];
    for (let i = 0; i < milestoneItems.length; i += 1) {
      submissions.push(await call(executor, 'atel_milestone_submit', { orderId, index: i, content: milestoneContent(i) }));
      verifications.push(await call(requester, 'atel_milestone_verify', { orderId, index: i }));
    }

    const finalOrder = await waitForSettled(requester, orderId);
    const timeline = await call(requester, 'atel_order_timeline', { orderId });
    const orderAudit = await call(requester, 'atel_audit_order_get', { orderId, limit: 100 });
    const requesterSessionAudit = await call(requester, 'atel_audit_session_get', { limit: 50 });
    const executorSessionAudit = await call(executor, 'atel_audit_session_get', { limit: 50 });
    const createRequestAudit = await call(requester, 'atel_audit_request_get', { requestId: createRequestId, limit: 20 });

    const finalStatus = String(finalOrder?.status ?? finalOrder?.Status ?? '').toLowerCase();
    if (finalStatus !== 'settled') {
      throw new Error(`Expected settled order, got ${finalStatus}: ${JSON.stringify(finalOrder)}`);
    }
    if (!Array.isArray(orderAudit?.events) || orderAudit.events.length === 0) {
      throw new Error(`Expected order audit events for ${orderId}`);
    }
    if (!Array.isArray(requesterSessionAudit?.events) || requesterSessionAudit.events.length === 0) {
      throw new Error('Expected requester session audit events');
    }
    if (createRequestId && (!createRequestAudit || !Array.isArray(createRequestAudit?.events) || createRequestAudit.events.length === 0)) {
      throw new Error(`Expected request audit events for ${createRequestId}`);
    }

    console.log(JSON.stringify({
      ok: true,
      orderId,
      requesterWhoami,
      executorWhoami,
      requesterRegister,
      executorRegister,
      searchResult,
      p2pText,
      sendResult,
      inboxResult,
      createResult,
      acceptResult,
      milestones,
      submissions,
      verifications,
      finalOrder,
      timeline,
      orderAudit,
      requesterSessionAudit,
      executorSessionAudit,
      createRequestAudit,
    }, null, 2));
  } finally {
    if (requesterCreate) await requesterCreate.close();
    await requester.close();
    await executor.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});