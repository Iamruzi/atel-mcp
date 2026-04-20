import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from '../config.js';
import { createAtelMcpServer } from './mcp-server.js';
import { extractRequestMeta } from './request-meta.js';
import { createAuditSink } from '../audit/file-sink.js';
import { MVP_MANIFEST } from './manifest.js';

const MCP_VERSION = '0.1.0';

function buildServiceMetadata() {
  const config = loadConfig();
  const baseHttpUrl = `http://${config.host}:${config.port}`;
  return {
    name: 'atel-mcp',
    version: MCP_VERSION,
    transport: 'streamable-http',
    environment: config.environment,
    mcpPath: '/mcp',
    mcpUrl: `${baseHttpUrl}/mcp`,
    healthUrl: `${baseHttpUrl}/healthz`,
    metadataUrl: `${baseHttpUrl}/.well-known/atel-mcp.json`,
    platformBaseUrl: config.platformBaseUrl,
    registryBaseUrl: config.registryBaseUrl,
    relayBaseUrl: config.relayBaseUrl,
    defaultRemoteScopes: config.defaultRemoteScopes,
    toolGroups: Object.fromEntries(
      Object.entries(MVP_MANIFEST).map(([group, tools]) => [group, tools.map((tool) => tool.name)])
    ),
  };
}

export function createHttpTransportApp() {
  const config = loadConfig();
  const audit = createAuditSink(config);
  const app = createMcpExpressApp({ host: config.host });

  app.get('/', async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: buildServiceMetadata(),
      usage: {
        transport: 'POST JSON-RPC requests to /mcp',
        auth: 'Send Authorization: Bearer <ATEL access token>',
      },
    });
  });

  app.get('/healthz', async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      name: 'atel-mcp',
      version: MCP_VERSION,
      environment: config.environment,
      platformBaseUrl: config.platformBaseUrl,
    });
  });

  app.get('/.well-known/atel-mcp.json', async (_req: Request, res: Response) => {
    res.json(buildServiceMetadata());
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    const server = await createAtelMcpServer({ ...meta, audit });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('[atel-mcp] request failed', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get('/mcp', async (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  });

  app.delete('/mcp', async (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  });

  return app;
}
