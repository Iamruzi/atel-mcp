import { DisputeCreateInputSchema } from '../contracts/schemas.js';
import { createDispute, getDispute, listDisputes } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';

export async function atelDisputeList(ctx: ToolExecutionContext) {
  requireScope(ctx, 'disputes.read');
  return listDisputes(ctx);
}

export async function atelDisputeGet(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'disputes.read');
  const disputeId = String((input as { disputeId?: unknown })?.disputeId ?? '').trim();
  return getDispute(ctx, disputeId);
}

export async function atelDisputeCreate(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'disputes.write');
  const parsed = DisputeCreateInputSchema.parse(input);
  const result = await createDispute(ctx, parsed);
  const disputeId = typeof (result as { disputeId?: unknown })?.disputeId === 'string' ? String((result as { disputeId?: unknown }).disputeId) : undefined;
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'dispute.created',
    status: 'ok',
    entityType: 'dispute',
    entityId: disputeId,
    orderId: parsed.orderId,
    metadata: { reason: parsed.reason },
  });
  return result;
}
