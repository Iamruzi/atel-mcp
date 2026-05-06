// OpenClaw plugin → ATEL Remote MCP bridge.
//
// Exposes ONE OpenClaw tool (`atel_mcp`) with two actions:
//   - action=list  → list remote ATEL MCP tools
//   - action=call  → call one remote ATEL MCP tool with JSON args
//
// Auth model: DID-Sig.
//   1. Plugin reads ed25519 secret key from identity.json
//   2. Plugin builds a SignedRequest envelope (one-time, then cached)
//   3. POST envelope to platform /auth/v1/did-sig → bearer token
//   4. Plugin uses bearer to call MCP server's /mcp endpoint
//
// Why not OAuth: OAuth requires a browser interaction. OpenClaw is a
// background daemon — no browser. DID-Sig is the headless equivalent.
//
// Why not local signing + direct platform POST (the prior design):
//   - Bypassed MCP's anti-drift layer (schema enforcement / prerequisite
//     checks / approval gate / actionable error hints)
//   - 5 LOCAL_SIGNED_TOOLS effectively gave OpenClaw users no
//     reliability protection that other ATEL clients enjoyed
//   - Cross-repo audit (2026-05-02) flagged this as the largest reliability
//     gap. Prior commit added platform-side prereq tools as a bottom-up
//     defense; THIS commit closes the gap top-down by routing OpenClaw
//     through MCP's full anti-drift stack.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { drainEvents, getStats, isIdle } from "./inbox.js";
import { getMode, setupReverseChannel } from "./setup.js";

const DEFAULT_SCOPES = [
  "identity.read",
  "contacts.read",
  "messages.read",
  "messages.write",
  "orders.read",
  "orders.write",
  "milestones.read",
  "milestones.write",
  "audit.read",
];

const DEFAULT_CONFIG = {
  serverBaseUrl: "https://atelai.xyz",
  platformBaseUrl: "https://api.atelai.xyz",
  identityPath: "/root/.openclaw/workspace/atel-sdk/.atel/identity.json",
  sdkDistPath: "/root/.openclaw/workspace/atel-sdk/dist/index.js",
  naclPath: "/root/.openclaw/workspace/atel-sdk/node_modules/tweetnacl/nacl-fast.js",
  scopes: DEFAULT_SCOPES,
};

const sessionCache = new WeakMap();

// Persistent cache so a plugin restart doesn't force a fresh DID-Sig
// exchange (saves ~1 round-trip + signing on every cold boot).
const TOKEN_CACHE_PATH = process.env.ATEL_MCP_TOKEN_CACHE_PATH || path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".openclaw",
  "atel-mcp-did-sig-cache.json",
);

