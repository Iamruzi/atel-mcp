/**
 * Pin atel_a2b_quote behavior — the anti-drift "Server 算" principle in
 * action. If this regresses, host LLMs go back to guessing prices with
 * training-data exchange rates and lock_funds will use wrong amounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { atelA2bQuote } from '../tools/a2b.js';
import type { ToolExecutionContext } from '../server/context.js';

interface MockReq {
  method: string;
  path: string;
  body?: unknown;
}

function makeCtx(platformResponse: unknown) {
  return {
    session: { did: 'did:atel:ed25519:tester', scopes: ['a2b.read'], environment: 'production', bearerToken: 'tok', sessionId: 's' },
    config: {},
    platform: {
      request: async (_req: MockReq) => platformResponse,
    },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;
}

test('a2b_quote: forwards (query, productId, value, country) to platform /a2b/quote-preview', async () => {
  let captured: MockReq | null = null;
  const ctx = {
    session: { did: 'did:atel:ed25519:tester', scopes: ['a2b.read'], environment: 'production', bearerToken: 'tok', sessionId: 's' },
    config: {},
    platform: {
      request: async (req: MockReq) => {
        captured = req;
        return {
          quotedPriceUsdc: 5.32,
          recommendedMaxAmountUsdc: 5.5,
          settlementChain: 'base',
          product: { productId: 'boxer-za-5', name: 'Boxer Giftcard 5 ZAR' },
          selectedPackage: { id: 'pkg-5', value: '5', amount: 5, quotedPriceUsdc: 5.32 },
        };
      },
    },
    emitAudit: async () => {},
  } as unknown as ToolExecutionContext;

  const result = await atelA2bQuote(ctx, {
    query: 'Boxer',
    productId: 'boxer-za-5',
    value: 5,
    country: 'ZA',
  });

  assert.ok(captured);
  const c = captured as MockReq;
  assert.equal(c.method, 'POST');
  assert.equal(c.path, '/trade/v1/remote/a2b/quote-preview');
  assert.deepEqual(c.body, {
    query: 'Boxer',
    productId: 'boxer-za-5',
    value: 5,
    country: 'ZA',
  });
  // Quote response surfaces what callers need.
  const r = result as { quotedPriceUsdc?: number; recommendedMaxAmountUsdc?: number };
  assert.equal(r.quotedPriceUsdc, 5.32);
  assert.equal(r.recommendedMaxAmountUsdc, 5.5);
});

test('a2b_quote: schema rejects empty query', async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => atelA2bQuote(ctx, { query: '', productId: 'x', value: 1 }),
    (err: unknown) => err instanceof Error,
  );
});

test('a2b_quote: schema rejects missing productId', async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => atelA2bQuote(ctx, { query: 'Boxer', value: 1 }),
    (err: unknown) => err instanceof Error,
  );
});

test('a2b_quote: schema rejects negative or zero value', async () => {
  const ctx = makeCtx({});
  await assert.rejects(
    () => atelA2bQuote(ctx, { query: 'Boxer', productId: 'p', value: 0 }),
    (err: unknown) => err instanceof Error,
  );
  await assert.rejects(
    () => atelA2bQuote(ctx, { query: 'Boxer', productId: 'p', value: -5 }),
    (err: unknown) => err instanceof Error,
  );
});

test('a2b_quote: schema rejects host attempting to compute amount themselves (>10000 cap on value)', async () => {
  // 10000 cap is "no real giftcard is worth $10k". If host passes raw
  // 6-decimal USDC (e.g. 1000000 = $1), this rejects pre-flight before
  // hitting platform.
  const ctx = makeCtx({});
  await assert.rejects(
    () => atelA2bQuote(ctx, { query: 'Boxer', productId: 'p', value: 1000000 }),
    (err: unknown) => err instanceof Error,
  );
});

test('a2b_quote: returns whatever platform returns (caller uses quotedPriceUsdc as source of truth)', async () => {
  const platformReply = {
    quotedPriceUsdc: 12.34,
    estimatedPriceUsdc: 12.20,
    recommendedMaxAmountUsdc: 12.95,
    warnings: ['estimate vs quoted differ by >1%'],
  };
  const ctx = makeCtx(platformReply);
  const result = await atelA2bQuote(ctx, {
    query: 'Boxer',
    productId: 'boxer-za-10',
    value: 10,
  });
  assert.deepEqual(result, platformReply);
});
