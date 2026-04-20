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
  OrderCreateInputSchema,
  SendMessageInputSchema,
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
    config,
    audit: args.audit,
    auth: args.auth,
  });

  server.registerTool('atel_whoami', { description: 'Return current authenticated ATEL identity and environment.' }, async () => asToolResult(await invoke('atel_whoami')));
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

  return server;
}
