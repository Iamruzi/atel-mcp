import type { ToolExecutionContext } from '../server/context.js';
import { PLATFORM_ENDPOINTS } from './endpoints.js';

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

export async function getBalance(ctx: ToolExecutionContext) {
  return ctx.platform.request<unknown>({
    method: 'GET',
    path: PLATFORM_ENDPOINTS.account.balance,
    query: { did: ctx.session.did },
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
