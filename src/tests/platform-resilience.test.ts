/**
 * Pin platform client retry + rate-limit behavior (T8.4 + T8.5).
 *
 * Cross-cuts every MCP→platform call. Regressions here either degrade
 * reliability (retries don't fire on transient errors) or break it
 * (retries fire on 4xx caller bugs and create load loops).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformClient, _platformLimiterForTests } from '../platform/client.js';
import { AtelMcpError } from '../contracts/errors.js';
import type { AtelMcpConfig } from '../config.js';

const baseConfig = {
  platformBaseUrl: 'https://api.atelai.xyz',
  registryBaseUrl: 'https://api.atelai.xyz',
  relayBaseUrl: 'https://api.atelai.xyz',
} as unknown as AtelMcpConfig;

function withFakeFetch(handler: () => Response | Promise<Response>) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return handler();
  }) as typeof fetch;
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ─── Retry on 5xx ───────────────────────────────────────────────────

test('platform client: retries on 503, succeeds on 4th attempt', async () => {
  _platformLimiterForTests.reset();
  let attempts = 0;
  const fake = withFakeFetch(() => {
    attempts += 1;
    if (attempts < 4) {
      return new Response('{"error":"upstream temporarily unavailable"}', { status: 503 });
    }
    return new Response('{"ok":true}', { status: 200 });
  });
  try {
    const client = new PlatformClient(baseConfig, 'req-503-test');
    const result = await client.request<{ ok: boolean }>({
      method: 'GET',
      path: '/account/v1/balance',
      bearerToken: 'tok',
    });
    assert.equal(result.ok, true);
    assert.equal(fake.callCount(), 4); // 3 failed + 1 success
  } finally {
    fake.restore();
  }
});

test('platform client: gives up after 4 total attempts on persistent 502', async () => {
  _platformLimiterForTests.reset();
  const fake = withFakeFetch(() => new Response('{"error":"bad gateway"}', { status: 502 }));
  try {
    const client = new PlatformClient(baseConfig, 'req-502-test');
    await assert.rejects(
      () => client.request<unknown>({
        method: 'GET',
        path: '/account/v1/balance',
        bearerToken: 'tok',
      }),
      (err: unknown) => {
        assert.ok(err instanceof AtelMcpError);
        assert.equal(err.code, 'UPSTREAM_ERROR');
        assert.match(err.message, /after retries/);
        return true;
      },
    );
    assert.equal(fake.callCount(), 4); // initial + 3 retries
  } finally {
    fake.restore();
  }
});

// ─── No retry on 4xx caller bugs ────────────────────────────────────

test('platform client: does NOT retry on 400 (caller bug, retrying never fixes)', async () => {
  _platformLimiterForTests.reset();
  const fake = withFakeFetch(() => new Response('{"error":"bad request"}', { status: 400 }));
  try {
    const client = new PlatformClient(baseConfig, 'req-400-test');
    await assert.rejects(
      () => client.request<unknown>({
        method: 'POST',
        path: '/trade/v1/order',
        bearerToken: 'tok',
        body: { invalid: true },
      }),
    );
    assert.equal(fake.callCount(), 1); // no retry
  } finally {
    fake.restore();
  }
});

test('platform client: does NOT retry on 401/403/404', async () => {
  _platformLimiterForTests.reset();
  for (const status of [401, 403, 404]) {
    const fake = withFakeFetch(() => new Response('{}', { status }));
    try {
      const client = new PlatformClient(baseConfig, `req-${status}-test`);
      await assert.rejects(() => client.request<unknown>({
        method: 'GET',
        path: '/account/v1/balance',
        bearerToken: 'tok',
      }));
      assert.equal(fake.callCount(), 1, `${status} should not retry`);
    } finally {
      fake.restore();
    }
  }
});

// ─── DOES retry on 408 / 429 (transient timing issues) ──────────────

test('platform client: DOES retry on 429 (rate limited by platform)', async () => {
  _platformLimiterForTests.reset();
  let attempts = 0;
  const fake = withFakeFetch(() => {
    attempts += 1;
    return attempts < 3
      ? new Response('{}', { status: 429 })
      : new Response('{"ok":true}', { status: 200 });
  });
  try {
    const client = new PlatformClient(baseConfig, 'req-429-test');
    const result = await client.request<{ ok: boolean }>({
      method: 'GET',
      path: '/account/v1/balance',
      bearerToken: 'tok',
    });
    assert.equal(result.ok, true);
    assert.equal(fake.callCount(), 3);
  } finally {
    fake.restore();
  }
});

// ─── Retry on network failure ───────────────────────────────────────

test('platform client: retries on fetch network error', async () => {
  _platformLimiterForTests.reset();
  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new TypeError('network down');
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  try {
    const client = new PlatformClient(baseConfig, 'req-net-test');
    const result = await client.request<{ ok: boolean }>({
      method: 'GET',
      path: '/account/v1/balance',
      bearerToken: 'tok',
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = original;
  }
});

// ─── Rate limit ─────────────────────────────────────────────────────

test('rate limit: drains bucket after capacity hits, then refuses', async () => {
  _platformLimiterForTests.reset();
  // Don't make actual requests — just exercise the limiter logic.
  // 60 capacity → 60 succeed, 61st refused (refill rate is 10/s, so within
  // the same instant it can't refill anything meaningful).
  for (let i = 0; i < 60; i++) {
    assert.equal(_platformLimiterForTests.tryConsume('test-key'), true, `request ${i + 1} should succeed`);
  }
  assert.equal(_platformLimiterForTests.tryConsume('test-key'), false, 'request 61 should be refused');
});

test('rate limit: separate keys have independent buckets', async () => {
  _platformLimiterForTests.reset();
  for (let i = 0; i < 60; i++) {
    _platformLimiterForTests.tryConsume('key-A');
  }
  // key-A drained, key-B still fresh.
  assert.equal(_platformLimiterForTests.tryConsume('key-A'), false);
  assert.equal(_platformLimiterForTests.tryConsume('key-B'), true);
});

test('rate limit: throws actionable hint when limit hit during request()', async () => {
  _platformLimiterForTests.reset();
  // Drain limiter for the test key by direct calls.
  for (let i = 0; i < 60; i++) {
    _platformLimiterForTests.tryConsume('drained-key');
  }
  // Now any actual request() with this key should hit the limit before fetch.
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    // Audit-fix 2026-05-03: rate limit key is now a separate
    // constructor arg from idempotency key. Pass 'drained-key' as the
    // 3rd arg so the limiter check uses the same key we drained above.
    const client = new PlatformClient(baseConfig, 'idem-key-distinct', 'drained-key');
    await assert.rejects(
      () => client.request<unknown>({
        method: 'GET',
        path: '/account/v1/balance',
        bearerToken: 'tok',
      }),
      (err: unknown) => {
        assert.ok(err instanceof AtelMcpError);
        assert.match(err.hint ?? '', /Back off/i);
        return true;
      },
    );
    assert.equal(fetchCalled, false, 'rate-limited request must not reach fetch');
  } finally {
    globalThis.fetch = original;
  }
});
