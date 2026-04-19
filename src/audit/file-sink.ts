import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AtelMcpConfig } from '../config.js';
import type { AuditEvent } from '../contracts/audit.js';
import type { AuditSink } from '../server/context.js';

interface StoredAuditEvent extends AuditEvent {
  id: string;
  createdAt: string;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

class JsonlAuditSink implements AuditSink {
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

export function createAuditSink(config: AtelMcpConfig): AuditSink | undefined {
  if (!config.auditLogPath) return undefined;
  return new JsonlAuditSink(config.auditLogPath);
}
