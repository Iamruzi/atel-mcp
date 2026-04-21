import type { Request, Response } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig } from '../config.js';
import { PlatformChallengeOAuthProvider } from '../oauth/provider.js';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}

function resolvePublicUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\/+/, ''), ensureTrailingSlash(baseUrl));
}

export function createOAuthBridge() {
  const config = loadConfig();
  const provider = new PlatformChallengeOAuthProvider(config, config.publicBaseUrl);
  const mcpServerUrl = resolvePublicUrl(config.publicBaseUrl, 'mcp');
  const issuerUrl = new URL(config.oauthIssuerUrl);

  const authRouter = mcpAuthRouter({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    serviceDocumentationUrl: config.serviceDocumentationUrl ? new URL(config.serviceDocumentationUrl) : undefined,
    scopesSupported: config.defaultRemoteScopes,
    resourceServerUrl: mcpServerUrl,
    resourceName: config.oauthResourceName,
    clientRegistrationOptions: {
      rateLimit: config.disableRegisterRateLimit ? false : undefined,
    },
  });

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpServerUrl);
  const bearerMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl,
  });

  const interactiveAuthorizeHandler = async (req: Request, res: Response) => {
    const sessionId = String(req.query.session || '');
    const session = provider.getLoginSession(sessionId);
    if (!session) {
      res.status(410).send('Authorization session expired. Please restart the login flow from your MCP host.');
      return;
    }

    const statusUrl = resolvePublicUrl(
      config.publicBaseUrl,
      `oauth/authorize/interactive/status/${encodeURIComponent(sessionId)}`,
    ).href;

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ATEL MCP Authorization</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; }
    main { max-width: 640px; margin: 48px auto; padding: 32px; background: #111827; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { line-height: 1.6; color: #cbd5e1; }
    code { display: block; margin: 20px 0; padding: 18px; border-radius: 14px; background: #020617; color: #f8fafc; font-size: 28px; font-weight: 700; letter-spacing: 0.3em; text-align: center; }
    .muted { color: #94a3b8; font-size: 14px; }
    .pill { display: inline-block; padding: 6px 10px; border-radius: 999px; background: #1d4ed8; color: white; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  </style>
</head>
<body>
  <main>
    <span class="pill">ATEL MCP</span>
    <h1>Link your agent</h1>
    <p>Use your existing ATEL agent to finish authorization. Send the code below to your agent, or run <strong>atel auth &lt;code&gt;</strong> in a terminal already linked to your DID.</p>
    <code>${escapeHtml(session.challengeCode)}</code>
    <p id="status">Waiting for ATEL agent confirmation...</p>
    <p class="muted">This page polls the ATEL platform and will redirect back to your MCP host automatically after verification.</p>
  </main>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    const statusUrl = ${JSON.stringify(statusUrl)};
    async function tick() {
      const response = await fetch(statusUrl, { cache: 'no-store' });
      const payload = await response.json();
      if (payload.status === 'verified' && payload.redirectTo) {
        document.getElementById('status').textContent = 'Verified. Redirecting back to your MCP host...';
        window.location.href = payload.redirectTo;
        return;
      }
      if (payload.status === 'expired') {
        document.getElementById('status').textContent = 'Authorization expired. Restart the flow from your MCP host.';
        return;
      }
      setTimeout(tick, 2000);
    }
    setTimeout(tick, 1500);
  </script>
</body>
</html>`);
  };

  const interactiveStatusHandler = async (req: Request, res: Response) => {
    try {
      const sessionId = String(req.params.sessionId || '');
      res.json(await provider.getLoginSessionStatus(sessionId));
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    authRouter,
    bearerMiddleware,
    interactiveAuthorizeHandler,
    interactiveStatusHandler,
  };
}

