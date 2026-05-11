/**
 * A2B (Agent-to-Business) gift-card purchase tools.
 *
 * Read tools (search / get / list) — no fund movement, low-risk.
 * Write tools (intent_create / lock_funds / execute_purchase) — real fund
 * movement; covered by sufficientBalance + walletReady prereqs and a hard
 * chain=base lock (Bitrefill rejects Fast/BSC USDC).
 *
 * Anti-drift wins this file enforces:
 *   1. limit server-clamped to 30 (the SKILL.md → LLM-uses-5 case from prod)
 *   2. redemption code returned ONLY when status=DELIVERED (server-gated, not
 *      client trust)
 *   3. chain hard-locked to 'base' for write path (host can't pass chain;
 *      prevents the prod regression where SDK accepted both raw and decimal
 *      amounts and LLM called it on Fast / BSC where Bitrefill silently rejects)
 *   4. amount in USDC decimal — schema rejects raw integers > 10000, and
 *      server-side balance check uses decimal too, so unit confusion can't
 *      pass type system AND prereq simultaneously
 */

import {
  A2bSearchInputSchema,
  A2bPurchaseGetInputSchema,
  A2bPurchaseListInputSchema,
  A2bIntentCreateInputSchema,
  A2bLockFundsInputSchema,
  A2bExecutePurchaseInputSchema,
  A2bPurchaseInputSchema,
  A2bQuoteInputSchema,
} from '../contracts/schemas.js';
import {
  a2bSearch,
  a2bCountries,
  a2bDetail,
  a2bList,
  a2bRedemptionReveal,
  a2bIntent,
  a2bDeposit,
  a2bCreateInvoice,
  a2bPay,
  a2bPurchase,
  a2bQuote,
  getBalance,
} from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';
import { assertPrerequisite } from '../auth/guards.js';
import { walletReady, sufficientBalance } from '../auth/prerequisites.js';
import { AtelMcpError } from '../contracts/errors.js';

/**
 * Server-enforced limit. The classic anti-drift case:
 *   SKILL.md: "use limit=30"
 *   Host LLM: "ok, default limit=5"
 *   Result: misses Boxer Giftcard at result position 7.
 * MCP fix: ignore host's limit, enforce 30 always.
 */
const A2B_SEARCH_LIMIT = 30;

export async function atelA2bSearch(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.read');
  const parsed = A2bSearchInputSchema.parse(input);
  // Server-clamp limit. Host can pass anything; we enforce A2B_SEARCH_LIMIT.
  const result = await a2bSearch(ctx, {
    query: parsed.query,
    country: parsed.country,
    limit: A2B_SEARCH_LIMIT,
  });
  return result;
}

/**
 * T3.4.2 — discoverable country list. Host LLM should call this BEFORE
 * passing a country code to atel_a2b_search / atel_a2b_purchase rather
 * than guessing. Server returns ~45 supported countries with a short
 * cache TTL; cheap call, run liberally.
 */
export async function atelA2bCountries(ctx: ToolExecutionContext) {
  requireScope(ctx, 'a2b.read');
  return a2bCountries(ctx);
}

export async function atelA2bPurchaseList(ctx: ToolExecutionContext, input?: unknown) {
  requireScope(ctx, 'a2b.read');
  const parsed = A2bPurchaseListInputSchema.parse(input ?? {});
  return a2bList(ctx, parsed);
}

/**
 * T3.4.1 — Get the live USDC quote for a product+value combo. Server
 * hits Bitrefill, returns the actual price the next purchase will cost.
 *
 * Anti-drift wins this tool enforces:
 *   1. Host LLM doesn't compute amount. Doesn't guess price. Doesn't
 *      use training data exchange rates ("$10 ≈ 0.0034 BTC * USDT
 *      rate ≈ ..."). Just picks (productId, value), gets the real
 *      number from Bitrefill via platform.
 *   2. The returned `quotedPriceUsdc` is the source of truth for the
 *      downstream lock_funds amount. Schema enforces non-zero positive
 *      response by the platform side.
 *   3. Caller is encouraged (in tool description) to call this BEFORE
 *      lock_funds — using the quote saves the "I lock 5 USDC but the
 *      card actually costs 5.30" failure mode.
 */
