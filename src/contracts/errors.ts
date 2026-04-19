export type AtelMcpErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'ENVIRONMENT_MISMATCH'
  | 'PREREQUISITE_NOT_MET'
  | 'INSUFFICIENT_BALANCE'
  | 'NOT_FOUND'
  | 'UPSTREAM_ERROR'
  | 'NOT_IMPLEMENTED';

export class AtelMcpError extends Error {
  constructor(
    public readonly code: AtelMcpErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AtelMcpError';
  }
}
