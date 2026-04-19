import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestMeta } from '../server/request-meta.js';

test('extractRequestMeta normalizes request headers', () => {
  const req = {
    header(name: string) {
      const map: Record<string, string> = {
        authorization: 'Bearer token-x',
        'x-request-id': 'req-1',
        'idempotency-key': 'idem-1',
        'user-agent': 'test-agent',
        host: 'mcp.example.com',
      };
      return map[name];
    },
    hostname: 'mcp.example.com',
  };
  const meta = extractRequestMeta(req as never);
  assert.equal(meta.authorization, 'Bearer token-x');
  assert.equal(meta.requestId, 'req-1');
  assert.equal(meta.idempotencyKey, 'idem-1');
  assert.equal(meta.hostName, 'mcp.example.com');
  assert.equal(meta.userAgent, 'test-agent');
});
