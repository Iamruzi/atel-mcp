/**
 * DID-Sig auth scheme tests.
 *
 * The point: prove that the headless backup channel works end-to-end
 * (parseAuthorization → composite routing → DID-Sig verify → session) and
 * that the existing Bearer flow is untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorization, parseBearerToken, toAtelSession } from '../auth/session.js';
import {
  isDidSigAuthorization,
  extractDidSigPayload,
  CompositeAuthIntrospectionClient,
  DID_SIG_TOKEN_SENTINEL,
} from '../auth/did-sig.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';
import type { RemoteBearerClaims } from '../auth/types.js';
import { AtelMcpError } from '../contracts/errors.js';

test('isDidSigAuthorization recognizes the scheme (case-insensitive)', () => {
  assert.equal(isDidSigAuthorization('ATEL-DID-Sig abc'), true);
  assert.equal(isDidSigAuthorization('atel-did-sig abc'), true);
  assert.equal(isDidSigAuthorization('Bearer abc'), false);
  assert.equal(isDidSigAuthorization(undefined), false);
  assert.equal(isDidSigAuthorization(''), false);
});

test('extractDidSigPayload pulls the base64 payload after the scheme', () => {
  assert.equal(extractDidSigPayload('ATEL-DID-Sig dGVzdA=='), 'dGVzdA==');
});

test('extractDidSigPayload throws with hint when payload missing', () => {
  assert.throws(
    () => extractDidSigPayload('ATEL-DID-Sig '),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'UNAUTHORIZED');
      assert.match(err.hint ?? '', /base64 payload/);
      return true;
    },
  );
});

test('parseAuthorization routes Bearer token unchanged', () => {
  const result = parseAuthorization('Bearer my-jwt-token');
  assert.equal(result, 'my-jwt-token');
  // No DID-Sig sentinel.
  assert.ok(!result.startsWith(DID_SIG_TOKEN_SENTINEL));
});

test('parseAuthorization tags DID-Sig payload with sentinel', () => {
  const result = parseAuthorization('ATEL-DID-Sig my-base64-payload');
  assert.equal(result, DID_SIG_TOKEN_SENTINEL + 'my-base64-payload');
});

test('parseBearerToken hint mentions both schemes', () => {
  assert.throws(
    () => parseBearerToken('Basic foo'),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.match(err.hint ?? '', /ATEL-DID-Sig/);
      return true;
    },
  );
});

test('CompositeAuthIntrospectionClient routes Bearer to bearer client', async () => {
  const bearerCalls: string[] = [];
  const didSigCalls: string[] = [];
  const bearer: AuthIntrospectionClient = {
    async introspectBearerToken(token) {
      bearerCalls.push(token);
      return { sub: 'a', did: 'did:atel:ed25519:a', env: 'production', scopes: [], sessionId: 's', issuedAt: 0, expiresAt: 9 };
    },
  };
  const didSig: AuthIntrospectionClient = {
    async introspectBearerToken(token) {
      didSigCalls.push(token);
      throw new Error('should not be called');
    },
  };
  const composite = new CompositeAuthIntrospectionClient(bearer, didSig);
  await composite.introspectBearerToken('plain-jwt');
  assert.deepEqual(bearerCalls, ['plain-jwt']);
  assert.deepEqual(didSigCalls, []);
});

test('CompositeAuthIntrospectionClient routes sentinel-tagged payload to DID-Sig client', async () => {
  const bearerCalls: string[] = [];
  const didSigCalls: string[] = [];
  const bearer: AuthIntrospectionClient = {
    async introspectBearerToken(token) {
      bearerCalls.push(token);
      throw new Error('should not be called');
    },
  };
  const didSig: AuthIntrospectionClient = {
    async introspectBearerToken(token) {
      didSigCalls.push(token);
      return { sub: 'b', did: 'did:atel:ed25519:b', env: 'production', scopes: [], sessionId: 's', issuedAt: 0, expiresAt: 9 };
    },
  };
  const composite = new CompositeAuthIntrospectionClient(bearer, didSig);
  // Pass the sentinel-tagged token that parseAuthorization would produce.
  await composite.introspectBearerToken(DID_SIG_TOKEN_SENTINEL + 'base64-payload');
  // The sentinel must be stripped before forwarding to the DID-Sig client.
  assert.deepEqual(bearerCalls, []);
  assert.deepEqual(didSigCalls, ['base64-payload']);
});

test('toAtelSession with DID-Sig claims uses platform-issued bearer token, not the sentinel-tagged input', () => {
  const claims: RemoteBearerClaims & { bearerToken?: string } = {
    sub: 'did:atel:ed25519:c',
    did: 'did:atel:ed25519:c',
    env: 'production',
    scopes: ['identity.read'],
    sessionId: 's',
    issuedAt: 0,
    expiresAt: 9999999999,
    bearerToken: 'platform-issued-bearer',
  };
  // Token here is what parseAuthorization produced — a sentinel + payload.
  const session = toAtelSession(DID_SIG_TOKEN_SENTINEL + 'base64-payload', claims);
  assert.equal(session.bearerToken, 'platform-issued-bearer');
  assert.equal(session.did, 'did:atel:ed25519:c');
});

test('toAtelSession falls back to stripped DID-Sig payload when verify response omitted bearerToken', () => {
  const claims: RemoteBearerClaims = {
    sub: 'did:atel:ed25519:d',
    did: 'did:atel:ed25519:d',
    env: 'production',
    scopes: [],
    sessionId: 's',
    issuedAt: 0,
    expiresAt: 9,
  };
  const session = toAtelSession(DID_SIG_TOKEN_SENTINEL + 'base64-payload', claims);
  // Without a platform bearer, we strip the sentinel — at least platform
  // calls won't be polluted by the internal sentinel char.
  assert.equal(session.bearerToken, 'base64-payload');
});
