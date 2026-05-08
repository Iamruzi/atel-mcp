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
import { spawn } from "node:child_process";
import { pushEvent } from "./inbox.js";
import { dispatchEvent } from "./tg-dispatch.js";

const _here = path.dirname(fileURLToPath(import.meta.url));

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

function wakeCronNow() {
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

export async function startListener({ host = "0.0.0.0", port = 3101, hmacSecret = null }) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "atel-mcp-openclaw-listener" }));
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
        // Push-driven cron wake: fire openclaw cron run for the
        // atel-mcp-poll job so the agent processes this event NOW,
        // instead of waiting up to 30s for the next scheduled tick.
        // Coalesced: bursts within 1s fire one wake. Saves 0-30s per
        // state transition (e.g. M0 verified → M1 submit was
        // bottlenecked by cron interval prior to this).
        wakeCronNow();
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
