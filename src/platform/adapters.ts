import type { ToolExecutionContext } from '../server/context.js';
import { PLATFORM_ENDPOINTS } from './endpoints.js';

/**
 * Pre-auth: POST /auth/v1/register. The platform endpoint is unauthenticated
 * (anyone can mint a new identity). We don't pass a bearer here because
 * the caller doesn't have one yet — that's the whole point of register.
 */
export async function registerUser(
  config: import('../config.js').AtelMcpConfig,
  input: { name?: string; sourceLabel?: string },
): Promise<unknown> {
  const url = `${config.platformBaseUrl.replace(/\/+$/, '')}${PLATFORM_ENDPOINTS.auth.register}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(`platform /auth/v1/register failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

export async function registrySearch(ctx: ToolExecutionContext, input: { query: string; capability?: string }) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.registry.search,
    query: { q: input.query, capability: input.capability },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function registryRegister(ctx: ToolExecutionContext, input: { name: string; description?: string; capabilities: string[]; discoverable: boolean }) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.registry.remoteRegister,
    body: input,
    bearerToken: ctx.session.bearerToken,
  });
}

// ─── A2B (Bitrefill gift card) adapters ──────────────────────────────────
//
// All a2b endpoints return raw platform JSON; MCP tool layer is responsible
// for shape normalization and prerequisite checks.

export async function a2bSearch(
  ctx: ToolExecutionContext,
  input: { query: string; country?: string; limit: number },
) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.a2b.search,
    body: input,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function a2bList(ctx: ToolExecutionContext, input?: { limit?: number; offset?: number }) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.a2b.list,
    query: { did: ctx.session.did, limit: input?.limit, offset: input?.offset },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function a2bDetail(ctx: ToolExecutionContext, intentId: string) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.a2b.detail(intentId),
    query: { did: ctx.session.did },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function a2bRedemptionReveal(ctx: ToolExecutionContext, intentId: string) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.a2b.redemptionReveal(intentId),
    query: { did: ctx.session.did },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function a2bIntent(
  ctx: ToolExecutionContext,
  input: { productId: string; value: number; country?: string },
) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.a2b.intent,
    body: input,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function a2bDeposit(
  ctx: ToolExecutionContext,
  input: { intentId: string; amount: number; userSA: string },
) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.a2b.deposit,
    body: input,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function a2bCreateInvoice(
  ctx: ToolExecutionContext,
  input: { intentId: string },
) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.a2b.createInvoice,
    body: input,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function a2bPay(
  ctx: ToolExecutionContext,
  input: { intentId: string; amount: number },
) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.a2b.pay,
    body: input,
    bearerToken: ctx.session.bearerToken,
  });
}

/**
 * Lookup a single agent by DID. Returns null if 404, used by prerequisite
 * checks (targetExists / executorReady) to verify a DID is real before
 * letting host-side LLM mutate state with a fabricated DID.
 */
export async function getAgent(ctx: ToolExecutionContext, did: string): Promise<unknown | null> {
  try {
    return await ctx.platform.request<unknown>({
      method: 'GET',
      path: PLATFORM_ENDPOINTS.registry.agent(did),
      bearerToken: ctx.session.bearerToken,
    });
  } catch (e) {
    // 404 means agent doesn't exist — return null so caller can decide.
    // Other errors (5xx, network) re-throw.
    const msg = (e as Error).message ?? '';
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) return null;
    throw e;
  }
}

export async function getBalance(ctx: ToolExecutionContext) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.account.balance,
    query: { did: ctx.session.did },
    bearerToken: ctx.session.bearerToken,
  });
}

/**
 * Cross-chain withdraw / transfer. For chain='fast', recipient must be a
 * 64-char hex pubkey (not bech32 — see fast_p2p_transfer_done memo).
 * For chain='base'/'bsc', recipient is an EVM 0x-prefixed address. Amount
 * is USDC decimal (e.g. 0.001 = 1000 micro-USDC).
 */
