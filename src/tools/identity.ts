import {
  AgentRegisterInputSchema,
  AgentSearchInputSchema,
  RecoverInputSchema,
  RegisterEndpointInputSchema,
  RegisterUserInputSchema,
  RuntimeLinkBindInputSchema,
  RuntimeLinkMutationOutputSchema,
  RuntimeLinkStatusOutputSchema,
  WhoamiOutputSchema,
} from '../contracts/schemas.js';
import { recoverIdentity, recoverSecretKey, registerUser, registryRegister, registrySearch, registryUpdateEndpoint } from '../platform/adapters.js';
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

/**
 * Pre-auth recovery tool. User submits the recovery code returned by
 * atel_register_user; gets back the DID. Pairs with their stored
 * secretKey (which they MUST have) to resume operation via DID-Sig.
 *
 * This is a DID lookup, not a secretKey recovery. Lost secretKey is
 * still lost — by design, until KEK custody arrives.
 */
export async function atelRecover(ctx: ToolExecutionContext, input: unknown) {
  const parsed = RecoverInputSchema.parse(input);
  return recoverIdentity(ctx.config, parsed);
}

/**
 * Recover the full secretKey for a DID using its recoveryCode. Different
 * from atelRecover above: that one only returns the DID; this one returns
 * the actual secretKey, which the caller can use to rebuild
 * .atel/identity.json on a fresh machine after losing the local copy.
 *
 * Requires server-side KEK backup (mcp_secret_key_backups row); identities
 * registered before that feature shipped get 410 Gone with a hint.
 */
export async function atelSecretKeyRecover(ctx: ToolExecutionContext, input: unknown) {
  const parsed = RecoverInputSchema.parse(input);
  return recoverSecretKey(ctx.config, parsed);
}

export async function atelAgentRegister(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  return registryRegister(ctx, AgentRegisterInputSchema.parse(input));
}

export async function atelAgentSearch(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  return registrySearch(ctx, AgentSearchInputSchema.parse(input));
}

/**
 * Register a callback URL the platform can use to push async events
 * (order_accepted / milestone callbacks / settlement notifications).
 *
 * Server-side guarantees (see atel-platform/internal/registry/endpoint_handler.go):
 *   - HTTPS required (http:// rejected with hint)
 *   - Reachability verified via HEAD request before persisting
 *   - URL de-duped so re-registering the same URL doesn't bloat candidates
 *
 * Use case: SDK / OpenClaw / self-hosted agents need this. Pure MCP-only
 * users (no local runtime) can skip it — they get events via polling
 * (atel_inbox_list) instead.
 */
export async function atelRegisterEndpoint(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'identity.read');
  const parsed = RegisterEndpointInputSchema.parse(input);
  return registryUpdateEndpoint(ctx, parsed);
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
