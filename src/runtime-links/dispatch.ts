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
