/**
 * Pin idempotency-key behavior on the MCP→platform path.
 *
 * Background: cross-repo audit found the main MCP→platform path was
 * dropping idempotency-key (only the linked-runtime forwarder set it).
 * Repeated requests on retries / dispatch loops would create duplicate
 * orders / messages. PlatformClient now injects the header on every POST,
 * defaulting to the requestId from MCP meta.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformClient, type PlatformRequest } from '../platform/client.js';
import type { AtelMcpConfig } from '../config.js';

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

const baseConfig = {
  platformBaseUrl: 'https://api.atelai.xyz',
  registryBaseUrl: 'https://api.atelai.xyz',
  relayBaseUrl: 'https://api.atelai.xyz',
} as unknown as AtelMcpConfig;

function readHeader(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  // Headers may be Record<string, string> or Headers instance; we set them
  // as plain object so this is sufficient.
  return headers[name];
}

test('platform client: POST request gets idempotency-key from default', async () => {
  const fake = withFakeFetch(() => new Response('null', { status: 200 }));
  try {
    const client = new PlatformClient(baseConfig, 'req-default-123');
    await client.request<unknown>({
      method: 'POST',
      path: '/trade/v1/order',
      bearerToken: 'tok',
      body: { foo: 'bar' },
    });
    assert.equal(fake.calls.length, 1);
    assert.equal(readHeader(fake.calls[0].init, 'idempotency-key'), 'req-default-123');
  } finally {
    fake.restore();
  }
});

test('platform client: GET request does NOT get idempotency-key (HTTP semantics)', async () => {
  const fake = withFakeFetch(() => new Response('{}', { status: 200 }));
  try {
    const client = new PlatformClient(baseConfig, 'req-default-123');
    await client.request<unknown>({
      method: 'GET',
      path: '/account/v1/balance',
      bearerToken: 'tok',
    });
    assert.equal(fake.calls.length, 1);
    assert.equal(readHeader(fake.calls[0].init, 'idempotency-key'), undefined);
  } finally {
    fake.restore();
  }
});

test('platform client: per-request idempotencyKey overrides default', async () => {
  const fake = withFakeFetch(() => new Response('null', { status: 200 }));
  try {
    const client = new PlatformClient(baseConfig, 'req-default-123');
    await client.request<unknown>({
      method: 'POST',
      path: '/trade/v1/order',
      bearerToken: 'tok',
      idempotencyKey: 'override-456',
      body: {},
    });
    assert.equal(readHeader(fake.calls[0].init, 'idempotency-key'), 'override-456');
  } finally {
    fake.restore();
  }
});

test('platform client: no default + no override means no header (legacy behavior preserved)', async () => {
  const fake = withFakeFetch(() => new Response('null', { status: 200 }));
  try {
    const client = new PlatformClient(baseConfig); // no defaultIdempotencyKey
    await client.request<unknown>({
      method: 'POST',
      path: '/trade/v1/order',
      bearerToken: 'tok',
      body: {},
    });
    assert.equal(readHeader(fake.calls[0].init, 'idempotency-key'), undefined);
  } finally {
    fake.restore();
  }
});

test('platform client: same default key on two POSTs (proves repeat-safety semantics)', async () => {
  const fake = withFakeFetch(() => new Response('null', { status: 200 }));
  try {
    const client = new PlatformClient(baseConfig, 'req-stable-789');
    await client.request<unknown>({ method: 'POST', path: '/trade/v1/order', bearerToken: 'tok', body: {} });
    await client.request<unknown>({ method: 'POST', path: '/trade/v1/order', bearerToken: 'tok', body: {} });
    assert.equal(fake.calls.length, 2);
    // Same client → same defaultIdempotencyKey → both POSTs carry the same
    // header value. Platform de-dupes on this header — second call is a
    // safe retry, not a fresh order.
    assert.equal(readHeader(fake.calls[0].init, 'idempotency-key'), 'req-stable-789');
    assert.equal(readHeader(fake.calls[1].init, 'idempotency-key'), 'req-stable-789');
  } finally {
    fake.restore();
  }
});
