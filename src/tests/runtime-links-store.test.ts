import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { getRuntimeLink, getRuntimeLinkSecret, listRuntimeLinks, removeRuntimeLink, upsertRuntimeLink } from '../runtime-links/store.js';

function configFor(path: string) {
  return loadConfig({
    ATEL_PLATFORM_BASE_URL: 'https://api.atelai.org',
    ATEL_MCP_RUNTIME_LINKS_PATH: path,
  } as never);
}

test('runtime-links store supports upsert, list, get, and remove', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atel-runtime-links-'));
  const file = join(dir, 'runtime-links.json');
  const config = configFor(file);

  try {
    assert.deepEqual(await listRuntimeLinks(config), []);

    await upsertRuntimeLink(config, {
      hostedDid: 'did:atel:ed25519:host-a',
      runtimeDid: 'did:atel:ed25519:runtime-a',
      backend: 'linked-runtime',
      status: 'linked',
      endpoint: 'https://runtime-a.example.com/mcp',
      authToken: 'secret-a',
    });

    await upsertRuntimeLink(config, {
      hostedDid: 'did:atel:ed25519:host-b',
      runtimeDid: 'did:atel:ed25519:runtime-b',
      backend: 'sdk-runtime',
      status: 'linked',
    });

    const links = await listRuntimeLinks(config);
    assert.equal(links.length, 2);
    assert.equal(links[0]?.hostedDid, 'did:atel:ed25519:host-a');
    assert.equal((await getRuntimeLink(config, 'did:atel:ed25519:host-b'))?.runtimeDid, 'did:atel:ed25519:runtime-b');
    assert.equal((await getRuntimeLink(config, 'did:atel:ed25519:host-a'))?.endpoint, 'https://runtime-a.example.com/mcp');
    assert.equal((await getRuntimeLink(config, 'did:atel:ed25519:host-a') as { authToken?: string } | null)?.authToken, undefined);
    assert.equal((await getRuntimeLinkSecret(config, 'did:atel:ed25519:host-a'))?.authToken, 'secret-a');

    await upsertRuntimeLink(config, {
      hostedDid: 'did:atel:ed25519:host-b',
      runtimeDid: 'did:atel:ed25519:runtime-b2',
      backend: 'sdk-runtime',
      status: 'degraded',
    });
    assert.equal((await getRuntimeLink(config, 'did:atel:ed25519:host-b'))?.runtimeDid, 'did:atel:ed25519:runtime-b2');

    const raw = JSON.parse(await readFile(file, 'utf8')) as { links: Array<{ hostedDid: string; authToken?: string }> };
    assert.equal(raw.links.length, 2);
    assert.equal(raw.links[0]?.authToken, 'secret-a');

    assert.equal(await removeRuntimeLink(config, 'did:atel:ed25519:host-a'), true);
    assert.equal(await removeRuntimeLink(config, 'did:atel:ed25519:host-a'), false);
    assert.deepEqual((await listRuntimeLinks(config)).map((item) => item.hostedDid), ['did:atel:ed25519:host-b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
