// In-process 30s poll loop. Independent of OpenClaw cron.
//
// Why this exists alongside cron + push listener:
// The 0.6.x cron path goes OpenClaw isolated session → agentTurn → LLM →
// atel_mcp action=poll_events. In an isolated session the plugin tool
// registry isn't loaded, so the LLM call fails with "unknown method"
// and messages stay stuck in platform inbox. Push mode also fails on
// any agent behind NAT/firewall (HEAD probe can't reach the listener).
//
// Solution: a setInterval inside the listener systemd process that
// polls /relay/v1/poll directly via DID-Sig, hands each message to
// inbox.pushEvent + tg-dispatch.dispatchEvent, then ACKs. Doesn't
// need OpenClaw cron, doesn't need a reachable listener.
//
// Auth: the platform's relayTokenMiddleware accepts a SignedRequest
// envelope (did/payload/timestamp/signature) for poll, and the /ack
// route uses DIDAuth which expects the same envelope. Plugin already
// has the secretKey loaded for heartbeat signing; we reuse the same
// primitives here.

import fs from "node:fs";
import crypto from "node:crypto";
import { pushEvent } from "./inbox.js";
import { dispatchEvent } from "./tg-dispatch.js";
import { wakeCronNow, maybeCacheOrderRole, enqueueMilestoneVerifiedHook, enqueueMilestoneSubmittedHook } from "./listener.js";

let timer = null;
let nacl = null;
let inFlight = false;
const autoActed = new Set(); // dedupe: orderId+action — fire-and-forget once

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
  // Sorted-key JSON — must match platform's auth.SerializePayload.
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
  const mod = await import("tweetnacl");
  nacl = mod.default ?? mod;
  return nacl;
}

async function signEnvelope(identity, payload) {
  const t = await loadNacl();
  const secretKey = decodeSecretKey(identity.secretKey);
  const timestamp = new Date().toISOString();
  const signable = serializePayload({ payload, did: identity.did, timestamp });
  const signature = Buffer.from(t.sign.detached(Buffer.from(signable), secretKey)).toString("base64");
  return { did: identity.did, payload, timestamp, signature };
}