function textResult(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
    isError,
  };
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function decodeSecretKey(raw) {
  if (typeof raw === "string" && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (typeof raw === "string") {
    return Buffer.from(raw, "base64");
  }
  throw new Error("Unsupported secretKey format in identity.json");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readTokenCacheFile() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeTokenCacheFile(cache) {
  ensureParentDir(TOKEN_CACHE_PATH);
  fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(cache, null, 2));
}

function tokenCacheKey(config, identity) {
  // Server URL + DID + platform URL is sufficient to uniquely scope a
  // bearer. We don't bake scope strings in because DID-Sig issues full
  // session bearers; scope filtering is done by MCP server-side.
  return [
    normalizeBaseUrl(config.serverBaseUrl),
    normalizeBaseUrl(config.platformBaseUrl),
    identity.did,
  ].join("|");
}

function getPersistedToken(config, identity) {
  const cache = readTokenCacheFile();
  const key = tokenCacheKey(config, identity);
  const entry = cache[key];
  if (!entry || typeof entry !== "object") return null;
  return entry;
}

function savePersistedToken(config, identity, patch) {
  const cache = readTokenCacheFile();
  const key = tokenCacheKey(config, identity);
  cache[key] = {
    ...(cache[key] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeTokenCacheFile(cache);
  return cache[key];
}

function clearPersistedToken(config, identity) {
  const cache = readTokenCacheFile();
  const key = tokenCacheKey(config, identity);
  if (cache[key]) {
    delete cache[key];
    writeTokenCacheFile(cache);
  }
}

export function readPluginConfig(runtime) {
  const loaded = runtime?.config?.loadConfig?.() || {};
  // Plugin id was renamed atel-mcp → atel-mcp-openclaw in 0.2.2 to match
  // the npm package name. Read the canonical key first, fall back to the
  // legacy key so installs that were never re-run keep working until the
  // user upgrades.
  const entries = loaded?.plugins?.entries || {};
  const entry =
    entries["atel-mcp-openclaw"]?.config ||
    entries["atel-mcp-openclaw"] ||
    entries["atel-mcp"]?.config ||
    entries["atel-mcp"] ||
    {};

  return {
    serverBaseUrl: normalizeBaseUrl(entry.serverBaseUrl || process.env.ATEL_MCP_REMOTE_BASE_URL || DEFAULT_CONFIG.serverBaseUrl),
    platformBaseUrl: normalizeBaseUrl(entry.platformBaseUrl || process.env.ATEL_PLATFORM_BASE_URL || DEFAULT_CONFIG.platformBaseUrl),
    identityPath: entry.identityPath || process.env.ATEL_IDENTITY_PATH || DEFAULT_CONFIG.identityPath,
    sdkDistPath: entry.sdkDistPath || process.env.ATEL_SDK_DIST_PATH || DEFAULT_CONFIG.sdkDistPath,
    naclPath: entry.naclPath || process.env.ATEL_NACL_PATH || DEFAULT_CONFIG.naclPath,
    scopes: Array.isArray(entry.scopes) && entry.scopes.length > 0 ? entry.scopes : DEFAULT_CONFIG.scopes,

    // Reverse channel (push mode) — added in 0.2.1.
    relayListenHost: entry.relayListenHost || process.env.ATEL_RELAY_LISTEN_HOST || "0.0.0.0",
    relayListenPort: Number(entry.relayListenPort || process.env.ATEL_RELAY_LISTEN_PORT || 3101),
    relayPublicUrl: entry.relayPublicUrl || process.env.ATEL_RELAY_PUBLIC_URL || null,
    relayHmacSecret: entry.relayHmacSecret || process.env.ATEL_RELAY_HMAC_SECRET || null,
  };
}

function serializePayloadLocal(obj) {
  // Same canonical-JSON rules platform's auth.SortedJSON produces. Keys
  // sorted alphabetically (recursive); arrays preserved; leaves stringify
  // in standard JSON. SDK exports the same function; we prefer SDK's
  // version when available (resolveSerializePayload) so we never drift.
  return JSON.stringify(obj, (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) {
      const sorted = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
}

async function resolveSerializePayload(config) {
  if (config.sdkDistPath && fs.existsSync(config.sdkDistPath)) {
    const sdkModule = await import(pathToFileURL(path.resolve(config.sdkDistPath)).href);
    if (typeof sdkModule.serializePayload === "function") {
      return sdkModule.serializePayload;
    }
  }
  return serializePayloadLocal;
}

async function resolveNacl(config) {
  if (config.naclPath && fs.existsSync(config.naclPath)) {
    const naclModule = await import(pathToFileURL(path.resolve(config.naclPath)).href);
    return naclModule.default ?? naclModule;
  }
  const naclModule = await import("tweetnacl");
  return naclModule.default ?? naclModule;
}

function resolveIdentityPath(configuredPath) {
  const candidates = [
    configuredPath,
    "/root/.openclaw/workspace/atel-sdk/.atel/identity.json",
    "/root/.openclaw/workspace-executor/atel-sdk/.atel/identity.json",
    "/root/.openclaw/workspace/atel-sdk/shrimp1-identity.json",
    "/root/.openclaw/workspace-executor/atel-sdk/shrimp1-identity.json",
    "/root/.openclaw/workspace/.atel/identity.json",
    "/root/.atel/identity.json",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`ATEL identity not found: ${candidates.join(", ")}`);
}

async function readJson(response) {
  // Read the body ONCE as text, then try to parse. The previous shape —
  // response.json().catch(() => response.text()) — re-reads the body in
  // the catch path, which throws "Body has already been read" because
  // fetch's Response body is a one-shot stream. That made every JSON
  // parse failure (server returns HTML 502, plain-text error, etc) bubble
  // up as "Body is unusable" instead of the actual error message,
  // breaking the cron poll path with a confusing transient error.
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function parseMcpPayload(response) {
  const raw = await response.text();
  if (!raw) return null;

  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  // Streamable HTTP transport may return SSE-framed JSON. Parse the last
  // data: line which carries the actual response.
  const eventLines = raw
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (const line of eventLines.reverse()) {
    const parsed = tryParse(line);
    if (parsed) return parsed;
  }

  throw new Error(`Unable to parse MCP response: ${raw.slice(0, 500)}`);
}

// ─── DID-Sig auth ─────────────────────────────────────────────────────

async function exchangeDidSigForToken(config) {
  // One round-trip:
  //   plugin builds SignedRequest envelope → POST platform /auth/v1/did-sig
  //   → bearer token (7-day expiry)
  // Replaces the previous 5-step OAuth PKCE dance entirely.
  const identityPath = resolveIdentityPath(config.identityPath);
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const secretKey = decodeSecretKey(identity.secretKey);

  const serializePayload = await resolveSerializePayload(config);
  const nacl = await resolveNacl(config);

  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  // Payload is the signed body. nonce makes the signed bytes unique per
  // request — defense-in-depth against signature replay even within the
  // 5-min ts window platform enforces.
  const payload = { nonce };
  const signable = serializePayload({ payload, did: identity.did, timestamp });
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(signable), secretKey)).toString("base64");

  const envelope = { did: identity.did, payload, timestamp, signature };

  const response = await fetch(`${config.platformBaseUrl}/auth/v1/did-sig`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body?.token !== "string") {
    throw new Error(`DID-Sig exchange failed: ${response.status} ${JSON.stringify(body)}`);
  }

  // expiresAt comes back as unix seconds; normalize to ms.
  const expiresAtMs = typeof body.expiresAt === "number"
    ? body.expiresAt * 1000
    : Date.now() + 7 * 24 * 3600_000;

  return {
    accessToken: body.token,
    expiresAt: expiresAtMs,
    did: identity.did,
    identity, // returned so caller can persist scoped to this DID
  };
}

async function getAccessToken(runtime) {
  const cached = sessionCache.get(runtime);
  if (cached?.accessToken && cached.expiresAt > Date.now() + 30_000) {
    return cached.accessToken;
  }

  const config = readPluginConfig(runtime);
  const identityPath = resolveIdentityPath(config.identityPath);
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));

  // Try persisted cache first (across plugin restarts).
  const persisted = getPersistedToken(config, identity);
  if (persisted?.accessToken && persisted?.expiresAt > Date.now() + 30_000) {
    sessionCache.set(runtime, {
      accessToken: persisted.accessToken,
      expiresAt: persisted.expiresAt,
      initialized: false,
      sessionId: null,
      requestSeq: 0,
    });
    return persisted.accessToken;
  }

  // Fresh exchange.
  let issued;
  try {
    issued = await exchangeDidSigForToken(config);
  } catch (e) {
    // Wipe stale persisted entry if exchange fails — next attempt starts clean.
    clearPersistedToken(config, identity);
    throw e;
  }

  savePersistedToken(config, identity, {
    accessToken: issued.accessToken,
    expiresAt: issued.expiresAt,
  });

  sessionCache.set(runtime, {
    accessToken: issued.accessToken,
    expiresAt: issued.expiresAt,
    initialized: false,
    sessionId: null,
    requestSeq: 0,
  });
  return issued.accessToken;
}

// ─── MCP request layer ────────────────────────────────────────────────

async function sendMcpRequest(runtime, method, params = {}) {
  const config = readPluginConfig(runtime);
  const cached = sessionCache.get(runtime);
  const accessToken = cached?.accessToken && cached.expiresAt > Date.now() + 30_000
    ? cached.accessToken
    : await getAccessToken(runtime);

  const current = sessionCache.get(runtime) || {
    accessToken,
    expiresAt: Date.now() + 3600_000,
    initialized: false,
    sessionId: null,
    requestSeq: 0,
  };

  if (!current.initialized) {
    const initHeaders = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (current.sessionId) {
      initHeaders["mcp-session-id"] = current.sessionId;
    }

    const initializeResponse = await fetch(`${config.serverBaseUrl}/mcp`, {
      method: "POST",
      headers: initHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "openclaw-init",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "openclaw-atel-mcp",
            version: "0.2.0",
          },
        },
      }),
    });

    const initializePayload = await parseMcpPayload(initializeResponse);
    if (!initializeResponse.ok) {
      throw new Error(`MCP initialize failed: ${initializeResponse.status} ${JSON.stringify(initializePayload)}`);
    }

    current.sessionId = initializeResponse.headers.get("mcp-session-id") || current.sessionId || null;
    current.initialized = true;
    sessionCache.set(runtime, current);
  }

  current.requestSeq += 1;
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (current.sessionId) {
    headers["mcp-session-id"] = current.sessionId;
  }

  const response = await fetch(`${config.serverBaseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `openclaw-${method.replace(/[^\w]+/g, "-")}-${current.requestSeq}`,
      method,
      params,
    }),
  });
  current.sessionId = response.headers.get("mcp-session-id") || current.sessionId || null;
  sessionCache.set(runtime, current);

  const payload = await parseMcpPayload(response);
  if (!response.ok) {
    throw new Error(`MCP ${method} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  if (payload?.error) {
    throw new Error(`MCP ${method} error: ${JSON.stringify(payload.error)}`);
  }
  return payload?.result ?? null;
}

