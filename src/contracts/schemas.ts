import { z } from 'zod';

export const DidSchema = z.string().min(1).startsWith('did:atel:');
export const OrderIdSchema = z.string().min(1).startsWith('ord-');

export const WhoamiOutputSchema = z.object({
  did: DidSchema,
  environment: z.enum(['production', 'local-test', 'custom']),
  scopes: z.array(z.string())
});

// Onboarding (T3.1.1): mint a fresh identity in one call. Pre-auth tool —
// caller has no DID yet. All fields optional; sourceLabel helps audit
// trace which host triggered the registration.
export const RegisterUserInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  sourceLabel: z.string().min(1).max(64).optional()
});

// Onboarding (T3.1.3): advertise a callback endpoint for async events.
// Server is the authority on http-vs-https decision (production rejects
// http://, non-prod ATEL_ENV_PROFILE=development|staging|test accepts it).
// Client-side we only require a valid http(s) URL — non-http schemes
// (ftp://, ws://, file://) would always fail server-side, so reject early.
export const RegisterEndpointInputSchema = z.object({
  endpoint: z.string().url().regex(/^https?:\/\//, 'endpoint must be http:// or https://'),
  label: z.string().min(1).max(64).optional()
});

// Onboarding (T3.1.5): look up DID by recovery code (pre-auth tool).
// 16-char minimum is a defensive lower bound; production codes are 52
// chars (32 bytes base32). Real validation happens server-side.
export const RecoverInputSchema = z.object({
  recoveryCode: z.string().min(16).max(64)
});

const RuntimeBackendSchema = z.enum(['platform-hosted', 'sdk-runtime', 'linked-runtime']);
const UserModeSchema = z.enum(['mcp-only', 'runtime-only', 'mcp-plus-runtime']);
const ExecutionClassSchema = z.enum(['platform-truth-read', 'platform-state-write', 'runtime-capable']);

export const RuntimeLinkRecordSchema = z.object({
  hostedDid: DidSchema,
  runtimeDid: DidSchema,
  backend: z.enum(['sdk-runtime', 'linked-runtime']),
  status: z.enum(['linked', 'degraded', 'offline']).optional(),
  endpoint: z.string().url().optional(),
  relayBaseUrl: z.string().url().optional(),
  lastSeenAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const RuntimeLinkStatusOutputSchema = z.object({
  did: DidSchema,
  linked: z.boolean(),
  runtimeLink: RuntimeLinkRecordSchema.nullable(),
  executionPlan: z.object({
    requestedBackend: RuntimeBackendSchema.optional(),
    declaredUserMode: UserModeSchema.optional(),
    selectedBackend: RuntimeBackendSchema,
    executionClass: ExecutionClassSchema,
    runtimeEligible: z.boolean(),
    futureBackends: z.array(RuntimeBackendSchema),
    runtimeLinkStatus: z.enum(['none', 'linked']),
    runtimeLink: RuntimeLinkRecordSchema.optional(),
    reason: z.string()
  }),
  architecture: z.object({
    userEntryMode: z.literal('mcp-primary'),
    runtimeRole: z.literal('sdk-runtime'),
    runtimeBackends: z.array(z.string()),
    supportedUserModes: z.array(z.string()),
    sourceOfTruth: z.literal('platform')
  })
});

export const RuntimeLinkBindInputSchema = z.object({
  runtimeDid: DidSchema,
  backend: z.enum(['sdk-runtime', 'linked-runtime']),
  endpoint: z.string().url().optional(),
  relayBaseUrl: z.string().url().optional(),
  authToken: z.string().min(1).optional(),
  status: z.enum(['linked', 'degraded', 'offline']).optional().default('linked')
});

export const RuntimeLinkMutationOutputSchema = z.object({
  did: DidSchema,
  action: z.enum(['bind', 'unbind']),
  changed: z.boolean(),
  linked: z.boolean(),
  runtimeLink: RuntimeLinkRecordSchema.nullable()
});

export const AgentRegisterInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  capabilities: z.array(z.string().min(1)).min(1),
  discoverable: z.boolean().default(true)
});

// query is optional — when omitted, returns all online discoverable agents
// (platform's handleSearch treats empty ?q= as "no name filter"). Originally
// we required min(1) as an anti-drift guard to stop LLM from calling
// agent_search to spam the registry, but that backfired: questions like
// "现在有多少 agent 在线" / "list all agents" became un-answerable — the
// schema rejected the empty query and the LLM, finding no data, hallucinated
// "只有你一个 agent 在线" even though 10+ agents were online. Verified prod
// 2026-05-11 with new user 哆啦弟. The platform-side capability filter is
// still optional so power users can narrow to capability.
export const AgentSearchInputSchema = z.object({
  query: z.string().optional(),
  capability: z.string().min(1).optional()
});

export const SendMessageInputSchema = z.object({
  peerDid: DidSchema,
  text: z.string().min(1).max(8000)
});

export const AckInputSchema = z.object({
  messageIds: z.array(z.number().int().positive()).min(1)
});

// AVIP TaskRequest envelope — must match platform's TaskRequest struct
// (atel-platform/internal/trade/handler.go). Plugin signs this with the
// requester's ed25519 secret key before calling atel_order_create; MCP
// server forwards to platform unchanged (no signing here — the server
// has no private keys). Platform verifies signature and runs AVIP v2
// flow: Intent anchored, CompletionProof at settle.
export const TaskRequestSchema = z.object({
  version: z.literal(2),
  orderId: z.string().nullable().optional(),
  taskId: z.string().min(1),
  requesterDid: DidSchema,
  executorDid: DidSchema,
  capability: z.string().min(1),
  description: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  timestamp: z.string().min(1)
});

export const OrderCreateInputSchema = z.object({
  executorDid: DidSchema,
  capabilityType: z.string().min(1),
  description: z.string().min(1).max(20000),
  priceUsdc: z.number().min(0),
  // Optional AVIP fields — when ALL of them are present, platform runs
  // the v2 path (signed TaskRequest verified, Intent stored + anchored,
  // CompletionProof generated at settle with FULFILLED/PARTIAL/VIOLATED
  // verdict). When absent, falls back to v0/v1 (no intent, no proof).
  // Plugin-side helper builds + signs all three in one pass; MCP server
  // forwards as-is (no signing here — server has no private keys).
  version: z.literal(2).optional(),
  taskRequest: TaskRequestSchema.optional(),
  taskSignature: z.string().min(1).optional(),
  intent: z.record(z.unknown()).optional(),
  // Settlement chain. REQUIRED — caller MUST explicitly pick one.
  // 2026-05-11: previously .optional() with platform-side default 'base'.
  // Two consecutive prod tests (ord-89fccad9-fc9, ord-180272fe-9a5,
  // ord-f27b0ad8-67d) all silently fell back to base because the LLM
  // kept reading the SKILL's P2P Fast transfer section, deciding "fast"
  // was a transfer keyword, and omitting chain. Making this required
  // forces the LLM to face a deterministic decision at tool-call time:
  // pick base/bsc/fast-coop based on what the user said. Anti-drift:
  // keep enum in lockstep with platform's internal/trade/order_handler.go.
  chain: z.enum(['base', 'bsc', 'fast-coop'])
    .describe(
      'REQUIRED settlement chain for the order escrow. Pick exactly one based on the user\'s words: ' +
      '(1) "base" — Base EVM AutoEscrow (~4-8min settle). DEFAULT when the user does NOT mention fast/bsc anywhere in the request. ' +
      '(2) "fast-coop" — Fast Network gasless escrow (~1min). MUST pick this whenever the user\'s message contains ANY of these tokens, regardless of surrounding context: "fast", "fast-coop", "fast 链", "走 fast", "用 fast", "这单 fast", "fast 结算". Do not second-guess based on whether the sentence "feels like" a transfer — fast in an order_create call always means fast-coop chain. ' +
      '(3) "bsc" — BSC EVM AutoEscrow. MUST pick when user says "bsc / 走 bsc". ' +
      'You CANNOT omit this field; the schema rejects missing chain.'
    )
});

export const OrderAcceptInputSchema = z.object({
  orderId: OrderIdSchema
});

export const OrderCompleteInputSchema = z.object({
  orderId: OrderIdSchema,
  taskId: z.string().min(1).optional(),
  proofBundle: z.record(z.string(), z.unknown()),
  anchorTx: z.string().min(1).optional(),
  traceRoot: z.string().min(1),
  chain: z.enum(['base', 'bsc', 'fast-coop']).optional(),
  traceEvents: z.array(z.record(z.string(), z.unknown())).optional(),
  audit: z.record(z.string(), z.unknown()).optional()
});

export const OrderConfirmInputSchema = z.object({
  orderId: OrderIdSchema
});

export const MilestoneActionInputSchema = z.object({
  orderId: OrderIdSchema,
  index: z.number().int().min(0).max(9)
});

export const MilestoneSubmitInputSchema = MilestoneActionInputSchema.extend({
  content: z.string().min(1).max(20000)
});

export const DisputeCreateInputSchema = z.object({
  orderId: OrderIdSchema,
  // T3.6.3: min 100 chars forces meaningful explanation. Anti-drift case
  // from production: host LLM submits "didn't work" as reason, arbitrator
  // can't decide. 100 chars ≈ 2 short sentences — enough for context.
  reason: z.string().min(100, 'reason must be >=100 chars to support arbitration').max(4000)
});

// T3.6.2 — Platform DID arbitration. verdict picks the winning side or a
// proportional split. split_ratio is required iff verdict='split'.
export const DisputeResolveInputSchema = z.object({
  disputeId: z.string().min(1),
  verdict: z.enum(['favor_requester', 'favor_executor', 'split']),
  // 0..1, fraction going to the REQUESTER (the rest goes to executor).
  // Only used when verdict='split'.
  splitRatio: z.number().min(0).max(1).optional(),
  notes: z.string().min(20, 'arbitrator notes must be >=20 chars').max(4000)
}).refine(
  (val) => val.verdict !== 'split' || typeof val.splitRatio === 'number',
  { message: 'splitRatio is required when verdict=split', path: ['splitRatio'] },
);

export const AuditOrderQueryInputSchema = z.object({
  orderId: OrderIdSchema,
  limit: z.number().int().min(1).max(500).optional().default(100)
});

export const AuditSessionQueryInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional().default(100)
});

