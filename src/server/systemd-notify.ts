// systemd sd_notify integration.
//
// When systemd starts the service with Type=notify + WatchdogSec=N, this
// module sends:
//   - READY=1     once the HTTP listener is up (systemd transitions the
//                 unit from 'activating' → 'active'; otherwise Type=notify
//                 would time out at the default 90s)
//   - WATCHDOG=1  at WATCHDOG_USEC/2 cadence so systemd knows the process
//                 is alive. Missing the deadline triggers Restart=on-watchdog
//                 (our unit uses Restart=always, same effect).
//   - STOPPING=1  on graceful shutdown so the watchdog miss isn't logged
//                 as a fault.
//
// Outside systemd (NOTIFY_SOCKET unset) this is a no-op. We shell out to
// systemd-notify(1) rather than open a UNIX datagram socket directly:
//   - Node's dgram.createSocket() doesn't expose AF_UNIX SOCK_DGRAM
//   - systemd-notify(1) is shipped with every systemd build, so available
//     wherever NOTIFY_SOCKET is set
//   - shell-out cost (1ms-ish, every 15s) is negligible
//
// One non-obvious gotcha: WATCHDOG=1 sent from a forked child process is
// IGNORED by systemd unless NotifyAccess=all is set on the unit. Default
// NotifyAccess=main is fine since we send from the main Node process.

import { execFile } from 'node:child_process';

let watchdogTimer: NodeJS.Timeout | null = null;

function sendNotify(payload: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  // systemd-notify accepts each "FIELD=value" as a separate argv entry,
  // OR a single string with newline separators. We use one-arg-per-line
  // to avoid quoting headaches.
  const args = payload.split('\n').filter(Boolean);
  execFile('systemd-notify', args, { timeout: 2000 }, () => {
    // Best-effort: don't surface failures. If systemd-notify is missing
    // or NOTIFY_SOCKET points to a stale path, the worst case is a
    // watchdog miss → systemd restarts us. That's the right behavior.
  });
}

/**
 * Mark the service ready. Idempotent — calling multiple times is harmless.
 * Call once after the HTTP listener is bound.
 */
export function notifyReady(): void {
  sendNotify('READY=1');
}

/**
 * Start sending WATCHDOG=1 at half the WATCHDOG_USEC interval. Call after
 * the listener is up. Returns a stop function for tests / graceful shutdown.
 */
export function startWatchdog(): () => void {
  const usec = process.env.WATCHDOG_USEC;
  if (!usec) return () => { /* no-op */ };
  // WATCHDOG_USEC is microseconds. Send WATCHDOG=1 at half cadence so we
  // never miss a deadline due to scheduling jitter. Floor at 1s so a tiny
  // misconfigured WatchdogSec= doesn't burn CPU.
  const intervalMs = Math.max(1000, Math.floor(Number(usec) / 2_000));
  if (watchdogTimer) return () => { /* already started */ };
  watchdogTimer = setInterval(() => {
    sendNotify('WATCHDOG=1');
  }, intervalMs);
  // Don't pin the event loop alive on the watchdog alone.
  watchdogTimer.unref?.();
  return () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };
}

/**
 * Tell systemd we're shutting down cleanly. Call from SIGTERM / SIGINT
 * handlers before process exit.
 */
export function notifyStopping(): void {
  sendNotify('STOPPING=1');
}
