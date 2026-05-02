/**
 * DualAuditSink behavior pins.
 *
 * The point: audit dual-write must never make the primary worse. JSONL is
 * source of truth on-host; the platform sink is best-effort. Tests cover
 * the failure modes the platform sink is supposed to absorb without
 * breaking dispatch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DualAuditSink } from '../audit/dual-sink.js';
import { JsonlAuditSink } from '../audit/file-sink.js';
import type { AuditSink } from '../server/context.js';
import type { AuditEvent } from '../contracts/audit.js';

function sampleEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    type: 'tool.invoked',
    did: 'did:atel:ed25519:tester',
    actor: 'host',
    environment: 'production',
    requestId: 'req-1',
    toolName: 'atel_whoami',
    sessionId: 'sess-1',
    ...overrides,
  };
}

class CountingSink implements AuditSink {
  public events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class ThrowingSink implements AuditSink {
  public attempts = 0;
  async emit(_event: AuditEvent): Promise<void> {
    this.attempts++;
    throw new Error('upstream offline');
  }
}

test('dual sink: both sinks see the event in order', async () => {
  const order: string[] = [];
  const a: AuditSink = {
    async emit() { order.push('primary'); },
  };
  const b: AuditSink = {
    async emit() { order.push('secondary'); },
  };
  const dual = new DualAuditSink(a, b);
  await dual.emit(sampleEvent());
  assert.deepEqual(order, ['primary', 'secondary']);
});

test('dual sink: primary failure throws (we must not silently lose host audit)', async () => {
  const failing: AuditSink = {
    async emit() { throw new Error('disk full'); },
  };
  const counting = new CountingSink();
  const dual = new DualAuditSink(failing, counting);
  await assert.rejects(() => dual.emit(sampleEvent()), /disk full/);
  // Secondary must NOT be called when primary failed — order matters.
  assert.equal(counting.events.length, 0);
});

test('dual sink: secondary failure is swallowed (primary still wins)', async () => {
  const counting = new CountingSink();
  const throwing = new ThrowingSink();
  const dual = new DualAuditSink(counting, throwing);
  await dual.emit(sampleEvent());
  // Primary recorded the event; secondary attempted (and failed) once.
  assert.equal(counting.events.length, 1);
  assert.equal(throwing.attempts, 1);
});

test('dual sink: secondary undefined → only primary writes', async () => {
  const counting = new CountingSink();
  const dual = new DualAuditSink(counting, undefined);
  await dual.emit(sampleEvent());
  assert.equal(counting.events.length, 1);
});

test('dual sink: real JSONL primary still flushes when secondary throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-audit-dual-'));
  const path = join(dir, 'audit.jsonl');
  const jsonl = new JsonlAuditSink(path);
  const throwing = new ThrowingSink();
  const dual = new DualAuditSink(jsonl, throwing);
  await dual.emit(sampleEvent({ requestId: 'req-jsonl-survives' }));
  const raw = await readFile(path, 'utf8');
  assert.match(raw, /"requestId":"req-jsonl-survives"/);
});
