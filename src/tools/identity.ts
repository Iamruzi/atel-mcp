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

export async function atelRuntimeLinkStatus(ctx: ToolExecutionContext) {
  requireScope(ctx, 'identity.read');
  const runtimeLink = await getRuntimeLink(ctx.config, ctx.session.did);
  return RuntimeLinkStatusOutputSchema.parse({
    did: ctx.session.did,
    linked: Boolean(runtimeLink),
    runtimeLink,
    executionPlan: ctx.executionPlan,
    architecture: runtimeArchitecture(ctx),
  });
}

export async function atelRuntimeLinkBind(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
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

export async function atelRuntimeLinkUnbind(ctx: ToolExecutionContext) {
  requireScope(ctx, 'identity.read');
  const removed = await removeRuntimeLink(ctx.config, ctx.session.did);
  return RuntimeLinkMutationOutputSchema.parse({
    did: ctx.session.did,
    action: 'unbind',
    changed: removed,
    linked: false,
    runtimeLink: null,
  });
}
