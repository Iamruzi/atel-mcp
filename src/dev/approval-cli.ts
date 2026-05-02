#!/usr/bin/env node
/**
 * Operator CLI for the approval gate.
 *
 * Usage:
 *   npm run approval:list                 — list all approvals (any DID)
 *   npm run approval:approve <id>         — mark <id> APPROVED
 *   npm run approval:deny    <id> <reason> — mark <id> DENIED with reason
 *   npm run approval:get     <id>         — show one approval's full state
 *
 * Reads ATEL_MCP_APPROVAL_LOG_PATH from env. If unset, exits with hint.
 */

import { loadConfig } from '../config.js';
import {
  operatorApprove,
  operatorDeny,
  getApproval,
} from '../approval/gate.js';
import { createApprovalStore } from '../approval/store.js';

async function main() {
  const config = loadConfig();
  if (!config.approvalLogPath) {
    console.error('ATEL_MCP_APPROVAL_LOG_PATH not set. Configure it in .env to use the gate.');
    process.exit(2);
  }
  const path = config.approvalLogPath;
  const [, , cmd, arg1, ...rest] = process.argv;

  switch (cmd) {
    case 'list': {
      // List ALL pending+approved across all DIDs (operator view).
      // We re-read the file directly because the gate's listApprovals is
      // scoped per-DID (intentional in the LLM-facing tool).
      const store = createApprovalStore(path);
      const did = arg1;
      if (!did) {
        console.error('Usage: approval:list <did>   (operator must pick a DID to scope by)');
        process.exit(2);
      }
      const items = await store.list(did);
      if (items.length === 0) {
        console.log(`No pending/approved approvals for ${did}.`);
        return;
      }
      for (const it of items) {
        console.log(`${it.id}  ${it.status.padEnd(8)} ${it.action.padEnd(18)} ${it.summary}`);
      }
      return;
    }
    case 'approve': {
      if (!arg1) {
        console.error('Usage: approval:approve <id>');
        process.exit(2);
      }
      const approver = process.env.USER ?? 'operator';
      const result = await operatorApprove(path, arg1, approver);
      console.log(`Approved ${result.id} by ${approver} at ${result.approvedAt}`);
      return;
    }
    case 'deny': {
      if (!arg1) {
        console.error('Usage: approval:deny <id> <reason words…>');
        process.exit(2);
      }
      const reason = rest.join(' ').trim() || 'denied by operator';
      const result = await operatorDeny(path, arg1, reason);
      console.log(`Denied ${result.id}: ${result.deniedReason}`);
      return;
    }
    case 'get': {
      if (!arg1) {
        console.error('Usage: approval:get <id>');
        process.exit(2);
      }
      const r = await getApproval(path, arg1);
      if (!r) {
        console.error(`Approval ${arg1} not found.`);
        process.exit(1);
      }
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    default:
      console.error('Unknown command. Try: list / approve / deny / get');
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
