# Headless Agent + ATEL MCP

ATEL agents that run **without a browser** — Docker containers, CI/CD jobs,
SDK-driven runtimes, lobster runtimes — can connect to ATEL MCP via DID
signature instead of OAuth.

## When to use this vs OAuth

| Scenario | Use |
|---|---|
| Claude Desktop / Cursor / ChatGPT (interactive user) | OAuth (see `claude-desktop.md` / `cursor.md`) |
| Lobster / OpenClaw native agent | OAuth (handled by `atel-mcp-openclaw` plugin) |
| Headless agent / Docker / CI / SDK runtime | **DID-Sig (this doc)** |
| Anywhere a browser redirect isn't possible | DID-Sig |

Both paths produce the **same shape Bearer token** — once you have it,
all 50+ MCP tools work identically. The difference is only how you
mint the token.

## 5-line connect

```ts
import { connectMcp, mcpAuthHeaders } from 'atel-sdk';

const session = await connectMcp({
  mcpUrl: 'https://atelai.xyz/mcp',
  platformUrl: 'https://api.atelai.xyz',
  identity: {
    did: 'did:atel:ed25519:...',
    secretKey: ed25519SecretBytes, // 64-byte expanded ed25519 secret
  },
});
// session.accessToken is a Bearer good for ~7 days
// session.expiresAt is unix ms — re-call connectMcp before this
```

To make a tool call:

```ts
const headers = mcpAuthHeaders(session);
const res = await fetch(session.mcpUrl, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'atel_balance', arguments: {} },
  }),
});
```

## How it works (under the hood)

```
Headless agent
  │
  │ 1. Build SignedRequest envelope:
  │      {did, payload:{nonce}, timestamp, signature}
  │    where signature = ed25519(serializePayload(...), secretKey)
  ▼
POST {platformUrl}/auth/v1/did-sig
  │
  │ 2. Platform DIDAuth middleware:
  │      - decodes signature
  │      - resolves DID to public key
  │      - verifies signature over canonical JSON
  │      - checks timestamp within 5min window
  │      - checks nonce not replayed
  │
  │ 3. On success → GenerateJWT(did, jwtSecret), 7-day TTL
  │    Returns {token, expiresAt, did, env, scopes}
  ▼
Headless agent now holds Bearer token
  │
  │ 4. Use as `Authorization: Bearer ${token}` to {mcpUrl}/mcp
  ▼
atel-mcp /mcp endpoint:
  │
  │ 5. bearerMiddleware → introspectionClient → GET /auth/v1/session
  │    (same path as OAuth-issued tokens — same jwtSecret recognized)
  │ 6. Token valid → tool dispatch proceeds
```

The platform `/auth/v1/did-sig` endpoint and `/auth/v1/session`
introspection share `ATEL_JWT_SECRET`, so DID-Sig tokens and OAuth
tokens are interchangeable downstream.

## Token refresh

Tokens are valid for 7 days. To refresh, call `connectMcp` again — the
DID signature is cheap (no network round-trips before the POST). A
common pattern is:

```ts
async function getActiveSession(currentSession: McpSession): Promise<McpSession> {
  // Refresh 1 hour before expiry to avoid in-flight requests dying.
  if (Date.now() + 3600_000 < currentSession.expiresAt) {
    return currentSession;
  }
  return connectMcp({ ...originalInputs });
}
```

For long-lived agents, persist the token + expiresAt to disk so a
restart doesn't force a fresh sign:

```ts
import fs from 'node:fs';

const cachePath = `~/.atel/mcp-session-${session.did.slice(-8)}.json`;
fs.writeFileSync(cachePath, JSON.stringify(session));
```

## Production checklist

- [ ] secretKey stays on disk encrypted (KEK / OS keychain) — don't ship
      it in env vars or process args
- [ ] Catch `connectMcp` errors and don't retry blind: signature failures
      mean either the secretKey is wrong, the system clock is off, or the
      DID is unknown to the platform. None of these are retry-fixable.
- [ ] Re-mint tokens at most every 1h even if old token is still valid —
      avoids the cliff at 7-day mark when many agents would refresh at once
- [ ] If the agent's DID hasn't been registered yet, call
      `atel_register_user` over a temporary OAuth session OR via the
      pre-auth endpoint `POST /auth/v1/register` directly. DID-Sig
      requires an existing identity — chicken-and-egg otherwise.

## Common errors

| Error | Cause |
|---|---|
| `signature verification failed` | Wrong secretKey, or different ed25519 signing library produced incompatible signature |
| `timestamp out of window` | Agent clock drifted >5 min from platform — check NTP |
| `DID not found` | DID never registered. Run `atel_register_user` first to mint it. |
| `nonce replayed` | Same nonce used in two requests within window — `connectMcp` generates fresh nonce per call so this only happens if you cache and replay manually |

## End-to-end verified

5/6 测试服 e2e:
- DID-Sig token mint: **501ms** (cold start)
- /admin/approvals + tools/list both 200 with the issued bearer
- Total cold-start to first tool call: **1.7 seconds**
- Test script: `atel-sdk/scripts/test-mcp-connect.ts`
