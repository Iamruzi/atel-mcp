import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AtelMcpConfig } from '../config.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { PlatformAuthIntrospectionClient } from '../auth/introspection.js';

interface OAuthLoginSession {
  id: string;
  challengeCode: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}

interface OAuthAuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  accessToken: string;
  scopes: string[];
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}

interface OAuthRefreshTokenRecord {
  clientId: string;
  accessToken: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function nowMs() {
  return Date.now();
}

function expiresIn(seconds: number) {
  return nowMs() + seconds * 1000;
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}

function resolveAppUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\/+/, ''), ensureTrailingSlash(baseUrl));
}

export class InMemoryOAuthClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    const clientId = `atel-mcp-${randomUUID()}`;
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: nowSeconds(),
      grant_types: client.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: client.response_types ?? ['code'],
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? 'none',
    };
    this.clients.set(clientId, registered);
    return registered;
  }
}

export class PlatformChallengeOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = false;

  private readonly sessions = new Map<string, OAuthLoginSession>();
  private readonly authorizationCodes = new Map<string, OAuthAuthorizationCodeRecord>();
  private readonly refreshTokens = new Map<string, OAuthRefreshTokenRecord>();
  private readonly introspectionClient: PlatformAuthIntrospectionClient;

  constructor(
    private readonly config: AtelMcpConfig,
    private readonly appBaseUrl: string,
    clientsStore: OAuthRegisteredClientsStore = new InMemoryOAuthClientsStore(),
  ) {
    this.clientsStore = clientsStore;
    this.introspectionClient = new PlatformAuthIntrospectionClient(config);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const challengeCode = await this.requestChallengeCode();
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      challengeCode,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes ?? this.config.defaultRemoteScopes,
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
      expiresAt: expiresIn(300),
    });

    const interactiveUrl = resolveAppUrl(this.appBaseUrl, 'oauth/authorize/interactive');
    interactiveUrl.searchParams.set('session', sessionId);
    res.redirect(interactiveUrl.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.authorizationCodes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt <= nowMs()) {
      throw new Error('Invalid or expired authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.authorizationCodes.get(authorizationCode);
    if (!record || record.expiresAt <= nowMs()) {
      throw new Error('Invalid or expired authorization code');
    }
    if (record.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new Error('Redirect URI mismatch');
    }
    if (resource?.href && record.resource && resource.href !== record.resource) {
      throw new Error('Resource indicator mismatch');
    }

    this.authorizationCodes.delete(authorizationCode);

    const refreshToken = randomUUID();
    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      accessToken: record.accessToken,
      scopes: record.scopes,
      resource: record.resource,
      expiresAt: expiresIn(7 * 24 * 3600),
    });

    return {
      access_token: record.accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: record.scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.expiresAt <= nowMs()) {
      throw new Error('Invalid or expired refresh token');
    }
    if (record.clientId !== client.client_id) {
      throw new Error('Refresh token was not issued to this client');
    }
    if (resource?.href && record.resource && resource.href !== record.resource) {
      throw new Error('Resource indicator mismatch');
    }

    const grantedScopes = scopes?.length ? scopes : record.scopes;
    return {
      access_token: record.accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: grantedScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = await this.introspectionClient.introspectBearerToken(token);
    return {
      token,
      clientId: claims.clientId ?? 'atel-mcp-remote',
      scopes: claims.scopes,
      expiresAt: claims.expiresAt,
      resource: resolveAppUrl(this.config.publicBaseUrl, 'mcp'),
      extra: {
        did: claims.did,
        sessionId: claims.sessionId,
        environment: claims.env,
      },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const refreshRecord = this.refreshTokens.get(request.token);
    if (refreshRecord && refreshRecord.clientId === client.client_id) {
      this.refreshTokens.delete(request.token);
      return;
    }

    for (const [code, record] of this.authorizationCodes.entries()) {
      if (record.accessToken === request.token && record.clientId === client.client_id) {
        this.authorizationCodes.delete(code);
      }
    }
  }

  getLoginSession(sessionId: string): OAuthLoginSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= nowMs()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  async getLoginSessionStatus(sessionId: string): Promise<
    | { status: 'pending'; code: string; expiresAt: number }
    | { status: 'expired' }
    | { status: 'verified'; redirectTo: string }
  > {
    const session = this.getLoginSession(sessionId);
    if (!session) return { status: 'expired' };

    const pollResult = await fetch(`${this.config.platformBaseUrl}/auth/v1/poll/${encodeURIComponent(session.challengeCode)}`, {
      method: 'GET',
    });

    if (pollResult.status === 410) {
      this.sessions.delete(sessionId);
      return { status: 'expired' };
    }

    const payload = await pollResult.json().catch(() => ({}));
    if (!pollResult.ok || payload?.status === 'not_found' || payload?.status === 'expired') {
      this.sessions.delete(sessionId);
      return { status: 'expired' };
    }

    if (payload?.status !== 'verified' || typeof payload?.token !== 'string') {
      return {
        status: 'pending',
        code: session.challengeCode,
        expiresAt: session.expiresAt,
      };
    }

    const authorizationCode = randomUUID();
    this.authorizationCodes.set(authorizationCode, {
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      accessToken: payload.token,
      scopes: session.scopes,
      codeChallenge: session.codeChallenge,
      resource: session.resource,
      expiresAt: expiresIn(300),
    });

    this.sessions.delete(sessionId);

    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.set('code', authorizationCode);
    if (session.state) redirectUrl.searchParams.set('state', session.state);

    return {
      status: 'verified',
      redirectTo: redirectUrl.href,
    };
  }

  private async requestChallengeCode(): Promise<string> {
    const response = await fetch(`${this.config.platformBaseUrl}/auth/v1/challenge`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Failed to create login challenge: ${response.status}`);
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload.code !== 'string') {
      throw new Error('Platform challenge response did not include a code');
    }
    return payload.code;
  }
}
