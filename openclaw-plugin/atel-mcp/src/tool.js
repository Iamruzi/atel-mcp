import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

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
  serverBaseUrl: "https://43-160-230-129.sslip.io",
  platformBaseUrl: "https://api.atelai.org",
  identityPath: "/root/.openclaw/workspace/atel-sdk/.atel/identity.json",
  sdkDistPath: "/root/.openclaw/workspace/atel-sdk/dist/index.js",
  naclPath: "/root/.openclaw/workspace/atel-sdk/node_modules/tweetnacl/nacl-fast.js",
  scopes: DEFAULT_SCOPES,
};

const sessionCache = new WeakMap();
const OAUTH_CACHE_PATH = process.env.ATEL_MCP_OAUTH_CACHE_PATH || path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".openclaw",
  "atel-mcp-oauth-cache.json",
);
const LOCAL_SIGNED_TOOLS = new Set([
  "atel_order_create",
  "atel_order_accept",
  "atel_milestone_submit",
  "atel_milestone_verify",
  "atel_dispute_create",
]);

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

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function makePkce() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readOauthCacheFile() {
  try {
    if (!fs.existsSync(OAUTH_CACHE_PATH)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(OAUTH_CACHE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOauthCacheFile(cache) {
  ensureParentDir(OAUTH_CACHE_PATH);
  fs.writeFileSync(OAUTH_CACHE_PATH, JSON.stringify(cache, null, 2));
}

function buildOauthCacheKey(config, identity, scopes) {
  return [
    normalizeBaseUrl(config.serverBaseUrl),
    normalizeBaseUrl(config.platformBaseUrl),
    identity.did,
    scopes.join(" "),
  ].join("|");
}

function getPersistedOauthCache(config, identity, scopes) {
  const cache = readOauthCacheFile();
  const key = buildOauthCacheKey(config, identity, scopes);
  const entry = cache[key];
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return { key, entry };
}

function savePersistedOauthCache(config, identity, scopes, patch) {
  const cache = readOauthCacheFile();
  const key = buildOauthCacheKey(config, identity, scopes);
  cache[key] = {
    ...(cache[key] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeOauthCacheFile(cache);
  return cache[key];
}

function clearPersistedOauthCache(config, identity, scopes) {
  const cache = readOauthCacheFile();
  const key = buildOauthCacheKey(config, identity, scopes);
  if (cache[key]) {
    delete cache[key];
    writeOauthCacheFile(cache);
  }
}

function readPluginConfig(runtime) {
  const loaded = runtime?.config?.loadConfig?.() || {};
  const entry =
    loaded?.plugins?.entries?.["atel-mcp"]?.config ||
    loaded?.plugins?.entries?.["atel-mcp"] ||
    {};

  return {
    serverBaseUrl: normalizeBaseUrl(entry.serverBaseUrl || process.env.ATEL_MCP_REMOTE_BASE_URL || DEFAULT_CONFIG.serverBaseUrl),
    platformBaseUrl: normalizeBaseUrl(entry.platformBaseUrl || process.env.ATEL_PLATFORM_BASE_URL || DEFAULT_CONFIG.platformBaseUrl),
    identityPath: entry.identityPath || process.env.ATEL_IDENTITY_PATH || DEFAULT_CONFIG.identityPath,
    sdkDistPath: entry.sdkDistPath || process.env.ATEL_SDK_DIST_PATH || DEFAULT_CONFIG.sdkDistPath,
    naclPath: entry.naclPath || process.env.ATEL_NACL_PATH || DEFAULT_CONFIG.naclPath,
    scopes: Array.isArray(entry.scopes) && entry.scopes.length > 0 ? entry.scopes : DEFAULT_CONFIG.scopes,
  };
}

function requireReadableFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return filePath;
}

function resolveIdentityPath(configuredPath) {
  const candidates = [
    configuredPath,
    "/root/.openclaw/workspace/atel-sdk/.atel/identity.json",
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
  return response.json().catch(async () => ({ raw: await response.text() }));
}

async function parseMcpPayload(response) {
  const raw = await response.text();
  if (!raw) {
    return null;
  }

  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) {
    return direct;
  }

  const eventLines = raw
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (const line of eventLines.reverse()) {
    const parsed = tryParse(line);
    if (parsed) {
      return parsed;
    }
  }

  throw new Error(`Unable to parse MCP response: ${raw.slice(0, 500)}`);
}

async function getAccessToken(runtime) {
  const cached = sessionCache.get(runtime);
  if (cached?.accessToken && cached.expiresAt > Date.now() + 30_000) {
    return cached.accessToken;
  }

  const config = readPluginConfig(runtime);
  const identityPath = resolveIdentityPath(config.identityPath);
  const sdkDistPath = requireReadableFile(config.sdkDistPath, "ATEL SDK dist");
  const naclPath = requireReadableFile(config.naclPath, "tweetnacl");
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const secretKey = decodeSecretKey(identity.secretKey);

  const sdkModule = await import(pathToFileURL(path.resolve(sdkDistPath)).href);
  const naclModule = await import(pathToFileURL(path.resolve(naclPath)).href);
  const serializePayload = sdkModule.serializePayload;
  const nacl = naclModule.default ?? naclModule;
  if (typeof serializePayload !== "function") {
    throw new Error(`serializePayload missing from ${sdkDistPath}`);
  }

  const persisted = getPersistedOauthCache(config, identity, config.scopes);
  const redirectUri = "https://atel.local/callback";
  const { verifier, challenge } = makePkce();

  if (
    persisted?.entry?.client?.client_id &&
    typeof persisted.entry?.refreshToken === "string" &&
    persisted.entry.refreshToken
  ) {
    const refreshParams = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: String(persisted.entry.client.client_id),
      refresh_token: persisted.entry.refreshToken,
    });
    const refreshResponse = await fetch(`${config.serverBaseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshParams.toString(),
    });
    const refreshPayload = await readJson(refreshResponse);
    if (refreshResponse.ok && typeof refreshPayload?.access_token === "string") {
      const nextRefreshToken =
        typeof refreshPayload?.refresh_token === "string" && refreshPayload.refresh_token
          ? refreshPayload.refresh_token
          : persisted.entry.refreshToken;
      savePersistedOauthCache(config, identity, config.scopes, {
        client: persisted.entry.client,
        refreshToken: nextRefreshToken,
      });
      sessionCache.set(runtime, {
        accessToken: refreshPayload.access_token,
        expiresAt: Date.now() + (Number(refreshPayload.expires_in || 3600) * 1000),
        initialized: false,
        sessionId: null,
        requestSeq: 0,
      });
      return refreshPayload.access_token;
    }

    clearPersistedOauthCache(config, identity, config.scopes);
  }

  const registrationBody = {
    client_name: "OpenClaw ATEL MCP Bridge",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  let registeredClient = persisted?.entry?.client ?? null;
  if (!registeredClient?.client_id) {
    const registerResponse = await fetch(`${config.serverBaseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registrationBody),
    });
    registeredClient = await readJson(registerResponse);
    if (!registerResponse.ok) {
      throw new Error(`MCP register failed: ${registerResponse.status} ${JSON.stringify(registeredClient)}`);
    }
  }

  const authorizeUrl = new URL(`${config.serverBaseUrl}/authorize`);
  authorizeUrl.searchParams.set("client_id", String(registeredClient.client_id));
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", config.scopes.join(" "));
  authorizeUrl.searchParams.set("state", "openclaw-atel-mcp");

  const authorizeResponse = await fetch(authorizeUrl, { method: "GET", redirect: "manual" });
  const interactiveLocation = authorizeResponse.headers.get("location");
  if (authorizeResponse.status !== 302 || !interactiveLocation) {
    throw new Error(`MCP authorize failed: ${authorizeResponse.status}`);
  }

  const sessionId = new URL(interactiveLocation).searchParams.get("session");
  if (!sessionId) {
    throw new Error("MCP authorize did not return session id");
  }

  const pendingResponse = await fetch(`${config.serverBaseUrl}/oauth/authorize/interactive/status/${encodeURIComponent(sessionId)}`);
  const pendingPayload = await readJson(pendingResponse);
  if (pendingPayload?.status !== "pending" || typeof pendingPayload?.code !== "string") {
    throw new Error(`Unexpected authorization status: ${JSON.stringify(pendingPayload)}`);
  }

  const timestamp = new Date().toISOString();
  const payload = { code: pendingPayload.code, did: identity.did, timestamp };
  const signable = serializePayload({ payload, did: identity.did, timestamp });
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(signable), secretKey)).toString("base64");

  const verifyResponse = await fetch(`${config.platformBaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: pendingPayload.code,
      did: identity.did,
      signature,
      timestamp,
    }),
  });
  const verifyPayload = await readJson(verifyResponse);
  if (!verifyResponse.ok) {
    throw new Error(`Platform verify failed: ${verifyResponse.status} ${JSON.stringify(verifyPayload)}`);
  }

  let statusPayload = null;
  for (let i = 0; i < 15; i += 1) {
    const statusResponse = await fetch(`${config.serverBaseUrl}/oauth/authorize/interactive/status/${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
    });
    statusPayload = await readJson(statusResponse);
    if (statusPayload?.status === "verified" && statusPayload?.redirectTo) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!statusPayload?.redirectTo) {
    throw new Error(`Authorization code not issued: ${JSON.stringify(statusPayload)}`);
  }

  const authorizationCode = new URL(statusPayload.redirectTo).searchParams.get("code");
  if (!authorizationCode) {
    throw new Error("Authorization code missing from redirect");
  }

  const tokenResponse = await fetch(`${config.serverBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: String(registeredClient.client_id),
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  const tokenPayload = await readJson(tokenResponse);
  if (!tokenResponse.ok || typeof tokenPayload?.access_token !== "string") {
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${JSON.stringify(tokenPayload)}`);
  }

  savePersistedOauthCache(config, identity, config.scopes, {
    client: registeredClient,
    refreshToken: typeof tokenPayload?.refresh_token === "string" ? tokenPayload.refresh_token : undefined,
  });

  sessionCache.set(runtime, {
    accessToken: tokenPayload.access_token,
    expiresAt: Date.now() + (Number(tokenPayload.expires_in || 3600) * 1000),
    initialized: false,
    sessionId: null,
    requestSeq: 0,
  });
  return tokenPayload.access_token;
}