export const AuditRequestQueryInputSchema = z.object({
  requestId: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(100)
});

// ─── A2B (Bitrefill gift card) schemas ────────────────────────────────
//
// Anti-drift design notes:
// - `query` is free-form (Bitrefill product name).
// - `country` is a free string here but server-side validates against
//   Bitrefill's supported list. We do NOT enum it client-side because
//   the list changes; instead errors carry actionable hint.
// - `limit` is server-clamped (see a2b.ts tool wrapper) — host LLM can
//   send any number, the tool enforces 30. The infamous漂移 case:
//   SKILL.md says "use 30", LLM uses 5 default, misses Boxer at position 7.

const A2bIntentIdSchema = z.string().min(1).startsWith('intent_');

export const A2bSearchInputSchema = z.object({
  query: z.string().min(1).max(200),
  country: z.string().min(2).max(40).optional(),
  // Note: server clamps to 30 regardless of what host passes; this field is
  // kept optional so the schema doesn't reject calls that omit it.
  limit: z.number().int().min(1).max(50).optional()
});

export const A2bPurchaseGetInputSchema = z.object({
  intentId: A2bIntentIdSchema
});

export const A2bPurchaseListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0)
});

// Anti-drift notes for write path:
// - amount fields are ALWAYS in USDC decimal (e.g. 0.01 = 1 cent, not raw 10000).
//   Production drift: SDK accepted both raw and decimal, LLM mixed them up.
// - chain is NOT accepted from host. Server hard-codes 'base' because Bitrefill
//   doesn't accept Fast/BSC USDC. See `测试/.../A2B-Fast链路开发计划` memo.
// - productId must come from a real atel_a2b_search result. Server will defer
//   the scope check to platform a2b policy table; MCP just shapes the input.

