export type ToolRisk = 'read' | 'write' | 'high-risk';
export type DeliveryPhase = '1A' | '1B' | '1C' | '2';

export interface ToolSpec {
  name: string;
  domain: 'identity' | 'wallet' | 'contacts' | 'messaging' | 'order' | 'milestone' | 'dispute' | 'audit';
  risk: ToolRisk;
  phase: DeliveryPhase;
  description: string;
}

export const TOOL_SPECS: ToolSpec[] = [
  { name: 'atel_whoami', domain: 'identity', risk: 'read', phase: '1A', description: 'Return current authenticated ATEL identity.' },
  { name: 'atel_agent_register', domain: 'identity', risk: 'write', phase: '1A', description: 'Register or update the current agent profile.' },
  { name: 'atel_agent_search', domain: 'identity', risk: 'read', phase: '1A', description: 'Search registered ATEL agents by capability or identity.' },
  { name: 'atel_balance', domain: 'wallet', risk: 'read', phase: '1A', description: 'Return current account balances.' },
  { name: 'atel_deposit_info', domain: 'wallet', risk: 'read', phase: '1A', description: 'Return deposit addresses and supported chains.' },
  { name: 'atel_contacts_list', domain: 'contacts', risk: 'read', phase: '1A', description: 'List available ATEL contacts for the current identity.' },
  { name: 'atel_inbox_list', domain: 'messaging', risk: 'read', phase: '1A', description: 'List recent ATEL messages for the current identity.' },
  { name: 'atel_order_get', domain: 'order', risk: 'read', phase: '1A', description: 'Get order details.' },
  { name: 'atel_order_list', domain: 'order', risk: 'read', phase: '1A', description: 'List orders.' },
  { name: 'atel_order_timeline', domain: 'order', risk: 'read', phase: '1A', description: 'Get the order activity timeline.' },
  { name: 'atel_milestone_list', domain: 'milestone', risk: 'read', phase: '1A', description: 'List milestone structure and status.' },
  { name: 'atel_dispute_get', domain: 'dispute', risk: 'read', phase: '1A', description: 'Get details for a dispute.' },
  { name: 'atel_dispute_list', domain: 'dispute', risk: 'read', phase: '1A', description: 'List disputes.' },
  { name: 'atel_audit_order_get', domain: 'audit', risk: 'read', phase: '1A', description: 'Read the audit trail for an order.' },
  { name: 'atel_audit_session_get', domain: 'audit', risk: 'read', phase: '1A', description: 'Read the audit trail for the current or specified session.' },
  { name: 'atel_audit_request_get', domain: 'audit', risk: 'read', phase: '1A', description: 'Read the audit trail for a specific request.' },
  { name: 'atel_send_message', domain: 'messaging', risk: 'write', phase: '1B', description: 'Send a text message to another ATEL agent.' },
  { name: 'atel_ack', domain: 'messaging', risk: 'write', phase: '1B', description: 'Acknowledge received ATEL messages.' },
  { name: 'atel_order_create', domain: 'order', risk: 'write', phase: '1C', description: 'Create an order with a structured request payload.' },
  { name: 'atel_order_accept', domain: 'order', risk: 'write', phase: '1C', description: 'Accept an order.' },
  { name: 'atel_milestone_submit', domain: 'milestone', risk: 'write', phase: '1C', description: 'Submit milestone content.' },
  { name: 'atel_milestone_verify', domain: 'milestone', risk: 'write', phase: '1C', description: 'Approve milestone content.' },
  { name: 'atel_milestone_reject', domain: 'milestone', risk: 'write', phase: '1C', description: 'Reject milestone content.' },
  { name: 'atel_dispute_create', domain: 'dispute', risk: 'write', phase: '1C', description: 'Create a dispute.' },
  { name: 'atel_order_escrow', domain: 'order', risk: 'high-risk', phase: '2', description: 'Lock funds to escrow as a direct MCP action.' },
  { name: 'atel_order_complete', domain: 'order', risk: 'high-risk', phase: '2', description: 'Complete an order explicitly.' },
  { name: 'atel_order_confirm', domain: 'order', risk: 'high-risk', phase: '2', description: 'Confirm and settle an order explicitly.' },
  { name: 'atel_dispute_resolve', domain: 'dispute', risk: 'high-risk', phase: '2', description: 'Resolve a dispute outcome.' }
];
