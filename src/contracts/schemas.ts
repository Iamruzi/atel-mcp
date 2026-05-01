import { z } from 'zod';

export const DidSchema = z.string().min(1).startsWith('did:atel:');
export const OrderIdSchema = z.string().min(1).startsWith('ord-');

export const WhoamiOutputSchema = z.object({
  did: DidSchema,
  environment: z.enum(['production', 'local-test', 'custom']),
  scopes: z.array(z.string())
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

export const AgentSearchInputSchema = z.object({
  query: z.string().min(1),
  capability: z.string().min(1).optional()
});

export const SendMessageInputSchema = z.object({
  peerDid: DidSchema,
  text: z.string().min(1).max(8000)
});

export const AckInputSchema = z.object({
  messageIds: z.array(z.number().int().positive()).min(1)
});

export const OrderCreateInputSchema = z.object({
  executorDid: DidSchema,
  capabilityType: z.string().min(1),
  description: z.string().min(1).max(20000),
  priceUsdc: z.number().min(0)
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
  chain: z.enum(['base', 'bsc']).optional(),
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
  reason: z.string().min(1).max(4000)
});

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
