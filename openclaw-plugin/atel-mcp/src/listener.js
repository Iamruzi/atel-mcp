// HTTP listener for platform → plugin push notifications.
//
// Why a standalone listener (not OpenClaw gateway HTTP via api.registerHttpRoute):
// OpenClaw gateway binds 127.0.0.1:18789 by design (it's an internal RPC
// server). Plugin routes registered there are NOT reachable from the public
// internet. Platform's relay-push dispatcher needs a reachable URL.
// So plugin opens its own HTTP server on a configurable port (default 3101),
// bound to 0.0.0.0, and registers that URL via atel_register_endpoint.
//
// On bind failure (port in use, NAT, no public IP), we log + skip; plugin
// falls back to pull mode (cron polls /relay/v1/inbox-jwt instead of
// receiving pushes).

import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { pushEvent } from "./inbox.js";
import { dispatchEvent } from "./tg-dispatch.js";
import { autoActOnPushEvent } from "./poll-loop.js";
import { dashboardAuth } from "./tool.js";

const _here = path.dirname(fileURLToPath(import.meta.url));

// ─── 0.6.35: SDK-style event-triggered LLM hook queue ─────────────────
//
// Mirrors atel-sdk/bin/atel.mjs hookQueue pattern (line ~6180+). The
// 30s OpenClaw cron tick is the dominant tail-latency contributor for
// A2A milestone chains (measured 11.8 min for 5-milestone order, vs
// SDK's seconds-scale per step). Listener now spawns `openclaw agent
// --agent main --local -m "<focused prompt>"` immediately on the
// events we know how to react to, bypassing cron wait + giving the LLM
// a single-purpose prompt (vs the generic system-prompt sweep).
//
// Step 1 scope (this version):
//   - milestone_verified event, executor side ONLY → submit next milestone
//   - serial queue (one openclaw agent at a time — avoids session lock thrash)
//   - in-memory dedup with 10min TTL
//   - session-lock retry 5× with 3-13s backoff (same as SDK)
//   - 240s per-attempt timeout (same as SDK milestone hooks)
//   - cron tick still runs as before (safety net for missed hooks)
//   - opt-out via ATEL_HOOK_MODE=0
//
// Out of scope (added in later versions):
//   - milestone_submitted (requester verify), milestone_rejected,
//     milestone_plan_confirmed, order_accepted hooks
//   - auto-accept / auto-approve-plan moved into hook path
//   - cron interval relaxation
const HOOK_MODE_ENABLED = process.env.ATEL_HOOK_MODE !== "0";
const HOOK_DEDUP_TTL_MS = 10 * 60 * 1000;
const HOOK_TIMEOUT_MS = 240_000;
const HOOK_LOCK_RETRY_MAX = 5;
const HOOK_LOCK_RETRY_BASE_MS = 3000;
const HOOK_LOCK_RETRY_STEP_MS = 2000;

const hookQueue = [];
let hookWorkerBusy = false;
const hookDedup = new Map(); // dedupeKey -> ms

let cachedOurDid = null;
function loadOurDid(identityPath) {
  if (cachedOurDid) return cachedOurDid;
  if (!identityPath) return null;
  try {
    const id = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    if (typeof id?.did === "string") cachedOurDid = id.did;
  } catch {}
  return cachedOurDid;
}

