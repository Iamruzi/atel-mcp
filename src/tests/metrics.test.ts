/**
 * Pin metrics exposition format + recording API.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordToolCall,
  recordDispatch,
  recordPlatformRequest,
  renderMetrics,
  _resetMetrics,
} from '../server/metrics.js';

test('metrics: tool call counter increments per tool+status', () => {
  _resetMetrics();
  recordToolCall('atel_whoami', 'ok', 12);
  recordToolCall('atel_whoami', 'ok', 8);
  recordToolCall('atel_whoami', 'error', 5);
  recordToolCall('atel_balance', 'ok', 30);

  const out = renderMetrics();
  // 2 ok calls to whoami
  assert.match(out, /atel_mcp_tool_calls_total\{status="ok",tool="atel_whoami"\} 2/);
  assert.match(out, /atel_mcp_tool_calls_total\{status="error",tool="atel_whoami"\} 1/);
  assert.match(out, /atel_mcp_tool_calls_total\{status="ok",tool="atel_balance"\} 1/);
});

test('metrics: histogram emits bucket + sum + count lines', () => {
  _resetMetrics();
  recordToolCall('atel_a2b_search', 'ok', 50);
  recordToolCall('atel_a2b_search', 'ok', 200);
  recordToolCall('atel_a2b_search', 'ok', 1500);

  const out = renderMetrics();
  // sum should be 1750
  assert.match(out, /atel_mcp_tool_duration_ms_sum\{tool="atel_a2b_search"\} 1750/);
  // count should be 3
  assert.match(out, /atel_mcp_tool_duration_ms_count\{tool="atel_a2b_search"\} 3/);
  // 50ms + 200ms both <= 1000 (le ordering uses bucket le label after the original labels)
  assert.match(out, /atel_mcp_tool_duration_ms_bucket\{tool="atel_a2b_search",le="1000"\} 2/);
  // +Inf bucket: count
  assert.match(out, /atel_mcp_tool_duration_ms_bucket\{tool="atel_a2b_search",le="\+Inf"\} 3/);
});

test('metrics: dispatch counter tracks scope outcomes', () => {
  _resetMetrics();
  recordDispatch('atel_order_create', 'ok');
  recordDispatch('atel_order_create', 'denied');
  recordDispatch('atel_order_create', 'ok');

  const out = renderMetrics();
  assert.match(out, /atel_mcp_dispatch_total\{scope_check="ok",tool="atel_order_create"\} 2/);
  assert.match(out, /atel_mcp_dispatch_total\{scope_check="denied",tool="atel_order_create"\} 1/);
});

test('metrics: platform request collapses path to top 2 segments (cardinality control)', () => {
  _resetMetrics();
  recordPlatformRequest('/trade/v1/order', '2xx');
  recordPlatformRequest('/trade/v1/order/ord-123', '2xx');
  recordPlatformRequest('/trade/v1/order/ord-456/accept', '2xx');
  // All three should land on the same collapsed path "/trade/v1".

  const out = renderMetrics();
  assert.match(out, /atel_mcp_platform_request_total\{[^}]*path="\/trade\/v1"[^}]*status_class="2xx"\} 3/);
});

test('metrics: status class buckets 4xx/5xx/error separately', () => {
  _resetMetrics();
  recordPlatformRequest('/x/y', '2xx');
  recordPlatformRequest('/x/y', '4xx');
  recordPlatformRequest('/x/y', '5xx');
  recordPlatformRequest('/x/y', 'error');

  const out = renderMetrics();
  for (const cls of ['2xx', '4xx', '5xx', 'error']) {
    assert.match(out, new RegExp(`status_class="${cls}"\\} 1`));
  }
});

test('metrics: rendered output is valid Prometheus exposition format', () => {
  _resetMetrics();
  recordToolCall('atel_whoami', 'ok', 5);
  const out = renderMetrics();

  // Each metric must have a HELP and TYPE line.
  assert.match(out, /^# HELP atel_mcp_tool_calls_total/m);
  assert.match(out, /^# TYPE atel_mcp_tool_calls_total counter/m);
  assert.match(out, /^# TYPE atel_mcp_tool_duration_ms histogram/m);
  // Trailing newline (Prometheus parser tolerates absence but expects it).
  assert.ok(out.endsWith('\n'));
});
