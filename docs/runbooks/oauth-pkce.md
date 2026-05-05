# OAuth + PKCE in atel-mcp

T9.1 deliverable. Written 2026-05-06 to settle a recurring confusion: "is
the OAuth flow standards-compliant or self-cooked?"

## TL;DR

The OAuth authorization-code flow with PKCE (RFC 7636) **is** standards-
compliant. The "platform challenge code" mechanism is a separate UX layer
on top of standard OAuth — it's how the user proves identity (replaces
password / 2FA), not how the host client proves it owns the auth code
(that's PKCE).

## The two challenges (don't conflate them)

1. **PKCE `code_challenge` / `code_verifier`** — RFC 7636. Client-side
   secret that proves the same client that started the authorization flow
   is the one redeeming the authorization code. Defends against auth-code
   theft. Validated by the MCP SDK's express layer
   (`skipLocalPkceValidation = false`).

2. **Platform challenge code** (e.g. `A1B2C3`) — ATEL-specific. Shown to
   the user on the interactive authorize page; user runs `atel auth A1B2C3`
   on their already-authenticated agent to confirm "yes, I'm starting an
   MCP session". Replaces username/password — the user authenticates by
   demonstrating they control their DID, not by typing a secret.

These are independent. PKCE proves the host client owns the auth code.
Platform challenge proves the human owns the DID.

## Where each one lives in the code

```
src/oauth/provider.ts
├── authorize()
│   ├── reads params.codeChallenge (PKCE — from client)
│   ├── requests platform challenge code (DID-Sig UX)
│   └── stores BOTH on the session
├── challengeForAuthorizationCode()
│   └── returns stored PKCE codeChallenge to the SDK for S256 verification
├── exchangeAuthorizationCode()
│   └── (does NOT verify codeVerifier — SDK already did that)
└── skipLocalPkceValidation = false
    └── tells SDK "yes, validate PKCE for me"
```

## How the round-trip works

```
Host (Cursor / Claude Desktop / OpenClaw)
  │
  │ 1. Generates code_verifier (random 43-128 chars)
  │    Computes code_challenge = base64url(sha256(code_verifier))
  │
  │ 2. GET /authorize?
  │      code_challenge=...&
  │      code_challenge_method=S256&
  │      ...
  ▼
atel-mcp /authorize handler
  │
  │ 3. Stores codeChallenge in session
  │ 4. Requests platform challenge code (e.g. A1B2C3)
  │ 5. Redirects host to interactive page that shows A1B2C3
  ▼
User
  │
  │ 6. Sees A1B2C3 on screen, runs `atel auth A1B2C3` on their agent
  │ 7. Agent calls /auth/v1/verify with DID-Sig over A1B2C3
  │ 8. Platform marks challenge verified → returns access token
  ▼
atel-mcp polling
  │
  │ 9. Mints OAuth authorization code, stores against codeChallenge
  │ 10. Redirects host back with ?code=... (standard OAuth)
  ▼
Host (back at its redirect URI)
  │
  │ 11. POST /token grant_type=authorization_code&
  │       code=...&code_verifier=ORIGINAL_VERIFIER
  ▼
atel-mcp /token handler (MCP SDK)
  │
  │ 12. SDK calls challengeForAuthorizationCode(code) → gets codeChallenge
  │ 13. SDK computes base64url(sha256(code_verifier))
  │ 14. SDK compares to codeChallenge → must match (FAIL → reject)
  │ 15. SDK calls exchangeAuthorizationCode → returns access_token
  ▼
Host has access_token — calls /mcp with Bearer auth.
```

The PKCE pieces (steps 1-2, 11-14) are exactly RFC 7636. The platform
challenge pieces (steps 4-9) are the user-confirm UX — orthogonal to PKCE.

## Verifying the contract isn't broken

`src/tests/oauth-provider.test.ts` pins:

1. **Round-trip persistence** — `codeChallenge` from `authorize()` survives
   to `challengeForAuthorizationCode()` byte-for-byte.
2. **`skipLocalPkceValidation` must stay false** — flipping it without
   also implementing server-side S256 hashing in `exchangeAuthorizationCode`
   would silently disable PKCE. The test fails the build if anyone flips it.

End-to-end smoke: `src/dev/smoke-remote-oauth.ts` exercises the whole
flow against the production server.

## Common questions

**Q: Why not just use a username/password OAuth provider like Auth0?**
A: ATEL identity is a DID + ed25519 secretKey, self-custodied. There's no
"password" we could ask for — the agent signs a challenge with the
secretKey instead. The platform challenge code is the thing the user can
say out loud to bridge a host (a fresh Cursor instance) to their existing
agent without re-typing the secretKey.

**Q: Could we allow `code_challenge_method=plain`?**
A: No. The MCP SDK only accepts S256. Don't loosen this — `plain` defeats
the point of PKCE on a browser-redirect flow.

**Q: What about Dynamic Client Registration?**
A: Implemented via `/register` in the SDK's auth router. Clients are
ephemeral (in-memory `InMemoryOAuthClientsStore`); each MCP host registers
once on first connect. If the MCP server restarts, hosts re-register
transparently.

**Q: Where do I add a new scope?**
A: `src/contracts/scopes.ts` — drives both the manifest published to
hosts and the per-tool scope checks. Adding a scope here also requires
updating `ATEL_REMOTE_MCP_SCOPES` on the platform side so introspection
returns it.
