import { loadConfig } from '../config.js';
import { createHttpTransportApp } from './http-transport.js';
import { notifyReady, startWatchdog, notifyStopping } from './systemd-notify.js';

const config = loadConfig();

// Startup preflight log — dump non-secret config so ops can verify
// production deploy didn't silently drift. Visible in journalctl at
// startup; catches "missing wallet.transfer scope" / runtime-links flag
// flipped by accident etc. before they ship.
console.log('[atel-mcp] startup preflight:');
console.log(`  environment:          ${config.environment}`);
console.log(`  platform:             ${config.platformBaseUrl}`);
console.log(`  defaultScopes:        ${config.defaultRemoteScopes.join(', ')}`);
console.log(`  runtimeLinksEnabled:  ${config.runtimeLinksEnabled}`);

const app = createHttpTransportApp();

const server = app.listen(config.port, config.host, () => {
  const listenPath = config.routeBasePath ? `${config.routeBasePath}/mcp` : '/mcp';
  console.log(`[atel-mcp] listening on http://${config.host}:${config.port}${listenPath}`);
  // sd_notify integration: under systemd Type=notify these flip the unit
  // to 'active' and start the watchdog ping loop. No-ops outside systemd.
  notifyReady();
  startWatchdog();
});

// Graceful shutdown: tell systemd we're stopping (so the upcoming silence
// isn't a watchdog miss), drain in-flight requests, then exit. SIGTERM is
// what `systemctl stop` sends; SIGINT covers Ctrl-C in dev.
function shutdown(signal: NodeJS.Signals) {
  console.log(`[atel-mcp] received ${signal}, shutting down`);
  notifyStopping();
  server.close((err) => {
    if (err) {
      console.error('[atel-mcp] server.close error:', err);
      process.exit(1);
    }
    process.exit(0);
  });
  // Hard timeout in case sockets hang. systemd's TimeoutStopSec= is the
  // outer bound; this is an inner safety so we don't get SIGKILLed.
  setTimeout(() => {
    console.warn('[atel-mcp] shutdown timeout — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