// Role cache: orderId → { executorDid, requesterDid }. Populated when
// any event payload carries both DIDs (order_created, order_accepted,
// escrow_confirmed, etc.). Persisted to disk so a listener restart
// mid-order doesn't lose the role mapping.
function orderRoleCacheFile() {
  const home = process.env.HOME || "/root";
  return path.join(home, ".openclaw", "atel-mcp-order-roles.json");
}
function readOrderRoleCache() {
  try {
    const p = orderRoleCacheFile();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return {}; }
}
function saveOrderRoleCache(cache) {
  try {
    const p = orderRoleCacheFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn(`[atel-mcp/listener-hook] order role cache save failed: ${e && e.message}`);
  }
}
// Inspect a relay event and cache (orderId → {executorDid, requesterDid}).
// Platform's notifyAgent is one-sided: it sends order_created to the
// executor with payload.requesterDid only (no executorDid — recipient
// IS the executor, that's implicit). Likewise order_accepted goes to
// the requester with payload.executorDid only. To infer the missing
// side we use the receiving identity (ourDid via identityPath) plus
// the event type.
export function maybeCacheOrderRole(messageBody, identityPath) {
  const evt = (messageBody?.body && typeof messageBody.body === "object" && messageBody.body.event) ? messageBody.body : messageBody;
  const eventType = String(evt?.event || evt?.eventType || "").replace(/\./g, "_");
  const payload = evt?.payload || evt || {};
  const orderId = payload.orderId || payload.order_id;
  if (!orderId) return;
  let executorDid = payload.executorDid || payload.executor_did || null;
  let requesterDid = payload.requesterDid || payload.requester_did || null;
  // Infer the missing side from "we are the recipient" + event semantics
  const ourDid = loadOurDid(identityPath);
  if (ourDid) {
    if (eventType === "order_created" && !executorDid) {
      // platform pushed order_created → executor (us)
      executorDid = ourDid;
    } else if (eventType === "order_accepted" && !requesterDid) {
      // platform pushed order_accepted → requester (us)
      requesterDid = ourDid;
    }
  }
  if (!executorDid && !requesterDid) return; // can't determine anything from this event
  const cache = readOrderRoleCache();
  const existing = cache[orderId] || {};
  const merged = {
    executorDid: executorDid || existing.executorDid || null,
    requesterDid: requesterDid || existing.requesterDid || null,
    cachedAt: Date.now(),
  };
  if (existing.executorDid === merged.executorDid && existing.requesterDid === merged.requesterDid) {
    return; // already cached, skip write
  }
  cache[orderId] = merged;
  // Prune entries older than 7 days
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const k of Object.keys(cache)) {
    if ((cache[k].cachedAt || 0) < cutoff) delete cache[k];
  }
  saveOrderRoleCache(cache);
  console.log(`[atel-mcp/listener-hook] role cache ${orderId} executor=${merged.executorDid?.slice(-12) || "?"} requester=${merged.requesterDid?.slice(-12) || "?"}`);
}
function weAreExecutor(orderId, ourDid) {
  const cache = readOrderRoleCache();
  return cache[orderId]?.executorDid === ourDid;
}
function weAreRequester(orderId, ourDid) {
  const cache = readOrderRoleCache();
  return cache[orderId]?.requesterDid === ourDid;
}

function pruneHookDedup() {
  const now = Date.now();
  for (const [k, ts] of hookDedup) {
    if (now - ts > HOOK_DEDUP_TTL_MS) hookDedup.delete(k);
  }
}

function processHookQueue() {
  if (hookWorkerBusy) return;
  if (hookQueue.length === 0) return;
  hookWorkerBusy = true;
  const job = hookQueue.shift();
  runHookAttempt(job, 0);
}

function runHookAttempt(job, attempt) {
  const t0 = Date.now();
  execFile(
    "openclaw",
    ["agent", "--agent", "main", "--local", "-m", job.prompt],
    { timeout: HOOK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const dur = Date.now() - t0;
      const combined = ((err && err.message) || "") + " " + (stderr || "");
      const isLockError = /session.*lock|file lock|already running|EBUSY|locked/i.test(combined);
      if (err && isLockError && attempt < HOOK_LOCK_RETRY_MAX) {
        const delay = HOOK_LOCK_RETRY_BASE_MS + attempt * HOOK_LOCK_RETRY_STEP_MS;
        console.warn(`[atel-mcp/listener-hook] session locked event=${job.eventType} order=${job.orderId} attempt=${attempt + 1}/${HOOK_LOCK_RETRY_MAX} retry-in=${delay}ms`);
        setTimeout(() => runHookAttempt(job, attempt + 1), delay);
        return;
      }
      if (err) {
        console.warn(`[atel-mcp/listener-hook] FAILED event=${job.eventType} order=${job.orderId} dur=${dur}ms code=${err.code || ""} err="${(err.message || "").slice(0, 200)}" stderr="${(stderr || "").slice(0, 200)}"`);
      } else {
        console.log(`[atel-mcp/listener-hook] OK event=${job.eventType} order=${job.orderId} dur=${dur}ms`);
      }
      hookWorkerBusy = false;
      setImmediate(processHookQueue);
    }
  );
}

