/**
 * A2B (Agent-to-Business) gift-card purchase tools.
 *
 * Read tools (search / get / list) — no fund movement, low-risk.
 * Write tools (intent_create / lock_funds / execute_purchase) live in a
 * separate commit because they need approval gate + chain=base hard-lock
 * (Bitrefill doesn't accept Fast USDC, see project memo).
 *
 * Anti-drift wins this file enforces:
 *   1. limit Server-clamped to 30 (the SKILL.md → LLM-uses-5 case from prod)
 *   2. redemption code returned ONLY when status=DELIVERED (server-gated, not
 *      client trust)
 */

import {
  A2bSearchInputSchema,
  A2bPurchaseGetInputSchema,
  A2bPurchaseListInputSchema,
} from '../contracts/schemas.js';
import { a2bSearch, a2bDetail, a2bList, a2bRedemptionReveal } from '../platform/adapters.js';
import type { ToolExecutionContext } from '../server/context.js';
import { childAuditBase } from '../server/context.js';
import { requireScope } from '../server/guards.js';

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

export async function atelA2bPurchaseList(ctx: ToolExecutionContext, input?: unknown) {
  requireScope(ctx, 'a2b.read');
  const parsed = A2bPurchaseListInputSchema.parse(input ?? {});
  return a2bList(ctx, parsed);
}

export async function atelA2bPurchaseGet(ctx: ToolExecutionContext, input: unknown) {
  requireScope(ctx, 'a2b.read');
  const parsed = A2bPurchaseGetInputSchema.parse(input);

  const detail = (await a2bDetail(ctx, parsed.intentId)) as Record<string, unknown> | null;
  if (!detail) return null;

  // Anti-drift: redemption code is ONLY returned when status=DELIVERED.
  // Without this check, host LLM might assume the code is always present and
  // surface a stale / undefined value to the user. The reveal endpoint is
  // strict server-side too, but we double-check the gate here so audit
  // shows the policy decision (and the LLM gets a clear actionable hint).
  const status = String(detail.status ?? detail.contract_status ?? '').toUpperCase();
  let redemption: unknown = null;
  if (status === 'DELIVERED' || status === 'FULFILLED') {
    try {
      redemption = await a2bRedemptionReveal(ctx, parsed.intentId);
    } catch (e) {
      // Code reveal failed (e.g. caller is not the issuer). Surface as null
      // with a hint in metadata.
      redemption = { error: 'reveal_failed', message: (e as Error).message };
    }
  }

  await ctx.emitAudit({
    ...childAuditBase(ctx),
    type: 'tool.succeeded',
    status: 'ok',
    entityType: 'order',
    entityId: parsed.intentId,
    metadata: { intentStatus: status, hasRedemption: redemption !== null },
  });

  return { ...detail, redemption };
}