// Used by setup.js to call MCP tools during plugin init (e.g.
// atel_register_endpoint). Public alias of sendMcpRequest.
export async function sendMcpRequestForRuntime(runtime, method, params) {
  return await sendMcpRequest(runtime, method, params);
}

// Poll the reverse channel for events. Two source paths:
//   - push mode (listener bound + endpoint registered): drain in-memory inbox
//   - pull mode (NAT / bind failed): fetch /relay/v1/inbox-jwt via MCP server
// Returns:
//   - `{ noEvents: true, mode, idle }` when nothing pending → agent should noop
//   - `{ events: [...], mode, count }` when events exist → agent acts on them
async function pollEvents(runtime) {
  const config = readPluginConfig(runtime);
  const identity = JSON.parse(fs.readFileSync(resolveIdentityPath(config.identityPath), "utf8"));
  const did = identity.did;

  // First, ALWAYS check the file-backed inbox. If push mode is alive in
  // any process (gateway or otherwise), events accumulate in the file
  // regardless of what this child process's getMode() thinks. This also
  // handles the race where setup() is still running async at the moment
  // poll_events is invoked: file events are the ground truth.
  let events = drainEvents(did);
  let mode = getMode();
  let usedPullFallback = false;

  if (events.length === 0 && mode !== "push") {
    // File is empty and we're explicitly in pull mode (or uninitialized
    // and decided we're not push). Fall back to MCP inbox poll.
    usedPullFallback = true;
    try {
      const inboxResult = await sendMcpRequest(runtime, "tools/call", {
        name: "atel_inbox_list",
        arguments: {},
      });
      const txt = inboxResult?.content?.[0]?.text ?? "{}";
      try {
        const parsed = JSON.parse(txt);
        events = Array.isArray(parsed?.messages) ? parsed.messages : [];
      } catch {
        events = [];
      }
    } catch (e) {
      return { error: `pull_inbox_failed: ${e?.message || String(e)}`, mode };
    }
  }

  if (!events || events.length === 0) {
    // Early return — caller (cron-driven agent) should noop and exit
    // without consuming output tokens on planning. See PoC token-cost
    // analysis (Plugin-0.2.1 audit doc §八).
    return { noEvents: true, mode, idle: isIdle(), did, usedPullFallback };
  }

  return {
    events,
    mode,
    count: events.length,
    did,
    usedPullFallback,
    stats: getStats(),
  };
}

