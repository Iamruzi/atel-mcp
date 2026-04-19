import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from '../config.js';
import { createAtelMcpServer } from './mcp-server.js';
import { extractRequestMeta } from './request-meta.js';
import { createAuditSink } from '../audit/file-sink.js';

export function createHttpTransportApp() {
  const config = loadConfig();
  const audit = createAuditSink(config);
  const app = createMcpExpressApp({ host: config.host });

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
