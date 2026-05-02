/**
 * Pin atel_register_endpoint behavior at the schema + handler boundary.
 *
 * The schema is the first layer of defense against the "fat-fingered URL"
 * drift case — if it lets through bad URLs, the platform reachability
 * check still rejects them but we waste a network round-trip + log noise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RegisterEndpointInputSchema } from '../contracts/schemas.js';
import { atelRegisterEndpoint } from '../tools/identity.js';
import type { ToolExecutionContext } from '../server/context.js';

interface MockReq { method: string; path: string; body?: unknown }

function makeCtx(platformResponse: unknown) {
  return {
    session: { did: 'did:atel:ed25519:tester', scopes: ['identity.read'], environment: 'production', bearerToken: 'tok', sessionId: 's' },
    config: {},
    platform: {
      request: async (_req: MockReq) => platformResponse,
    },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;
}

// ─── Schema gates ────────────────────────────────────────────────────

test('register_endpoint schema: accepts valid https URL', () => {
  const r = RegisterEndpointInputSchema.parse({ endpoint: 'https://agent.example.com/callback' });
  assert.equal(r.endpoint, 'https://agent.example.com/callback');
});

test('register_endpoint schema: rejects http://', () => {
  assert.throws(() => RegisterEndpointInputSchema.parse({ endpoint: 'http://agent.example.com' }));
});

test('register_endpoint schema: rejects invalid URL', () => {
  assert.throws(() => RegisterEndpointInputSchema.parse({ endpoint: 'not-a-url' }));
});

test('register_endpoint schema: rejects ftp://', () => {
  assert.throws(() => RegisterEndpointInputSchema.parse({ endpoint: 'ftp://agent.example.com' }));
});

test('register_endpoint schema: optional label accepted with size limit', () => {
  const r = RegisterEndpointInputSchema.parse({ endpoint: 'https://x.com', label: 'primary' });
  assert.equal(r.label, 'primary');
  assert.throws(() => RegisterEndpointInputSchema.parse({ endpoint: 'https://x.com', label: 'x'.repeat(100) }));
});

// ─── Handler forwards to platform ────────────────────────────────────

test('register_endpoint: forwards parsed body to platform adapter', async () => {
  let captured: MockReq | null = null;
  const ctx = {
    session: { did: 'did:atel:ed25519:tester', scopes: ['identity.read'], environment: 'production', bearerToken: 'tok', sessionId: 's' },
    config: {},
    platform: {
      request: async (req: MockReq) => {
        captured = req;
        return { did: 'did:atel:ed25519:tester', candidates: [], updatedAt: 'now' };
      },
    },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;

  await atelRegisterEndpoint(ctx, {
    endpoint: 'https://agent.example.com/callback',
    label: 'primary',
  });

  assert.ok(captured);
  const c = captured as MockReq;
  assert.equal(c.method, 'POST');
  assert.equal(c.path, '/registry/v1/remote/endpoint');
  assert.deepEqual(c.body, {
    endpoint: 'https://agent.example.com/callback',
    label: 'primary',
  });
});

test('register_endpoint: returns platform response directly', async () => {
  const platformResp = {
    did: 'did:atel:ed25519:tester',
    candidates: [{ url: 'https://x.com', label: 'p', registeredAt: '2026-05-02T10:00:00Z' }],
    updatedAt: '2026-05-02T10:00:00Z',
  };
  const ctx = makeCtx(platformResp);
  const result = await atelRegisterEndpoint(ctx, { endpoint: 'https://x.com' });
  assert.deepEqual(result, platformResp);
});
