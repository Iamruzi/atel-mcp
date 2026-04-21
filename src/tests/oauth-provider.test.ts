import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformChallengeOAuthProvider } from '../oauth/provider.js';
import type { AtelScope } from '../contracts/scopes.js';

const baseConfig = {
  host: '127.0.0.1',
  port: 8787,
  trustProxy: 'loopback',
  publicBaseUrl: 'http://127.0.0.1:8787',
  oauthIssuerUrl: 'http://127.0.0.1:8787',
  routeBasePath: '',
  oauthResourceName: 'ATEL MCP',
  serviceDocumentationUrl: undefined,
  platformBaseUrl: 'https://api.atelai.org',
  registryBaseUrl: 'https://api.atelai.org',
  relayBaseUrl: 'https://api.atelai.org',
  environment: 'production' as const,
  defaultRemoteScopes: ['identity.read', 'messages.write'] as AtelScope[],
  allowCustomRemoteMcp: false,
};

test('PlatformChallengeOAuthProvider completes challenge-poll flow and exchanges auth code', async () => {
  const originalFetch = globalThis.fetch;
  let issuedCode = '';

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);

    if (url.endsWith('/auth/v1/challenge')) {
      issuedCode = 'A1B2C3';
      return new Response(JSON.stringify({ code: issuedCode, expiresIn: 300 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith(`/auth/v1/poll/${issuedCode}`)) {
      return new Response(JSON.stringify({
        status: 'verified',
        token: 'atel-access-token',
        did: 'did:atel:ed25519:tester',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith('/auth/v1/session')) {
      return new Response(JSON.stringify({
        did: 'did:atel:ed25519:tester',
        environment: 'production',
        scopes: ['identity.read', 'messages.write'],
        sessionId: 'session:test',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        clientId: 'oauth-client',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new PlatformChallengeOAuthProvider(baseConfig, baseConfig.publicBaseUrl);
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Test Client',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      logo_uri: undefined,
      tos_uri: undefined,
    });

    const redirects: string[] = [];
    await provider.authorize(client, {
      redirectUri: 'https://example.com/callback',
      state: 'state-1',
      scopes: ['identity.read'],
      codeChallenge: 'challenge-123',
    }, {
      redirect: (url: string) => {
        redirects.push(url);
      },
    } as never);

    assert.equal(redirects.length, 1);
    const interactive = new URL(redirects[0]!);
    const sessionId = interactive.searchParams.get('session');
    assert.ok(sessionId);

    const status = await provider.getLoginSessionStatus(sessionId!);
    assert.equal(status.status, 'verified');
    assert.ok(status.redirectTo);

    const callbackUrl = new URL(status.redirectTo);
    const authorizationCode = callbackUrl.searchParams.get('code');
    assert.ok(authorizationCode);
    assert.equal(callbackUrl.searchParams.get('state'), 'state-1');

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      authorizationCode!,
      'verifier-123',
      'https://example.com/callback',
    );
    assert.equal(tokens.access_token, 'atel-access-token');
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.refresh_token);

    const authInfo = await provider.verifyAccessToken('atel-access-token');
    assert.equal(authInfo.clientId, 'oauth-client');
    assert.deepEqual(authInfo.scopes, ['identity.read', 'messages.write']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PlatformChallengeOAuthProvider preserves the public base path in authorize redirects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/challenge')) {
      return new Response(JSON.stringify({ code: 'PATH42', expiresIn: 300 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const provider = new PlatformChallengeOAuthProvider(
      {
        ...baseConfig,
        publicBaseUrl: 'http://43.160.230.129/atel-mcp',
        oauthIssuerUrl: 'http://43.160.230.129/atel-mcp',
        routeBasePath: '/atel-mcp',
      },
      'http://43.160.230.129/atel-mcp',
    );
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'none',
      client_name: 'Prefixed Client',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      logo_uri: undefined,
      tos_uri: undefined,
    });

    const redirects: string[] = [];
    await provider.authorize(client, {
      redirectUri: 'https://example.com/callback',
      codeChallenge: 'challenge-123',
    }, {
      redirect: (url: string) => {
        redirects.push(url);
      },
    } as never);

    assert.equal(redirects.length, 1);
    assert.match(redirects[0]!, /^http:\/\/43\.160\.230\.129\/atel-mcp\/oauth\/authorize\/interactive\?session=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
