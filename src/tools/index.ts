import * as identity from './identity.js';
import * as wallet from './wallet.js';
import * as messaging from './messaging.js';
import * as order from './order.js';
import * as milestone from './milestone.js';
import * as dispute from './dispute.js';
import * as audit from './audit.js';

export const TOOL_HANDLERS = {
  atel_whoami: identity.atelWhoami,
  atel_agent_register: identity.atelAgentRegister,
  atel_agent_search: identity.atelAgentSearch,
  atel_balance: wallet.atelBalance,
  atel_deposit_info: wallet.atelDepositInfo,
  atel_contacts_list: messaging.atelContactsList,
  atel_inbox_list: messaging.atelInboxList,
  atel_send_message: messaging.atelSendMessage,
  atel_ack: messaging.atelAck,
  atel_order_get: order.atelOrderGet,
  atel_order_list: order.atelOrderList,
  atel_order_timeline: order.atelOrderTimeline,
  atel_order_create: order.atelOrderCreate,
  atel_order_accept: order.atelOrderAccept,
  atel_milestone_list: order.atelMilestoneList,
  atel_milestone_submit: milestone.atelMilestoneSubmit,
  atel_milestone_verify: milestone.atelMilestoneVerify,
  atel_milestone_reject: milestone.atelMilestoneReject,
  atel_dispute_get: dispute.atelDisputeGet,
  atel_dispute_list: dispute.atelDisputeList,
  atel_dispute_create: dispute.atelDisputeCreate,
  atel_audit_order_get: audit.atelAuditOrderGet,
  atel_audit_session_get: audit.atelAuditSessionGet,
  atel_audit_request_get: audit.atelAuditRequestGet,
} as const;

export type ToolName = keyof typeof TOOL_HANDLERS;

export function listPlannedTools(): string[] {
  return Object.keys(TOOL_HANDLERS);
}
