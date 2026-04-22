import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { buildExecutionRoutePlan, parseDeclaredUserMode, parsePreferredRuntimeBackend } from '../server/execution-routing.js';

const config = loadConfig({
  ATEL_PLATFORM_BASE_URL: 'http://127.0.0.1:18204',
  ATEL_MCP_PUBLIC_BASE_URL: 'https://mcp.atel.test',
  ATEL_MCP_OAUTH_ISSUER_URL: 'https://mcp.atel.test',
  ATEL_MCP_RUNTIME_BACKENDS: 'platform-hosted,sdk-runtime,linked-runtime',
  ATEL_MCP_SUPPORTED_USER_MODES: 'mcp-only,runtime-only,mcp-plus-runtime',
} as never);

test('parse runtime preference headers safely', () => {
  assert.equal(parsePreferredRuntimeBackend('sdk-runtime'), 'sdk-runtime');
  assert.equal(parsePreferredRuntimeBackend('nope'), undefined);
  assert.equal(parseDeclaredUserMode('mcp-plus-runtime'), 'mcp-plus-runtime');
  assert.equal(parseDeclaredUserMode('broken'), undefined);
});

test('runtime-capable tools stay platform-hosted during staged rollout', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_send_message',
    config,
    preferredBackend: 'sdk-runtime',
    userMode: 'mcp-plus-runtime',
  });
  assert.equal(plan.selectedBackend, 'platform-hosted');
  assert.equal(plan.executionClass, 'runtime-capable');
  assert.equal(plan.runtimeEligible, true);
  assert.deepEqual(plan.futureBackends, ['sdk-runtime', 'linked-runtime']);
  assert.match(plan.reason, /current rollout keeps atel_send_message on platform-hosted/);
});

test('read tools remain platform-truth reads', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_order_get',
    config,
  });
  assert.equal(plan.selectedBackend, 'platform-hosted');
  assert.equal(plan.executionClass, 'platform-truth-read');
  assert.equal(plan.runtimeEligible, false);
  assert.deepEqual(plan.futureBackends, []);
});

test('linked-runtime requested without a registered link falls back explicitly', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_send_message',
    config,
    preferredBackend: 'linked-runtime',
    userMode: 'mcp-plus-runtime',
    runtimeLink: null,
  });
  assert.equal(plan.selectedBackend, 'platform-hosted');
  assert.equal(plan.runtimeLinkStatus, 'none');
  assert.match(plan.reason, /no runtime link is registered/);
});

test('linked-runtime selects remote dispatch for atel_send_message when endpoint exists', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_send_message',
    config,
    preferredBackend: 'linked-runtime',
    userMode: 'mcp-plus-runtime',
    runtimeLink: {
      hostedDid: 'did:atel:ed25519:host',
      runtimeDid: 'did:atel:ed25519:runtime',
      backend: 'linked-runtime',
      endpoint: 'https://runtime.example.com/mcp',
      status: 'linked',
    },
  });
  assert.equal(plan.selectedBackend, 'linked-runtime');
  assert.equal(plan.runtimeLinkStatus, 'linked');
  assert.match(plan.reason, /linked-runtime selected/);
});


test('linked-runtime selects remote dispatch for atel_order_create when endpoint exists', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_order_create',
    config,
    preferredBackend: 'linked-runtime',
    userMode: 'mcp-plus-runtime',
    runtimeLink: {
      hostedDid: 'did:atel:ed25519:host',
      runtimeDid: 'did:atel:ed25519:runtime',
      backend: 'linked-runtime',
      endpoint: 'https://runtime.example.com/mcp',
      status: 'linked',
    },
  });
  assert.equal(plan.selectedBackend, 'linked-runtime');
  assert.equal(plan.runtimeLinkStatus, 'linked');
  assert.match(plan.reason, /linked-runtime selected/);
});


test('linked-runtime selects remote dispatch for atel_order_accept when endpoint exists', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_order_accept',
    config,
    preferredBackend: 'linked-runtime',
    userMode: 'mcp-plus-runtime',
    runtimeLink: {
      hostedDid: 'did:atel:ed25519:host',
      runtimeDid: 'did:atel:ed25519:runtime',
      backend: 'linked-runtime',
      endpoint: 'https://runtime.example.com/mcp',
      status: 'linked',
    },
  });
  assert.equal(plan.selectedBackend, 'linked-runtime');
  assert.equal(plan.runtimeLinkStatus, 'linked');
  assert.match(plan.reason, /linked-runtime selected/);
});


test('linked-runtime selects remote dispatch for atel_milestone_submit when endpoint exists', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_milestone_submit',
    config,
    preferredBackend: 'linked-runtime',
    userMode: 'mcp-plus-runtime',
    runtimeLink: {
      hostedDid: 'did:atel:ed25519:host',
      runtimeDid: 'did:atel:ed25519:runtime',
      backend: 'linked-runtime',
      endpoint: 'https://runtime.example.com/mcp',
      status: 'linked',
    },
  });
  assert.equal(plan.selectedBackend, 'linked-runtime');
  assert.equal(plan.runtimeLinkStatus, 'linked');
  assert.match(plan.reason, /linked-runtime selected/);
});


test('linked-runtime selects remote dispatch for atel_milestone_verify when endpoint exists', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_milestone_verify',
    config,
    preferredBackend: 'linked-runtime',
    userMode: 'mcp-plus-runtime',
    runtimeLink: {
      hostedDid: 'did:atel:ed25519:host',
      runtimeDid: 'did:atel:ed25519:runtime',
      backend: 'linked-runtime',
      endpoint: 'https://runtime.example.com/mcp',
      status: 'linked',
    },
  });
  assert.equal(plan.selectedBackend, 'linked-runtime');
  assert.equal(plan.runtimeLinkStatus, 'linked');
  assert.match(plan.reason, /linked-runtime selected/);
});


test('linked-runtime selects remote dispatch for atel_milestone_reject when endpoint exists', () => {
  const plan = buildExecutionRoutePlan({
    toolName: 'atel_milestone_reject',
    config,
    preferredBackend: 'linked-runtime',
    userMode: 'mcp-plus-runtime',
    runtimeLink: {
      hostedDid: 'did:atel:ed25519:host',
      runtimeDid: 'did:atel:ed25519:runtime',
      backend: 'linked-runtime',
      endpoint: 'https://runtime.example.com/mcp',
      status: 'linked',
    },
  });
  assert.equal(plan.selectedBackend, 'linked-runtime');
  assert.equal(plan.runtimeLinkStatus, 'linked');
  assert.match(plan.reason, /linked-runtime selected/);
});
