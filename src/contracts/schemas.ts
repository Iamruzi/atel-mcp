import { z } from 'zod';

export const DidSchema = z.string().min(1).startsWith('did:atel:');
export const OrderIdSchema = z.string().min(1).startsWith('ord-');

export const WhoamiOutputSchema = z.object({
  did: DidSchema,
  environment: z.enum(['production', 'local-test', 'custom']),
  scopes: z.array(z.string())
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
