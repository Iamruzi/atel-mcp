import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from '../config.js';
import { dispatchTool } from './tool-dispatch.js';
import {
  AckInputSchema,
  AgentRegisterInputSchema,
  AgentSearchInputSchema,
  RecoverInputSchema,
  RegisterEndpointInputSchema,
  RegisterUserInputSchema,
  DisputeCreateInputSchema,
  DisputeResolveInputSchema,
  AuditOrderQueryInputSchema,
  AuditRequestQueryInputSchema,
  AuditSessionQueryInputSchema,
  MilestoneActionInputSchema,
  MilestoneSubmitInputSchema,
  OrderAcceptInputSchema,
  OrderCompleteInputSchema,
  OrderConfirmInputSchema,
  OrderCreateInputSchema,
  RuntimeLinkBindInputSchema,
  SendMessageInputSchema,
  A2bSearchInputSchema,
  A2bPurchaseGetInputSchema,
  A2bPurchaseListInputSchema,
  A2bIntentCreateInputSchema,
  A2bLockFundsInputSchema,
  A2bExecutePurchaseInputSchema,
  A2bPurchaseInputSchema,
  A2bQuoteInputSchema,
  FastTransferInputSchema,
  WalletTransferInputSchema,
  WalletWithdrawInputSchema,
} from '../contracts/schemas.js';
import type { AuditSink } from './context.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';
import * as order from '../tools/order.js';

function asToolResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Wrap a tool invocation so that AtelMcpError throws surface as STRUCTURED
 * tool errors. Without this, the MCP SDK's default createToolError() keeps
 * only error.message and drops .code, .details (e.g. approval id, intent
 * hash, hint, prereq fix steps) — which is exactly the actionable payload
 * the host LLM needs to recover.
 *
 * Structure (must stay backward-compatible with happy-path tool results
 * that already use { content: [{type:'text', text: JSON-string}] }):
 *
 *   {
 *     content: [{ type: 'text', text: <pretty-json of {code, message, details, hint}> }],
 *     isError: true
 *   }
 *
 * Discovered 2026-05-03 during scenario testing: APPROVAL_PENDING gate
 * was firing but the host had no way to extract the approval id.
 */
async function tryInvoke(invoke: (toolName: string, input?: unknown) => Promise<unknown>, toolName: string, input?: unknown) {
  try {
    return asToolResult(await invoke(toolName, input));
  } catch (err) {
    const isAtelMcp = err && typeof err === 'object' && 'code' in err && 'message' in err;
    if (isAtelMcp) {
      const e = err as { code: string; message: string; details?: unknown; hint?: string };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ code: e.code, message: e.message, details: e.details ?? null, hint: e.hint ?? null }, null, 2),
        }],
        isError: true,
      };
    }
    // Non-AtelMcpError — let SDK default handling kick in
    throw err;
  }
}

function orderIdInput() {
  return { orderId: z.string().min(1).startsWith('ord-') };
}

function disputeIdInput() {
  return { disputeId: z.string().min(1) };
}