export async function atelA2bQuote(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.read');
  const parsed = A2bQuoteInputSchema.parse(input);
  return a2bQuote(ctx, parsed);
}

/**
 * One-shot A2B purchase. Replaces the legacy 3-step
 * intent_create → lock_funds → execute_purchase chain for MCP callers.
 * Platform's /trade/v1/remote/a2b/order does it all server-side.
 *
 * Required: a2b.write scope. Real funds move (USDC on chain=base).
 * Caller MUST have run atel_a2b_quote first to learn quotedPriceUsdc;
 * pass it (or higher) as maxAmountUsdc here so platform can refuse if
 * Bitrefill repushes a higher quote at order time.
 */
export async function atelA2bPurchase(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.write');
  const parsed = A2bPurchaseInputSchema.parse(input);
  return a2bPurchase(ctx, parsed);
}

export async function atelA2bPurchaseGet(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.read');
  const parsed = A2bPurchaseGetInputSchema.parse(input);

  const detail = (await a2bDetail(ctx, parsed.intentId)) as Record<string, unknown> | null;
  if (!detail) return null;

  // Anti-drift: redemption code is returned when status=DELIVERED/FULFILLED
  // OR when delivery.ready === true (Bitrefill has sealed the redemption
  // ciphertext server-side even if on-chain status hasn't flipped yet).
  //
  // 2026-05-11: tester report 4.5 — purchased gift card showed
  // `delivery.ready=true` but `effectiveStatus=EXPIRED_OR_ABANDONED`
  // (Bitrefill side delivered + redemption stored, but on-chain ConfirmDelivery
  // missed the deadline window, so EffectiveStatus fell to EXPIRED). Without
  // a delivery.ready bypass, the user paid real USDC + Bitrefill sent a real
  // code but the MCP tool refused to surface it. The fund + code are reality;
  // we should hand the code over.
  //
  // Status is read from multiple shapes because /trade/v1/remote/a2b/order
  // (this tool's adapter) and /trade/v1/a2b/detail (dashboard) serialize
  // the payload differently — onchain.status (remote) vs onchain.status_name
  // (dashboard), effectiveStatus (remote) vs status (dashboard).
  const detailAny = detail as Record<string, unknown> & {
    onchain?: { status?: string; status_name?: string };
    delivery?: { ready?: boolean };
    effectiveStatus?: string;
    contractStatus?: string;
  };
  const onchainStatus = String(
    detailAny.onchain?.status ?? detailAny.onchain?.status_name ?? ''
  ).toUpperCase();
  const status = String(
    detail.status ?? detail.contract_status ?? detailAny.effectiveStatus ?? detailAny.contractStatus ?? onchainStatus
  ).toUpperCase();
  const deliveryReady = detailAny.delivery?.ready === true;
  let redemption: unknown = null;
  let revealOk = false;
  if (status === 'DELIVERED' || status === 'FULFILLED' || deliveryReady) {
    try {
      redemption = await a2bRedemptionReveal(ctx, parsed.intentId);
      revealOk = true;
    } catch (e) {
      // Code reveal failed (e.g. caller is not the issuer). Surface as
      // an error object on the tool result so the LLM can see why, but
      // mark the audit metadata as hasRedemption=false so audit truth
      // doesn't claim we delivered a code when we didn't.
      redemption = { error: 'reveal_failed', message: (e as Error).message };
    }
  }

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'order',
    entityId: parsed.intentId,
    metadata: { intentStatus: status, hasRedemption: revealOk },
  });

  return { ...detail, redemption };
}

// ─── Write path ──────────────────────────────────────────────────────────
//
// Three-step Bitrefill flow (intentionally split so balance can be checked
// between user "I want X" and actual chain spend):
//
//   1. atel_a2b_intent_create  — create a gift-card intent (no funds moved).
//      Platform records max_amount in USDC for the chosen face value.
//
//   2. atel_a2b_lock_funds     — escrow USDC from user's base SA into the
//      a2b custody contract. This is where balance enforcement happens.
//
//   3. atel_a2b_execute_purchase — call Bitrefill createInvoice + pay
//      atomically server-side. On success, redemption code is fetched via
//      atel_a2b_purchase_get once status flips to DELIVERED.
//
// The split exists because Bitrefill's invoice has a short TTL (15-30 min);
// users sometimes browse for 5 minutes between intent_create and lock_funds.
// Doing it as one tool would race the invoice expiry.

