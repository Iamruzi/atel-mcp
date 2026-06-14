// Periodic heartbeat to platform's /registry/v1/heartbeat so the agent
// stays online=TRUE in platform.agents. Without this, the platform's
// 1-min sweep marks last_seen-stale agents offline after 3 min of
// silence — which makes order routing skip them as executors.
//
// Why heartbeat from the listener process (and not from the cron-driven
// agent prompt): the agent only fires when there's an event to process,
// so a quiet inbox would let last_seen go stale anyway. The listener is
// always alive; using it as the heartbeat surface avoids depending on
// LLM ticks for liveness.
//
// Why DID-Sig directly (and not via MCP server): the heartbeat endpoint
// uses the platform's DIDAuth middleware which expects the SignedRequest
// envelope shape, not the JWT bearer that MCP uses. Plugin already has
// the secret key loaded for the existing DID-Sig token exchange, so we
// reuse the same signing primitives here.

import fs from "node:fs";
import crypto from "node:crypto";

let timer = null;
let nacl = null;

function decodeSecretKey(raw) {
  if (typeof raw === "string" && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (typeof raw === "string") {
    return Buffer.from(raw, "base64");
  }
  throw new Error("Unsupported secretKey format in identity.json");
}

function serializePayload(obj) {
  // Sorted-key JSON, matches platform's auth.SerializePayload + SDK's
  // serializePayload. Verified in test (M0 verify request).
  return JSON.stringify(obj, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

async function loadNacl() {
  if (nacl) return nacl;
  // Prefer the local node_modules copy bundled with the plugin so we
  // don't depend on lobster-side filesystem layout.
  const mod = await import("tweetnacl");
  nacl = mod.default ?? mod;
  return nacl;
}

async function fireHeartbeat(platformBaseUrl, identityPath) {
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const secretKey = decodeSecretKey(identity.secretKey);
  const t = await loadNacl();

  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = { nonce };
  const signable = serializePayload({ payload, did: identity.did, timestamp });
  const signature = Buffer.from(t.sign.detached(Buffer.from(signable), secretKey)).toString("base64");

  const envelope = { did: identity.did, payload, timestamp, signature };
  const url = `${platformBaseUrl.replace(/\/+$/, "")}/registry/v1/heartbeat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`heartbeat ${res.status}: ${body.slice(0, 200)}`);
  }
}

export function startHeartbeat({ platformBaseUrl, identityPath, intervalMs = 90_000 }) {
  if (timer) return; // idempotent
  if (!platformBaseUrl || !identityPath) {
    console.warn("[atel-mcp/heartbeat] missing config; skipping");
    return;
  }
  if (!fs.existsSync(identityPath)) {
    console.warn(`[atel-mcp/heartbeat] identity not found at ${identityPath}; skipping`);
    return;
  }
  // Fire one immediately so first online state isn't gated on the
  // first interval tick (90s lag would let the platform sweep mark us
  // offline before we ever heartbeat).
  fireHeartbeat(platformBaseUrl, identityPath).catch((err) => {
    console.warn(`[atel-mcp/heartbeat] initial fire failed: ${err && err.message}`);
  });
  timer = setInterval(() => {
    fireHeartbeat(platformBaseUrl, identityPath).catch((err) => {
      // Soft-fail: log + continue. A transient platform 5xx must not
      // crash the listener.
      console.warn(`[atel-mcp/heartbeat] tick failed: ${err && err.message}`);
    });
  }, intervalMs);
  if (timer.unref) timer.unref(); // don't hold the event loop open
  console.log(`[atel-mcp/heartbeat] started (interval ${intervalMs}ms)`);
}

export function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
