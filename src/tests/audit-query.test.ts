import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryAuditByOrder, queryAuditByRequest, queryAuditBySession } from '../audit/query.js';
import { loadConfig } from '../config.js';

test('queryAuditByOrder filters by did and orderId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-audit-'));
  const file = join(dir, 'audit.jsonl');
  await writeFile(file, [
    JSON.stringify({ id: '1', createdAt: '2026-01-01T00:00:00Z', type: 'order.created', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r1', toolName: 'atel_order_create', orderId: 'ord-1', sessionId: 's1' }),
    JSON.stringify({ id: '2', createdAt: '2026-01-01T00:00:01Z', type: 'milestone.verified', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r2', toolName: 'atel_milestone_verify', orderId: 'ord-1', sessionId: 's1' }),
    JSON.stringify({ id: '3', createdAt: '2026-01-01T00:00:02Z', type: 'order.created', did: 'did:atel:ed25519:b', actor: 'host', environment: 'production', requestId: 'r3', toolName: 'atel_order_create', orderId: 'ord-1', sessionId: 's2' }),
  ].join('\n') + '\n', 'utf8');
  const config = loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org', ATEL_MCP_AUDIT_LOG_PATH: file } as never);
  const events = await queryAuditByOrder(config, 'did:atel:ed25519:a', 'ord-1', 50);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.id, '2');
  assert.equal(events[1]?.id, '1');
});

test('queryAuditBySession filters by did and sessionId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-audit-'));
  const file = join(dir, 'audit.jsonl');
  await writeFile(file, [
    JSON.stringify({ id: '1', createdAt: '2026-01-01T00:00:00Z', type: 'tool.invoked', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r1', toolName: 'atel_whoami', sessionId: 's1' }),
    JSON.stringify({ id: '2', createdAt: '2026-01-01T00:00:01Z', type: 'tool.succeeded', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r2', toolName: 'atel_balance', sessionId: 's1' }),
    JSON.stringify({ id: '3', createdAt: '2026-01-01T00:00:02Z', type: 'tool.invoked', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r3', toolName: 'atel_balance', sessionId: 's2' }),
  ].join('\n') + '\n', 'utf8');
  const config = loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org', ATEL_MCP_AUDIT_LOG_PATH: file } as never);
  const events = await queryAuditBySession(config, 'did:atel:ed25519:a', 's1', 50);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.id, '2');
  assert.equal(events[1]?.id, '1');
});


test('queryAuditByRequest filters by did and requestId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-mcp-audit-'));
  const file = join(dir, 'audit.jsonl');
  await writeFile(file, [
    JSON.stringify({ id: '1', createdAt: '2026-01-01T00:00:00Z', type: 'tool.invoked', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r1', toolName: 'atel_order_get', sessionId: 's1' }),
    JSON.stringify({ id: '2', createdAt: '2026-01-01T00:00:01Z', type: 'tool.succeeded', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r1', toolName: 'atel_order_get', sessionId: 's1' }),
    JSON.stringify({ id: '3', createdAt: '2026-01-01T00:00:02Z', type: 'tool.invoked', did: 'did:atel:ed25519:a', actor: 'host', environment: 'production', requestId: 'r2', toolName: 'atel_balance', sessionId: 's1' }),
    JSON.stringify({ id: '4', createdAt: '2026-01-01T00:00:03Z', type: 'tool.invoked', did: 'did:atel:ed25519:b', actor: 'host', environment: 'production', requestId: 'r1', toolName: 'atel_order_get', sessionId: 's2' }),
  ].join('\n') + '\n', 'utf8');
  const config = loadConfig({ ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org', ATEL_MCP_AUDIT_LOG_PATH: file } as never);
  const events = await queryAuditByRequest(config, 'did:atel:ed25519:a', 'r1', 50);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.id, '2');
  assert.equal(events[1]?.id, '1');
});