async function pollOnce(platformBaseUrl, identityPath) {
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const pollEnv = await signEnvelope(identity, { nonce: crypto.randomBytes(16).toString("hex") });
  const pollUrl = `${platformBaseUrl.replace(/\/+$/, "")}/relay/v1/poll`;
  const res = await fetch(pollUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pollEnv),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`poll HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  if (messages.length === 0) return 0;

  const ackIds = [];
  let sawA2AEvent = false;
  for (const m of messages) {
    try {
      // Platform wraps relay payloads as {body, path, method}. Plugin
      // inbox stores the whole thing for poll_events compatibility;
      // tg-dispatch reads the inner `body` field (eventType/payload).
      pushEvent(identity.did, m.message);
      const dispatchInput = m.message?.body && typeof m.message.body === "object"
        ? m.message.body
        : m.message;
      await dispatchEvent(dispatchInput, { targetDid: identity.did });
      // 0.6.36: cache order roles + enqueue LLM hook for milestone_verified
      // (executor side) on PULL events too. The push path in listener.js
      // already does this; pull path needs the same hookup because most
      // events arrive via pull when the agent endpoint is mcp://remote/...
      // (pull-mode default for any agent without a registered https URL).
      try { maybeCacheOrderRole(dispatchInput, identityPath); } catch (e) { console.warn(`[atel-mcp/poll-loop] role cache error: ${e && e.message}`); }
      try { enqueueMilestoneVerifiedHook({ messageBody: dispatchInput, identityPath }); } catch (e) { console.warn(`[atel-mcp/poll-loop] hook enqueue error: ${e && e.message}`); }
      try { enqueueMilestoneSubmittedHook({ messageBody: dispatchInput, identityPath }); } catch (e) { console.warn(`[atel-mcp/poll-loop] submitted hook error: ${e && e.message}`); }

      // Hardcoded auto-actions for the trivial state-mutation steps.
      // These don't need LLM judgment (they're "yes" 100% of the time
      // for a participant who agreed to the order in the first place),
      // and routing them through cron→LLM was costing 30s–5min per hop.
      // Only handle decisions with NO content judgment: accept order,
      // approve plan. milestone_submit / milestone_verify still need
      // the LLM (content generation, content review).
      const evtType = dispatchInput?.event || dispatchInput?.eventType || "";
      const orderId = dispatchInput?.payload?.orderId || dispatchInput?.orderId;
      if (orderId && (evtType === "order_created" || evtType === "order_accepted")) {
        sawA2AEvent = true;
        // Fire-and-forget. Failures are logged + cron is the fallback.
        autoActOnEvent(platformBaseUrl, identity, evtType, orderId).catch((err) => {
          console.warn(`[atel-mcp/poll-loop] auto-act ${evtType} ${orderId}: ${err && err.message}`);
        });
      } else if (evtType && evtType.startsWith("milestone_")) {
        // Content-judgment events still go through the LLM. Wake cron
        // immediately so the agent doesn't sit idle for up to 30s.
        sawA2AEvent = true;
      }

      ackIds.push(m.id);
    } catch (err) {
      console.warn(`[atel-mcp/poll-loop] dispatch failed id=${m.id}: ${err && err.message}`);
    }
  }

  if (ackIds.length > 0) {
    const ackEnv = await signEnvelope(identity, { ids: ackIds });
    const ackUrl = `${platformBaseUrl.replace(/\/+$/, "")}/relay/v1/ack`;
    const ar = await fetch(ackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ackEnv),
    });
    if (!ar.ok) {
      const t = await ar.text().catch(() => "");
      console.warn(`[atel-mcp/poll-loop] ack HTTP ${ar.status}: ${t.slice(0, 200)}`);
    }
  }

  // Wake the cron job for content-judgment events (milestone_submit /
  // milestone_verify). For pure-state events we already fired the platform
  // call directly; we still wake so the agent's view of order_list is fresh.
  if (sawA2AEvent) {
    try { wakeCronNow(); } catch (e) { /* listener.js may not be loaded in some test paths */ }
  }

  return messages.length;
}

// autoActOnEvent — fire the platform DIDAuth call that cron+LLM would
// normally make for trivial state mutations. Idempotent on platform side
// (accept rejects "already accepted", milestone_plan_feedback rejects
// "wrong status"), but we also dedupe locally to avoid log spam.
async function autoActOnEvent(platformBaseUrl, identity, evtType, orderId) {
  const dedupeKey = `${orderId}:${evtType}`;
  if (autoActed.has(dedupeKey)) return;
  autoActed.add(dedupeKey);
  // Cap memory — each entry is a short string, but a long-running listener
  // could in theory accumulate thousands.
  if (autoActed.size > 500) {
    const first = autoActed.values().next().value;
    autoActed.delete(first);
  }

  const base = platformBaseUrl.replace(/\/+$/, "");

  if (evtType === "order_created") {
    // Executor side: auto-accept. Empty payload is fine — handler reads
    // orderId from URL param and runs auto-escrow on its own.
    const env = await signEnvelope(identity, {});
    const url = `${base}/trade/v1/order/${encodeURIComponent(orderId)}/accept`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    const body = await res.text().catch(() => "");
    if (res.ok) {
      console.log(`[atel-mcp/poll-loop] auto-accepted ${orderId}`);
    } else {
      // 409 = wrong status (someone else already accepted, or order moved).
      // Quietly demote to debug — it's expected during retries.
      const level = res.status === 409 ? "debug" : "warn";
      console[level === "warn" ? "warn" : "log"](`[atel-mcp/poll-loop] auto-accept ${orderId} HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    return;
  }

  if (evtType === "order_accepted") {
    // Both sides receive this; both should approve plan. Platform tracks
    // milestone_requester_ok / milestone_executor_ok independently and
    // advances to executing only when both are true. If we're the executor
    // who just accepted, our own approval is also needed (separate from
    // the accept call). Auto-approve for both roles.
    const env = await signEnvelope(identity, { approved: true });
    const url = `${base}/trade/v1/order/${encodeURIComponent(orderId)}/milestones/feedback`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    const body = await res.text().catch(() => "");
    if (res.ok) {
      console.log(`[atel-mcp/poll-loop] auto-approved plan ${orderId}`);
    } else {
      const level = res.status === 409 ? "debug" : "warn";
      console[level === "warn" ? "warn" : "log"](`[atel-mcp/poll-loop] auto-approve plan ${orderId} HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    return;
  }
}

// 0.6.17 — exposed so listener.js HTTP push handler can fire autoAct on
// events that arrive via push (push_status=succeeded). Without this,
// push-route events were ack'd immediately and poll-loop never re-pulled
// them, so the hardcoded auto-accept / auto-approve-plan path (added in
// 0.6.8) silently never fired for any plugin whose listener was reachable
// from platform — manifesting as "order stays in created / milestone_review
// forever" until cron-keeper LLM eventually noticed and acted.
export async function autoActOnPushEvent({ platformBaseUrl, identityPath, dispatchInput }) {
  if (!platformBaseUrl || !identityPath || !dispatchInput) return;
  const evtType = dispatchInput?.event || dispatchInput?.eventType || "";
  const orderId = dispatchInput?.payload?.orderId || dispatchInput?.orderId;
  if (!orderId) return;
  if (evtType !== "order_created" && evtType !== "order_accepted") return;
  try {
    const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    await autoActOnEvent(platformBaseUrl, identity, evtType, orderId);
  } catch (err) {
    console.warn(`[atel-mcp/poll-loop] push autoAct ${evtType} ${orderId}: ${err && err.message}`);
  }
}

export function startPollLoop({ platformBaseUrl, identityPath, intervalMs = 30_000 }) {
  if (timer) return;
  if (!platformBaseUrl || !identityPath) {
    console.warn("[atel-mcp/poll-loop] missing config; skipping");
    return;
  }
  if (!fs.existsSync(identityPath)) {
    console.warn(`[atel-mcp/poll-loop] identity not found at ${identityPath}; skipping`);
    return;
  }

  const tick = async () => {
    // Guard against overlap if a poll takes longer than the interval
    // (slow platform → next tick fires before the previous returns).
    if (inFlight) return;
    inFlight = true;
    try {
      const n = await pollOnce(platformBaseUrl, identityPath);
      if (n > 0) console.log(`[atel-mcp/poll-loop] drained ${n} messages`);
    } catch (err) {
      console.warn(`[atel-mcp/poll-loop] tick failed: ${err && err.message}`);
    } finally {
      inFlight = false;
    }
  };

  // Fire immediately so installation→first-message latency isn't gated
  // on the first interval tick.
  tick();
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[atel-mcp/poll-loop] started (interval ${intervalMs}ms)`);
}

export function stopPollLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
