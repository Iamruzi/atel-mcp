export type AtelMcpErrorCode =
  // HTTP-level (transport)
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UPSTREAM_ERROR'
  | 'NOT_IMPLEMENTED'
  // Business-level (domain)
  | 'ENVIRONMENT_MISMATCH'
  | 'PREREQUISITE_NOT_MET'
  | 'INSUFFICIENT_BALANCE'
  | 'WALLET_NOT_READY'
  | 'TARGET_NOT_FOUND'
  | 'SCOPE_DENIED'
  | 'IDEMPOTENCY_REPLAY'
  | 'EXECUTOR_OFFLINE'
  | 'CAPABILITY_MISMATCH'
  | 'APPROVAL_PENDING';

/**
 * AtelMcpError carries a code (machine-readable, stable enum), a human message,
 * an optional structured `details` payload, and an actionable `hint` that tells
 * the calling LLM what to do next. The hint is the difference between
 *   "execution reverted"   (raw, LLM has no idea)
 * and
 *   "FAST balance is 0.5, you need 0.6 — try chain=base where you have 5 USDC"
 * (actionable: LLM can self-correct).
 */
export class AtelMcpError extends Error {
  constructor(
    public readonly code: AtelMcpErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'AtelMcpError';
  }

  /**
   * Serialize for MCP error response. LLM reads `code` + `hint` to self-correct,
   * `message` for display, `details` for debugging.
   */
  toResponse(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }
}
