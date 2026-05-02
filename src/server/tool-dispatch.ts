import { randomUUID } from 'node:crypto';
import type { AuditSink, ToolExecutionContext } from './context.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';
import { buildRequestContext, NoopAuditSink, childAuditBase } from './context.js';
import { AtelMcpError } from '../contracts/errors.js';
import { TOOL_SCOPE_REQUIREMENTS } from '../contracts/scopes.js';
import { assertRemoteEnvironmentAllowed, assertScopes } from '../auth/guards.js';
import { getToolHandler, hasTool, type ToolName } from './tool-registry.js';
import { buildExecutionRoutePlan } from './execution-routing.js';
import { getRuntimeLink } from '../runtime-links/store.js';
import { isPreAuthTool } from './pre-auth.js';
import { PlatformClient } from '../platform/client.js';
import { recordToolCall, recordDispatch } from './metrics.js';
import type { AtelMcpConfig } from '../config.js';

export interface DispatchToolInput {
  toolName: string;
  input?: unknown;
  authorization?: string | null;
  requestId?: string;
  idempotencyKey?: string;
  hostName?: string;
  userAgent?: string;
  preferredRuntimeBackend?: 'platform-hosted' | 'sdk-runtime' | 'linked-runtime';
  declaredUserMode?: 'mcp-only' | 'runtime-only' | 'mcp-plus-runtime';
  config: AtelMcpConfig;
  audit?: AuditSink;
  auth?: AuthIntrospectionClient;
}

export async function dispatchTool(args: DispatchToolInput): Promise<unknown> {
  if (!hasTool(args.toolName)) {
    throw new AtelMcpError('NOT_FOUND', `Unknown tool: ${args.toolName}`);
  }

  // Pre-auth tools bypass session resolution because there's no identity
  // yet (e.g. atel_register_user mints the first one). They share the
  // same audit + handler-call shape but skip introspection / scope check.
  if (isPreAuthTool(args.toolName)) {
    return dispatchPreAuthTool(args);
  }

  const ctx = await buildRequestContext({
    authorization: args.authorization,
    requestId: args.requestId,
    toolName: args.toolName,
    idempotencyKey: args.idempotencyKey,
    hostName: args.hostName,
    userAgent: args.userAgent,
    preferredRuntimeBackend: args.preferredRuntimeBackend,
    declaredUserMode: args.declaredUserMode,
    config: args.config,
    deps: { audit: args.audit, auth: args.auth },
  });

  // Skip the runtime-link lookup entirely when the subsystem is disabled.
  // Saves one JSON file read per dispatch and keeps the dispatch hot path
  // free of legacy code once production flips the flag off.
  const runtimeLink = args.config.runtimeLinksEnabled
    ? await getRuntimeLink(args.config, ctx.session.did)
    : null;

  ctx.executionPlan = buildExecutionRoutePlan({
    toolName: args.toolName,
    config: args.config,
    preferredBackend: args.preferredRuntimeBackend,
    userMode: args.declaredUserMode,
    runtimeLink,
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
      executionPlan: ctx.executionPlan,
    },
  });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.invoked',
    status: 'ok',
    entityType: 'request',
    entityId: ctx.meta.requestId,
    metadata: { executionPlan: ctx.executionPlan },
  });

  try {
    assertRemoteEnvironmentAllowed(ctx.session, args.config.allowCustomRemoteMcp ? ['production', 'custom'] : ['production']);
    const requirements = TOOL_SCOPE_REQUIREMENTS[args.toolName];
    if (requirements) assertScopes(ctx.session, { requireAll: requirements.all, requireAny: requirements.any });
    recordDispatch(args.toolName, 'ok');
  } catch (error) {
    recordDispatch(args.toolName, 'denied');
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
  const handlerStart = Date.now();
  try {
    const result = await handler(ctx as never, args.input as never);
    recordToolCall(args.toolName, 'ok', Date.now() - handlerStart);
    await ctx.emitAudit({
      ...childAuditBase(ctx),
      type: 'tool.succeeded',
      status: 'ok',
      entityType: 'request',
      entityId: ctx.meta.requestId,
    });
    return result;
  } catch (error) {
    recordToolCall(args.toolName, 'error', Date.now() - handlerStart);
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

/**
 * Dispatch path for tools that don't require an authenticated session.
 * Builds a stripped context (placeholder session) so handlers see the
 * same shape, but skips introspection / scope / runtime-link lookups.
 *
 * Audit still runs — pre-auth traffic is the most security-sensitive
 * surface; we want every register call captured.
 */
async function dispatchPreAuthTool(args: DispatchToolInput): Promise<unknown> {
  const requestId = args.requestId ?? randomUUID();
  const audit = args.audit ?? new NoopAuditSink();

  const ctx = {
    meta: {
      requestId,
      toolName: args.toolName,
      idempotencyKey: args.idempotencyKey,
      hostName: args.hostName,
      userAgent: args.userAgent,
      preferredRuntimeBackend: args.preferredRuntimeBackend,
      declaredUserMode: args.declaredUserMode,
    },
    // Placeholder session — handlers can read .environment and read-only
    // fields but should NOT use .did or .bearerToken (these are empty
    // strings; pre-auth handlers must talk to platform with no bearer).
    session: {
      subject: '',
      did: '',
      environment: args.config.environment,
      scopes: [],
      bearerToken: '',
      sessionId: 'pre-auth',
      expiresAt: 0,
    },
    config: args.config,
    // Pre-auth has no DID → shared "pre-auth" rate-limit bucket.
    // Prevents register/recover flood from N fresh request ids.
    platform: new PlatformClient(args.config, args.idempotencyKey ?? requestId, 'pre-auth'),
    executionPlan: {
      selectedBackend: 'platform-hosted' as const,
      executionClass: 'platform-state-write' as const,
      runtimeEligible: false,
      futureBackends: [],
      runtimeLinkStatus: 'none' as const,
      reason: 'pre-auth tool — no execution routing',
    },
    emitAudit: async (event: import('../contracts/audit.js').AuditEvent) => {
      try {
        await audit.emit(event);
      } catch (e) {
        console.error('[atel-mcp] pre-auth audit emit failed', e);
      }
    },
  } as unknown as ToolExecutionContext;

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.invoked',
    status: 'ok',
    entityType: 'request',
    entityId: requestId,
    metadata: { preAuth: true },
  });

  const handler = getToolHandler(args.toolName as ToolName);
  try {
    const result = await handler(ctx as never, args.input as never);
    await ctx.emitAudit({
      ...childAuditBase(ctx),
      type: 'tool.succeeded',
      status: 'ok',
      entityType: 'request',
      entityId: requestId,
      metadata: { preAuth: true },
    });
    return result;
  } catch (error) {
    await ctx.emitAudit({
      ...childAuditBase(ctx),
      type: 'tool.failed',
      status: 'error',
      entityType: 'request',
      entityId: requestId,
      errorCode: error instanceof AtelMcpError ? error.code : undefined,
      metadata: {
        preAuth: true,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
