import * as identity from './identity.js';
import * as wallet from './wallet.js';
import * as messaging from './messaging.js';
import * as order from './order.js';
import * as milestone from './milestone.js';
import * as dispute from './dispute.js';
import * as audit from './audit.js';
import * as a2b from './a2b.js';
import * as fast from './fast.js';

export const TOOL_HANDLERS = {
  atel_whoami: identity.atelWhoami,
  atel_register_user: identity.atelRegisterUser,
  atel_recover: identity.atelRecover,
  atel_secret_key_recover: identity.atelSecretKeyRecover,
  atel_runtime_link_status: identity.atelRuntimeLinkStatus,
  atel_runtime_link_bind: identity.atelRuntimeLinkBind,
  atel_runtime_link_unbind: identity.atelRuntimeLinkUnbind,
  atel_agent_register: identity.atelAgentRegister,
  atel_agent_search: identity.atelAgentSearch,
  atel_register_endpoint: identity.atelRegisterEndpoint,
  atel_dashboard_auth: identity.atelDashboardAuth,
  atel_balance: wallet.atelBalance,
  atel_deposit_info: wallet.atelDepositInfo,
  atel_wallet_status: wallet.atelWalletStatus,
  atel_contacts_list: messaging.atelContactsList,
  atel_inbox_list: messaging.atelInboxList,
  atel_send_message: messaging.atelSendMessage,
  atel_ack: messaging.atelAck,
  atel_order_get: order.atelOrderGet,
  atel_order_list: order.atelOrderList,
  atel_order_timeline: order.atelOrderTimeline,
  atel_order_create: order.atelOrderCreate,
  atel_order_accept: order.atelOrderAccept,
  atel_milestone_plan_feedback: order.atelMilestonePlanFeedback,
  atel_order_complete: order.atelOrderComplete,
  atel_order_confirm: order.atelOrderConfirm,
  atel_milestone_list: order.atelMilestoneList,
  atel_milestone_submit: milestone.atelMilestoneSubmit,
  atel_milestone_verify: milestone.atelMilestoneVerify,
  atel_milestone_reject: milestone.atelMilestoneReject,
  atel_dispute_get: dispute.atelDisputeGet,
  atel_dispute_list: dispute.atelDisputeList,
  atel_dispute_create: dispute.atelDisputeCreate,
  atel_dispute_resolve: dispute.atelDisputeResolve,
  atel_audit_order_get: audit.atelAuditOrderGet,
  atel_audit_session_get: audit.atelAuditSessionGet,
  atel_audit_request_get: audit.atelAuditRequestGet,
  atel_a2b_search: a2b.atelA2bSearch,
  atel_a2b_countries: a2b.atelA2bCountries,
  atel_a2b_purchase_list: a2b.atelA2bPurchaseList,
  atel_a2b_purchase_get: a2b.atelA2bPurchaseGet,
  atel_a2b_quote: a2b.atelA2bQuote,
  atel_a2b_purchase: a2b.atelA2bPurchase,
  atel_a2b_intent_create: a2b.atelA2bIntentCreate,
  atel_a2b_lock_funds: a2b.atelA2bLockFunds,
  atel_a2b_execute_purchase: a2b.atelA2bExecutePurchase,
  atel_fast_balance: fast.atelFastBalance,
  atel_fast_deposit_address: fast.atelFastDepositAddress,
  atel_fast_transfer: fast.atelFastTransfer,
  atel_wallet_transfer: wallet.atelWalletTransfer,
  atel_wallet_withdraw: wallet.atelWalletWithdraw,
} as const;

export type ToolName = keyof typeof TOOL_HANDLERS;

export function listPlannedTools(): string[] {
  return Object.keys(TOOL_HANDLERS);
}
