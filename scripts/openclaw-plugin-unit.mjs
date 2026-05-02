#!/usr/bin/env node
// Lightweight unit-level validation for the OpenClaw plugin rewrite (T6.4).
//
// What this proves:
//   1. Plugin imports cleanly (no syntax errors, no missing deps)
//   2. createAtelMcpTool returns a valid OpenClaw tool descriptor
//   3. Calling action=call routes through MCP (NOT through the deleted
//      LOCAL_SIGNED_TOOLS bypass) — verified by capturing fetch
//   4. DID-Sig auth path: plugin POSTs envelope to /auth/v1/did-sig
//      before calling MCP /mcp endpoint
//
// What this does NOT prove:
//   - End-to-end against a live MCP server / platform (that's the
//     existing scripts/smoke-openclaw-plugin-{order,dispute}.mjs which
//     need a deployed server). We rely on those for true integration.
//
// Run: node scripts/openclaw-plugin-unit.mjs

import { createAtelMcpTool } from "../openclaw-plugin/atel-mcp/src/tool.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import nacl from "../openclaw-plugin/atel-mcp/node_modules/tweetnacl/nacl.js";

let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ": " + detail : ""}`);
  }
}

// ─── Setup: temp identity + temp token cache ─────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atel-mcp-plugin-test-"));
const identityPath = path.join(tmpDir, "identity.json");
const tokenCachePath = path.join(tmpDir, "did-sig-cache.json");

const keypair = nacl.sign.keyPair();
const did = "did:atel:ed25519:" + Buffer.from(keypair.publicKey).toString("base64");
fs.writeFileSync(
  identityPath,
  JSON.stringify({
    did,
    publicKey: Buffer.from(keypair.publicKey).toString("hex"),
    secretKey: Buffer.from(keypair.secretKey).toString("hex"),
  }),
);

// Use the env override for cache path so each run is isolated.
process.env.ATEL_MCP_TOKEN_CACHE_PATH = tokenCachePath;

const fakeRuntime = {
  config: {
    loadConfig: () => ({
      plugins: {
        entries: {
          "atel-mcp": {
            config: {
              serverBaseUrl: "https://mcp.test.local",
              platformBaseUrl: "https://api.test.local",
              identityPath,
              // No sdkDistPath / naclPath → falls back to local serializer + bundled tweetnacl.
            },
          },
        },
      },
    }),
  },
};

// ─── Test 1: tool descriptor shape ───────────────────────────────────

console.log("\n[1] tool descriptor shape");
const tool = createAtelMcpTool(fakeRuntime);
check("name is atel_mcp", tool.name === "atel_mcp");
check("has execute fn", typeof tool.execute === "function");
check("parameters action enum has list+call", JSON.stringify(tool.parameters?.properties?.action?.enum) === '["list","call"]');
check("parameters required includes action", Array.isArray(tool.parameters?.required) && tool.parameters.required.includes("action"));

// ─── Test 2: fetch capture — DID-Sig + MCP routing ────────────────────

console.log("\n[2] DID-Sig auth + MCP routing");
const fetchCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  if (String(url).includes("/auth/v1/did-sig")) {
    return new Response(JSON.stringify({
      token: "fake-bearer-token-from-did-sig",
      did,
      sessionId: `did-sig:${did}`,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (String(url).endsWith("/mcp")) {
    // First call (initialize) returns a session id; second call (tools/call) returns the actual result.
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "fake-session-1" },
      });
    }
    if (body.method === "tools/call") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true, fromMcp: true }) }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  }
  return new Response("{}", { status: 404 });
};

try {
  const result = await tool.execute("test-call-1", {
    action: "call",
    tool: "atel_order_create",
    args: { executorDid: "did:atel:ed25519:executor", capabilityType: "code_gen", description: "test", priceUsdc: 0 },
  });

  check("execute returns content array", Array.isArray(result?.content) && result.content.length > 0);
  check("execute does not error", result?.isError !== true, JSON.stringify(result));

  // Verify the routing: should have hit /auth/v1/did-sig FIRST, then /mcp at least twice (initialize + tools/call).
  const didSigCalls = fetchCalls.filter((c) => c.url.includes("/auth/v1/did-sig"));
  const mcpCalls = fetchCalls.filter((c) => c.url.endsWith("/mcp"));

  check("called /auth/v1/did-sig exactly once", didSigCalls.length === 1, `got ${didSigCalls.length}`);
  check("called /mcp at least 2 times (initialize + tools/call)", mcpCalls.length >= 2, `got ${mcpCalls.length}`);

  // Critical: NO direct calls to /trade/v1/order or other platform business endpoints.
  // The whole point of T6.4 is that order_create should now go THROUGH MCP, not bypass it.
  const platformDirectCalls = fetchCalls.filter((c) => /\/trade\/v1\/(order|dispute)/.test(c.url));
  check(
    "atel_order_create does NOT call /trade/v1/order directly (no LOCAL_SIGNED_TOOLS bypass)",
    platformDirectCalls.length === 0,
    `unexpected direct calls: ${JSON.stringify(platformDirectCalls.map((c) => c.url))}`,
  );

  // DID-Sig envelope shape sanity: did + payload + timestamp + signature
  const didSigBody = JSON.parse(didSigCalls[0].init.body);
  check("envelope has did", didSigBody.did === did);
  check("envelope has payload with nonce", typeof didSigBody.payload?.nonce === "string" && didSigBody.payload.nonce.length > 0);
  check("envelope has timestamp (RFC3339)", typeof didSigBody.timestamp === "string" && /\d{4}-\d{2}-\d{2}T/.test(didSigBody.timestamp));
  check("envelope has base64 signature", typeof didSigBody.signature === "string" && didSigBody.signature.length > 0);

  // MCP request used the bearer from DID-Sig
  const mcpAuthHeader = mcpCalls[0].init.headers?.authorization;
  check("MCP request used bearer from DID-Sig", mcpAuthHeader === "Bearer fake-bearer-token-from-did-sig");
} finally {
  globalThis.fetch = originalFetch;
}

// ─── Test 3: persisted token cache reused on second exchange ──────────

console.log("\n[3] persisted token cache");
// fresh tool instance → new WeakMap → should hit persisted cache from above
const fetchCalls2 = [];
globalThis.fetch = async (url, init) => {
  fetchCalls2.push({ url: String(url) });
  if (String(url).endsWith("/mcp")) {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-2" },
      });
    }
    if (body.method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
  }
  return new Response("{}", { status: 404 });
};

try {
  const tool2 = createAtelMcpTool(fakeRuntime);
  await tool2.execute("test-list-1", { action: "list" });
  const didSigCalls = fetchCalls2.filter((c) => c.url.includes("/auth/v1/did-sig"));
  check("did NOT re-exchange DID-Sig (cache hit)", didSigCalls.length === 0, `unexpected ${didSigCalls.length} re-exchanges`);
} finally {
  globalThis.fetch = originalFetch;
}

// ─── Test 4: cleanup ──────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
