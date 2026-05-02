import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from '../config.js';
import { dispatchTool } from './tool-dispatch.js';
import {
  AckInputSchema,
  AgentRegisterInputSchema,
  AgentSearchInputSchema,
  DisputeCreateInputSchema,
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
  FastTransferInputSchema,
  WalletTransferInputSchema,
} from '../contracts/schemas.js';
import type { AuditSink } from './context.js';
import type { AuthIntrospectionClient } from '../auth/introspection.js';

function asToolResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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

  server.registerTool('atel_whoami', { description: 'Return current authenticated ATEL identity and environment.' }, async () => asToolResult(await invoke('atel_whoami')));
  server.registerTool('atel_runtime_link_status', { description: 'Return runtime-link status and staged execution routing metadata for the current identity.' }, async () => asToolResult(await invoke('atel_runtime_link_status')));
  server.registerTool('atel_runtime_link_bind', { description: 'Bind the current hosted DID to a runtime DID for future staged runtime dispatch.', inputSchema: RuntimeLinkBindInputSchema.shape }, async (input) => asToolResult(await invoke('atel_runtime_link_bind', input)));
  server.registerTool('atel_runtime_link_unbind', { description: 'Remove the runtime binding for the current hosted DID.' }, async () => asToolResult(await invoke('atel_runtime_link_unbind')));
  server.registerTool('atel_agent_register', { description: 'Register or update the current ATEL agent profile.', inputSchema: AgentRegisterInputSchema.shape }, async (input) => asToolResult(await invoke('atel_agent_register', input)));
  server.registerTool('atel_agent_search', { description: 'Search registered ATEL agents by capability or identity.', inputSchema: AgentSearchInputSchema.shape }, async (input) => asToolResult(await invoke('atel_agent_search', input)));
  server.registerTool('atel_balance', { description: 'Return current ATEL account balances.' }, async () => asToolResult(await invoke('atel_balance')));
  server.registerTool('atel_deposit_info', { description: 'Return supported deposit chains and addresses.' }, async () => asToolResult(await invoke('atel_deposit_info')));
  server.registerTool('atel_contacts_list', { description: 'List available ATEL contacts for the current identity.' }, async () => asToolResult(await invoke('atel_contacts_list')));
  server.registerTool('atel_inbox_list', { description: 'List recent ATEL messages for the current identity.' }, async () => asToolResult(await invoke('atel_inbox_list')));
  server.registerTool('atel_send_message', { description: 'Send a text message to another ATEL agent.', inputSchema: SendMessageInputSchema.shape }, async (input) => asToolResult(await invoke('atel_send_message', input)));
  server.registerTool('atel_ack', { description: 'Acknowledge received ATEL messages.', inputSchema: AckInputSchema.shape }, async (input) => asToolResult(await invoke('atel_ack', input)));
  server.registerTool('atel_order_get', { description: 'Get an order summary.', inputSchema: orderIdInput() }, async (input) => asToolResult(await invoke('atel_order_get', input)));
  server.registerTool('atel_order_list', { description: 'List orders visible to the current DID.', inputSchema: { role: z.string().optional(), status: z.string().optional() } }, async (input) => asToolResult(await invoke('atel_order_list', input)));
  server.registerTool('atel_order_timeline', { description: 'Get the order activity timeline.', inputSchema: orderIdInput() }, async (input) => asToolResult(await invoke('atel_order_timeline', input)));
  server.registerTool('atel_order_create', { description: 'Create an ATEL order.', inputSchema: OrderCreateInputSchema.shape }, async (input) => asToolResult(await invoke('atel_order_create', input)));
  server.registerTool('atel_order_accept', { description: 'Accept an ATEL order.', inputSchema: OrderAcceptInputSchema.shape }, async (input) => asToolResult(await invoke('atel_order_accept', input)));
  server.registerTool('atel_order_complete', { description: 'Complete an ATEL order with proof and trace metadata.', inputSchema: OrderCompleteInputSchema.shape }, async (input) => asToolResult(await invoke('atel_order_complete', input)));
  server.registerTool('atel_order_confirm', { description: 'Confirm and settle a completed ATEL order.', inputSchema: OrderConfirmInputSchema.shape }, async (input) => asToolResult(await invoke('atel_order_confirm', input)));
  server.registerTool('atel_milestone_list', { description: 'List milestones for an order.', inputSchema: orderIdInput() }, async (input) => asToolResult(await invoke('atel_milestone_list', input)));
  server.registerTool('atel_milestone_submit', { description: 'Submit milestone content.', inputSchema: MilestoneSubmitInputSchema.shape }, async (input) => asToolResult(await invoke('atel_milestone_submit', input)));
  server.registerTool('atel_milestone_verify', { description: 'Approve milestone content.', inputSchema: MilestoneActionInputSchema.shape }, async (input) => asToolResult(await invoke('atel_milestone_verify', input)));
  server.registerTool('atel_milestone_reject', { description: 'Reject milestone content with feedback.', inputSchema: { orderId: z.string().min(1).startsWith('ord-'), index: z.number().int().min(0).max(9), content: z.string().min(1) } }, async (input) => asToolResult(await invoke('atel_milestone_reject', input)));
  server.registerTool('atel_dispute_get', { description: 'Get dispute details.', inputSchema: disputeIdInput() }, async (input) => asToolResult(await invoke('atel_dispute_get', input)));
  server.registerTool('atel_dispute_list', { description: 'List disputes for current DID.' }, async () => asToolResult(await invoke('atel_dispute_list')));
  server.registerTool('atel_dispute_create', { description: 'Create a dispute for an order.', inputSchema: DisputeCreateInputSchema.shape }, async (input) => asToolResult(await invoke('atel_dispute_create', input)));
  server.registerTool('atel_audit_order_get', { description: 'Read the audit trail for an order.', inputSchema: AuditOrderQueryInputSchema.shape }, async (input) => asToolResult(await invoke('atel_audit_order_get', input)));
  server.registerTool('atel_audit_session_get', { description: 'Read the audit trail for the current or specified session.', inputSchema: AuditSessionQueryInputSchema.shape }, async (input) => asToolResult(await invoke('atel_audit_session_get', input)));
  server.registerTool('atel_audit_request_get', { description: 'Read the audit trail for a specific request.', inputSchema: AuditRequestQueryInputSchema.shape }, async (input) => asToolResult(await invoke('atel_audit_request_get', input)));
  server.registerTool('atel_a2b_search', { description: 'Search Bitrefill gift cards. Server enforces limit=30 (the SKILL.md drift case). Filter by country (e.g. ZA, US).', inputSchema: A2bSearchInputSchema.shape }, async (input) => asToolResult(await invoke('atel_a2b_search', input)));
  server.registerTool('atel_a2b_purchase_list', { description: 'List your A2B gift card purchases (paginated).', inputSchema: A2bPurchaseListInputSchema.shape }, async (input) => asToolResult(await invoke('atel_a2b_purchase_list', input)));
  server.registerTool('atel_a2b_purchase_get', { description: 'Get one A2B purchase. Redemption code is included only when status=DELIVERED.', inputSchema: A2bPurchaseGetInputSchema.shape }, async (input) => asToolResult(await invoke('atel_a2b_purchase_get', input)));
  server.registerTool('atel_a2b_intent_create', { description: 'Create a Bitrefill purchase intent. value is local-currency face value (e.g. 1.0 USD), NOT USDC amount. No funds moved.', inputSchema: A2bIntentCreateInputSchema.shape }, async (input) => asToolResult(await invoke('atel_a2b_intent_create', input)));
  server.registerTool('atel_a2b_lock_funds', { description: 'Lock USDC for an intent on chain=base (server hard-locked, Bitrefill rejects Fast/BSC). amount is USDC decimal. Server enforces walletReady + sufficientBalance.', inputSchema: A2bLockFundsInputSchema.shape }, async (input) => asToolResult(await invoke('atel_a2b_lock_funds', input)));
  server.registerTool('atel_a2b_execute_purchase', { description: 'Execute the Bitrefill purchase (createInvoice + pay). Run only after atel_a2b_lock_funds succeeded. Poll atel_a2b_purchase_get for redemption code once status=DELIVERED.', inputSchema: A2bExecutePurchaseInputSchema.shape }, async (input) => asToolResult(await invoke('atel_a2b_execute_purchase', input)));
  server.registerTool('atel_fast_balance', { description: 'Read your Fast Network USDC balance + Fast hex address. Returns null balance if platform balance response omits chainBalances.fast (known gap).' }, async () => asToolResult(await invoke('atel_fast_balance')));
  server.registerTool('atel_fast_deposit_address', { description: 'Return your Fast Network deposit address (64-char hex = ed25519 pubkey). bech32 / 0x prefixes are NOT valid on Fast.' }, async () => asToolResult(await invoke('atel_fast_deposit_address')));
  server.registerTool('atel_fast_transfer', { description: 'Direct USDC P2P transfer on Fast Network (no escrow). Recipient accepts did:atel:ed25519:... DID OR 64-char hex pubkey. amount is USDC decimal. High-risk; requires wallet.transfer scope + per-action operator approval.', inputSchema: FastTransferInputSchema.shape }, async (input) => asToolResult(await invoke('atel_fast_transfer', input)));
  server.registerTool('atel_wallet_transfer', { description: 'EVM USDC transfer (chain=base|bsc). Address is 0x-prefixed 40-char hex; amount is USDC decimal. High-risk; requires wallet.transfer scope + per-action operator approval (out-of-band, not LLM-grantable).', inputSchema: WalletTransferInputSchema.shape }, async (input) => asToolResult(await invoke('atel_wallet_transfer', input)));
  server.registerTool('atel_approval_list', { description: 'List your pending and approved high-risk action approvals. Use to check whether your filed action is ready to retry.' }, async () => asToolResult(await invoke('atel_approval_list')));
  server.registerTool('atel_approval_get', { description: 'Get one approval record by id. Returns 404 if id belongs to another DID.', inputSchema: { id: z.string().min(1).startsWith('appr-') } }, async (input) => asToolResult(await invoke('atel_approval_get', input)));

  return server;
}
