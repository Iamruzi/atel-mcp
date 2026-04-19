export type AtelScope =
  | 'identity.read'
  | 'wallet.read'
  | 'contacts.read'
  | 'contacts.write'
  | 'messages.read'
  | 'messages.write'
  | 'orders.read'
  | 'orders.write'
  | 'milestones.read'
  | 'milestones.write'
  | 'disputes.read'
  | 'disputes.write';

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
  atel_agent_register: { all: ['identity.read'] },
  atel_agent_search: { all: ['identity.read'] },
  atel_balance: { all: ['wallet.read'] },
  atel_deposit_info: { all: ['wallet.read'] },
  atel_contacts_list: { all: ['contacts.read'] },
  atel_inbox_list: { all: ['messages.read'] },
  atel_send_message: { all: ['messages.write'] },
  atel_ack: { all: ['messages.write'] },
  atel_order_get: { all: ['orders.read'] },
  atel_order_list: { all: ['orders.read'] },
  atel_order_timeline: { all: ['orders.read'] },
  atel_order_create: { all: ['orders.write'] },
  atel_order_accept: { all: ['orders.write'] },
  atel_milestone_list: { all: ['milestones.read'] },
  atel_milestone_submit: { all: ['milestones.write'] },
  atel_milestone_verify: { all: ['milestones.write'] },
  atel_milestone_reject: { all: ['milestones.write'] },
  atel_dispute_get: { all: ['disputes.read'] },
  atel_dispute_list: { all: ['disputes.read'] },
  atel_audit_order_get: { all: ['orders.read'] },
  atel_audit_session_get: { all: ['identity.read'] },
  atel_dispute_create: { all: ['disputes.write'] },
};
