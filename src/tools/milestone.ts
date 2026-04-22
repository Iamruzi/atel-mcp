import { MilestoneActionInputSchema, MilestoneSubmitInputSchema } from '../contracts/schemas.js';
import { submitMilestone, verifyMilestone } from '../platform/adapters.js';
import { getRuntimeLinkSecret } from '../runtime-links/store.js';
import { invokeLinkedRuntimeTool } from '../runtime-links/dispatch.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';

export async function atelMilestoneSubmit(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'milestones.write');
  const parsed = MilestoneSubmitInputSchema.parse(input);

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
      toolName: 'atel_milestone_submit',
      input: parsed,
      requestId: ctx.meta.requestId,
      idempotencyKey: ctx.meta.idempotencyKey ?? ctx.meta.requestId,
    });
    backend = 'linked-runtime';
    routeTarget = runtimeLink.runtimeDid;
  } else {
    result = await submitMilestone(ctx, parsed);
  }

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'milestone.submitted',
    status: 'ok',
    entityType: 'milestone',
    entityId: `${parsed.orderId}:${parsed.index}`,
    orderId: parsed.orderId,
    milestoneIndex: parsed.index,
    metadata: { backend, routeTarget },
  });
  return result;
}

export async function atelMilestoneVerify(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'milestones.write');
  const parsed = MilestoneActionInputSchema.parse(input);

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
      toolName: 'atel_milestone_verify',
      input: parsed,
      requestId: ctx.meta.requestId,
      idempotencyKey: ctx.meta.idempotencyKey ?? ctx.meta.requestId,
    });
    backend = 'linked-runtime';
    routeTarget = runtimeLink.runtimeDid;
  } else {
    result = await verifyMilestone(ctx, { ...parsed, approved: true });
  }

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'milestone.verified',
    status: 'ok',
    entityType: 'milestone',
    entityId: `${parsed.orderId}:${parsed.index}`,
    orderId: parsed.orderId,
    milestoneIndex: parsed.index,
    metadata: { backend, routeTarget },
  });
  return result;
}

export function milestoneRejectAuditTypeFromOutcome(outcome: string) {
  if (outcome === 'arbitration_passed') return 'milestone.arbitration_passed' as const;
  if (outcome === 'arbitration_failed') return 'milestone.arbitration_failed' as const;
  return 'milestone.rejected' as const;
}

export async function atelMilestoneReject(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'milestones.write');
  const parsed = MilestoneSubmitInputSchema.pick({ orderId: true, index: true, content: true }).parse(input);

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
      toolName: 'atel_milestone_reject',
      input: parsed,
      requestId: ctx.meta.requestId,
      idempotencyKey: ctx.meta.idempotencyKey ?? ctx.meta.requestId,
    });
    backend = 'linked-runtime';
    routeTarget = runtimeLink.runtimeDid;
  } else {
    result = await verifyMilestone(ctx, { orderId: parsed.orderId, index: parsed.index, approved: false, feedback: parsed.content });
  }

  const resultRecord = (result && typeof result === 'object') ? (result as Record<string, unknown>) : {};
  const outcome = String(resultRecord.status ?? 'rejected');
  const auditType = milestoneRejectAuditTypeFromOutcome(outcome);
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: auditType,
    status: 'ok',
    entityType: 'milestone',
    entityId: `${parsed.orderId}:${parsed.index}`,
    orderId: parsed.orderId,
    milestoneIndex: parsed.index,
    metadata: { feedback: parsed.content, outcome, reason: resultRecord.reason, message: resultRecord.message, backend, routeTarget },
  });
  return result;
}
