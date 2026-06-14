import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AtelMcpConfig } from '../config.js';
import type { AuditEvent } from '../contracts/audit.js';
import type { AuditSink } from '../server/context.js';
import { DualAuditSink } from './dual-sink.js';
import { createPlatformAuditSink } from './platform-sink.js';

interface StoredAuditEvent extends AuditEvent {
  id: string;
  createdAt: string;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class JsonlAuditSink implements AuditSink {
  constructor(private readonly path: string) {}

  async emit(event: AuditEvent): Promise<void> {
    const row: StoredAuditEvent = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      ...event,
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(row)}\n`, 'utf8');
  }
}

/**
 * Compose the audit sink. JSONL is the primary truth (must succeed). The
 * platform ingest sink is layered on top when enabled — it's best-effort
 * and never blocks the dispatch path.
 *
 * Migration story: today, audit lives in JSONL on each MCP host. Operators
 * grep these files. Once the platform's mcp_audit_log table is ready, flip
 * ATEL_MCP_AUDIT_PLATFORM_INGEST=true and the dual sink starts feeding the
 * central DB without losing the local copy. Full cutover (delete JSONL)
 * comes later, after a soak window proves field alignment.
 */
export function createAuditSink(config: AtelMcpConfig): AuditSink | undefined {
  if (!config.auditLogPath) return undefined;
  const primary = new JsonlAuditSink(config.auditLogPath);
  const secondary = createPlatformAuditSink(config);
  if (!secondary) return primary;
  return new DualAuditSink(primary, secondary);
}
