# ATEL MCP Domain Cutover Checklist

This document is the operator checklist for moving ATEL MCP from a temporary host such as `sslip.io` to a real public domain such as `mcp.atelai.org`.

Use it when you want:

- a stable production URL
- a proper TLS certificate on your own domain
- a cleaner OAuth issuer
- user docs that do not point to a temporary hostname

## Target State

Recommended final shape:

```text
ATEL_MCP_BASE_URL=https://mcp.atelai.org
MCP endpoint=https://mcp.atelai.org/mcp
OAuth issuer=https://mcp.atelai.org
```

The important rule is simple:

- the public base URL
- the OAuth issuer URL
- the resource metadata URL
- the actual `/mcp` endpoint

must all agree on the same public host.

Do not mix:

- one host in docs
- another host in OAuth issuer
- another host in reverse proxy

That is how you get broken OAuth and confusing client behavior.

## Layer 1: DNS

Before touching the app, make sure DNS is correct.

Checklist:

1. Create a DNS record such as `mcp.atelai.org`.
2. Point it to the public machine that serves ATEL MCP.
3. Wait until the record resolves from an external network.
4. Verify both the A record and the final host match what users will type.

Quick check:

```bash
dig mcp.atelai.org
nslookup mcp.atelai.org
```

## Layer 2: TLS Certificate

Remote MCP with OAuth should be exposed over HTTPS.

Checklist:

1. Issue a TLS certificate for the final domain.
2. Install the certificate in nginx or your edge layer.
3. Confirm the browser trusts the certificate.
4. Confirm the host answers on `443`.

Quick check:

```bash
curl -I https://mcp.atelai.org
```

If the certificate is wrong, fix that first. Do not continue to OAuth debugging until TLS is correct.

## Layer 3: Reverse Proxy

The Node server can stay on loopback. The public host should be served by nginx or another reverse proxy.

Recommended shape:

- public HTTPS host on `443`
- proxy to local Node process on `127.0.0.1:8787`
- preserve `Host`
- set `X-Forwarded-Proto https`

Important:

- if the public host is `mcp.atelai.org`, nginx must actually answer for `mcp.atelai.org`
- if you use a path prefix, the same prefix must be reflected in `ATEL_MCP_PUBLIC_BASE_URL` and `ATEL_MCP_OAUTH_ISSUER_URL`

## Layer 4: Application Environment

This is the most important part.

On the server, update the env file so the MCP server publishes the final public URL.

Example final values:

```bash
ATEL_PLATFORM_BASE_URL=https://api.atelai.org
ATEL_REGISTRY_BASE_URL=https://api.atelai.org
ATEL_RELAY_BASE_URL=https://api.atelai.org
ATEL_MCP_PUBLIC_BASE_URL=https://mcp.atelai.org
ATEL_MCP_OAUTH_ISSUER_URL=https://mcp.atelai.org
ATEL_MCP_URL=http://127.0.0.1:8787/mcp
```

If you use a prefixed route such as `/atel-mcp`, then these must match that exact prefix:

```bash
ATEL_MCP_PUBLIC_BASE_URL=https://mcp.atelai.org/atel-mcp
ATEL_MCP_OAUTH_ISSUER_URL=https://mcp.atelai.org/atel-mcp
ATEL_MCP_URL=http://127.0.0.1:8787/atel-mcp/mcp
```

Do not mix:

- root-level public URL
- prefixed issuer URL

The app explicitly checks for mismatched base paths.

## Layer 5: Restart and Basic Health Check

After changing env values:

1. restart the MCP service
2. confirm health
3. confirm public metadata

Example:

```bash
./scripts/stop-release-candidate.sh
./scripts/run-release-candidate.sh ./.env.release.local
curl -fsS http://127.0.0.1:8787/healthz
```

The health payload should show:

- `publicBaseUrl` equals your final public domain
- `oauthIssuerUrl` equals your final public domain
- `platformBaseUrl` equals the intended upstream environment

## Layer 6: Public Metadata Validation

These endpoints must be correct before any client test matters.

Check:

```bash
curl -fsS https://mcp.atelai.org/.well-known/oauth-authorization-server
curl -fsS https://mcp.atelai.org/.well-known/oauth-protected-resource/mcp
curl -sS -D - -o /dev/null -X POST https://mcp.atelai.org/mcp
```

What you want to see:

- issuer points to the final domain
- token and authorization endpoints point to the final domain
- protected resource points to the final domain
- unauthenticated `/mcp` returns `401` with correct OAuth metadata hints

## Layer 7: Real OAuth Smoke

Do not stop at metadata checks.

Run a real OAuth flow from another machine:

1. register client
2. authorize
3. verify on ATEL platform
4. exchange token
5. call `initialize`
6. call `tools/list`

If these pass, the cutover is real.

If metadata passes but OAuth fails, the usual causes are:

- wrong issuer
- wrong host in redirect chain
- wrong platform upstream
- stale reverse proxy config

## Layer 8: User Docs

After the technical cutover is confirmed, update user-facing docs.

Files to update:

- `README.md`
- `docs/clients/getting-started.md`
- `docs/clients/getting-started.zh.md`
- `docs/clients/claude-code.md`
- `docs/clients/claude-code.zh.md`
- `docs/clients/codex.md`
- `docs/clients/codex.zh.md`
- `docs/clients/openclaw.md`
- `docs/clients/openclaw.zh.md`

Recommended rule:

- keep `${ATEL_MCP_BASE_URL}` as the canonical documentation format
- update only the example host when the domain changes

That way, future host changes stay cheap.

## Layer 9: Old Host Cleanup

After the new domain is stable:

1. remove old temporary references from docs
2. remove temporary nginx server blocks if no longer needed
3. remove temporary certificates if they are no longer used
4. make sure OAuth metadata does not still advertise the old host

Do not leave the old host half-alive unless you intentionally want a compatibility window.

## Recommended Cutover Order

Use this order:

1. DNS
2. TLS
3. reverse proxy
4. application env
5. service restart
6. metadata validation
7. real OAuth smoke
8. docs update
9. old host cleanup

## Final Acceptance Standard

The cutover is only done when all of these are true:

- browser opens the new host over HTTPS without certificate warning
- health endpoint reports the final public domain
- OAuth metadata publishes the final public domain
- resource metadata publishes the final public domain
- real OAuth flow succeeds
- `initialize` succeeds
- `tools/list` succeeds
- user docs point to the right example host

If any one of these is false, the cutover is not complete.
