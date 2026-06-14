/**
 * Pin behavior of the capability registry cache.
 *
 * Two layers being tested:
 *   1. validateCapability — the pure validation logic given a registry.
 *      Most regressions in the "drift" guard land here (host invents
 *      a string, gets a hint pointing at canonical names + suggestion).
 *   2. getCapabilityRegistry — fetch + cache + fallback path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCapabilityRegistry,
  validateCapability,
  _resetCapabilityCache,
  _getFallbackRegistry,
  type CapabilityRegistry,
} from '../platform/capability-cache.js';
import type { AtelMcpConfig } from '../config.js';

const baseConfig = {
  platformBaseUrl: 'https://api.atelai.xyz',
} as unknown as AtelMcpConfig;

const sampleRegistry: CapabilityRegistry = {
  capabilities: ['coding', 'writing', 'general'],
  aliases: { code: 'coding', write: 'writing', task: 'general' },
};

// ─── validateCapability ──────────────────────────────────────────────

test('validateCapability: canonical names accepted and returned as-is', () => {
  const r = validateCapability(sampleRegistry, 'coding');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized, 'coding');
});

test('validateCapability: aliases normalized to canonical', () => {
  const r = validateCapability(sampleRegistry, 'code');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized, 'coding');
});

test('validateCapability: case-insensitive', () => {
  const r = validateCapability(sampleRegistry, 'CODING');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized, 'coding');
});

test('validateCapability: trims whitespace', () => {
  const r = validateCapability(sampleRegistry, '  writing  ');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.normalized, 'writing');
});

test('validateCapability: empty input rejected with hint listing valid values', () => {
  const r = validateCapability(sampleRegistry, '');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.hint, /coding/);
    assert.match(r.hint, /writing/);
    assert.match(r.hint, /general/);
  }
});

test('validateCapability: unknown rejected with hint + suggestion when prefix matches', () => {
  // "cod" prefix-matches "coding" → suggestion offered.
  const r = validateCapability(sampleRegistry, 'cod');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.suggestion, 'coding');
    assert.match(r.hint, /coding/);
    assert.match(r.hint, /Did you mean "coding"/);
  }
});

test('validateCapability: unknown with no near-match still gives full list', () => {
  const r = validateCapability(sampleRegistry, 'xyz_invented_string');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.suggestion, undefined);
    assert.match(r.hint, /Valid values:/);
  }
});

// ─── getCapabilityRegistry: fetch + cache + fallback ─────────────────

test('getCapabilityRegistry: fetches from platform on first call', async () => {
  _resetCapabilityCache();
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      capabilities: ['coding', 'writing'],
      aliases: { code: 'coding' },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const reg = await getCapabilityRegistry(baseConfig);
    assert.deepEqual(reg.capabilities, ['coding', 'writing']);
    assert.equal(reg.aliases.code, 'coding');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/capability\/v1\/standard$/);
  } finally {
    globalThis.fetch = original;
  }
});

test('getCapabilityRegistry: second call uses cache (no extra fetch)', async () => {
  _resetCapabilityCache();
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({
      capabilities: ['coding'],
      aliases: {},
    }), { status: 200 });
  }) as typeof fetch;
  try {
    await getCapabilityRegistry(baseConfig);
    await getCapabilityRegistry(baseConfig);
    await getCapabilityRegistry(baseConfig);
    assert.equal(fetchCount, 1, 'expected exactly 1 platform fetch across 3 cache reads');
  } finally {
    globalThis.fetch = original;
  }
});

test('getCapabilityRegistry: falls back when platform fetch fails', async () => {
  _resetCapabilityCache();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('platform unreachable');
  }) as typeof fetch;
  // Suppress the expected console.error noise.
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const reg = await getCapabilityRegistry(baseConfig);
    assert.deepEqual(reg, _getFallbackRegistry());
  } finally {
    globalThis.fetch = original;
    console.error = originalConsoleError;
  }
});

test('getCapabilityRegistry: falls back when platform returns empty list', async () => {
  _resetCapabilityCache();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ capabilities: [], aliases: {} }), { status: 200 });
  }) as typeof fetch;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const reg = await getCapabilityRegistry(baseConfig);
    assert.deepEqual(reg, _getFallbackRegistry());
  } finally {
    globalThis.fetch = original;
    console.error = originalConsoleError;
  }
});

test('getCapabilityRegistry: concurrent first calls share single in-flight fetch', async () => {
  _resetCapabilityCache();
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    // simulate latency so concurrent callers all queue up
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({
      capabilities: ['coding'],
      aliases: {},
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const [a, b, c] = await Promise.all([
      getCapabilityRegistry(baseConfig),
      getCapabilityRegistry(baseConfig),
      getCapabilityRegistry(baseConfig),
    ]);
    assert.equal(fetchCount, 1, 'concurrent callers must share the in-flight fetch');
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  } finally {
    globalThis.fetch = original;
  }
});

// ─── Fallback registry sanity ────────────────────────────────────────

test('fallback registry mirrors atel-platform/internal/capability/normalize.go canonical list', () => {
  const fallback = _getFallbackRegistry();
  // Sample of canonical names that must be present (drift guard).
  const required = ['coding', 'research', 'translation', 'data', 'writing', 'general'];
  for (const cap of required) {
    assert.ok(fallback.capabilities.includes(cap), `fallback missing canonical: ${cap}`);
  }
  // Sample of aliases that must map correctly.
  assert.equal(fallback.aliases.code, 'coding');
  assert.equal(fallback.aliases.write, 'writing');
  assert.equal(fallback.aliases.task, 'general');
});
