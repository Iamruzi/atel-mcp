export type AtelRuntimeBackend = 'platform-hosted' | 'sdk-runtime' | 'linked-runtime';
export type AtelUserMode = 'mcp-only' | 'runtime-only' | 'mcp-plus-runtime';
export type AtelExecutionClass = 'platform-truth-read' | 'platform-state-write' | 'runtime-capable';

export interface RuntimeLinkRecord {
  hostedDid: string;
  runtimeDid: string;
  backend: Exclude<AtelRuntimeBackend, 'platform-hosted'>;
  status?: 'linked' | 'degraded' | 'offline';
  endpoint?: string;
  relayBaseUrl?: string;
  lastSeenAt?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredRuntimeLinkRecord extends RuntimeLinkRecord {
  authToken?: string;
}

export interface ExecutionRoutePlan {
  requestedBackend?: AtelRuntimeBackend;
  declaredUserMode?: AtelUserMode;
  selectedBackend: AtelRuntimeBackend;
  executionClass: AtelExecutionClass;
  runtimeEligible: boolean;
  futureBackends: AtelRuntimeBackend[];
  runtimeLinkStatus: 'none' | 'linked';
  runtimeLink?: RuntimeLinkRecord;
  reason: string;
}