export const A2bIntentCreateInputSchema = z.object({
  productId: z.string().min(1).max(200),
  // value is local-currency face value (e.g. 1.0 USD for a $1 Boxer card),
  // not the USDC amount paid. Server / Bitrefill computes the USDC amount.
  value: z.number().positive().max(10000),
  country: z.string().min(2).max(40).optional()
});

// T3.4.x — atel_a2b_purchase consolidates the legacy stepwise flow
// (intent_create → lock_funds → execute_purchase) into a single platform
// call against /trade/v1/remote/a2b/order. Platform creates the intent,
// deposits user funds into the A2B contract, asks Bitrefill for an
// invoice, pays it, and (optionally) reveals the redemption code in one
// shot. Host LLM only needs to know:
//   1. the productId (from atel_a2b_search)
//   2. the face value (e.g. 50 ZAR for cheapest Boxer SA)
//   3. a USDC ceiling (maxAmountUsdc) — server refuses if Bitrefill quotes
//      higher
// Returns the intent id, the actual paid USDC, and the delivery status
// ('delivered' / 'pending' / 'paid'). If autoReveal=false, caller must
// poll atel_a2b_purchase_get for the redemption code.
export const A2bPurchaseInputSchema = z.object({
  query: z.string().min(1).max(200),
  productId: z.string().min(1).max(200),
  value: z.number().positive().max(10000),
  country: z.string().min(2).max(40).optional(),
  maxAmountUsdc: z.number().positive().max(10000),
  autoReveal: z.boolean().optional(),
});

