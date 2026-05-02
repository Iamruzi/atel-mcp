import {
  AgentRegisterInputSchema,
  AgentSearchInputSchema,
  RuntimeLinkBindInputSchema,
  RuntimeLinkMutationOutputSchema,
  RuntimeLinkStatusOutputSchema,
  WhoamiOutputSchema,
} from '../contracts/schemas.js';
import { registryRegister, registrySearch } from '../platform/adapters.js';
import { getRuntimeLink, removeRuntimeLink, upsertRuntimeLink } from '../runtime-links/store.js';
import type { ToolExecutionContext } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { AtelMcpError } from '../contracts/errors.js';

/**
 * Throw NOT_IMPLEMENTED if runtime-links subsystem is turned off in config.
 * The 3 runtime-link tools share this guard so flipping the config flag in
 * production gives a single, explainable error to every caller.
 */
function assertRuntimeLinksEnabled(ctx: ToolExecutionContext): void {
  if (!ctx.config.runtimeLinksEnabled) {
    throw new AtelMcpError(
      'NOT_IMPLEMENTED',
      'Runtime-links subsystem is disabled on this MCP server',
      { configFlag: 'ATEL_MCP_RUNTIME_LINKS_ENABLED' },
      'This deployment has phased out the legacy linked-runtime backend. Use platform-hosted dispatch (the default) or contact ops if you have an OpenClaw plugin runtime that still needs binding.',
    );
  }
}

function runtimeArchitecture(ctx: ToolExecutionContext) {
  return {
    userEntryMode: ctx.config.userEntryMode,
    runtimeRole: ctx.config.runtimeRole,
    runtimeBackends: ctx.config.runtimeBackends,
    supportedUserModes: ctx.config.supportedUserModes,
    sourceOfTruth: 'platform' as const,
  };
}

export async function atelWhoami(ctx: ToolExecutionContext) {
  requireScope(ctx, 'identity.read');
  const output = {
    did: ctx.session.did,
    environment: ctx.session.environment,
    scopes: ctx.session.scopes,
  };
  return WhoamiOutputSchema.parse(output);
}

export async function atelAgentRegister(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  return registryRegister(ctx, AgentRegisterInputSchema.parse(input));
}

export async function atelAgentSearch(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  return registrySearch(ctx, AgentSearchInputSchema.parse(input));
}

/** @deprecated runtime-links subsystem is on the退场 path. See config.runtimeLinksEnabled. */
export async function atelRuntimeLinkStatus(ctx: ToolExecutionContext) {
  requireScope(ctx, 'identity.read');
  assertRuntimeLinksEnabled(ctx);
  const runtimeLink = await getRuntimeLink(ctx.config, ctx.session.did);
  return RuntimeLinkStatusOutputSchema.parse({
    did: ctx.session.did,
    linked: Boolean(runtimeLink),
    runtimeLink,
    executionPlan: ctx.executionPlan,
    architecture: runtimeArchitecture(ctx),
  });
}

/** @deprecated runtime-links subsystem is on the退场 path. See config.runtimeLinksEnabled. */
export async function atelRuntimeLinkBind(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  assertRuntimeLinksEnabled(ctx);
  const payload = RuntimeLinkBindInputSchema.parse(input);
  const runtimeLink = await upsertRuntimeLink(ctx.config, {
    hostedDid: ctx.session.did,
    runtimeDid: payload.runtimeDid,
    backend: payload.backend,
    endpoint: payload.endpoint,
    relayBaseUrl: payload.relayBaseUrl,
    authToken: payload.authToken,
    status: payload.status,
    lastSeenAt: new Date().toISOString(),
  });
  return RuntimeLinkMutationOutputSchema.parse({
    did: ctx.session.did,
    action: 'bind',
    changed: true,
    linked: true,
    runtimeLink,
  });
}

/** @deprecated runtime-links subsystem is on the退场 path. See config.runtimeLinksEnabled. */
export async function atelRuntimeLinkUnbind(ctx: ToolExecutionContext) {
  requireScope(ctx, 'identity.read');
  assertRuntimeLinksEnabled(ctx);
  const removed = await removeRuntimeLink(ctx.config, ctx.session.did);
  return RuntimeLinkMutationOutputSchema.parse({
    did: ctx.session.did,
    action: 'unbind',
    changed: removed,
    linked: false,
    runtimeLink: null,
  });
}