/**
 * Create a Bitrefill purchase intent. No fund movement — just records the
 * product / face-value / country tuple and reserves max_amount in USDC.
 *
 * Anti-drift: `value` is local-currency face value (e.g. 1.0 USD for a $1 card),
 * NOT the USDC amount. Server / Bitrefill computes the USDC amount from
 * exchange rate. Schema's `.max(10000)` blocks the most common drift case
 * (LLM passing raw 6-decimal USDC like 1000000 = $1).
 */
export async function atelA2bIntentCreate(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.write');
  const parsed = A2bIntentCreateInputSchema.parse(input);

  const result = await a2bIntent(ctx, parsed);

  const intentId = typeof (result as { intentId?: unknown })?.intentId === 'string'
    ? String((result as { intentId?: unknown }).intentId)
    : undefined;

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'order',
    entityId: intentId,
    metadata: {
      productId: parsed.productId,
      faceValue: parsed.value,
      country: parsed.country,
    },
  });

  return result;
}

/**
 * Lock USDC funds for an intent. This is the real fund-movement step; checked
 * against on-chain balance + wallet readiness on chain=base.
 *
 * Anti-drift wins:
 *   - chain is NOT a parameter (server forces 'base'). Bitrefill rejects
 *     Fast / BSC USDC; allowing chain to leak in would let LLM lock funds
 *     that can never settle.
 *   - amount must be USDC decimal. sufficientBalance reads chainBalances.base
 *     (also decimal) so a raw integer like 10000 (= $0.01) would correctly
 *     fail the balance check, not silently pass.
 *   - walletReady('base') first because user might be Fast-only — without
 *     this they get an opaque on-chain revert.
 */
export async function atelA2bLockFunds(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.write');
  const parsed = A2bLockFundsInputSchema.parse(input);

  await assertPrerequisite(ctx.session, () => walletReady(ctx, 'base'));
  await assertPrerequisite(ctx.session, () => sufficientBalance(ctx, 'base', parsed.amount));

  // Resolve user's base smart-account address. Server hard-codes chain=base.
  const balance = (await getBalance(ctx)) as { chainAddresses?: Record<string, string> };
  const userSA = balance.chainAddresses?.base;
  if (!userSA) {
    // walletReady should have caught this, but defense in depth so we never
    // pass undefined to platform's a2b/wallet/deposit endpoint.
    throw new AtelMcpError(
      'WALLET_NOT_READY',
      'Base smart-account address missing after walletReady passed',
      { knownAddresses: Object.keys(balance.chainAddresses ?? {}) },
      'Retry atel_balance until chainAddresses.base appears.',
    );
  }

  const result = await a2bDeposit(ctx, {
    intentId: parsed.intentId,
    amount: parsed.amount,
    userSA,
  });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'order',
    entityId: parsed.intentId,
    metadata: {
      intentId: parsed.intentId,
      amount: parsed.amount,
      chain: 'base',
    },
  });

  return result;
}

/**
 * Execute the locked purchase. Two server-side calls (createInvoice → pay)
 * chained because Bitrefill requires an invoice to be created before a pay
 * can target it; splitting this into two MCP tools would let an LLM stop
 * after createInvoice and leave funds locked indefinitely.
 *
 * On success, status will eventually flip to DELIVERED (Bitrefill webhook,
 * usually <30s). Caller should poll atel_a2b_purchase_get to fetch the
 * redemption code.
 */
export async function atelA2bExecutePurchase(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.write');
  const parsed = A2bExecutePurchaseInputSchema.parse(input);

  const invoice = await a2bCreateInvoice(ctx, { intentId: parsed.intentId });
  const pay = await a2bPay(ctx, { intentId: parsed.intentId, amount: parsed.amount });

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'order',
    entityId: parsed.intentId,
    metadata: {
      intentId: parsed.intentId,
      amount: parsed.amount,
      chain: 'base',
      stage: 'invoice+pay',
    },
  });

  return { invoice, pay };
}
