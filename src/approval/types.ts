/**
 * Approval gate types.
 *
 * Two-factor security model for high-risk MCP actions:
 *   1. Scope (e.g. wallet.transfer) = "this client may attempt this category"
 *   2. Approval (per-action, out-of-band) = "user OK'd THIS specific action"
 *
 * Why both: scopes are granted at session creation (broad). For irreversible
 * fund movement we want a fresh per-action confirmation that survived a
 * round-trip to the user (dashboard / CLI / TG), not just a JWT scope claim
 * that an over-permissioned host LLM can spend at will.
 */

export type ApprovalAction =
  | 'wallet.transfer'
  | 'wallet.withdraw'
  | 'fast.transfer';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';

export interface ApprovalRequest {
  id: string;
  did: string;
  action: ApprovalAction;
  /** Stable hash of (toolName + canonical params); same intent → same hash → matches the same approval. */
  intentHash: string;
  /** Human-readable summary so the operator/dashboard knows what they are approving. */
  summary: string;
  /** Echo of the params for the operator to inspect. Sensitive fields filtered before display. */
  params: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  approvedBy?: string;
  consumedAt?: string;
  deniedAt?: string;
  deniedReason?: string;
}

export interface ApprovalIntent {
  action: ApprovalAction;
  toolName: string;
  /** Params that uniquely identify the intent (e.g. recipient + amount + chain). */
  intentParams: Record<string, unknown>;
  /** What to show the operator in dashboard / CLI. */
  summary: string;
}
