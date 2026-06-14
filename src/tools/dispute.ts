import { DisputeCreateInputSchema, DisputeResolveInputSchema } from '../contracts/schemas.js';
import { createDispute, getDispute, listDisputes, resolveDispute } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { assertPrerequisite } from '../auth/guards.js';
import { disputeRejectThresholdMet } from '../auth/prerequisites.js';

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
  // T3.6.1: require >=3 rejections on at least one milestone before
  // accepting a dispute. Stops the "open a dispute on first reject"
  // failure mode that floods the arbitration queue.
  await assertPrerequisite(ctx.session, () => disputeRejectThresholdMet(ctx, parsed.orderId));
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

/**
 * T3.6.2 — Submit arbitration verdict. High-risk: this is what releases
 * locked escrow funds in the disputed split. dispute.resolve scope is
 * NOT default-granted; it sits in the high-risk tier alongside wallet
 * write actions. Platform-side enforces the arbitrator allowlist.
 *
 * Verdict semantics:
 *   - favor_requester: full escrow returns to requester
 *   - favor_executor:  full escrow goes to executor (treats work as accepted)
 *   - split:           escrow split per splitRatio (0..1, fraction to requester)
 */
export async function atelDisputeResolve(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'dispute.resolve');
  const parsed = DisputeResolveInputSchema.parse(input);
  const result = await resolveDispute(ctx, parsed);
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'dispute',
    entityId: parsed.disputeId,
    metadata: {
      action: 'resolve',
      verdict: parsed.verdict,
      splitRatio: parsed.splitRatio,
    },
  });
  return result;
}
