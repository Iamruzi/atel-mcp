/**
 * Pin DidSigIntrospectionClient.introspectBearerToken behavior.
 *
 * Existing did-sig-auth.test.ts covers parsing / routing / sentinel.
 * This file covers the actual introspect path: base64-decode envelope,
 * forward to platform /auth/v1/did-sig, map response to RemoteBearerClaims.
 *
 * Regression target: any change that breaks the protocol contract with
 * platform (envelope format, endpoint URL, response field mapping)
 * should fail one of these tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DidSigIntrospectionClient } from '../auth/did-sig.js';
import { AtelMcpError } from '../contracts/errors.js';
import type { AtelMcpConfig } from '../config.js';

const baseConfig = {
  platformBaseUrl: 'https://api.atelai.xyz',
  defaultRemoteScopes: ['identity.read'],
  environment: 'production',
} as unknown as AtelMcpConfig;

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

function withFakeFetch(handler: (req: CapturedFetch) => Response | Promise<Response>) {
  const calls: CapturedFetch[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: CapturedFetch = { url: String(input), init: init ?? {} };
    calls.push(captured);
    return handler(captured);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function encodeEnvelope(envelope: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

test('did-sig introspect: forwards decoded envelope to /auth/v1/did-sig verbatim', async () => {
  const envelope = {
    did: 'did:atel:ed25519:GomjeYAPoS4yLABCDEFGHIJKLMNOPQRSTUVWXYZ123',
    payload: { nonce: 'abc123def456' },
    timestamp: '2026-05-02T10:00:00.000Z',
    signature: 'base64-sig-bytes-here',
  };
  const fake = withFakeFetch(() =>
    new Response(
      JSON.stringify({
        token: 'platform-issued-jwt-xyz',
        did: envelope.did,
        sessionId: `did-sig:${envelope.did}`,
        expiresAt: 9999999999,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  try {
    const client = new DidSigIntrospectionClient(baseConfig);
    const claims = await client.introspectBearerToken(encodeEnvelope(envelope));

    // Endpoint correctness — must be /auth/v1/did-sig, not /auth/v1/verify.
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.atelai.xyz/auth/v1/did-sig');
    assert.equal(fake.calls[0].init.method, 'POST');

    // Body forwarded verbatim (envelope JSON, not wrapped/transformed).
    const sent = JSON.parse(String(fake.calls[0].init.body));
    assert.deepEqual(sent, envelope);

    // Response mapped onto RemoteBearerClaims.
    assert.equal(claims.did, envelope.did);
    assert.equal(claims.sub, envelope.did);
    assert.equal((claims as { bearerToken?: string }).bearerToken, 'platform-issued-jwt-xyz');
    assert.equal(claims.sessionId, `did-sig:${envelope.did}`);
  } finally {
    fake.restore();
  }
});

test('did-sig introspect: rejects malformed base64 with actionable hint', async () => {
  const fake = withFakeFetch(() => new Response('{}', { status: 200 }));
  try {
    const client = new DidSigIntrospectionClient(baseConfig);
    await assert.rejects(
      () => client.introspectBearerToken('not-valid-base64-!!!@@@'),
      (err: unknown) => {
        assert.ok(err instanceof AtelMcpError);
        assert.equal(err.code, 'UNAUTHORIZED');
        assert.match(err.hint ?? '', /base64-encode/);
        return true;
      },
    );
    // Platform must NOT have been hit when envelope is malformed.
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test('did-sig introspect: rejects envelope missing required field', async () => {
  // Envelope missing `signature` field.
  const incomplete = encodeEnvelope({
    did: 'did:atel:ed25519:abc',
    payload: { nonce: 'x' },
    timestamp: '2026-05-02T10:00:00Z',
    // signature missing
  });
  const fake = withFakeFetch(() => new Response('{}', { status: 200 }));
  try {
    const client = new DidSigIntrospectionClient(baseConfig);
    await assert.rejects(
      () => client.introspectBearerToken(incomplete),
      (err: unknown) => err instanceof AtelMcpError && err.code === 'UNAUTHORIZED',
    );
    assert.equal(fake.calls.length, 0); // platform not contacted
  } finally {
    fake.restore();
  }
});

test('did-sig introspect: surfaces platform 401 with hint', async () => {
  const envelope = {
    did: 'did:atel:ed25519:abc',
    payload: { nonce: 'x' },
    timestamp: '2026-05-02T10:00:00Z',
    signature: 'sig',
  };
  const fake = withFakeFetch(() =>
    new Response(JSON.stringify({ error: 'signature verification failed' }), { status: 401 }),
  );
  try {
    const client = new DidSigIntrospectionClient(baseConfig);
    await assert.rejects(
      () => client.introspectBearerToken(encodeEnvelope(envelope)),
      (err: unknown) => {
        assert.ok(err instanceof AtelMcpError);
        assert.equal(err.code, 'UNAUTHORIZED');
        assert.match(err.hint ?? '', /clock skew|fresh timestamp/i);
        return true;
      },
    );
  } finally {
    fake.restore();
  }
});

test('did-sig introspect: rejects platform 200 missing token field', async () => {
  // Platform should never return 200 without a token, but be defensive.
  const envelope = {
    did: 'did:atel:ed25519:abc',
    payload: { nonce: 'x' },
    timestamp: '2026-05-02T10:00:00Z',
    signature: 'sig',
  };
  const fake = withFakeFetch(() =>
    new Response(JSON.stringify({ did: envelope.did /* no token */ }), { status: 200 }),
  );
  try {
    const client = new DidSigIntrospectionClient(baseConfig);
    await assert.rejects(
      () => client.introspectBearerToken(encodeEnvelope(envelope)),
      (err: unknown) => err instanceof AtelMcpError && err.code === 'UNAUTHORIZED',
    );
  } finally {
    fake.restore();
  }
});

test('did-sig introspect: scopes fall back to defaultRemoteScopes when platform omits', async () => {
  const envelope = {
    did: 'did:atel:ed25519:abc',
    payload: { nonce: 'x' },
    timestamp: '2026-05-02T10:00:00Z',
    signature: 'sig',
  };
  const fake = withFakeFetch(() =>
    new Response(
      JSON.stringify({
        token: 'jwt',
        did: envelope.did,
        // no scopes field
      }),
      { status: 200 },
    ),
  );
  try {
    const client = new DidSigIntrospectionClient(baseConfig);
    const claims = await client.introspectBearerToken(encodeEnvelope(envelope));
    assert.deepEqual(claims.scopes, ['identity.read']);
  } finally {
    fake.restore();
  }
});
