import type { AtelScope } from './contracts/scopes.js';

export type AtelEnvironmentProfile = 'production' | 'local-test' | 'custom';

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
  auditLogPath?: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AtelMcpConfig {
  const platformBaseUrl = env.ATEL_PLATFORM_BASE_URL ?? 'https://api.atelai.org';
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
  if (platformBaseUrl === 'https://api.atelai.org') environment = 'production';
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
    auditLogPath: env.ATEL_MCP_AUDIT_LOG_PATH?.trim() || undefined,
  };
}
