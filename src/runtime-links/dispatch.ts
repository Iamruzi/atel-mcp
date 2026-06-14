/**
 * Linked-runtime forwarding for OpenClaw / 龙虾 users.
 *
 * When a hosted DID has a runtime-link bound (see store.ts), tool calls
 * for that DID are forwarded to the agent runtime registered by 龙虾
 * instead of being executed locally. This is the production path for the
 * majority of ATEL users.
 *
 * Lives behind config.runtimeLinksEnabled (default on) +
 * executionPlan.selectedBackend === 'linked-runtime' (only when the DID
 * actually has a link bound to a linked-runtime backend).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AtelMcpError } from '../contracts/errors.js';

interface LinkedRuntimeInvokeArgs {
  endpoint: string;
  authToken?: string;
  toolName: string;
  input?: unknown;
  requestId?: string;
  idempotencyKey?: string;
}

function parseTextPayload(result: unknown): unknown {
  const text = Array.isArray((result as { content?: Array<{ type?: string; text?: string }> })?.content)
    ? (result as { content: Array<{ type?: string; text?: string }> }).content.find((item) => item.type === 'text')?.text
    : undefined;

  if (!text) return result;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function invokeLinkedRuntimeTool(args: LinkedRuntimeInvokeArgs): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(args.endpoint), {
    requestInit: {
      headers: {
        ...(args.authToken ? { authorization: `Bearer ${args.authToken}` } : {}),
        ...(args.requestId ? { 'x-request-id': args.requestId } : {}),
        ...(args.idempotencyKey ? { 'idempotency-key': args.idempotencyKey } : {}),
        'x-atel-runtime-backend': 'platform-hosted',
        'x-atel-user-mode': 'mcp-plus-runtime',
        'x-atel-runtime-hop': '1',
      },
    },
  });

  const client = new Client({ name: 'atel-mcp-linked-runtime', version: '0.1.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: args.toolName, arguments: (args.input as Record<string, unknown> | undefined) ?? {} });
    return parseTextPayload(result);
  } catch (error) {
    throw new AtelMcpError('UPSTREAM_ERROR', 'The linked runtime could not complete this request.', {
      endpoint: args.endpoint,
      toolName: args.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.close().catch(() => {});
  }
}
