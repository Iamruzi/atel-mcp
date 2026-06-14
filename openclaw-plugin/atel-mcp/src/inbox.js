// Filesystem-backed event inbox for ATEL platform → plugin pushes.
//
// Architectural note (verified 2026-05-04 PoC):
// OpenClaw loads plugin once in the gateway process (where the HTTP
// listener binds) AND ONCE PER agent turn in a separate child process
// (where the tool's execute() runs). Two processes, no shared memory.
// So the inbox CANNOT be an in-memory Map — listener (gateway) and
// poll_events (agent child) wouldn't see each other's data.
//
// Solution: append to a JSONL file per DID. Listener writes via append.
// Reader (poll_events) atomically renames the file to a temp path,
// reads, then deletes — equivalent to drain semantics with concurrent-
// writer safety (rename is atomic on POSIX; appended writes always
// extend the file, never overwrite).
//
// Storage path: ~/.openclaw/atel-mcp-inbox/<did-hash>.jsonl
// Why hashed: DIDs are long; filesystem path length limits.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const MAX_PER_DID = 100;
const TTL_MS = 24 * 3600 * 1000;

const INBOX_DIR =
  process.env.ATEL_MCP_INBOX_DIR ||
  path.join(process.env.HOME || os.homedir() || ".", ".openclaw", "atel-mcp-inbox");

function ensureInboxDir() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}

// Clean up stale tmp files left over from drains that crashed mid-rename.
// Without this, a host that crashes during drain accumulates *.read-*
// files that grow forever. Called opportunistically from drainEvents and
// pushEvent so we don't need a separate cron.
const STALE_TMP_AGE_MS = 5 * 60 * 1000;
function cleanStaleTmpFiles() {
  try {
    const cutoff = Date.now() - STALE_TMP_AGE_MS;
    for (const name of fs.readdirSync(INBOX_DIR)) {
      if (!name.includes(".read-")) continue;
      const full = path.join(INBOX_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      } catch {
        // file vanished concurrently or stat failed — fine
      }
    }
  } catch {
    // inbox dir might not exist yet on first call — ignore
  }
}

function inboxFile(did) {
  // Truncated SHA-256 hex; collision-resistant for our scale (one row
  // per ATEL identity), short enough to keep filesystem happy.
  const h = crypto.createHash("sha256").update(did).digest("hex").slice(0, 16);
  return path.join(INBOX_DIR, `${h}.jsonl`);
}

export function pushEvent(did, event) {
  if (!did || !event) return false;
  ensureInboxDir();
  // Opportunistic cleanup — every push is a chance to mop up stale tmps
  // without paying the cost of a separate sweeper.
  cleanStaleTmpFiles();
  const line = JSON.stringify({ event, receivedAt: Date.now() }) + "\n";
  fs.appendFileSync(inboxFile(did), line);
  // touch a global heartbeat file so isIdle() can answer cross-process
  fs.writeFileSync(path.join(INBOX_DIR, ".last-event-at"), String(Date.now()));
  return true;
}

// Atomic-ish drain: rename the inbox file to a tmp name (preventing
// further appends from leaking into the read), read everything, delete.
// If the file doesn't exist, return [].
//
// Returns events newest-first so the agent processes recent events first
// when summarizing — matches user expectation that "the latest thing
// that happened" is the most relevant signal.
export function drainEvents(did) {
  if (!did) return [];
  ensureInboxDir();
  cleanStaleTmpFiles(); // opportunistic
  const src = inboxFile(did);
  if (!fs.existsSync(src)) return [];
  const tmp = src + `.read-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(src, tmp);
  } catch (err) {
    // Race with another reader, or file vanished — treat as empty
    if (err.code === "ENOENT") return [];
    throw err;
  }
  let raw = "";
  try {
    raw = fs.readFileSync(tmp, "utf-8");
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  const cutoff = Date.now() - TTL_MS;
  const events = [];
  let droppedTTL = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.receivedAt && row.receivedAt < cutoff) {
        droppedTTL += 1;
        continue;
      }
      // Tag each event with its receivedAt so the agent can decide what's
      // recent enough to act on (avoid acting on hours-old stale events
      // that arrived while the agent was offline).
      events.push({ ...row.event, _receivedAt: row.receivedAt });
    } catch {
      // skip malformed line — defensive
    }
  }
  if (droppedTTL > 0) {
    console.log(`[atel-mcp/inbox] drained, dropped ${droppedTTL} stale events (>${TTL_MS / 3600 / 1000}h old)`);
  }
  // Enforce per-drain size cap (newest kept; oldest dropped if over limit)
  if (events.length > MAX_PER_DID) {
    const dropped = events.length - MAX_PER_DID;
    events.splice(0, dropped);
    console.log(`[atel-mcp/inbox] over MAX_PER_DID — dropped ${dropped} oldest events`);
  }
  // Newest first.
  events.reverse();
  return events;
}

// Cross-process idle check via heartbeat file mtime.
export function isIdle(thresholdMs = 5 * 60 * 1000) {
  const beat = path.join(INBOX_DIR, ".last-event-at");
  if (!fs.existsSync(beat)) return true;
  try {
    const ts = Number(fs.readFileSync(beat, "utf-8")) || 0;
    return Date.now() - ts > thresholdMs;
  } catch {
    return true;
  }
}

// Diagnostics — count files in inbox dir.
export function getStats() {
  ensureInboxDir();
  let didCount = 0;
  let eventCount = 0;
  for (const name of fs.readdirSync(INBOX_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    didCount += 1;
    try {
      const raw = fs.readFileSync(path.join(INBOX_DIR, name), "utf-8");
      eventCount += raw.split("\n").filter((l) => l.trim()).length;
    } catch {}
  }
  let lastEventAt = 0;
  try {
    lastEventAt = Number(fs.readFileSync(path.join(INBOX_DIR, ".last-event-at"), "utf-8")) || 0;
  } catch {}
  return {
    didCount,
    eventCount,
    lastEventAt,
    lastEventAgoMs: lastEventAt === 0 ? null : Date.now() - lastEventAt,
    inboxDir: INBOX_DIR,
  };
}