function buildPromptMilestoneVerified(orderId, milestoneIndex, currentMilestone, allComplete) {
  if (allComplete) return null;
  return [
    `[ATEL hook · executor · 0.6.38]`,
    `Order ${orderId}: milestone M${milestoneIndex} just verified.`,
    `You are the executor. Submit milestone M${currentMilestone} NOW.`,
    ``,
    `Steps:`,
    `1. atel__atel_order_get args={"orderId":"${orderId}"} — read description.`,
    `2. atel__atel_milestone_list args={"orderId":"${orderId}"} — read milestone[${currentMilestone}]'s title and any plan notes.`,
    `3. WRITE substantive deliverable content for M${currentMilestone} (real content matching the title + the order description). Match the language the order asks for. Not placeholder, not "TBD".`,
    `4. atel__atel_milestone_submit args={"orderId":"${orderId}","index":${currentMilestone},"content":"<your deliverable text>"}`,
    ``,
    `Do ONLY the above. Do not sweep other orders, do not list other agents, do not query balance. Reply NO_REPLY when done.`,
  ].join("\n");
}

function buildPromptMilestoneSubmitted(orderId, milestoneIndex) {
  return [
    `[ATEL hook · requester · 0.6.38]`,
    `Order ${orderId}: executor just submitted milestone M${milestoneIndex}.`,
    `You are the requester. Verify it (pass or reject) NOW.`,
    ``,
    `Steps:`,
    `1. atel__atel_order_get args={"orderId":"${orderId}"} — read the order description.`,
    `2. atel__atel_milestone_list args={"orderId":"${orderId}"} — find milestone[${milestoneIndex}], read its title + result_summary (the executor's submission).`,
    `3. Judge whether the submission satisfies M${milestoneIndex}'s goal in the context of the order description:`,
    `   - PASS if result_summary length ≥ 10 chars AND the content clearly relates to the order description / milestone title (the platform's verifier rule).`,
    `   - REJECT if result_summary is empty, placeholder text ("TBD", "I will..."), or wholly unrelated.`,
    `4a. If PASS: atel__atel_milestone_verify args={"orderId":"${orderId}","index":${milestoneIndex}}`,
    `4b. If REJECT: atel__atel_milestone_reject args={"orderId":"${orderId}","index":${milestoneIndex},"content":"<short specific reason — point at what is missing>"}`,
    ``,
    `Do ONLY the above. Do not sweep other orders, do not query balance. Reply NO_REPLY when done.`,
  ].join("\n");
}

// Accept either the unwrapped event shape ({event, payload, ...}) or
// the platform's HTTP wrapper ({body: {event, payload, ...}}). Both
// the push path (listener.js HTTP POST) and the pull path
// (poll-loop.js) call this helper.
function unwrapEvent(messageBody) {
  if (messageBody?.body && typeof messageBody.body === "object" && messageBody.body.event) {
    return messageBody.body;
  }
  return messageBody;
}

export function enqueueMilestoneVerifiedHook({ messageBody, identityPath }) {
  if (!HOOK_MODE_ENABLED) return;
  try {
    const ourDid = loadOurDid(identityPath);
    if (!ourDid) return;
    const evt = unwrapEvent(messageBody);
    const eventType = String(evt?.event || evt?.eventType || "").replace(/\./g, "_");
    if (eventType !== "milestone_verified") return;
    const payload = evt?.payload || evt || {};
    const orderId = payload.orderId || payload.order_id;
    const milestoneIndex = payload.milestoneIndex ?? payload.milestone_index;
    const currentMilestone = payload.currentMilestone ?? payload.current_milestone;
    const allComplete = payload.allComplete ?? payload.all_complete ?? false;
    if (!orderId || milestoneIndex == null || currentMilestone == null) {
      console.log(`[atel-mcp/listener-hook] milestone_verified missing fields (orderId=${orderId} mi=${milestoneIndex} cm=${currentMilestone}) — skip`);
      return;
    }

    if (!weAreExecutor(orderId, ourDid)) {
      // Role unknown (cache miss — order pre-dates this listener) OR
      // we're the requester. Either way, skip the hook. Cron-tick path
      // will pick up the event from inbox on its next sweep.
      console.log(`[atel-mcp/listener-hook] M${milestoneIndex} verified for ${orderId} — not us executor (or unknown role), skip hook; cron will handle`);
      return;
    }

    const dedupeKey = `milestone_verified:${orderId}:${milestoneIndex}`;
    pruneHookDedup();
    if (hookDedup.has(dedupeKey)) {
      console.log(`[atel-mcp/listener-hook] dedup hit ${dedupeKey} — skip`);
      return;
    }
    hookDedup.set(dedupeKey, Date.now());

    const prompt = buildPromptMilestoneVerified(orderId, milestoneIndex, currentMilestone, allComplete);
    if (!prompt) {
      console.log(`[atel-mcp/listener-hook] M${milestoneIndex} verified for ${orderId} is allComplete — no hook needed (platform auto-settles)`);
      return;
    }
    hookQueue.push({ eventType: "milestone_verified", orderId, prompt });
    console.log(`[atel-mcp/listener-hook] enqueued event=milestone_verified order=${orderId} mi=${milestoneIndex} → submit M${currentMilestone} (queue depth=${hookQueue.length}, busy=${hookWorkerBusy})`);
    processHookQueue();
  } catch (e) {
    console.warn(`[atel-mcp/listener-hook] enqueue error: ${e && e.message}`);
  }
}

