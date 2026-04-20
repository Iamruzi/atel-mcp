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
  OrderCreateInputSchema,
  SendMessageInputSchema,
  WhoamiOutputSchema,
} from '../contracts/schemas.js';

export const MVP_MANIFEST = {
  identity: [
    { name: 'atel_whoami', input: null, output: WhoamiOutputSchema },
    { name: 'atel_agent_register', input: AgentRegisterInputSchema },
    { name: 'atel_agent_search', input: AgentSearchInputSchema },
  ],
  wallet: [
    { name: 'atel_balance' },
    { name: 'atel_deposit_info' },
  ],
  messaging: [
    { name: 'atel_contacts_list' },
    { name: 'atel_inbox_list' },
    { name: 'atel_send_message', input: SendMessageInputSchema },
    { name: 'atel_ack', input: AckInputSchema },
  ],
  order: [
    { name: 'atel_order_get' },
    { name: 'atel_order_list' },
    { name: 'atel_order_timeline' },
    { name: 'atel_order_create', input: OrderCreateInputSchema },
    { name: 'atel_order_accept', input: OrderAcceptInputSchema },
  ],
  milestone: [
    { name: 'atel_milestone_list' },
    { name: 'atel_milestone_submit', input: MilestoneSubmitInputSchema },
    { name: 'atel_milestone_verify', input: MilestoneActionInputSchema },
    { name: 'atel_milestone_reject', input: MilestoneSubmitInputSchema.pick({ orderId: true, index: true, content: true }) },
  ],
  dispute: [
    { name: 'atel_dispute_get' },
    { name: 'atel_dispute_list' },
    { name: 'atel_dispute_create', input: DisputeCreateInputSchema },
  ],
  audit: [
    { name: 'atel_audit_order_get', input: AuditOrderQueryInputSchema },
    { name: 'atel_audit_session_get', input: AuditSessionQueryInputSchema },
    { name: 'atel_audit_request_get', input: AuditRequestQueryInputSchema },
  ]
} as const;