async function loadSigningContext(runtime) {
  const config = readPluginConfig(runtime);
  const identityPath = resolveIdentityPath(config.identityPath);
  const sdkDistPath = requireReadableFile(config.sdkDistPath, "ATEL SDK dist");
  const naclPath = requireReadableFile(config.naclPath, "tweetnacl");
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const secretKey = decodeSecretKey(identity.secretKey);

  const sdkModule = await import(pathToFileURL(path.resolve(sdkDistPath)).href);
  const naclModule = await import(pathToFileURL(path.resolve(naclPath)).href);
  const serializePayload = sdkModule.serializePayload;
  const nacl = naclModule.default ?? naclModule;
  if (typeof serializePayload !== "function") {
    throw new Error(`serializePayload missing from ${sdkDistPath}`);
  }

  return {
    config,
    identity,
    secretKey,
    serializePayload,
    nacl,
  };
}

function buildSignedEnvelope(signing, payload) {
  const timestamp = new Date().toISOString();
  const signable = signing.serializePayload({
    payload,
    did: signing.identity.did,
    timestamp,
  });
  const signature = Buffer.from(
    signing.nacl.sign.detached(Buffer.from(signable), signing.secretKey),
  ).toString("base64");

  return {
    did: signing.identity.did,
    payload,
    timestamp,
    signature,
  };
}