// 0.6.38: requester-side hook. When executor submits a milestone, we
// (the requester) need to verify or reject it. Same queue/dedup/spawn
// machinery as enqueueMilestoneVerifiedHook; only the event type, role
// check, and prompt differ.
export function enqueueMilestoneSubmittedHook({ messageBody, identityPath }) {
  if (!HOOK_MODE_ENABLED) return;
  try {
    const ourDid = loadOurDid(identityPath);
    if (!ourDid) return;
    const evt = unwrapEvent(messageBody);
    const eventType = String(evt?.event || evt?.eventType || "").replace(/\./g, "_");
    if (eventType !== "milestone_submitted") return;
    const payload = evt?.payload || evt || {};
    const orderId = payload.orderId || payload.order_id;
    const milestoneIndex = payload.milestoneIndex ?? payload.milestone_index;
    if (!orderId || milestoneIndex == null) {
      console.log(`[atel-mcp/listener-hook] milestone_submitted missing fields (orderId=${orderId} mi=${milestoneIndex}) — skip`);
      return;
    }

    if (!weAreRequester(orderId, ourDid)) {
      // We're the executor (or role unknown). Don't fire — executor
      // doesn't need to verify their own submission. Cron path on
      // requester's side will still handle even if their plugin
      // doesn't have hooks yet.
      console.log(`[atel-mcp/listener-hook] M${milestoneIndex} submitted for ${orderId} — not us requester (or unknown role), skip hook`);
      return;
    }

    const dedupeKey = `milestone_submitted:${orderId}:${milestoneIndex}`;
    pruneHookDedup();
    if (hookDedup.has(dedupeKey)) {
      console.log(`[atel-mcp/listener-hook] dedup hit ${dedupeKey} — skip`);
      return;
    }
    hookDedup.set(dedupeKey, Date.now());

    const prompt = buildPromptMilestoneSubmitted(orderId, milestoneIndex);
    hookQueue.push({ eventType: "milestone_submitted", orderId, prompt });
    console.log(`[atel-mcp/listener-hook] enqueued event=milestone_submitted order=${orderId} mi=${milestoneIndex} → verify/reject (queue depth=${hookQueue.length}, busy=${hookWorkerBusy})`);
    processHookQueue();
  } catch (e) {
    console.warn(`[atel-mcp/listener-hook] enqueue error: ${e && e.message}`);
  }
}

// Coalesce burst push notifications into one cron wake within a 1s
// window. Avoids spawning openclaw cron run for every event when the
// platform retries or fires a tight stream of milestone events.
let pendingWakeTimer = null;
let cachedJobId = null;

function readMcpPollJobId() {
  if (cachedJobId) return cachedJobId;
  try {
    const home = process.env.HOME || "/root";
    const p = path.join(home, ".openclaw", "cron", "jobs.json");
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    const job = (d.jobs || []).find((j) => j.name === "atel-mcp-poll");
    if (job && job.id) {
      cachedJobId = job.id;
      return cachedJobId;
    }
  } catch {}
  return null;
}

