import { OrderAcceptInputSchema, OrderCreateInputSchema, OrderIdSchema } from '../contracts/schemas.js';
import { acceptOrder, createOrder, getOrder, getOrderTimeline, listMilestones, listOrders } from '../platform/adapters.js';
import { getRuntimeLinkSecret } from '../runtime-links/store.js';
import { invokeLinkedRuntimeTool } from '../runtime-links/dispatch.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';

export async function atelOrderGet(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.read');
  const orderId = OrderIdSchema.parse((input as { orderId?: unknown })?.orderId);
  return getOrder(ctx, orderId);
}

export async function atelOrderList(ctx: ToolExecutionContext, input?: unknown) {
  requireScope(ctx, 'orders.read');
  const parsed = (input ?? {}) as { role?: string; status?: string };
  return listOrders(ctx, parsed);
}

export async function atelOrderTimeline(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.read');
  const orderId = OrderIdSchema.parse((input as { orderId?: unknown })?.orderId);
  return getOrderTimeline(ctx, orderId);
}

export async function atelOrderCreate(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.write');
  const parsed = OrderCreateInputSchema.parse(input);

  let result: unknown;
  let backend = 'platform-hosted';
  let routeTarget: string | undefined;

  if (ctx.executionPlan.selectedBackend === 'linked-runtime') {
    const runtimeLink = await getRuntimeLinkSecret(ctx.config, ctx.session.did);
    if (!runtimeLink?.endpoint) {
      throw new Error('Linked runtime selected without a registered endpoint');
    }
    result = await invokeLinkedRuntimeTool({
      endpoint: runtimeLink.endpoint,
      authToken: runtimeLink.authToken,
      toolName: 'atel_order_create',
      input: parsed,
      requestId: ctx.meta.requestId,
      idempotencyKey: ctx.meta.idempotencyKey ?? ctx.meta.requestId,
    });
    backend = 'linked-runtime';
    routeTarget = runtimeLink.runtimeDid;
  } else {
    result = await createOrder(ctx, parsed);
  }

  const orderId = typeof (result as { orderId?: unknown })?.orderId === 'string' ? String((result as { orderId?: unknown }).orderId) : undefined;
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'order.created',
    status: 'ok',
    entityType: 'order',
    entityId: orderId,
    orderId,
    peerDid: parsed.executorDid,
    metadata: {
      capabilityType: parsed.capabilityType,
      priceUsdc: parsed.priceUsdc,
      backend,
      routeTarget,
    },
  });
  return result;
}

export async function atelOrderAccept(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.write');
  const orderId = OrderAcceptInputSchema.parse(input).orderId;

  let result: unknown;
  let backend = 'platform-hosted';
  let routeTarget: string | undefined;

  if (ctx.executionPlan.selectedBackend === 'linked-runtime') {
    const runtimeLink = await getRuntimeLinkSecret(ctx.config, ctx.session.did);
    if (!runtimeLink?.endpoint) {
      throw new Error('Linked runtime selected without a registered endpoint');
    }
    result = await invokeLinkedRuntimeTool({
      endpoint: runtimeLink.endpoint,
      authToken: runtimeLink.authToken,
      toolName: 'atel_order_accept',
      input: { orderId },
      requestId: ctx.meta.requestId,
      idempotencyKey: ctx.meta.idempotencyKey ?? ctx.meta.requestId,
    });
    backend = 'linked-runtime';
    routeTarget = runtimeLink.runtimeDid;
  } else {
    result = await acceptOrder(ctx, orderId);
  }

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'order.accepted',
    status: 'ok',
    entityType: 'order',
    entityId: orderId,
    orderId,
    metadata: {
      backend,
      routeTarget,
    },
  });
  return result;
}

export async function atelMilestoneList(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'milestones.read');
  const orderId = OrderIdSchema.parse((input as { orderId?: unknown })?.orderId);
  return listMilestones(ctx, orderId);
}
