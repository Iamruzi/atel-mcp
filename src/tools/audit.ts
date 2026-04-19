import { AuditOrderQueryInputSchema, AuditSessionQueryInputSchema } from '../contracts/schemas.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { queryAuditByOrder, queryAuditBySession } from '../audit/query.js';

export async function atelAuditOrderGet(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'orders.read');
  const parsed = AuditOrderQueryInputSchema.parse(input);
  const events = await queryAuditByOrder(ctx.config, ctx.session.did, parsed.orderId, parsed.limit);
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'order',
    entityId: parsed.orderId,
    orderId: parsed.orderId,
    metadata: { auditQuery: 'order', returned: events.length },
  });
  return { orderId: parsed.orderId, events };
}

export async function atelAuditSessionGet(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  const parsed = AuditSessionQueryInputSchema.parse(input ?? {});
  const sessionId = parsed.sessionId ?? ctx.session.sessionId;
  const events = await queryAuditBySession(ctx.config, ctx.session.did, sessionId, parsed.limit);
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'session',
    entityId: sessionId,
    metadata: { auditQuery: 'session', returned: events.length },
  });
  return { sessionId, events };
}
