import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requireApproval,
  operatorApprove,
  operatorDeny,
  listApprovals,
  _resetApprovalStoreCache,
} from '../approval/gate.js';
import { hashIntent } from '../approval/store.js';
import { AtelMcpError } from '../contracts/errors.js';

interface FakeCtx {
  session: { did: string };
  config: { approvalLogPath?: string; approvalBypassTools?: string[] };
}

function makeCtx(approvalLogPath?: string): FakeCtx {
  return {
    session: { did: 'did:atel:ed25519:tester' },
    config: { approvalLogPath, approvalBypassTools: [] },
  };
}

const sampleIntent = {
  action: 'wallet.transfer' as const,
  toolName: 'atel_wallet_transfer',
  intentParams: { chain: 'base', address: '0xabc', amount: 1.5 },
  summary: 'Transfer 1.5 USDC on BASE to 0xabc',
};

test('approval gate: bypass when approvalLogPath unset', async () => {
  const ctx = makeCtx(undefined);
  const result = await requireApproval(ctx as never, sampleIntent, {});
  assert.equal(result, null);
});

test('approval gate: bypass when tool is in bypassTools list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-appr-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx(path);
  const result = await requireApproval(ctx as never, sampleIntent, {
    approvalLogPath: path,
    bypassTools: ['atel_wallet_transfer'],
  });
  assert.equal(result, null);
});

test('approval gate: first call files PENDING and throws APPROVAL_PENDING', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-appr-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx(path);
  await assert.rejects(
    () => requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }),
    (err: unknown) => {
      assert.ok(err instanceof AtelMcpError);
      assert.equal(err.code, 'APPROVAL_PENDING');
      assert.match(err.hint ?? '', /approval:approve appr-/);
      const details = err.details as { approvalId?: string };
      assert.match(details.approvalId ?? '', /^appr-/);
      return true;
    },
  );
  // The pending record should be visible via listApprovals.
  const pending = await listApprovals(path, ctx.session.did);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
});

test('approval gate: same intent on second call reuses the same pending id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-appr-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx(path);
  let firstId: string | undefined;
  let secondId: string | undefined;
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }).catch((e: AtelMcpError) => {
    firstId = (e.details as { approvalId?: string }).approvalId;
  });
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }).catch((e: AtelMcpError) => {
    secondId = (e.details as { approvalId?: string }).approvalId;
  });
  assert.ok(firstId);
  assert.equal(firstId, secondId);
});

test('approval gate: different intents file separate pending records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-appr-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx(path);
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }).catch(() => {});
  await requireApproval(ctx as never, { ...sampleIntent, intentParams: { ...sampleIntent.intentParams, amount: 2.0 } }, { approvalLogPath: path }).catch(() => {});
  const pending = await listApprovals(path, ctx.session.did);
  assert.equal(pending.length, 2);
});

test('approval gate: after operatorApprove, the gate consumes and returns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-appr-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx(path);
  let pendingId: string | undefined;
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }).catch((e: AtelMcpError) => {
    pendingId = (e.details as { approvalId?: string }).approvalId;
  });
  assert.ok(pendingId);
  await operatorApprove(path, pendingId!, 'test-operator');
  const consumed = await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path });
  assert.ok(consumed);
  assert.equal(consumed.status, 'consumed');
  // A SECOND retry must not reuse the consumed approval — gate should file
  // a new pending one and throw again. Without this property the same
  // operator approval would let an LLM execute the action twice.
  await assert.rejects(
    () => requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }),
    (err: unknown) => err instanceof AtelMcpError && err.code === 'APPROVAL_PENDING',
  );
});

test('approval gate: operatorDeny blocks the same intent until a new pending is filed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-appr-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx(path);
  let pendingId: string | undefined;
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }).catch((e: AtelMcpError) => {
    pendingId = (e.details as { approvalId?: string }).approvalId;
  });
  await operatorDeny(path, pendingId!, 'wrong recipient');
  // A retry should NOT find the denied approval as approved; it should file
  // a new pending one (so the LLM can ask the user again with an updated
  // params / better summary).
  let secondId: string | undefined;
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path }).catch((e: AtelMcpError) => {
    secondId = (e.details as { approvalId?: string }).approvalId;
  });
  assert.ok(secondId);
  assert.notEqual(secondId, pendingId);
});

test('approval gate: hashIntent ignores key order', () => {
  const a = hashIntent({
    action: 'wallet.transfer',
    toolName: 'atel_wallet_transfer',
    intentParams: { chain: 'base', address: '0xabc', amount: 1.5 },
    summary: 'irrelevant',
  });
  const b = hashIntent({
    action: 'wallet.transfer',
    toolName: 'atel_wallet_transfer',
    intentParams: { amount: 1.5, address: '0xabc', chain: 'base' },
    summary: 'completely different summary text',
  });
  assert.equal(a, b);
});

test('approval gate: TTL expiry — expired pending does not match new request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-appr-'));
  const path = join(dir, 'approvals.jsonl');
  _resetApprovalStoreCache();
  const ctx = makeCtx(path);
  let firstId: string | undefined;
  // TTL=1ms — by the time we make the second call, the pending has expired.
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path, ttlMs: 1 }).catch((e: AtelMcpError) => {
    firstId = (e.details as { approvalId?: string }).approvalId;
  });
  await new Promise((r) => setTimeout(r, 10));
  let secondId: string | undefined;
  await requireApproval(ctx as never, sampleIntent, { approvalLogPath: path, ttlMs: 1 }).catch((e: AtelMcpError) => {
    secondId = (e.details as { approvalId?: string }).approvalId;
  });
  assert.notEqual(firstId, secondId);
});
