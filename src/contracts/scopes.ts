/**
 * AtelScope is a permission descriptor declared on each MCP tool. The session
 * (issued via OAuth or DID auth) carries the scopes the user granted, and the
 * `assertScopes` middleware in dispatch enforces them.
 *
 * Three tiers (strictly ordered):
 *   1. read       — observe only, no mutation
 *   2. write      — mutate state but reversible / no real fund movement
 *   3. high_risk  — irreversible / real fund movement (transfer/withdraw/arbitrate)
 *
 * High-risk scopes are NEVER granted by default. They require explicit user
 * grant + an approval gate (see src/approval/) before execution.
 */
export type AtelScope =
  // Read scopes
  | 'identity.read'
  | 'wallet.read'
  | 'contacts.read'
  | 'messages.read'
  | 'orders.read'
  | 'milestones.read'
  | 'disputes.read'
  | 'a2b.read'
  // Write scopes (low-risk: reversible / no fund impact)
  | 'contacts.write'
  | 'messages.write'
  | 'orders.write'
  | 'milestones.write'
  | 'disputes.write'
  | 'a2b.write'
  // High-risk scopes (irreversible: real fund movement, never default-granted)
  | 'wallet.transfer'
  | 'wallet.withdraw'
  | 'order.arbitrate'
  | 'dispute.resolve'
  | 'settlement.override';

export const DEFAULT_REMOTE_SCOPES: AtelScope[] = [
  'identity.read',
  'wallet.read',
  'contacts.read',
  'messages.read',
  'orders.read',
  'milestones.read',
  'disputes.read'
];

export const TOOL_SCOPE_REQUIREMENTS: Record<string, { all?: AtelScope[]; any?: AtelScope[] }> = {
  atel_whoami: { all: ['identity.read'] },
  atel_runtime_link_status: { all: ['identity.read'] },
  atel_runtime_link_bind: { all: ['identity.read'] },
  atel_runtime_link_unbind: { all: ['identity.read'] },
  atel_agent_register: { all: ['identity.read'] },
  atel_agent_search: { all: ['identity.read'] },
  atel_register_endpoint: { all: ['identity.read'] },
  atel_balance: { all: ['wallet.read'] },
  atel_deposit_info: { all: ['wallet.read'] },
  atel_wallet_status: { all: ['wallet.read'] },
  atel_contacts_list: { all: ['contacts.read'] },
  atel_inbox_list: { all: ['messages.read'] },
  atel_send_message: { all: ['messages.write'] },
  atel_ack: { all: ['messages.write'] },
  atel_order_get: { all: ['orders.read'] },
  atel_order_list: { all: ['orders.read'] },
  atel_order_timeline: { all: ['orders.read'] },
  atel_order_create: { all: ['orders.write'] },
  atel_order_accept: { all: ['orders.write'] },
  atel_order_complete: { all: ['orders.write'] },
  atel_order_confirm: { all: ['orders.write'] },
  atel_milestone_list: { all: ['milestones.read'] },
  atel_milestone_submit: { all: ['milestones.write'] },
  atel_milestone_verify: { all: ['milestones.write'] },
  atel_milestone_reject: { all: ['milestones.write'] },
  atel_dispute_get: { all: ['disputes.read'] },
  atel_dispute_list: { all: ['disputes.read'] },
  atel_audit_order_get: { all: ['orders.read'] },
  atel_audit_session_get: { all: ['identity.read'] },
  atel_audit_request_get: { all: ['identity.read'] },
  atel_dispute_create: { all: ['disputes.write'] },
  atel_a2b_search: { all: ['a2b.read'] },
  atel_a2b_purchase_list: { all: ['a2b.read'] },
  atel_a2b_purchase_get: { all: ['a2b.read'] },
  atel_a2b_quote: { all: ['a2b.read'] },
  atel_a2b_intent_create: { all: ['a2b.write'] },
  atel_a2b_lock_funds: { all: ['a2b.write'] },
  atel_a2b_execute_purchase: { all: ['a2b.write'] },
  atel_fast_balance: { all: ['wallet.read'] },
  atel_fast_deposit_address: { all: ['wallet.read'] },
  atel_fast_transfer: { all: ['wallet.transfer'] },
  atel_wallet_transfer: { all: ['wallet.transfer'] },
  atel_approval_list: { all: ['wallet.read'] },
  atel_approval_get: { all: ['wallet.read'] },
};
