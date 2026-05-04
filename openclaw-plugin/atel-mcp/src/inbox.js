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

function inboxFile(did) {
  // Truncated SHA-256 hex; collision-resistant for our scale (one row
  // per ATEL identity), short enough to keep filesystem happy.
  const h = crypto.createHash("sha256").update(did).digest("hex").slice(0, 16);
  return path.join(INBOX_DIR, `${h}.jsonl`);
}

export function pushEvent(did, event) {
  if (!did || !event) return false;
  ensureInboxDir();
  const line = JSON.stringify({ event, receivedAt: Date.now() }) + "\n";
  fs.appendFileSync(inboxFile(did), line);
  // touch a global heartbeat file so isIdle() can answer cross-process
  fs.writeFileSync(path.join(INBOX_DIR, ".last-event-at"), String(Date.now()));
  return true;
}

// Atomic-ish drain: rename the inbox file to a tmp name (preventing
// further appends from leaking into the read), read everything, delete.
// If the file doesn't exist, return [].
export function drainEvents(did) {
  if (!did) return [];
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
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.receivedAt && row.receivedAt < cutoff) continue;
      events.push(row.event);
    } catch {
      // skip malformed line — defensive
    }
  }
  // Enforce per-drain size cap (oldest dropped first if over limit)
  if (events.length > MAX_PER_DID) {
    events.splice(0, events.length - MAX_PER_DID);
  }
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
