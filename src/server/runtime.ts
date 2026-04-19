import { loadConfig } from '../config.js';
import { AtelMcpError } from '../contracts/errors.js';
import { TOOL_SCOPE_REQUIREMENTS } from '../contracts/scopes.js';
import { buildRequestContext, childAuditBase, type AuditSink } from './context.js';
import { assertRemoteEnvironmentAllowed, assertScopes } from '../auth/guards.js';
import { getToolHandler, hasTool } from './tool-registry.js';

export interface InvokeToolInput {
  toolName: string;
  authorization?: string | null;
  input?: unknown;
  requestId?: string;
  idempotencyKey?: string;
  hostName?: string;
  userAgent?: string;
}

export interface InvokeToolResult {
  ok: true;
  toolName: string;
  requestId: string;
  data: unknown;
}

export class ToolRuntime {
  constructor(private readonly audit?: AuditSink) {}

  async invoke(input: InvokeToolInput): Promise<InvokeToolResult> {
    if (!hasTool(input.toolName)) {
      throw new AtelMcpError('NOT_FOUND', `Unknown tool: ${input.toolName}`);
    }

    const ctx = await buildRequestContext({
      authorization: input.authorization,
      requestId: input.requestId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      hostName: input.hostName,
      userAgent: input.userAgent,
      config: loadConfig(),
      deps: { audit: this.audit },
    });

    assertRemoteEnvironmentAllowed(ctx.session);
    const requirements = TOOL_SCOPE_REQUIREMENTS[input.toolName];
    if (requirements) assertScopes(ctx.session, { requireAll: requirements.all, requireAny: requirements.any });

    const handler = getToolHandler(input.toolName);
    try {
      const data = await handler(ctx as never, input.input as never);
      await ctx.emitAudit({
        ...childAuditBase(ctx),
        type: 'tool.succeeded',
        status: 'ok',
        entityType: 'request',
        entityId: ctx.meta.requestId,
      });
      return { ok: true, toolName: input.toolName, requestId: ctx.meta.requestId, data };
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
}
