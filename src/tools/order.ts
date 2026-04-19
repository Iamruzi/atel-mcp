import { OrderAcceptInputSchema, OrderCreateInputSchema, OrderIdSchema } from '../contracts/schemas.js';
import { acceptOrder, createOrder, getOrder, getOrderTimeline, listMilestones, listOrders } from '../platform/adapters.js';
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
  const result = await createOrder(ctx, parsed);
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
    },
  });
  return result;
}

export async function atelOrderAccept(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.write');
  const orderId = OrderAcceptInputSchema.parse(input).orderId;
  const result = await acceptOrder(ctx, orderId);
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'order.accepted',
    status: 'ok',
    entityType: 'order',
    entityId: orderId,
    orderId,
  });
  return result;
}

export async function atelMilestoneList(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'milestones.read');
  const orderId = OrderIdSchema.parse((input as { orderId?: unknown })?.orderId);
  return listMilestones(ctx, orderId);
}
