import type { AuditSink } from './context.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';
import { buildRequestContext, childAuditBase } from './context.js';
import { AtelMcpError } from '../contracts/errors.js';
import { TOOL_SCOPE_REQUIREMENTS } from '../contracts/scopes.js';
import { assertRemoteEnvironmentAllowed, assertScopes } from '../auth/guards.js';
import { getToolHandler, hasTool, type ToolName } from './tool-registry.js';
import type { AtelMcpConfig } from '../config.js';

export interface DispatchToolInput {
  toolName: string;
  input?: unknown;
  authorization?: string | null;
  requestId?: string;
  idempotencyKey?: string;
  hostName?: string;
  userAgent?: string;
  config: AtelMcpConfig;
  audit?: AuditSink;
  auth?: AuthIntrospectionClient;
}

export async function dispatchTool(args: DispatchToolInput): Promise<unknown> {
  if (!hasTool(args.toolName)) {
    throw new AtelMcpError('NOT_FOUND', `Unknown tool: ${args.toolName}`);
  }

  const ctx = await buildRequestContext({
    authorization: args.authorization,
    requestId: args.requestId,
    toolName: args.toolName,
    idempotencyKey: args.idempotencyKey,
    hostName: args.hostName,
    userAgent: args.userAgent,
    config: args.config,
    deps: { audit: args.audit, auth: args.auth },
  });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'auth.session_resolved',
    status: 'ok',
    entityType: 'session',
    entityId: ctx.session.sessionId,
    metadata: {
      scopes: ctx.session.scopes,
      clientId: ctx.session.clientId,
    },
  });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.invoked',
    status: 'ok',
    entityType: 'request',
    entityId: ctx.meta.requestId,
  });

  try {
    assertRemoteEnvironmentAllowed(ctx.session, args.config.allowCustomRemoteMcp ? ['production', 'custom'] : ['production']);
    const requirements = TOOL_SCOPE_REQUIREMENTS[args.toolName];
    if (requirements) assertScopes(ctx.session, { requireAll: requirements.all, requireAny: requirements.any });
  } catch (error) {
    await ctx.emitAudit({
      ...childAuditBase(ctx),
      type: 'guard.rejected',
      status: 'rejected',
      entityType: 'request',
      entityId: ctx.meta.requestId,
      errorCode: error instanceof AtelMcpError ? error.code : undefined,
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }

  const handler = getToolHandler(args.toolName as ToolName);
  try {
    const result = await handler(ctx as never, args.input as never);
    await ctx.emitAudit({
      ...childAuditBase(ctx),
      type: 'tool.succeeded',
      status: 'ok',
      entityType: 'request',
      entityId: ctx.meta.requestId,
    });
    return result;
  } catch (error) {
    await ctx.emitAudit({
      ...childAuditBase(ctx),
      type: 'tool.failed',
      status: 'error',
      entityType: 'request',
      entityId: ctx.meta.requestId,
      errorCode: error instanceof AtelMcpError ? error.code : undefined,
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
