import type { AtelMcpConfig } from '../config.js';
import type { AtelRuntimeBackend, AtelUserMode, ExecutionRoutePlan, RuntimeLinkRecord } from '../contracts/runtime.js';

const RUNTIME_CAPABLE_TOOLS = new Set<string>([
  'atel_send_message',
  'atel_order_create',
  'atel_order_accept',
  'atel_milestone_submit',
  'atel_milestone_verify',
  'atel_milestone_reject',
  'atel_dispute_create',
]);

const LINKED_RUNTIME_ENABLED_TOOLS = new Set<string>([
  'atel_send_message',
  'atel_order_create',
  'atel_order_accept',
  'atel_milestone_submit',
  'atel_milestone_verify',
  'atel_milestone_reject',
]);

const PLATFORM_STATE_WRITE_TOOLS = new Set<string>([
  'atel_agent_register',
  'atel_ack',
  'atel_order_create',
  'atel_order_accept',
  'atel_milestone_submit',
  'atel_milestone_verify',
  'atel_milestone_reject',
  'atel_dispute_create',
]);

function normalizeBackend(value?: string): AtelRuntimeBackend | undefined {
  if (value === 'platform-hosted' || value === 'sdk-runtime' || value === 'linked-runtime') return value;
  return undefined;
}

function normalizeUserMode(value?: string): AtelUserMode | undefined {
  if (value === 'mcp-only' || value === 'runtime-only' || value === 'mcp-plus-runtime') return value;
  return undefined;
}

export function parsePreferredRuntimeBackend(value?: string): AtelRuntimeBackend | undefined {
  return normalizeBackend(value?.trim());
}

export function parseDeclaredUserMode(value?: string): AtelUserMode | undefined {
  return normalizeUserMode(value?.trim());
}

function linkedRuntimeSelectable(toolName: string, runtimeLink?: RuntimeLinkRecord | null): boolean {
  return LINKED_RUNTIME_ENABLED_TOOLS.has(toolName)
    && runtimeLink?.backend === 'linked-runtime'
    && Boolean(runtimeLink.endpoint);
}

export function buildExecutionRoutePlan(args: {
  toolName: string;
  config: AtelMcpConfig;
  preferredBackend?: AtelRuntimeBackend;
  userMode?: AtelUserMode;
  runtimeLink?: RuntimeLinkRecord | null;
}): ExecutionRoutePlan {
  const runtimeEligible = RUNTIME_CAPABLE_TOOLS.has(args.toolName);
  const executionClass = runtimeEligible
    ? 'runtime-capable'
    : (PLATFORM_STATE_WRITE_TOOLS.has(args.toolName) ? 'platform-state-write' : 'platform-truth-read');

  const configuredBackends = args.config.runtimeBackends.filter((item): item is AtelRuntimeBackend =>
    item === 'platform-hosted' || item === 'sdk-runtime' || item === 'linked-runtime'
  );

  const futureBackends: AtelRuntimeBackend[] = runtimeEligible
    ? configuredBackends.filter((backend): backend is AtelRuntimeBackend => backend === 'sdk-runtime' || backend === 'linked-runtime')
    : [];

  const runtimeLinkStatus: 'none' | 'linked' = args.runtimeLink ? 'linked' : 'none';

  if (args.preferredBackend === 'linked-runtime' && runtimeEligible && !args.runtimeLink) {
    return {
      requestedBackend: args.preferredBackend,
      declaredUserMode: args.userMode,
      selectedBackend: 'platform-hosted',
      executionClass,
      runtimeEligible,
      futureBackends,
      runtimeLinkStatus,
      reason: 'linked-runtime requested, but no runtime link is registered for this hosted DID; falling back to platform-hosted',
    };
  }

  if (args.preferredBackend === 'linked-runtime' && linkedRuntimeSelectable(args.toolName, args.runtimeLink)) {
    return {
      requestedBackend: args.preferredBackend,
      declaredUserMode: args.userMode,
      selectedBackend: 'linked-runtime',
      executionClass,
      runtimeEligible,
      futureBackends,
      runtimeLinkStatus,
      runtimeLink: args.runtimeLink ?? undefined,
      reason: `linked-runtime selected for ${args.toolName} via registered runtime endpoint`,
    };
  }

  if (args.preferredBackend === 'linked-runtime' && runtimeEligible) {
    return {
      requestedBackend: args.preferredBackend,
      declaredUserMode: args.userMode,
      selectedBackend: 'platform-hosted',
      executionClass,
      runtimeEligible,
      futureBackends,
      runtimeLinkStatus,
      runtimeLink: args.runtimeLink ?? undefined,
      reason: `linked-runtime requested for ${args.toolName}, but this rollout only enables linked-runtime dispatch for selected tools with a registered endpoint; falling back to platform-hosted`,
    };
  }

  if (args.preferredBackend && runtimeEligible && futureBackends.includes(args.preferredBackend)) {
    return {
      requestedBackend: args.preferredBackend,
      declaredUserMode: args.userMode,
      selectedBackend: 'platform-hosted',
      executionClass,
      runtimeEligible,
      futureBackends,
      runtimeLinkStatus,
      runtimeLink: args.runtimeLink ?? undefined,
      reason: `requested ${args.preferredBackend}, but current rollout keeps ${args.toolName} on platform-hosted while runtime routing is staged`,
    };
  }

  if (args.userMode === 'runtime-only' && runtimeEligible) {
    return {
      requestedBackend: args.preferredBackend,
      declaredUserMode: args.userMode,
      selectedBackend: 'platform-hosted',
      executionClass,
      runtimeEligible,
      futureBackends,
      runtimeLinkStatus,
      runtimeLink: args.runtimeLink ?? undefined,
      reason: 'runtime-only mode declared, but runtime dispatch is not enabled in this rollout; falling back to platform-hosted',
    };
  }

  return {
    requestedBackend: args.preferredBackend,
    declaredUserMode: args.userMode,
    selectedBackend: 'platform-hosted',
    executionClass,
    runtimeEligible,
    futureBackends,
    runtimeLinkStatus,
    runtimeLink: args.runtimeLink ?? undefined,
    reason: runtimeEligible
      ? 'platform-hosted by default; runtime routing remains compatibility-only in this phase'
      : 'platform is the source of truth for this tool class',
  };
}
