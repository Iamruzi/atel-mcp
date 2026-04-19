export type AuditActor = 'host' | 'system';
export type AuditStatus = 'ok' | 'error' | 'rejected';
export type AuditEnvironment = 'production' | 'local-test' | 'custom';
export type AuditEntityType = 'session' | 'message' | 'order' | 'milestone' | 'dispute' | 'request';

export type AuditEventType =
  | 'auth.session_resolved'
  | 'tool.invoked'
  | 'tool.succeeded'
  | 'tool.failed'
  | 'guard.rejected'
  | 'message.sent'
  | 'message.acked'
  | 'order.created'
  | 'order.accepted'
  | 'milestone.submitted'
  | 'milestone.verified'
  | 'milestone.rejected'
  | 'milestone.arbitration_passed'
  | 'milestone.arbitration_failed'
  | 'dispute.created';

export interface AuditEvent {
  type: AuditEventType;
  did: string;
  actor: AuditActor;
  environment: AuditEnvironment;
  requestId: string;
  toolName: string;
  status?: AuditStatus;
  sessionId?: string;
  entityType?: AuditEntityType;
  entityId?: string;
  orderId?: string;
  milestoneIndex?: number;
  peerDid?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}
