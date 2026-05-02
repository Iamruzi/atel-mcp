/**
 * Approval gate.
 *
 * Call `requireApproval(ctx, intent)` from any high-risk tool BEFORE doing
 * any chain spend / external state mutation. Behavior:
 *
 *   1. Look up an approved record matching (did, intentHash). If found,
 *      consume it (one-shot) and return — tool may proceed.
 *   2. If not found, look up a pending record. If a pending one exists,
 *      throw APPROVAL_PENDING with the same id (host LLM should poll).
 *   3. If neither, file a new pending record + throw APPROVAL_PENDING with
 *      its id, summary, and an actionable hint pointing at the dashboard /
 *      approval CLI.
 *
 * The same intent (same hash) always lands on the same approval id within
 * the TTL window — host can retry safely with the same idempotencyKey.
 */

import { AtelMcpError } from '../contracts/errors.js';
import type { ToolExecutionContext } from '../server/context.js';
import type { ApprovalIntent, ApprovalRequest } from './types.js';
import {
  createApprovalStore,
  hashIntent,
  newApprovalId,
  type ApprovalStore,
} from './store.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes — long enough for a human dashboard click.

export interface ApprovalGateConfig {
  /** Path to the JSONL approval log. If unset, gate is in test-bypass mode. */
  approvalLogPath?: string;
  /** Tools the gate ignores entirely (smoke tests, internal flows). */
  bypassTools?: string[];
  /** Override TTL for testing (ms). */
  ttlMs?: number;
}

let cachedStore: ApprovalStore | undefined;
let cachedStorePath: string | undefined;

function getStore(path: string): ApprovalStore {
  if (cachedStore && cachedStorePath === path) return cachedStore;
  cachedStore = createApprovalStore(path);
  cachedStorePath = path;
  return cachedStore;
}

/** Test-only: drop the cached store so a new path is honored. */
export function _resetApprovalStoreCache(): void {
  cachedStore = undefined;
  cachedStorePath = undefined;
}

export async function requireApproval(
  ctx: ToolExecutionContext,
  intent: ApprovalIntent,
  gateConfig: ApprovalGateConfig = {},
): Promise<ApprovalRequest | null> {
  if (!gateConfig.approvalLogPath) {
    // Test-bypass mode: gate is not configured, treat as pre-approved. This
    // is intentional — production deployments MUST set approvalLogPath.
    return null;
  }
  if (gateConfig.bypassTools?.includes(intent.toolName)) {
    return null;
  }

  const store = getStore(gateConfig.approvalLogPath);
  const intentHash = hashIntent(intent);
  const ttlMs = gateConfig.ttlMs ?? DEFAULT_TTL_MS;

  const approved = await store.findApproved(ctx.session.did, intentHash);
  if (approved) {
    // Consume the approval — single-use, can't be replayed for a second
    // tool call with the same intent.
    return store.consume(approved.id, ctx.session.did);
  }

  const pending = await store.findPending(ctx.session.did, intentHash);
  if (pending) {
    throw new AtelMcpError(
      'APPROVAL_PENDING',
      `Action awaiting user approval`,
      {
        approvalId: pending.id,
        intentHash,
        action: intent.action,
        summary: intent.summary,
        expiresAt: pending.expiresAt,
      },
      `Approve via dashboard or run: npm run approval:approve ${pending.id}. The tool can be retried after approval.`,
    );
  }

  // First time we see this intent — file a fresh pending record.
  const now = new Date();
  const fresh: ApprovalRequest = {
    id: newApprovalId(),
    did: ctx.session.did,
    action: intent.action,
    intentHash,
    summary: intent.summary,
    params: intent.intentParams,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  await store.upsert(fresh);

  throw new AtelMcpError(
    'APPROVAL_PENDING',
    `Action requires user approval before execution`,
    {
      approvalId: fresh.id,
      intentHash,
      action: intent.action,
      summary: intent.summary,
      expiresAt: fresh.expiresAt,
    },
    `New approval filed. Approve via dashboard or run: npm run approval:approve ${fresh.id}. Then retry this tool.`,
  );
}

/**
 * Operator-side: mark an approval as APPROVED. Only callable from the CLI /
 * dashboard, NOT from MCP tools (MCP tools file approvals; they don't grant
 * them — that would defeat the point of the gate).
 */
export async function operatorApprove(
  approvalLogPath: string,
  id: string,
  approver: string,
): Promise<ApprovalRequest> {
  const store = getStore(approvalLogPath);
  const existing = await store.get(id);
  if (!existing) throw new Error(`Approval ${id} not found`);
  if (existing.status !== 'pending') {
    throw new Error(`Approval ${id} is in status=${existing.status}, can only approve from 'pending'`);
  }
  const next: ApprovalRequest = {
    ...existing,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: approver,
  };
  await store.upsert(next);
  return next;
}

export async function operatorDeny(
  approvalLogPath: string,
  id: string,
  reason: string,
): Promise<ApprovalRequest> {
  const store = getStore(approvalLogPath);
  const existing = await store.get(id);
  if (!existing) throw new Error(`Approval ${id} not found`);
  if (existing.status !== 'pending') {
    throw new Error(`Approval ${id} is in status=${existing.status}, can only deny from 'pending'`);
  }
  const next: ApprovalRequest = {
    ...existing,
    status: 'denied',
    deniedAt: new Date().toISOString(),
    deniedReason: reason,
  };
  await store.upsert(next);
  return next;
}

export async function listApprovals(approvalLogPath: string, did: string): Promise<ApprovalRequest[]> {
  const store = getStore(approvalLogPath);
  return store.list(did);
}

export async function getApproval(approvalLogPath: string, id: string): Promise<ApprovalRequest | null> {
  const store = getStore(approvalLogPath);
  return store.get(id);
}