// T3.4.1 — server-side quote calculation. Anti-drift principle #1:
// host doesn't compute amount, doesn't guess prices. It picks (productId,
// value) and the platform calls Bitrefill to get the actual USDC charge.
// The returned `quotedPriceUsdc` is the source of truth for the
// downstream lock_funds / execute_purchase amount.
export const A2bQuoteInputSchema = z.object({
  // Original search query — platform uses it to ensure quote matches
  // what the user searched for (defense against productId spoofing).
  query: z.string().min(1).max(200),
  productId: z.string().min(1).max(200),
  value: z.number().positive().max(10000),
  country: z.string().min(2).max(40).optional()
});

export const A2bLockFundsInputSchema = z.object({
  intentId: A2bIntentIdSchema,
  // amount is USDC decimal (NOT raw). Server enforces it equals the
  // intent's max_amount within tolerance — host can't lock more / less.
  amount: z.number().positive().max(10000)
});

export const A2bExecutePurchaseInputSchema = z.object({
  intentId: A2bIntentIdSchema,
  // amount is USDC decimal of payment to Bitrefill. Server validates against
  // already-deposited amount.
  amount: z.number().positive().max(10000)
});

// ─── Fast Network schemas ────────────────────────────────────────────────
//
// Anti-drift design notes:
// - chain is NOT a parameter on fast_transfer (server hard-codes 'fast').
//   Without this, the LLM might pass chain='base' but use a 64-char hex
//   address — Fast format on EVM endpoint silently fails.
// - recipient accepts EITHER a `did:atel:` DID (we base58-decode → hex) OR
//   a raw 64-char hex string. bech32 NOT accepted (Fast P2P endpoint
//   rejects it; see fast_p2p_transfer_done memo).
// - amount is USDC decimal (0.001 = 1000 micro-USDC). Schema caps at 10000
//   to block raw 6-decimal integers (e.g. `1000` would be $0.001 in
//   decimal but LLM may have meant $1000 = 1000000000 raw).

const FastHexAddressSchema = z.string().regex(/^[0-9a-fA-F]{64}$/, 'Fast address must be 64-char hex (no 0x prefix)');

// Recipient: either ATEL DID (we resolve to hex) or raw 64-char hex.
const FastRecipientSchema = z.union([DidSchema, FastHexAddressSchema]);

export const FastTransferInputSchema = z.object({
  recipient: FastRecipientSchema,
  amount: z.number().positive().max(10000),
  // Optional human-readable note for audit (does NOT go on-chain — Fast's
  // user_data is Option<32-byte hash>, not arbitrary text. See memo.)
  memo: z.string().max(200).optional()
});

// ─── EVM wallet transfer (base / bsc) ────────────────────────────────────
//
// Anti-drift design notes:
// - chain is REQUIRED + restricted to base/bsc (Fast goes via fast_transfer
//   which has different recipient format). Without forcing this distinction,
//   LLM can pass a hex 64-char Fast address with chain=base — silent fail.
// - address must be EVM 0x-prefixed 40-char hex. Schema rejects 64-char
//   Fast hex format and bech32.
// - amount is USDC decimal, capped at 10000.

const EvmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'EVM address must be 0x-prefixed 40-char hex');

export const WalletTransferInputSchema = z.object({
  chain: z.enum(['base', 'bsc']),
  address: EvmAddressSchema,
  amount: z.number().positive().max(10000),
  memo: z.string().max(200).optional()
});

// ─── Withdraw to external wallet (base / bsc / fast) ─────────────────────
//
// vs transfer:
// - Withdraw assumes the recipient is OUTSIDE the ATEL ecosystem
//   (cold storage, external CEX, personal wallet). transfer is for
//   ATEL-internal P2P movement.
// - Anti-drift: handler warns if the address actually IS a known ATEL
//   agent (probable host LLM mistake — meant transfer).
// - Address format validated per chain (EVM 0x for base/bsc, raw 64-hex
//   for fast — bech32 / DID forms NOT accepted; user should use
//   atel_fast_transfer if they want DID-aware sending).

const FastHexAddrOnlySchema = z.string().regex(/^[0-9a-fA-F]{64}$/, 'Fast address must be 64-char hex (no 0x prefix). Use atel_fast_transfer for DID/bech32 forms.');

// Use a discriminated union so the address regex is enforced per-chain
// — base/bsc require 0x..40, fast requires 64 hex.
export const WalletWithdrawInputSchema = z.discriminatedUnion('chain', [
  z.object({
    chain: z.literal('base'),
    address: EvmAddressSchema,
    amount: z.number().positive().max(10000),
    memo: z.string().max(200).optional()
  }),
  z.object({
    chain: z.literal('bsc'),
    address: EvmAddressSchema,
    amount: z.number().positive().max(10000),
    memo: z.string().max(200).optional()
  }),
  z.object({
    chain: z.literal('fast'),
    address: FastHexAddrOnlySchema,
    amount: z.number().positive().max(10000),
    memo: z.string().max(200).optional()
  })
]);