export async function createAtelMcpServer(args: {
  authorization?: string | null;
  requestId?: string;
  idempotencyKey?: string;
  hostName?: string;
  userAgent?: string;
  preferredRuntimeBackend?: 'platform-hosted' | 'sdk-runtime' | 'linked-runtime';
  declaredUserMode?: 'mcp-only' | 'runtime-only' | 'mcp-plus-runtime';
  audit?: AuditSink;
  auth?: AuthIntrospectionClient;
}) {
  const config = loadConfig();
  const server = new McpServer({ name: 'atel-mcp', version: '0.1.0' });

  const invoke = (toolName: string, input?: unknown) => dispatchTool({
    toolName,
    input,
    authorization: args.authorization,
    requestId: args.requestId,
    idempotencyKey: args.idempotencyKey,
    hostName: args.hostName,
    userAgent: args.userAgent,
    preferredRuntimeBackend: args.preferredRuntimeBackend,
    declaredUserMode: args.declaredUserMode,
    config,
    audit: args.audit,
    auth: args.auth,
  });

  server.registerTool('atel_whoami', { description: 'Return current authenticated ATEL identity and environment.' }, async () => tryInvoke(invoke, 'atel_whoami'));
  server.registerTool('atel_register_user', { description: 'Mint a fresh ATEL identity end-to-end. UNAUTHENTICATED — caller has no DID yet. Returns {did, secretKey, token, walletStatus, recoveryCode}. Save secretKey AND recoveryCode securely; use token as Bearer for subsequent calls.', inputSchema: RegisterUserInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_register_user', input));
  server.registerTool('atel_recover', { description: 'Look up DID by recoveryCode (returned at atel_register_user time). UNAUTHENTICATED. Use case: you kept secretKey but forgot which DID it belongs to. Lost secretKey is NOT recoverable — by design.', inputSchema: RecoverInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_recover', input));
  server.registerTool('atel_runtime_link_status', { description: 'Return runtime-link status and staged execution routing metadata for the current identity.' }, async () => tryInvoke(invoke, 'atel_runtime_link_status'));
  server.registerTool('atel_runtime_link_bind', { description: 'Bind the current hosted DID to a runtime DID for future staged runtime dispatch.', inputSchema: RuntimeLinkBindInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_runtime_link_bind', input));
  server.registerTool('atel_runtime_link_unbind', { description: 'Remove the runtime binding for the current hosted DID.' }, async () => tryInvoke(invoke, 'atel_runtime_link_unbind'));
  server.registerTool('atel_agent_register', { description: 'Register or update the current ATEL agent profile.', inputSchema: AgentRegisterInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_agent_register', input));
  server.registerTool('atel_agent_search', { description: 'Search registered ATEL agents by capability or identity.', inputSchema: AgentSearchInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_agent_search', input));
  server.registerTool('atel_register_endpoint', { description: 'Advertise an HTTPS callback URL the platform can use to push async events. Server validates HTTPS + reachability (HEAD probe) before persisting. SDK / OpenClaw / self-hosted agents need this; pure MCP-only users can skip and poll atel_inbox_list instead.', inputSchema: RegisterEndpointInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_register_endpoint', input));
  server.registerTool('atel_balance', { description: 'Return current ATEL account balances.' }, async () => tryInvoke(invoke, 'atel_balance'));
  server.registerTool('atel_deposit_info', { description: 'Return supported deposit chains and addresses.' }, async () => tryInvoke(invoke, 'atel_deposit_info'));
  server.registerTool('atel_wallet_status', { description: 'Poll wallet deployment progress after atel_register_user. Returns {status:pending|partial|ready, chainAddresses, hint}. Poll every 3-5s until status=ready before placing paid orders.' }, async () => tryInvoke(invoke, 'atel_wallet_status'));
  server.registerTool('atel_contacts_list', { description: 'List available ATEL contacts for the current identity.' }, async () => tryInvoke(invoke, 'atel_contacts_list'));
  server.registerTool('atel_inbox_list', { description: 'List recent ATEL messages for the current identity.' }, async () => tryInvoke(invoke, 'atel_inbox_list'));
  server.registerTool('atel_send_message', { description: 'Send a text message to another ATEL agent.', inputSchema: SendMessageInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_send_message', input));
  server.registerTool('atel_ack', { description: 'Acknowledge received ATEL messages.', inputSchema: AckInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_ack', input));
  server.registerTool('atel_order_get', { description: 'Get an order summary.', inputSchema: orderIdInput() }, async (input) => tryInvoke(invoke, 'atel_order_get', input));
  server.registerTool('atel_order_list', { description: 'List orders visible to the current DID.', inputSchema: { role: z.string().optional(), status: z.string().optional() } }, async (input) => tryInvoke(invoke, 'atel_order_list', input));
  server.registerTool('atel_order_timeline', { description: 'Get the order activity timeline.', inputSchema: orderIdInput() }, async (input) => tryInvoke(invoke, 'atel_order_timeline', input));
  server.registerTool('atel_order_create', { description: 'Create an ATEL order.', inputSchema: OrderCreateInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_order_create', input));
  server.registerTool('atel_order_accept', { description: 'Accept an ATEL order.', inputSchema: OrderAcceptInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_order_accept', input));
  server.registerTool('atel_milestone_plan_feedback', { description: 'Confirm or reject the auto-generated milestone plan after order_accept locks escrow. Both requester AND executor must call with approved=true before M0 starts; either can pass approved=false + feedback to request a revision. Status must be milestone_review.', inputSchema: order.MilestonePlanFeedbackInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_milestone_plan_feedback', input));
  server.registerTool('atel_order_complete', { description: 'Complete an ATEL order with proof and trace metadata.', inputSchema: OrderCompleteInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_order_complete', input));
  server.registerTool('atel_order_confirm', { description: 'Confirm and settle a completed ATEL order.', inputSchema: OrderConfirmInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_order_confirm', input));
  server.registerTool('atel_milestone_list', { description: 'List milestones for an order.', inputSchema: orderIdInput() }, async (input) => tryInvoke(invoke, 'atel_milestone_list', input));
  server.registerTool('atel_milestone_submit', { description: 'Submit milestone content.', inputSchema: MilestoneSubmitInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_milestone_submit', input));
  server.registerTool('atel_milestone_verify', { description: 'Approve milestone content.', inputSchema: MilestoneActionInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_milestone_verify', input));
  server.registerTool('atel_milestone_reject', { description: 'Reject milestone content with feedback.', inputSchema: { orderId: z.string().min(1).startsWith('ord-'), index: z.number().int().min(0).max(9), content: z.string().min(1) } }, async (input) => tryInvoke(invoke, 'atel_milestone_reject', input));
  server.registerTool('atel_dispute_get', { description: 'Get dispute details.', inputSchema: disputeIdInput() }, async (input) => tryInvoke(invoke, 'atel_dispute_get', input));
  server.registerTool('atel_dispute_list', { description: 'List disputes for current DID.' }, async () => tryInvoke(invoke, 'atel_dispute_list'));
  server.registerTool('atel_dispute_create', { description: 'Create a dispute for an order. Requires >=3 rejections on a milestone (otherwise returns PREREQUISITE_NOT_MET). reason must be >=100 chars.', inputSchema: DisputeCreateInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_dispute_create', input));
  // DisputeResolveInputSchema and WalletWithdrawInputSchema are NOT plain
  // z.object — DisputeResolve has .refine() (ZodEffects), Withdraw is a
  // discriminatedUnion. Pass the full schema, not .shape (which only
  // exists on raw z.object). Fixed 2026-05-03 — previously registered
  // without inputSchema, which made the SDK pass `args=undefined` to the
  // handler, causing parse() to fail at the first field check.
  server.registerTool('atel_dispute_resolve', { description: 'Submit arbitration verdict (favor_requester|favor_executor|split). High-risk: this releases locked escrow. Requires dispute.resolve scope (high-risk tier, never default-granted) AND platform-side arbitrator allowlist membership.', inputSchema: DisputeResolveInputSchema }, async (input) => tryInvoke(invoke, 'atel_dispute_resolve', input));
  server.registerTool('atel_audit_order_get', { description: 'Read the audit trail for an order.', inputSchema: AuditOrderQueryInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_audit_order_get', input));
  server.registerTool('atel_audit_session_get', { description: 'Read the audit trail for the current or specified session.', inputSchema: AuditSessionQueryInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_audit_session_get', input));
  server.registerTool('atel_audit_request_get', { description: 'Read the audit trail for a specific request.', inputSchema: AuditRequestQueryInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_audit_request_get', input));
  server.registerTool('atel_a2b_search', { description: 'Search Bitrefill gift cards. Server enforces limit=30 (the SKILL.md drift case). Filter by country (e.g. ZA, US).', inputSchema: A2bSearchInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_search', input));
  server.registerTool('atel_a2b_purchase_list', { description: 'List your A2B gift card purchases (paginated).', inputSchema: A2bPurchaseListInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_purchase_list', input));
  server.registerTool('atel_a2b_purchase_get', { description: 'Get one A2B purchase. Redemption code is included only when status=DELIVERED.', inputSchema: A2bPurchaseGetInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_purchase_get', input));
  server.registerTool('atel_a2b_quote', { description: 'Get the live USDC price Bitrefill will charge for (productId, value). Server hits Bitrefill — DO NOT compute amounts yourself, always call this first then use quotedPriceUsdc as the amount for atel_a2b_purchase / atel_a2b_lock_funds. Anti-drift: stops the "LLM uses training-data exchange rate" failure mode.', inputSchema: A2bQuoteInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_quote', input));
  server.registerTool('atel_a2b_purchase', { description: 'One-shot A2B gift card purchase. Pass productId (from atel_a2b_search), local-currency value, and maxAmountUsdc (use atel_a2b_quote first). Platform creates intent, deposits USDC on chain=base, requests Bitrefill invoice, pays it, and (autoReveal=true by default) reveals the redemption code in one round trip. Replaces the legacy intent_create / lock_funds / execute_purchase chain for MCP callers.', inputSchema: A2bPurchaseInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_purchase', input));
  server.registerTool('atel_a2b_intent_create', { description: 'Create a Bitrefill purchase intent. value is local-currency face value (e.g. 1.0 USD), NOT USDC amount. No funds moved.', inputSchema: A2bIntentCreateInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_intent_create', input));
  server.registerTool('atel_a2b_lock_funds', { description: 'Lock USDC for an intent on chain=base (server hard-locked, Bitrefill rejects Fast/BSC). amount is USDC decimal. Server enforces walletReady + sufficientBalance.', inputSchema: A2bLockFundsInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_lock_funds', input));
  server.registerTool('atel_a2b_execute_purchase', { description: 'Execute the Bitrefill purchase (createInvoice + pay). Run only after atel_a2b_lock_funds succeeded. Poll atel_a2b_purchase_get for redemption code once status=DELIVERED.', inputSchema: A2bExecutePurchaseInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_a2b_execute_purchase', input));
  server.registerTool('atel_fast_balance', { description: 'Read your Fast Network USDC balance + Fast hex address. Returns null balance if platform balance response omits chainBalances.fast (known gap).' }, async () => tryInvoke(invoke, 'atel_fast_balance'));
  server.registerTool('atel_fast_deposit_address', { description: 'Return your Fast Network deposit address (64-char hex = ed25519 pubkey). bech32 / 0x prefixes are NOT valid on Fast.' }, async () => tryInvoke(invoke, 'atel_fast_deposit_address'));
  server.registerTool('atel_fast_transfer', { description: 'Direct USDC P2P transfer on Fast Network (no escrow). Recipient accepts did:atel:ed25519:... DID OR 64-char hex pubkey. amount is USDC decimal. High-risk; requires wallet.transfer scope + per-action operator approval.', inputSchema: FastTransferInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_fast_transfer', input));
  server.registerTool('atel_wallet_transfer', { description: 'EVM USDC transfer (chain=base|bsc). Address is 0x-prefixed 40-char hex; amount is USDC decimal. High-risk; requires wallet.transfer scope + per-action operator approval (out-of-band, not LLM-grantable).', inputSchema: WalletTransferInputSchema.shape }, async (input) => tryInvoke(invoke, 'atel_wallet_transfer', input));
  server.registerTool('atel_wallet_withdraw', { description: 'EXTERNAL withdrawal to a non-ATEL wallet (chain=base|bsc|fast). EVM addresses are 0x..40 hex, Fast addresses are 64-char raw hex. Highest risk: irreversible, leaves ATEL custody. Requires wallet.withdraw scope + ALWAYS triggers per-action operator approval (no threshold).', inputSchema: WalletWithdrawInputSchema }, async (input) => tryInvoke(invoke, 'atel_wallet_withdraw', input));
  server.registerTool('atel_approval_list', { description: 'List your pending and approved high-risk action approvals. Use to check whether your filed action is ready to retry.' }, async () => tryInvoke(invoke, 'atel_approval_list'));
  server.registerTool('atel_approval_get', { description: 'Get one approval record by id. Returns 404 if id belongs to another DID.', inputSchema: { id: z.string().min(1).startsWith('appr-') } }, async (input) => tryInvoke(invoke, 'atel_approval_get', input));

  return server;
}
