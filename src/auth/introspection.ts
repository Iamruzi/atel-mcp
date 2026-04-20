import type { AtelMcpConfig } from '../config.js';
import type { AtelScope } from '../contracts/scopes.js';
import { AtelMcpError } from '../contracts/errors.js';
import { PLATFORM_ENDPOINTS } from '../platform/endpoints.js';
import type { PlatformSessionEnvelope, RemoteBearerClaims } from './types.js';

export interface AuthIntrospectionClient {
  introspectBearerToken(token: string): Promise<RemoteBearerClaims>;
}

export class PlatformAuthIntrospectionClient implements AuthIntrospectionClient {
  constructor(private readonly config: AtelMcpConfig) {}

  async introspectBearerToken(token: string): Promise<RemoteBearerClaims> {
    const sessionAttempt = await this.fetchJson<PlatformSessionEnvelope>(token, PLATFORM_ENDPOINTS.auth.session);
    if (sessionAttempt.ok && sessionAttempt.payload?.did) {
      return this.toClaimsFromSession(sessionAttempt.payload);
    }

    const meAttempt = await this.fetchJson<PlatformSessionEnvelope>(token, PLATFORM_ENDPOINTS.auth.me);
    if (meAttempt.ok && meAttempt.payload?.did) {
      return this.toClaimsFromMe(meAttempt.payload);
    }

    throw new AtelMcpError('UNAUTHORIZED', 'Authentication failed or the session has expired.', {
      sessionAttempt: {
        status: sessionAttempt.status,
        payload: sessionAttempt.payload,
      },
      meAttempt: {
        status: meAttempt.status,
        payload: meAttempt.payload,
      },
    });
  }

  private async fetchJson<T>(token: string, path: string): Promise<{ ok: boolean; status: number; payload: T | null }> {
    const response = await fetch(`${this.config.platformBaseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    const payload = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  }

  private toClaimsFromSession(payload: PlatformSessionEnvelope): RemoteBearerClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
      sub: payload.did,
      did: payload.did,
      env: this.parseEnvironment(payload.environment),
      scopes: this.parseScopes(payload.scopes),
      sessionId: payload.sessionId || `session:${payload.did}`,
      issuedAt: payload.issuedAt ?? now,
      expiresAt: payload.expiresAt ?? now + 3600,
      clientId: payload.clientId || 'atel-mcp-remote',
    };
  }

  private toClaimsFromMe(payload: PlatformSessionEnvelope): RemoteBearerClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
      sub: payload.did,
      did: payload.did,
      env: this.config.environment,
      scopes: this.config.defaultRemoteScopes,
      sessionId: `session:${payload.did}`,
      issuedAt: now,
      expiresAt: now + 3600,
      clientId: 'atel-mcp-remote',
    };
  }

  private parseEnvironment(value: PlatformSessionEnvelope['environment']): RemoteBearerClaims['env'] {
    if (value === 'production' || value === 'local-test' || value === 'custom') return value;
    return this.config.environment;
  }

  private parseScopes(value: PlatformSessionEnvelope['scopes']): AtelScope[] {
    if (!Array.isArray(value) || value.length === 0) return this.config.defaultRemoteScopes;
    return value.filter((entry): entry is AtelScope => typeof entry === 'string') as AtelScope[];
  }
}

export function createAuthIntrospectionClient(config: AtelMcpConfig): AuthIntrospectionClient {
  return new PlatformAuthIntrospectionClient(config);
}
