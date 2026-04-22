import { AckInputSchema, SendMessageInputSchema } from '../contracts/schemas.js';
import { ackInbox, listContacts, listInbox, sendMessage } from '../platform/adapters.js';
import { getRuntimeLinkSecret } from '../runtime-links/store.js';
import { invokeLinkedRuntimeTool } from '../runtime-links/dispatch.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';

export async function atelContactsList(ctx: ToolExecutionContext) {
  requireScope(ctx, 'contacts.read');
  return listContacts(ctx);
}

export async function atelInboxList(ctx: ToolExecutionContext) {
  requireScope(ctx, 'messages.read');
  return listInbox(ctx);
}

export async function atelSendMessage(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'messages.write');
  const parsed = SendMessageInputSchema.parse(input);

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
      toolName: 'atel_send_message',
      input: parsed,
      requestId: ctx.meta.requestId,
      idempotencyKey: ctx.meta.idempotencyKey ?? ctx.meta.requestId,
    });
    backend = 'linked-runtime';
    routeTarget = runtimeLink.runtimeDid;
  } else {
    result = await sendMessage(ctx, parsed);
  }

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'message.sent',
    status: 'ok',
    entityType: 'message',
    entityId: typeof (result as { id?: unknown })?.id === 'string' ? String((result as { id?: unknown }).id) : undefined,
    peerDid: parsed.peerDid,
    metadata: { kind: 'text', backend, routeTarget },
  });
  return result;
}

export async function atelAck(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'messages.write');
  const parsed = AckInputSchema.parse(input);
  const result = await ackInbox(ctx, parsed.messageIds);
  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'message.acked',
    status: 'ok',
    entityType: 'message',
    entityId: parsed.messageIds.join(','),
    metadata: { messageIds: parsed.messageIds },
  });
  return result;
}