async function signedPlatformRequest(runtime, method, pathName, payload) {
  const signing = await loadSigningContext(runtime);
  const response = await fetch(`${signing.config.platformBaseUrl}${pathName}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(buildSignedEnvelope(signing, payload)),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`Platform ${method} ${pathName} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function normalizeOrderCreateArgs(input) {
  return {
    executorDid: String(input?.executorDid || "").trim(),
    capabilityType: String(input?.capabilityType || "").trim(),
    description: String(input?.description || "").trim(),
    priceUsdc: Number(input?.priceUsdc ?? 0),
    chain: typeof input?.chain === "string" && input.chain.trim() ? input.chain.trim() : undefined,
  };
}

function normalizeMilestoneArgs(input) {
  return {
    orderId: String(input?.orderId || "").trim(),
    index: Number(input?.index),
    content: typeof input?.content === "string" ? input.content : "",
    approved: Boolean(input?.approved),
    feedback: typeof input?.feedback === "string" ? input.feedback : "",
  };
}

async function callLocalSignedTool(runtime, toolName, rawArgs) {
  const args = parseArgs(rawArgs);

  switch (toolName) {
    case "atel_order_create": {
      const input = normalizeOrderCreateArgs(args);
      if (!input.executorDid || !input.capabilityType || !input.description || !Number.isFinite(input.priceUsdc) || input.priceUsdc < 0) {
        throw new Error("atel_order_create requires executorDid, capabilityType, description, and priceUsdc >= 0");
      }
      const payload = {
        executorDid: input.executorDid,
        capabilityType: input.capabilityType,
        priceAmount: input.priceUsdc,
        priceCurrency: "USD",
        pricingModel: "per_task",
        description: input.description,
      };
      if (input.chain) {
        payload.chain = input.chain;
      }
      return {
        tool: toolName,
        mode: "local-signed",
        structuredContent: await signedPlatformRequest(runtime, "POST", "/trade/v1/order", payload),
        content: [],
        isError: false,
      };
    }
    case "atel_order_accept": {
      const orderId = String(args?.orderId || "").trim();
      if (!orderId) {
        throw new Error("atel_order_accept requires orderId");
      }
      return {
        tool: toolName,
        mode: "local-signed",
        structuredContent: await signedPlatformRequest(runtime, "POST", `/trade/v1/order/${encodeURIComponent(orderId)}/accept`, {}),
        content: [],
        isError: false,
      };
    }
    case "atel_milestone_submit": {
      const input = normalizeMilestoneArgs(args);
      if (!input.orderId || !Number.isInteger(input.index) || input.index < 0 || input.index > 9 || !input.content) {
        throw new Error("atel_milestone_submit requires orderId, index, and content");
      }
      return {
        tool: toolName,
        mode: "local-signed",
        structuredContent: await signedPlatformRequest(
          runtime,
          "POST",
          `/trade/v1/order/${encodeURIComponent(input.orderId)}/milestone/${input.index}/submit`,
          { resultSummary: input.content },
        ),
        content: [],
        isError: false,
      };
    }
    case "atel_milestone_verify": {
      const input = normalizeMilestoneArgs(args);
      if (!input.orderId || !Number.isInteger(input.index) || input.index < 0 || input.index > 9) {
        throw new Error("atel_milestone_verify requires orderId and index");
      }
      if (!input.approved && !input.feedback) {
        throw new Error("atel_milestone_verify requires feedback when approved=false");
      }
      return {
        tool: toolName,
        mode: "local-signed",
        structuredContent: await signedPlatformRequest(
          runtime,
          "POST",
          `/trade/v1/order/${encodeURIComponent(input.orderId)}/milestone/${input.index}/verify`,
          {
            passed: input.approved,
            rejectReason: input.approved ? "" : input.feedback,
          },
        ),
        content: [],
        isError: false,
      };
    }
    case "atel_dispute_create": {
      const orderId = String(args?.orderId || "").trim();
      const reason = String(args?.reason || "").trim();
      const description = typeof args?.description === "string" ? args.description.trim() : "";
      if (!orderId || !reason) {
        throw new Error("atel_dispute_create requires orderId and reason");
      }
      return {
        tool: toolName,
        mode: "local-signed",
        structuredContent: await signedPlatformRequest(runtime, "POST", "/dispute/v1/open", {
          orderId,
          reason,
          description,
        }),
        content: [],
        isError: false,
      };
    }
    default:
      throw new Error(`Unsupported local-signed tool: ${toolName}`);
  }
}

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
            version: "0.1.0",
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
  if (raw == null) {
    return {};
  }
  if (typeof raw === "object") {
    return raw;
  }
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  throw new Error("args must be a JSON object or JSON string");
}

async function callRemoteTool(runtime, toolName, args) {
  if (LOCAL_SIGNED_TOOLS.has(toolName)) {
    return callLocalSignedTool(runtime, toolName, args);
  }

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
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "call"],
          description: "list remote tools or call one remote tool",
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
        return textResult({ error: `unsupported action: ${String(action)}` }, true);
      } catch (error) {
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

