import {
  AgentRegisterInputSchema,
  AgentSearchInputSchema,
  RegisterUserInputSchema,
  RuntimeLinkBindInputSchema,
  RuntimeLinkMutationOutputSchema,
  RuntimeLinkStatusOutputSchema,
  WhoamiOutputSchema,
} from '../contracts/schemas.js';
import { registerUser, registryRegister, registrySearch } from '../platform/adapters.js';
import { getRuntimeLink, removeRuntimeLink, upsertRuntimeLink } from '../runtime-links/store.js';
import type { ToolExecutionContext } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { AtelMcpError } from '../contracts/errors.js';

/**
 * Throw NOT_IMPLEMENTED if runtime-links subsystem is turned off in config.
 * The 3 runtime-link tools share this guard so deployments that opt out
 * (e.g. an MCP host that does not serve OpenClaw / 龙虾 users) give a
 * single, explainable error to every caller.
 */
function assertRuntimeLinksEnabled(ctx: ToolExecutionContext): void {
  if (!ctx.config.runtimeLinksEnabled) {
    throw new AtelMcpError(
      'NOT_IMPLEMENTED',
      'Runtime-links subsystem is disabled on this MCP server',
      { configFlag: 'ATEL_MCP_RUNTIME_LINKS_ENABLED' },
      'This MCP host is not configured to serve OpenClaw / 龙虾 runtime bindings. Contact ops if your DID needs runtime forwarding here, or use a host that has runtime-links enabled (the default).',
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

/**
 * Pre-auth onboarding tool. Mints a fresh ATEL identity end-to-end so
 * external hosts (Claude Desktop / Cursor / Codex / OpenClaw etc.) can
 * give brand-new users access without a separate dashboard signup step.
 *
 * Returns:
 *   - did: the new identity (did:atel:ed25519:<base58>)
 *   - secretKey: ed25519 64-byte key (base64) — caller MUST persist
 *     this securely (e.g. ~/.atel/identity.json). Server does not keep
 *     a copy in this version (no KEK custody yet).
 *   - publicKey: base58-encoded 32-byte public key
 *   - token: 7-day JWT bearer for immediate use
 *   - walletStatus: "pending" — caller polls atel_balance later until
 *     wallet addresses appear (T3.1.2 will surface a dedicated tool)
 *
 * Bypass for the usual scope check happens in dispatch (PRE_AUTH_TOOLS).
 */
export async function atelRegisterUser(ctx: ToolExecutionContext, input: unknown) {
  // No scope/auth check — dispatch already routed via the pre-auth path.
  const parsed = RegisterUserInputSchema.parse(input ?? {});
  const result = await registerUser(ctx.config, {
    name: parsed.name,
    sourceLabel: parsed.sourceLabel ?? ctx.meta.hostName ?? 'mcp-host',
  });
  return result;
}

export async function atelAgentRegister(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  return registryRegister(ctx, AgentRegisterInputSchema.parse(input));
}

export async function atelAgentSearch(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  return registrySearch(ctx, AgentSearchInputSchema.parse(input));
}

/** Runtime-link surface for OpenClaw / 龙虾 binding. Gated by config.runtimeLinksEnabled (default on). */
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

/** Runtime-link surface for OpenClaw / 龙虾 binding. Gated by config.runtimeLinksEnabled (default on). */
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

/** Runtime-link surface for OpenClaw / 龙虾 binding. Gated by config.runtimeLinksEnabled (default on). */
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