export function wakeCronNow() {
  // Coalesce: if multiple pushes arrive within 1s, fire one cron wake.
  //
  // Method: bump the atel-mcp-poll job's `nextRunAtMs` in jobs.json to
  // "now". The gateway's cron scheduler watches that file and re-reads
  // when fields change, so this triggers an immediate run on the next
  // scheduler tick (typically <1s). We tried `openclaw cron run <id>`
  // first but the CLI tries to connect to the gateway WebSocket and
  // fails ("gateway closed") on this setup, so jobs.json mutation is
  // the reliable in-process path.
  if (pendingWakeTimer) return;
  pendingWakeTimer = setTimeout(() => {
    pendingWakeTimer = null;
    try {
      const home = process.env.HOME || "/root";
      const p = path.join(home, ".openclaw", "cron", "jobs.json");
      if (!fs.existsSync(p)) {
        console.warn("[atel-mcp/listener] wake skipped — jobs.json not found");
        return;
      }
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const job = (d.jobs || []).find((j) => j.name === "atel-mcp-poll");
      if (!job) {
        console.warn("[atel-mcp/listener] wake skipped — atel-mcp-poll job not in jobs.json");
        return;
      }
      const wasNext = job.state?.nextRunAtMs;
      const now = Date.now();
      // Only bump if next run is meaningfully in the future (>2s) —
      // otherwise we'd be racing a scheduler that's already about to
      // fire, and our write+rewrite churn is wasted I/O.
      if (typeof wasNext === "number" && wasNext - now < 2000) {
        return;
      }
      if (!job.state) job.state = {};
      job.state.nextRunAtMs = now;
      job.updatedAtMs = now;
      fs.writeFileSync(p, JSON.stringify(d, null, 2));
      console.log(`[atel-mcp/listener] wake — bumped nextRunAtMs (was ${wasNext ? Math.round((wasNext - now) / 1000) + "s away" : "unset"})`);
    } catch (e) {
      console.warn(`[atel-mcp/listener] wake error: ${e && e.message}`);
    }
  }, 1000);
}

let serverInstance = null;

