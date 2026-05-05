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
import { renderMetrics } from './metrics.js';
import { createApprovalStore } from '../approval/store.js';

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

  // T8.1 — Prometheus exposition. Cardinality is bounded (tool name +
  // status enum + collapsed platform path).
  app.get(route('/metrics'), async (_req: Request, res: Response) => {
    res.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  app.get(route('/.well-known/atel-mcp.json'), async (_req: Request, res: Response) => {
    res.json(buildServiceMetadata());
  });

  // ─────── Approval admin endpoints (T5.1/T5.2/T5.4) ────────────────────
  //
  // Why these exist alongside the in-process gate: the gate files PENDING
  // approvals when a high-risk tool runs, but only the operator CLI could
  // approve them until now. These endpoints let:
  //   - atel-portal show a queue of pending approvals (GET /admin/approvals)
  //   - atel-tg-bot push inline keyboard buttons that drive
  //     POST /admin/approvals/:id/{approve,deny,cancel}
  //
  // Auth model: bearerMiddleware verifies the OAuth token; we cross-check
  // that req.auth.extra.did matches:
  //   - the listing DID (list / get) — DID can only see their own queue
  //   - the approval's owner DID (cancel) — only the originator can cancel
  //   - one of ATEL_MCP_OPERATOR_DIDS (approve / deny) — only operators
  //     can grant approvals; the originator approving their own action
  //     would defeat the gate
  if (config.approvalLogPath) {
    const approvalStore = createApprovalStore(config.approvalLogPath);
    const operatorDids = new Set(
      (process.env.ATEL_MCP_OPERATOR_DIDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    // Service-token bypass for tg-bot: tg-bot doesn't hold per-user OAuth
    // tokens (it auths users via Telegram), so it forwards user actions
    // with X-Atel-Service-Token (shared secret) + X-Atel-Acting-DID (the
    // user's DID). Both must be present and the token must match
    // ATEL_MCP_SERVICE_TOKEN. When the token is missing or empty,
    // service auth is OFF — admin endpoints accept only OAuth bearer.
    const serviceToken = (process.env.ATEL_MCP_SERVICE_TOKEN || '').trim();

    // Hybrid auth middleware. The MCP SDK's bearerMiddleware rejects
    // requests without `Authorization: Bearer ...` BEFORE our handler
    // runs, which kills the service-token path. So for /admin/approvals/*
    // we run a custom middleware that accepts EITHER:
    //   - OAuth bearer (delegates to oauth.bearerMiddleware)
    //   - X-Atel-Service-Token + X-Atel-Acting-DID (sets req.auth.extra.did)
    // The handler then reads callerDid(req) which works for both paths.
    function adminAuthMiddleware(req: Request, res: Response, next: () => void) {
      // Service-token path (preferred for tg-bot / internal services).
      if (serviceToken) {
        const provided = (req.header('x-atel-service-token') || '').trim();
        const actingDid = (req.header('x-atel-acting-did') || '').trim();
        if (provided && actingDid && provided === serviceToken) {
          // Stamp synthetic AuthInfo so callerDid() finds it. Fields
          // mirror what the real OAuth path produces (clientId / scopes
          // are best-effort placeholders since this is a service call,
          // not a per-user OAuth session).
          (req as Request & { auth?: unknown }).auth = {
            token: 'service-token',
            clientId: 'atel-mcp-service',
            scopes: ['identity.read', 'orders.read', 'orders.write'],
            extra: { did: actingDid },
          };
          next();
          return;
        }
      }
      // Fall through to OAuth bearer.
      oauth.bearerMiddleware(req as never, res as never, next as never);
    }

    function callerDid(req: Request): string | null {
      const auth = (req as Request & { auth?: { extra?: { did?: string } } }).auth;
      return auth?.extra?.did ?? null;
    }

    function isOperator(did: string): boolean {
      return operatorDids.has(did);
    }

    app.get(route('/admin/approvals'), adminAuthMiddleware, async (req: Request, res: Response) => {
      const did = callerDid(req);
      if (!did) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      try {
        const list = await approvalStore.list(did);
        res.json({ count: list.length, approvals: list });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: 'list failed', detail: message });
      }
    });

    app.get(route('/admin/approvals/:id'), adminAuthMiddleware, async (req: Request, res: Response) => {
      const did = callerDid(req);
      if (!did) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      try {
        const record = await approvalStore.get(String(req.params.id ?? ""));
        if (!record) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        // Non-operators only see their own approvals.
        if (record.did !== did && !isOperator(did)) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        res.json(record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: 'get failed', detail: message });
      }
    });

    app.post(route('/admin/approvals/:id/approve'), adminAuthMiddleware, async (req: Request, res: Response) => {
      const did = callerDid(req);
      if (!did) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      if (!isOperator(did)) {
        res.status(403).json({
          error: 'operator only',
          hint: 'Only DIDs listed in ATEL_MCP_OPERATOR_DIDS can approve. The originator cannot approve their own action.',
        });
        return;
      }
      try {
        const { operatorApprove } = await import('../approval/gate.js');
        const next = await operatorApprove(config.approvalLogPath!, String(req.params.id ?? ""), did);
        res.json(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: 'approve failed', detail: message });
      }
    });

    app.post(route('/admin/approvals/:id/deny'), adminAuthMiddleware, async (req: Request, res: Response) => {
      const did = callerDid(req);
      if (!did) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      if (!isOperator(did)) {
        res.status(403).json({ error: 'operator only' });
        return;
      }
      const reason = String((req.body as { reason?: string } | undefined)?.reason ?? '').slice(0, 500);
      try {
        const { operatorDeny } = await import('../approval/gate.js');
        const next = await operatorDeny(config.approvalLogPath!, String(req.params.id ?? ""), reason || 'no reason given');
        res.json(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: 'deny failed', detail: message });
      }
    });

    app.post(route('/admin/approvals/:id/cancel'), adminAuthMiddleware, async (req: Request, res: Response) => {
      const did = callerDid(req);
      if (!did) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const reason = String((req.body as { reason?: string } | undefined)?.reason ?? '').slice(0, 500);
      try {
        const { ownerCancel } = await import('../approval/gate.js');
        const next = await ownerCancel(config.approvalLogPath!, String(req.params.id ?? ""), did, reason || 'no reason given');
        res.json(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: 'cancel failed', detail: message });
      }
    });
  }

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
