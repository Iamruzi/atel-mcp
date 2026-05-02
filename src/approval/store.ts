/**
 * JSONL-backed approval request store.
 *
 * Append-only log; read-side reconstructs latest state per id. Same model
 * as audit-log so we get the same operational properties (single-file move,
 * grep-friendly, no DB dependency for MCP layer).
 *
 * Operations:
 *   - upsert(req): write a record (any status) — used by gate to file
 *     PENDING and by CLI to mark APPROVED/DENIED.
 *   - findPending(did, intentHash): latest pending record matching this
 *     exact intent. If found + still in TTL → can be approved.
 *   - findApproved(did, intentHash): latest record where status=approved
 *     and not yet consumed.
 *   - consume(id): write a CONSUMED marker (one-shot — same approval can't
 *     be reused for a second tool call).
 *   - list(did): all non-consumed records (pending + approved) for a DID.
 *   - get(id): full history for a single id.
 */

import { mkdir, appendFile, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalIntent, ApprovalRequest, ApprovalStatus } from './types.js';

export interface ApprovalStore {
  upsert(req: ApprovalRequest): Promise<void>;
  findPending(did: string, intentHash: string): Promise<ApprovalRequest | null>;
  findApproved(did: string, intentHash: string): Promise<ApprovalRequest | null>;
  consume(id: string, did: string): Promise<ApprovalRequest>;
  list(did: string): Promise<ApprovalRequest[]>;
  get(id: string): Promise<ApprovalRequest | null>;
}

/**
 * Hash an intent into a stable key. Same toolName + same intentParams →
 * same hash regardless of object key order.
 */
export function hashIntent(intent: ApprovalIntent): string {
  const canonical = canonicalize({
    toolName: intent.toolName,
    action: intent.action,
    params: intent.intentParams,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function newApprovalId(): string {
  return `appr-${randomUUID()}`;
}

class JsonlApprovalStore implements ApprovalStore {
  constructor(private readonly path: string) {}

  async upsert(req: ApprovalRequest): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(req)}\n`, 'utf8');
  }

  async findPending(did: string, intentHash: string): Promise<ApprovalRequest | null> {
    const all = await this.readAll();
    // Latest record per id wins; we want one whose latest state is 'pending'
    // and which matches did + intentHash and isn't past expiresAt.
    const latest = collapseLatest(all);
    const now = Date.now();
    const candidates = latest.filter(
      (r) =>
        r.did === did &&
        r.intentHash === intentHash &&
        r.status === 'pending' &&
        new Date(r.expiresAt).getTime() > now,
    );
    return candidates.sort(byCreatedAtDesc)[0] ?? null;
  }

  async findApproved(did: string, intentHash: string): Promise<ApprovalRequest | null> {
    const all = await this.readAll();
    const latest = collapseLatest(all);
    const now = Date.now();
    const candidates = latest.filter(
      (r) =>
        r.did === did &&
        r.intentHash === intentHash &&
        r.status === 'approved' &&
        new Date(r.expiresAt).getTime() > now,
    );
    return candidates.sort(byCreatedAtDesc)[0] ?? null;
  }

  async consume(id: string, did: string): Promise<ApprovalRequest> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Approval ${id} not found`);
    if (existing.did !== did) throw new Error(`Approval ${id} belongs to a different DID`);
    if (existing.status === 'consumed') throw new Error(`Approval ${id} already consumed`);
    if (existing.status !== 'approved') throw new Error(`Approval ${id} is in status=${existing.status}, must be 'approved' to consume`);
    const next: ApprovalRequest = {
      ...existing,
      status: 'consumed',
      consumedAt: new Date().toISOString(),
    };
    await this.upsert(next);
    return next;
  }

  async list(did: string): Promise<ApprovalRequest[]> {
    const all = await this.readAll();
    const latest = collapseLatest(all);
    return latest
      .filter((r) => r.did === did && (r.status === 'pending' || r.status === 'approved'))
      .sort(byCreatedAtDesc);
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    const all = await this.readAll();
    const matches = all.filter((r) => r.id === id);
    if (matches.length === 0) return null;
    // File order matters: append-only log, the LAST row for an id is the
    // latest state. Sorting by createdAt would tie because operatorApprove
    // preserves the original createdAt — we'd return the pending row by
    // accident and then refuse to consume the approval.
    return matches[matches.length - 1];
  }

  private async readAll(): Promise<ApprovalRequest[]> {
    try {
      await stat(this.path);
    } catch {
      return [];
    }
    const raw = await readFile(this.path, 'utf8');
    const out: ApprovalRequest[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ApprovalRequest);
      } catch {
        // Skip corrupt rows; don't fail the whole read.
      }
    }
    return out;
  }
}

function collapseLatest(events: ApprovalRequest[]): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const e of events) {
    const prior = byId.get(e.id);
    if (!prior) {
      byId.set(e.id, e);
      continue;
    }
    // Prefer the row written later. createdAt is the original; we use the
    // approvedAt/consumedAt/deniedAt tail timestamps if present, else fall
    // back to a stable order: pending < approved/denied < consumed.
    if (statusRank(e.status) >= statusRank(prior.status)) {
      byId.set(e.id, e);
    }
  }
  return Array.from(byId.values());
}

function statusRank(s: ApprovalStatus): number {
  switch (s) {
    case 'pending':
      return 0;
    case 'approved':
    case 'denied':
      return 1;
    case 'consumed':
    case 'expired':
      return 2;
  }
}

function byCreatedAtDesc(a: ApprovalRequest, b: ApprovalRequest): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export function createApprovalStore(path: string): ApprovalStore {
  return new JsonlApprovalStore(path);
}
