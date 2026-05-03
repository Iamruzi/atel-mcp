import { OrderAcceptInputSchema, OrderCompleteInputSchema, OrderConfirmInputSchema, OrderCreateInputSchema, OrderIdSchema } from '../contracts/schemas.js';
import { acceptOrder, completeOrder, confirmOrder, createOrder, getOrder, getOrderTimeline, listMilestones, listOrders } from '../platform/adapters.js';
import { getCapabilityRegistry, validateCapability } from '../platform/capability-cache.js';
import { getRuntimeLinkSecret } from '../runtime-links/store.js';
import { invokeLinkedRuntimeTool } from '../runtime-links/dispatch.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { assertPrerequisite } from '../auth/guards.js';
import { executorReady, sufficientBalance, walletReady, orderInStatus, callerIsRole } from '../auth/prerequisites.js';
import { AtelMcpError } from '../contracts/errors.js';

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

  // Validate capability against the platform's standard registry. Cuts
  // the "host LLM invents capability string" drift case at the MCP layer
  // before any platform round-trip. Aliases (e.g. "code" → "coding") are
  // accepted and normalized so we forward the canonical name to platform.
  const registry = await getCapabilityRegistry(ctx.config);
  const capCheck = validateCapability(registry, parsed.capabilityType);
  if (!capCheck.ok) {
    throw new AtelMcpError(
      'INVALID_INPUT',
      `Unknown capabilityType: ${parsed.capabilityType}`,
      { suggested: capCheck.suggestion, valid: registry.capabilities },
      capCheck.hint,
    );
  }
  // Forward the normalized canonical name to platform, not the raw input.
  parsed.capabilityType = capCheck.normalized;

  // Reject before locking funds: executor exists & online & has the capability,
  // requester wallet on base is deployed, requester has price + 5% gas buffer.
  // Without these, order goes onchain → escrow lock → executor can never accept
  // (offline / wrong skill) → order expires → user waits + frustration.
  await assertPrerequisite(ctx.session, () => executorReady(ctx, parsed.executorDid, parsed.capabilityType));
  await assertPrerequisite(ctx.session, () => walletReady(ctx, 'base'));
  await assertPrerequisite(ctx.session, () => sufficientBalance(ctx, 'base', parsed.priceUsdc));

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

  // Server-side state-machine enforcement: order must be in a pre-acceptance
  // state + caller must be the assigned executor. Stops host LLM from
  // "accepting" an order that's already executing or that someone else owns.
  // Platform sets status='created' at INSERT (see internal/trade/handler.go
  // INSERT INTO orders ... 'created' ...); we accept the equivalent older
  // names 'pending' / 'pending_acceptance' too for forward-compat.
  await assertPrerequisite(ctx.session, () => orderInStatus(ctx, orderId, ['created', 'pending', 'pending_acceptance']));
  await assertPrerequisite(ctx.session, () => callerIsRole(ctx, orderId, 'executor'));

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

export async function atelOrderComplete(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.write');
  const parsed = OrderCompleteInputSchema.parse(input);
  const result = await completeOrder(ctx, parsed);

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'order.completed',
    status: 'ok',
    entityType: 'order',
    entityId: parsed.orderId,
    orderId: parsed.orderId,
    metadata: {
      backend: 'platform-hosted',
      chain: parsed.chain,
    },
  });
  return result;
}

export async function atelOrderConfirm(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.write');
  const orderId = OrderConfirmInputSchema.parse(input).orderId;
  const result = await confirmOrder(ctx, orderId);

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'order.confirmed',
    status: 'ok',
    entityType: 'order',
    entityId: orderId,
    orderId,
    metadata: {
      backend: 'platform-hosted',
    },
  });
  return result;
}

export async function atelMilestoneList(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'milestones.read');
  const orderId = OrderIdSchema.parse((input as { orderId?: unknown })?.orderId);
  return listMilestones(ctx, orderId);
}