export async function startListener({ host = "0.0.0.0", port = 3101, hmacSecret = null, platformBaseUrl = null, identityPath = null }) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "atel-mcp-openclaw-listener" }));
      return;
    }

    // POST /dashboard-auth — atel-mcp server proxies LLM tool calls to here
    // because the plugin needs the user's local identity.json secret key to
    // sign the dashboard /login challenge. The server can't sign locally
    // (no private key), and the plugin-registered "atel_mcp" tool was
    // silently dropped by OpenClaw loader after 2026-05-07. So we expose
    // dashboard_auth as a listener HTTP endpoint, called from server-side
    // `atel_dashboard_auth` tool, which the LLM sees through mcp.servers
    // transport.
    //
    // Auth: HMAC over `timestamp\ncode` using the same hmacSecret as relay
    // push, so only atel-mcp server (which knows the per-agent secret via
    // register_endpoint) can call this endpoint. Without HMAC, anyone on
    // the public internet could submit auth codes for any agent on this box.
    if (req.method === "POST" && (req.url || "").startsWith("/dashboard-auth")) {
      const chunks0 = [];
      req.on("data", (c) => chunks0.push(c));
      req.on("end", async () => {
        try {
          const raw = Buffer.concat(chunks0).toString("utf-8");
          let body;
          try { body = JSON.parse(raw || "{}"); } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "INVALID_JSON" }));
            return;
          }
          const code = String(body?.code || "").trim();
          const ts = String(req.headers["x-atel-timestamp"] || "");
          const providedHmac = String(req.headers["x-atel-push-hmac"] || "");
          if (hmacSecret) {
            const mac = crypto.createHmac("sha256", hmacSecret);
            mac.update(ts);
            mac.update("\n");
            mac.update(code);
            const expected = mac.digest("hex");
            if (providedHmac !== expected) {
              res.statusCode = 401;
              res.end(JSON.stringify({ ok: false, error: "HMAC_MISMATCH" }));
              return;
            }
          }
          if (!identityPath || !platformBaseUrl) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "LISTENER_NOT_CONFIGURED", message: "identityPath / platformBaseUrl not passed to startListener" }));
            return;
          }
          const result = await dashboardAuth({ identityPath, platformBaseUrl }, code);
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: "INTERNAL", message: (e && e.message) || String(e) }));
        }
      });
      return;
    }
    // Platform's relay-push dispatcher POSTs to <endpoint><path>, where
    // <path> varies by message kind:
    //   - "/atel/v1/relay-message"  for plain p2p text (atel_send_message)
    //   - "/atel/v1/notify"         for A2A events (order_*, milestone_*, settled, ...)
    // Both share the same envelope shape (target_did via header, body in
    // request body). Listener accepts both. The earlier "/atel-relay"
    // alias is also kept for early PoC tooling.
    const url = req.url || "";
    const isPlatformPush =
      req.method === "POST" &&
      (url === "/atel/v1/relay-message" || url === "/atel/v1/notify");
    const isLegacyAlias = req.method === "POST" && url === "/atel-relay";
    if (!isPlatformPush && !isLegacyAlias) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");

        // Platform protocol (verified 2026-05-04 from
        // internal/relay/dispatcher.go):
        //   - target_did in HEADER X-Atel-Target-Did (not body)
        //   - sender_did in HEADER X-Atel-Sender
        //   - HMAC signs: timestamp + "\n" + target_did + "\n" + body
        //   - Body is the RAW relay message (no target/sender wrapper)
        const did = req.headers["x-atel-target-did"] || "";
        const senderDid = req.headers["x-atel-sender"] || "";
        const timestamp = req.headers["x-atel-timestamp"] || "";

        // HMAC verification — see Plugin-0.2.1 design doc Q4.
        const providedHmac = req.headers["x-atel-push-hmac"] || "";
        if (hmacSecret) {
          const mac = crypto.createHmac("sha256", hmacSecret);
          mac.update(timestamp);
          mac.update("\n");
          mac.update(did);
          mac.update("\n");
          mac.update(raw);
          const expected = mac.digest("hex");
          if (providedHmac !== expected) {
            console.warn("[atel-mcp/listener] HMAC mismatch (or missing) — rejecting push");
            res.statusCode = 401;
            res.end("hmac mismatch");
            return;
          }
        } else if (providedHmac) {
          console.warn("[atel-mcp/listener] HMAC header present but no secret configured — accepting (set ATEL_RELAY_HMAC_SECRET to verify)");
        }

        if (!did) {
          // Legacy alias (if anyone POSTs to /atel-relay with body
          // shape we used in early PoC) — also accept body.target_did
          // for compatibility.
          let body;
          try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
          const fallbackDid = body.target_did || body.targetDid;
          if (!fallbackDid) {
            res.statusCode = 400;
            res.end("missing target_did (header X-Atel-Target-Did)");
            return;
          }
          pushEvent(fallbackDid, body);
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, queued: true, source: "legacy-body" }));
          return;
        }

        // Standard platform path: body is the relay message itself.
        let messageBody;
        try { messageBody = JSON.parse(raw || "{}"); } catch { messageBody = { raw: raw }; }
        const event = {
          target_did: did,
          sender_did: senderDid,
          timestamp,
          message: messageBody,
        };
        pushEvent(did, event);
        // Format and send the canonical TG card for this event without
        // waiting for the cron-driven agent to react. Agent's job is
        // pure state mutation; this dispatch is pure notification. No
        // LLM in the loop here — output is deterministic. We pass
        // target_did so dispatch can choose role-aware wording (e.g.
        // executor receives "你已接受订单", requester receives
        // "订单已被接受").
        dispatchEvent(messageBody, { extensionDir: _here, targetDid: did }).catch((e) => {
          console.warn("[atel-mcp/listener] tg dispatch error:", e && e.message);
        });
        // 0.6.17 fix R10: also fire hardcoded autoAct on push-route events.
        // Pre-0.6.17, autoActOnEvent only ran in poll-loop's pull path —
        // when platform's push to listener succeeded the event was ack'd
        // immediately and poll-loop never re-pulled it, so order_created /
        // order_accepted hardcoded auto-accept / auto-approve-plan never
        // fired. Manifested as orders stuck in "created" / "milestone_review"
        // for any plugin whose listener was reachable from platform.
        const dispatchInput = messageBody?.body && typeof messageBody.body === "object"
          ? messageBody.body
          : messageBody;
        autoActOnPushEvent({ platformBaseUrl, identityPath, dispatchInput }).catch((e) => {
          console.warn("[atel-mcp/listener] push autoAct error:", e && e.message);
        });
        // Push-driven cron wake: fire openclaw cron run for the
        // atel-mcp-poll job so the agent processes this event NOW,
        // instead of waiting up to 30s for the next scheduled tick.
        wakeCronNow();
        // 0.6.35 hook path: cache role mappings on order_* events,
        // then enqueue a focused-prompt LLM spawn for milestone_verified
        // events (executor side only). Runs in parallel to the cron-tick
        // path which is still the safety net.
        maybeCacheOrderRole(messageBody, identityPath);
        enqueueMilestoneVerifiedHook({ messageBody, identityPath });
        enqueueMilestoneSubmittedHook({ messageBody, identityPath });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, queued: true }));
      } catch (err) {
        console.error("[atel-mcp/listener] handler error:", err && err.message);
        res.statusCode = 500;
        res.end("internal error");
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      serverInstance = server;
      console.log(`[atel-mcp/listener] listening on ${host}:${port} (POST /atel-relay)`);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function stopListener() {
  if (serverInstance) {
    try { serverInstance.close(); } catch {}
    serverInstance = null;
  }
}