export async function walletWithdraw(
  ctx: ToolExecutionContext,
  input: { chain: 'fast' | 'base' | 'bsc'; address: string; amount: number },
) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.wallet.withdraw,
    body: input,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function getDepositInfo(ctx: ToolExecutionContext) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.account.depositInfo,
    query: { did: ctx.session.did },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function listContacts(ctx: ToolExecutionContext) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.contacts.list,
    query: { did: ctx.session.did },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function listInbox(ctx: ToolExecutionContext) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.relay.inbox,
    query: { did: ctx.session.did },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function ackInbox(ctx: ToolExecutionContext, messageIds: number[]) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.relay.ack,
    body: { did: ctx.session.did, ids: messageIds },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function sendMessage(ctx: ToolExecutionContext, input: { peerDid: string; text: string }) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.relay.send,
    body: {
      target: input.peerDid,
      sender: ctx.session.did,
      message: {
        kind: 'text',
        text: input.text,
        sourceLabel: 'ATEL MCP',
      },
    },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function getOrder(ctx: ToolExecutionContext, orderId: string) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: `${PLATFORM_ENDPOINTS.trade.order}/${encodeURIComponent(orderId)}`,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function listOrders(ctx: ToolExecutionContext, input?: { role?: string; status?: string }) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.trade.orders,
    query: { did: ctx.session.did, role: input?.role, status: input?.status },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function getOrderTimeline(ctx: ToolExecutionContext, orderId: string) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.trade.timeline(orderId),
    bearerToken: ctx.session.bearerToken,
  });
}

export async function createOrder(ctx: ToolExecutionContext, input: { executorDid: string; capabilityType: string; description: string; priceUsdc: number }) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.trade.remoteOrder,
    body: {
      executorDid: input.executorDid,
      capabilityType: input.capabilityType,
      priceAmount: input.priceUsdc,
      priceCurrency: 'USD',
      pricingModel: 'per_task',
      description: input.description,
      sourceLabel: 'ATEL MCP',
    },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function acceptOrder(ctx: ToolExecutionContext, orderId: string) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.trade.remoteAccept(orderId),
    body: {},
    bearerToken: ctx.session.bearerToken,
  });
}

export async function completeOrder(ctx: ToolExecutionContext, input: {
  orderId: string;
  taskId?: string;
  proofBundle: unknown;
  anchorTx?: string;
  traceRoot: string;
  chain?: 'base' | 'bsc';
  traceEvents?: unknown;
  audit?: unknown;
}) {
  const { orderId, ...body } = input;
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.trade.remoteComplete(orderId),
    body,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function confirmOrder(ctx: ToolExecutionContext, orderId: string) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.trade.remoteConfirm(orderId),
    body: {},
    bearerToken: ctx.session.bearerToken,
  });
}

export async function listMilestones(ctx: ToolExecutionContext, orderId: string) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.trade.milestones(orderId),
    bearerToken: ctx.session.bearerToken,
  });
}

export async function submitMilestone(ctx: ToolExecutionContext, input: { orderId: string; index: number; content: string }) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.trade.remoteMilestoneSubmit(input.orderId, input.index),
    body: { resultSummary: input.content },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function verifyMilestone(ctx: ToolExecutionContext, input: { orderId: string; index: number; approved: boolean; feedback?: string }) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.trade.remoteMilestoneVerify(input.orderId, input.index),
    body: {
      passed: input.approved,
      rejectReason: input.approved ? '' : input.feedback,
    },
    bearerToken: ctx.session.bearerToken,
  });
}

export async function listDisputes(ctx: ToolExecutionContext) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.dispute.list,
    bearerToken: ctx.session.bearerToken,
  });
}

export async function getDispute(ctx: ToolExecutionContext, disputeId: string) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.dispute.detail(disputeId),
    bearerToken: ctx.session.bearerToken,
  });
}

export async function createDispute(ctx: ToolExecutionContext, input: { orderId: string; reason: string }) {
  return ctx.platform.request<unknown>({
    method: 'POST',
    path: PLATFORM_ENDPOINTS.dispute.remoteCreate,
    body: { orderId: input.orderId, reason: input.reason },
    bearerToken: ctx.session.bearerToken,
  });
}