async function listRemoteTools(runtime) {
  const result = await sendMcpRequest(runtime, "tools/list", {});
  return {
    count: Array.isArray(result?.tools) ? result.tools.length : 0,
    tools: Array.isArray(result?.tools)
      ? result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema || null,
        }))
      : [],
  };
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") return JSON.parse(raw);
  throw new Error("args must be a JSON object or JSON string");
}

async function callRemoteTool(runtime, toolName, args) {
  // No more LOCAL_SIGNED_TOOLS branch. Every tool — including the 5
  // previously-bypassed ones (order_create, order_accept,
  // milestone_submit, milestone_verify, dispute_create) — now goes
  // through MCP server. That gives OpenClaw users access to MCP's
  // anti-drift layer (schema enforcement, prerequisite checks, approval
  // gate, actionable error hints) automatically.
  const result = await sendMcpRequest(runtime, "tools/call", {
    name: toolName,
    arguments: parseArgs(args),
  });

  return {
    tool: toolName,
    content: result?.content || [],
    structuredContent: result?.structuredContent ?? null,
    isError: result?.isError ?? false,
  };
}

export function createAtelMcpTool(runtime) {
  return {
    name: "atel_mcp",
    label: "ATEL MCP",
    description: [
      "Bridge OpenClaw to the ATEL Remote MCP service.",
      "Use action=list to inspect available tools.",
      "Use action=call with a remote tool name and JSON args to execute an ATEL business action.",
      "Use action=poll_events to drain pending platform → agent notifications (order events, milestone events, settlements). Returns { noEvents: true } when nothing is pending — in that case, just stop, no further action needed. When events exist, react to each per its type.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "call", "poll_events"],
          description: "list = enumerate remote tools; call = invoke one remote tool; poll_events = drain pending platform notifications",
        },
        tool: {
          type: "string",
          description: "Remote ATEL MCP tool name when action=call",
        },
        args: {
          type: ["object", "string"],
          description: "Remote ATEL MCP tool arguments as object or JSON string",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId, params) {
      const action = params?.action;
      try {
        if (action === "list") {
          return textResult(await listRemoteTools(runtime));
        }
        if (action === "call") {
          if (!params?.tool || typeof params.tool !== "string") {
            return textResult({ error: "tool is required when action=call" }, true);
          }
          return textResult(await callRemoteTool(runtime, params.tool, params.args));
        }
        if (action === "poll_events") {
          return textResult(await pollEvents(runtime));
        }
        return textResult({ error: `unsupported action: ${String(action)}` }, true);
      } catch (error) {
        // Drop session on any error so the next call re-authenticates
        // cleanly. Common case: bearer expired between calls; clearing
        // the WeakMap entry triggers a fresh DID-Sig exchange on retry.
        sessionCache.delete(runtime);
        return textResult(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}
