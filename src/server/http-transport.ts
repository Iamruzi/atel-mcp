import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from '../config.js';
import { createAtelMcpServer } from './mcp-server.js';
import { extractRequestMeta } from './request-meta.js';
import { createAuditSink } from '../audit/file-sink.js';
import { MVP_MANIFEST } from './manifest.js';
import { createOAuthBridge } from './oauth.js';
import { AtelMcpError } from '../contracts/errors.js';
import { parseDeclaredUserMode, parsePreferredRuntimeBackend } from './execution-routing.js';

const MCP_VERSION = '0.1.0';

function routePath(basePath: string, path: string) {
  if (!basePath) return path;
  if (path === '/') return basePath;
  return `${basePath}${path}`;
}

function buildAllowedHosts(config: ReturnType<typeof loadConfig>) {
  const allowedHosts = new Set<string>(['127.0.0.1', 'localhost']);
  allowedHosts.add(config.host);
  allowedHosts.add(new URL(config.publicBaseUrl).hostname);
  allowedHosts.add(new URL(config.oauthIssuerUrl).hostname);
  return [...allowedHosts].filter(Boolean);
}

export function buildServiceMetadata(config = loadConfig()) {
  return {
    name: 'atel-mcp',
    version: MCP_VERSION,
    transport: 'streamable-http',
    environment: config.environment,
    mcpPath: routePath(config.routeBasePath, '/mcp'),
    mcpUrl: `${config.publicBaseUrl}/mcp`,
    healthUrl: `${config.publicBaseUrl}/healthz`,
    metadataUrl: `${config.publicBaseUrl}/.well-known/atel-mcp.json`,
    oauthProtectedResourceUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    oauthAuthorizationServerUrl: `${config.oauthIssuerUrl}/.well-known/oauth-authorization-server`,
    platformBaseUrl: config.platformBaseUrl,
    registryBaseUrl: config.registryBaseUrl,
    relayBaseUrl: config.relayBaseUrl,
    defaultRemoteScopes: config.defaultRemoteScopes,
    architecture: {
      userEntryMode: config.userEntryMode,
      runtimeRole: config.runtimeRole,
      runtimeBackends: config.runtimeBackends,
      supportedUserModes: config.supportedUserModes,
      sourceOfTruth: 'platform',
    },
    toolGroups: Object.fromEntries(
      Object.entries(MVP_MANIFEST).map(([group, tools]) => [group, tools.map((tool) => tool.name)])
    ),
  };
}

export function createHttpTransportApp() {
  const config = loadConfig();
  const audit = createAuditSink(config);
  const app = createMcpExpressApp({ host: config.host, allowedHosts: buildAllowedHosts(config) });
  const oauth = createOAuthBridge();
  const route = (path: string) => routePath(config.routeBasePath, path);

  // Production should only trust the local reverse proxy chain by default.
  app.set('trust proxy', config.trustProxy);

  app.use(config.routeBasePath || '/', oauth.authRouter);
  app.get(route('/oauth/authorize/interactive'), oauth.interactiveAuthorizeHandler);
  app.get(route('/oauth/authorize/interactive/status/:sessionId'), oauth.interactiveStatusHandler);

  app.get(route('/'), async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: buildServiceMetadata(),
      usage: {
        transport: `POST JSON-RPC requests to ${route('/mcp')}`,
        auth: 'Unauthenticated requests receive OAuth metadata through WWW-Authenticate.',
      },
    });
  });

  app.get(route('/healthz'), async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      name: 'atel-mcp',
      version: MCP_VERSION,
      environment: config.environment,
      platformBaseUrl: config.platformBaseUrl,
      publicBaseUrl: config.publicBaseUrl,
      oauthIssuerUrl: config.oauthIssuerUrl,
    });
  });

  app.get(route('/.well-known/atel-mcp.json'), async (_req: Request, res: Response) => {
    res.json(buildServiceMetadata());
  });

  app.post(route('/mcp'), oauth.bearerMiddleware, async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    const server = await createAtelMcpServer({
      ...meta,
      preferredRuntimeBackend: parsePreferredRuntimeBackend(meta.preferredRuntimeBackend),
      declaredUserMode: parseDeclaredUserMode(meta.declaredUserMode),
      audit,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('[atel-mcp] request failed', {
        requestId: meta.requestId,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AtelMcpError ? error.code : undefined,
        details: error instanceof AtelMcpError ? error.details : undefined,
      });
      if (!res.headersSent) {
        if (error instanceof AtelMcpError) {
          const status = error.code === 'UNAUTHORIZED' ? 401
            : error.code === 'FORBIDDEN' ? 403
            : error.code === 'INVALID_INPUT' ? 400
            : error.code === 'NOT_FOUND' ? 404
            : error.code === 'UPSTREAM_ERROR' ? 502
            : 500;
          res.status(status).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error.message,
              data: {
                atelCode: error.code,
                details: error.details ?? null,
                requestId: meta.requestId,
              },
            },
            id: null,
          });
        } else {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
      }
    }
  });

  app.get(route('/mcp'), oauth.bearerMiddleware, async (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  });

  app.delete(route('/mcp'), oauth.bearerMiddleware, async (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  });

  return app;
}
