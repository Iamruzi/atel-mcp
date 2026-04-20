import { rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const explicitTargets = [
  '/tmp/atel-mcp-audit.jsonl',
  '/tmp/atel-mcp-http.log',
  '/tmp/atel-mcp-http.pid',
  '/tmp/atel-mcp.log',
  '/tmp/atel-mcp.pid',
];

const tmpPrefixes = [
  'atel-mcp-',
  'fix-atel-mcp-',
  'patch-atel-mcp-',
  'run-atel-mcp-',
];

const requesterDid = process.env.ATEL_MCP_DEV_REQUESTER_DID ?? 'did:atel:ed25519:mcpreq';
const executorDid = process.env.ATEL_MCP_DEV_EXECUTOR_DID ?? 'did:atel:ed25519:mcpexec';
const dbHost = process.env.ATEL_DB_HOST ?? '127.0.0.1';
const dbPort = process.env.ATEL_DB_PORT ?? '5432';
const dbUser = process.env.ATEL_DB_USER ?? 'atel';
const dbName = process.env.ATEL_DB_NAME ?? 'atel_platform';
const dbPass = process.env.ATEL_DB_PASS ?? 'atel_platform_2026';

function runCleanupSql() {
  const sql = `
WITH target_orders AS (
  SELECT order_id FROM orders WHERE requester_did IN ('${requesterDid}','${executorDid}') OR executor_did IN ('${requesterDid}','${executorDid}')
), deleted_disputes AS (
  DELETE FROM disputes WHERE initiator_did IN ('${requesterDid}','${executorDid}') OR order_id IN (SELECT order_id FROM target_orders)
), deleted_milestones AS (
  DELETE FROM milestones WHERE order_id IN (SELECT order_id FROM target_orders)
), deleted_domain_events AS (
  DELETE FROM domain_events WHERE aggregate_id IN (SELECT order_id FROM target_orders)
), deleted_relay_messages AS (
  DELETE FROM relay_messages WHERE sender_did IN ('${requesterDid}','${executorDid}') OR target_did IN ('${requesterDid}','${executorDid}')
), deleted_contacts AS (
  DELETE FROM contacts WHERE owner_did IN ('${requesterDid}','${executorDid}') OR contact_did IN ('${requesterDid}','${executorDid}')
)
DELETE FROM orders WHERE order_id IN (SELECT order_id FROM target_orders);
`;

  execFileSync('psql', [
    '-h', dbHost,
    '-p', dbPort,
    '-U', dbUser,
    '-d', dbName,
    '-v', 'ON_ERROR_STOP=1',
    '-c', sql,
  ], {
    env: { ...process.env, PGPASSWORD: dbPass },
    stdio: 'pipe',
  });
}

function removePath(target: string, removed: string[]) {
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
  removed.push(target);
}

function removeTmpArtifacts(removed: string[]) {
  for (const entry of readdirSync('/tmp')) {
    if (!tmpPrefixes.some((prefix) => entry.startsWith(prefix))) continue;
    const fullPath = join('/tmp', entry);
    try {
      const stats = statSync(fullPath);
      rmSync(fullPath, { recursive: stats.isDirectory(), force: true });
      removed.push(fullPath);
    } catch {
      // ignore races / disappearing temp files
    }
  }
}

const removed: string[] = [];

try {
  execFileSync('pkill', ['-f', 'dist/server/http.js'], { stdio: 'ignore' });
  removed.push('process:dist/server/http.js');
} catch {
  // ignore when no MCP server is running
}

runCleanupSql();
removed.push('db:mcp-dev-state');

for (const target of explicitTargets) removePath(target, removed);
removeTmpArtifacts(removed);

console.log(JSON.stringify({ ok: true, removed }, null, 2));
