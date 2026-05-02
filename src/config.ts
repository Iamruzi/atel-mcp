import type { AtelScope } from './contracts/scopes.js';

export type AtelEnvironmentProfile = 'production' | 'local-test' | 'custom';
export type AtelUserEntryMode = 'mcp-primary';
export type AtelRuntimeRole = 'sdk-runtime';

export interface AtelMcpConfig {
  port: number;
  host: string;
  trustProxy: string | number | boolean;
  publicBaseUrl: string;
  oauthIssuerUrl: string;
  routeBasePath: string;
  serviceDocumentationUrl?: string;
  oauthResourceName: string;
  platformBaseUrl: string;
  registryBaseUrl: string;
  relayBaseUrl: string;
  environment: AtelEnvironmentProfile;
  defaultRemoteScopes: AtelScope[];
  allowCustomRemoteMcp: boolean;
  disableRegisterRateLimit?: boolean;
  auditLogPath?: string;
  /**
   * Whether to also POST each audit event to the platform's mcp_audit_log
   * ingest endpoint. JSONL stays as the on-host primary regardless. Off by
   * default until the platform endpoint is ready and field-aligned.
   */
  auditPlatformIngestEnabled: boolean;
  /** Bearer token for the platform audit ingest endpoint (separate from user sessions). */
  auditPlatformIngestToken?: string;
  /** Identifier for this MCP instance — used by platform de-dup if MCP runs HA. */
  mcpInstance: string;
  approvalLogPath?: string;
  approvalBypassTools?: string[];
  /**
   * Whether the runtime-links subsystem is wired into dispatch.
   *
   * Default true because most ATEL users come in through OpenClaw / 龙虾,
   * which relies on this subsystem to forward tool calls to a registered
   * agent runtime (see src/runtime-links/dispatch.ts).
   *
   * Set to false ONLY for MCP hosts that do not serve 龙虾 users (e.g.
   * an internal-tooling MCP). When false:
   *   - the 3 atel_runtime_link_* tools return NOT_IMPLEMENTED
   *   - dispatch skips getRuntimeLink (one fewer file read per call)
   *   - linked-runtime never wins backend selection (always platform-hosted)
   *   - invokeLinkedRuntimeTool is never reached
   */
  runtimeLinksEnabled: boolean;
  userEntryMode: AtelUserEntryMode;
  runtimeRole: AtelRuntimeRole;
  runtimeBackends: string[];
  supportedUserModes: string[];
  runtimeLinksPath: string;
}

function parseScopes(raw?: string): AtelScope[] {
  if (!raw?.trim()) return [
    'identity.read',
    'wallet.read',
    'contacts.read',
    'messages.read',
    'messages.write',
    'orders.read',
    'orders.write',
    'milestones.read',
    'milestones.write',
    'disputes.read',
    'disputes.write',
  ];
  return raw.split(',').map((item) => item.trim()).filter(Boolean) as AtelScope[];
}

function normalizeRouteBasePath(pathname: string): string {
  if (!pathname || pathname === '/') return '';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseCsvList(raw: string | undefined, fallback: string[]): string[] {
  const items = raw?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return items.length > 0 ? items : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AtelMcpConfig {
  const platformBaseUrl = env.ATEL_PLATFORM_BASE_URL ?? 'https://api.atelai.xyz';
  const registryBaseUrl = env.ATEL_REGISTRY_BASE_URL ?? platformBaseUrl;
  const relayBaseUrl = env.ATEL_RELAY_BASE_URL ?? platformBaseUrl;
  const port = Number(env.PORT ?? '8787');
  const host = env.HOST ?? '127.0.0.1';
  const rawTrustProxy = env.ATEL_MCP_TRUST_PROXY?.trim();
  const trustProxy = rawTrustProxy
    ? (/^\d+$/.test(rawTrustProxy) ? Number(rawTrustProxy) : rawTrustProxy)
    : 'loopback';
  const publicBaseUrl = (env.ATEL_MCP_PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/+$/, '');
  const oauthIssuerUrl = (env.ATEL_MCP_OAUTH_ISSUER_URL ?? publicBaseUrl).replace(/\/+$/, '');
  const publicPath = normalizeRouteBasePath(new URL(publicBaseUrl).pathname);
  const issuerPath = normalizeRouteBasePath(new URL(oauthIssuerUrl).pathname);
  if (publicPath && issuerPath && publicPath !== issuerPath) {
    throw new Error(`ATEL MCP public base path mismatch: public=${publicPath} issuer=${issuerPath}`);
  }
  const routeBasePath = publicPath || issuerPath;

  let environment: AtelEnvironmentProfile = 'custom';
  if (platformBaseUrl === 'https://api.atelai.xyz') environment = 'production';
  if (platformBaseUrl.includes('127.0.0.1') || platformBaseUrl.includes('localhost')) environment = 'local-test';

  return {
    port,
    host,
    trustProxy,
    publicBaseUrl,
    oauthIssuerUrl,
    routeBasePath,
    serviceDocumentationUrl: env.ATEL_MCP_SERVICE_DOCUMENTATION_URL?.trim() || undefined,
    oauthResourceName: env.ATEL_MCP_OAUTH_RESOURCE_NAME?.trim() || 'ATEL MCP',
    platformBaseUrl,
    registryBaseUrl,
    relayBaseUrl,
    environment,
    defaultRemoteScopes: parseScopes(env.ATEL_MCP_DEFAULT_SCOPES),
    allowCustomRemoteMcp: env.ALLOW_CUSTOM_REMOTE_MCP === 'true',
    disableRegisterRateLimit: env.ATEL_MCP_DISABLE_REGISTER_RATE_LIMIT === 'true',
    auditLogPath: env.ATEL_MCP_AUDIT_LOG_PATH?.trim() || undefined,
    auditPlatformIngestEnabled: env.ATEL_MCP_AUDIT_PLATFORM_INGEST?.trim().toLowerCase() === 'true',
    auditPlatformIngestToken: env.ATEL_MCP_AUDIT_PLATFORM_INGEST_TOKEN?.trim() || undefined,
    mcpInstance: env.ATEL_MCP_INSTANCE_ID?.trim() || env.HOSTNAME?.trim() || `${host}:${port}`,
    approvalLogPath: env.ATEL_MCP_APPROVAL_LOG_PATH?.trim() || undefined,
    approvalBypassTools: parseCsvList(env.ATEL_MCP_APPROVAL_BYPASS_TOOLS, []),
    // Default true. ATEL_MCP_RUNTIME_LINKS_ENABLED=false only on MCP hosts
    // that don't serve OpenClaw / 龙虾 users (a small minority).
    runtimeLinksEnabled: env.ATEL_MCP_RUNTIME_LINKS_ENABLED?.trim().toLowerCase() !== 'false',
    userEntryMode: 'mcp-primary',
    runtimeRole: 'sdk-runtime',
    runtimeBackends: parseCsvList(env.ATEL_MCP_RUNTIME_BACKENDS, ['platform-hosted', 'sdk-runtime', 'linked-runtime']),
    supportedUserModes: parseCsvList(env.ATEL_MCP_SUPPORTED_USER_MODES, ['mcp-only', 'runtime-only', 'mcp-plus-runtime']),
    runtimeLinksPath: env.ATEL_MCP_RUNTIME_LINKS_PATH?.trim() || '.runtime/runtime-links.json',
  };
}

