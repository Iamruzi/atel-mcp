import { loadConfig } from '../config.js';
import type { StoredRuntimeLinkRecord } from '../contracts/runtime.js';
import { listRuntimeLinks, removeRuntimeLink, upsertRuntimeLink } from '../runtime-links/store.js';

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part?.startsWith('--')) continue;
    const key = part.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      result[key] = 'true';
      continue;
    }
    result[key] = value;
    i += 1;
  }
  return result;
}

function requireArg(args: Record<string, string>, key: string): string {
  const value = args[key]?.trim();
  if (!value) throw new Error(`Missing required argument: --${key}`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [command = 'list', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const config = loadConfig();

  if (command === 'list') {
    print({ ok: true, path: config.runtimeLinksPath, links: await listRuntimeLinks(config) });
    return;
  }

  if (command === 'upsert') {
    const link: StoredRuntimeLinkRecord = {
      hostedDid: requireArg(args, 'hosted-did'),
      runtimeDid: requireArg(args, 'runtime-did'),
      backend: requireArg(args, 'backend') as StoredRuntimeLinkRecord['backend'],
      status: args['status'] as StoredRuntimeLinkRecord['status'] | undefined,
      endpoint: args['endpoint'],
      relayBaseUrl: args['relay-base-url'],
      authToken: args['auth-token'],
      lastSeenAt: args['last-seen-at'],
    };

    if (link.backend !== 'sdk-runtime' && link.backend !== 'linked-runtime') {
      throw new Error('Invalid --backend. Expected sdk-runtime or linked-runtime');
    }

    await upsertRuntimeLink(config, link);
    print({ ok: true, path: config.runtimeLinksPath, link });
    return;
  }

  if (command === 'remove') {
    const hostedDid = requireArg(args, 'hosted-did');
    const removed = await removeRuntimeLink(config, hostedDid);
    print({ ok: true, path: config.runtimeLinksPath, hostedDid, removed });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  print({ ok: false, message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
