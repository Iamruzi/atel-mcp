import { randomUUID } from 'node:crypto';
import type { AtelMcpConfig } from '../config.js';
import type { AuditEvent } from '../contracts/audit.js';
import type { AtelRuntimeBackend, AtelUserMode, ExecutionRoutePlan } from '../contracts/runtime.js';
import { PlatformClient } from '../platform/client.js';
import { createAuthIntrospectionClient, type AuthIntrospectionClient } from '../auth/introspection.js';
import { resolveSession } from '../auth/session.js';
import type { AtelSession } from '../auth/types.js';

export interface McpRequestMeta {
  requestId: string;
  toolName: string;
  idempotencyKey?: string;
  hostName?: string;
  userAgent?: string;
  preferredRuntimeBackend?: AtelRuntimeBackend;
  declaredUserMode?: AtelUserMode;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}

export class NoopAuditSink implements AuditSink {
  async emit(_event: AuditEvent): Promise<void> {}
}

export interface McpRequestContext {
  meta: McpRequestMeta;
  session: AtelSession;
  config: AtelMcpConfig;
  platform: PlatformClient;
  executionPlan: ExecutionRoutePlan;
  emitAudit(event: AuditEvent): Promise<void>;
}

export function childAuditBase(ctx: McpRequestContext): Omit<AuditEvent, 'type'> {
  return {
    did: ctx.session.did,
    actor: 'host',
    environment: ctx.session.environment,
    requestId: ctx.meta.requestId,
    toolName: ctx.meta.toolName,
    sessionId: ctx.session.sessionId,
  };
}

export async function buildRequestContext(args: {
  authorization?: string | null;
  requestId?: string;
  toolName: string;
  idempotencyKey?: string;
  hostName?: string;
  userAgent?: string;
  preferredRuntimeBackend?: AtelRuntimeBackend;
  declaredUserMode?: AtelUserMode;
  deps?: {
    auth?: AuthIntrospectionClient;
    audit?: AuditSink;
  };
  config: AtelMcpConfig;
}): Promise<McpRequestContext> {
  const meta: McpRequestMeta = {
    requestId: args.requestId ?? randomUUID(),
    toolName: args.toolName,
    idempotencyKey: args.idempotencyKey,
    hostName: args.hostName,
    userAgent: args.userAgent,
    preferredRuntimeBackend: args.preferredRuntimeBackend,
    declaredUserMode: args.declaredUserMode,
  };

  const auth = args.deps?.auth ?? createAuthIntrospectionClient(args.config);
  const session = await resolveSession(
    { authorization: args.authorization, requestId: meta.requestId, toolName: meta.toolName },
    { auth },
  );

  return {
    meta,
    session,
    config: args.config,
    platform: new PlatformClient(args.config),
    executionPlan: {
      declaredUserMode: args.declaredUserMode,
      selectedBackend: 'platform-hosted',
      executionClass: 'platform-truth-read',
      runtimeEligible: false,
      futureBackends: [],
      runtimeLinkStatus: 'none',
      reason: 'execution plan not resolved yet',
    },
    emitAudit: async (event: AuditEvent) => {
      try {
        await ((args.deps?.audit) ?? new NoopAuditSink()).emit(event);
      } catch (error) {
        console.error('[atel-mcp] audit emit failed', error);
      }
    },
  };
}

export type ToolExecutionContext = McpRequestContext;
