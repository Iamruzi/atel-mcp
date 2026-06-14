/**
 * T8.1 — Prometheus-compatible metrics endpoint.
 *
 * Lightweight in-process counters/histograms exposed at /metrics in
 * Prometheus exposition format. Scrape-friendly, no external dependency.
 *
 * Why not import prom-client: an extra dep for the few metrics we care
 * about isn't worth it. The exposition format is ~50 lines of code.
 *
 * Metrics emitted:
 *   - atel_mcp_tool_calls_total{tool, status}: counter, status in
 *     {ok, error}
 *   - atel_mcp_tool_duration_ms_bucket{tool, le}: histogram of tool
 *     handler latency (ms)
 *   - atel_mcp_dispatch_total{tool, scope_check}: counter,
 *     scope_check in {ok, denied}
 *   - atel_mcp_platform_request_total{path, status_class}: counter,
 *     class in {2xx, 4xx, 5xx, error}
 */

const HISTOGRAM_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

class Counter {
  private values = new Map<string, number>();
  inc(labels: Record<string, string>, by = 1): void {
    const key = encodeLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  *entries(): Generator<[string, number]> {
    for (const [k, v] of this.values) yield [k, v];
  }
  reset(): void {
    this.values.clear();
  }
}

class Histogram {
  // For each label set: bucket counts (sorted by le, last is +Inf) + sum + count.
  private values = new Map<string, { buckets: number[]; sum: number; count: number }>();

  observe(labels: Record<string, string>, valueMs: number): void {
    const key = encodeLabels(labels);
    let entry = this.values.get(key);
    if (!entry) {
      entry = { buckets: new Array(HISTOGRAM_BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      this.values.set(key, entry);
    }
    entry.sum += valueMs;
    entry.count += 1;
    for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i++) {
      if (valueMs <= HISTOGRAM_BUCKETS_MS[i]) entry.buckets[i] += 1;
    }
  }

  *entries(): Generator<[string, { buckets: number[]; sum: number; count: number }]> {
    for (const [k, v] of this.values) yield [k, v];
  }
  reset(): void {
    this.values.clear();
  }
}

function encodeLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join(',');
}

function decodeLabels(encoded: string): string {
  // For exposition: the encoded form is already nearly Prometheus syntax.
  return encoded; // already key="value",key2="value2"
}

const toolCallsTotal = new Counter();
const toolDurationMs = new Histogram();
const dispatchTotal = new Counter();
const platformRequestTotal = new Counter();

export function recordToolCall(tool: string, status: 'ok' | 'error', durationMs: number): void {
  toolCallsTotal.inc({ tool, status });
  toolDurationMs.observe({ tool }, durationMs);
}

export function recordDispatch(tool: string, scopeCheck: 'ok' | 'denied'): void {
  dispatchTotal.inc({ tool, scope_check: scopeCheck });
}

export function recordPlatformRequest(path: string, statusClass: '2xx' | '4xx' | '5xx' | 'error'): void {
  // Cardinality control: collapse path to its first 2 segments
  // (e.g. /trade/v1/order/foo → /trade/v1).
  const segments = path.split('/').filter(Boolean).slice(0, 2);
  const collapsed = '/' + segments.join('/');
  platformRequestTotal.inc({ path: collapsed, status_class: statusClass });
}

/**
 * Render counters/histograms in Prometheus exposition format.
 */
export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push('# HELP atel_mcp_tool_calls_total Number of MCP tool calls by tool name and outcome.');
  lines.push('# TYPE atel_mcp_tool_calls_total counter');
  for (const [labels, value] of toolCallsTotal.entries()) {
    lines.push(`atel_mcp_tool_calls_total{${decodeLabels(labels)}} ${value}`);
  }

  lines.push('# HELP atel_mcp_tool_duration_ms Tool handler latency in milliseconds.');
  lines.push('# TYPE atel_mcp_tool_duration_ms histogram');
  for (const [labels, h] of toolDurationMs.entries()) {
    for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i++) {
      lines.push(`atel_mcp_tool_duration_ms_bucket{${decodeLabels(labels)},le="${HISTOGRAM_BUCKETS_MS[i]}"} ${h.buckets[i]}`);
    }
    lines.push(`atel_mcp_tool_duration_ms_bucket{${decodeLabels(labels)},le="+Inf"} ${h.count}`);
    lines.push(`atel_mcp_tool_duration_ms_sum{${decodeLabels(labels)}} ${h.sum}`);
    lines.push(`atel_mcp_tool_duration_ms_count{${decodeLabels(labels)}} ${h.count}`);
  }

  lines.push('# HELP atel_mcp_dispatch_total MCP dispatch outcomes (scope check pass/deny).');
  lines.push('# TYPE atel_mcp_dispatch_total counter');
  for (const [labels, value] of dispatchTotal.entries()) {
    lines.push(`atel_mcp_dispatch_total{${decodeLabels(labels)}} ${value}`);
  }

  lines.push('# HELP atel_mcp_platform_request_total MCP→platform HTTP requests by path prefix and status class.');
  lines.push('# TYPE atel_mcp_platform_request_total counter');
  for (const [labels, value] of platformRequestTotal.entries()) {
    lines.push(`atel_mcp_platform_request_total{${decodeLabels(labels)}} ${value}`);
  }

  return lines.join('\n') + '\n';
}

/** Test-only: drop all metric state. */
export function _resetMetrics(): void {
  toolCallsTotal.reset();
  toolDurationMs.reset();
  dispatchTotal.reset();
  platformRequestTotal.reset();
}
