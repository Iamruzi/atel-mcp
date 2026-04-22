import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AtelMcpConfig } from '../config.js';
import type { RuntimeLinkRecord, StoredRuntimeLinkRecord } from '../contracts/runtime.js';

interface RuntimeLinkStoreShape {
  links?: StoredRuntimeLinkRecord[];
}

function resolveRuntimeLinksPath(config: AtelMcpConfig): string {
  return resolve(config.runtimeLinksPath);
}

function sanitizeRuntimeLink(link: StoredRuntimeLinkRecord): RuntimeLinkRecord {
  return {
    hostedDid: link.hostedDid,
    runtimeDid: link.runtimeDid,
    backend: link.backend,
    status: link.status,
    endpoint: link.endpoint,
    relayBaseUrl: link.relayBaseUrl,
    lastSeenAt: link.lastSeenAt,
    metadata: link.metadata,
  };
}

async function readRuntimeLinkStore(path: string): Promise<RuntimeLinkStoreShape> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as RuntimeLinkStoreShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeRuntimeLinkStore(path: string, links: StoredRuntimeLinkRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ links }, null, 2) + '\n', 'utf8');
}

function sortLinks<T extends StoredRuntimeLinkRecord>(links: T[]): T[] {
  return [...links].sort((a, b) => a.hostedDid.localeCompare(b.hostedDid));
}

async function listRuntimeLinksInternal(config: AtelMcpConfig): Promise<StoredRuntimeLinkRecord[]> {
  const store = await readRuntimeLinkStore(resolveRuntimeLinksPath(config));
  return Array.isArray(store.links) ? sortLinks(store.links) : [];
}

export async function listRuntimeLinks(config: AtelMcpConfig): Promise<RuntimeLinkRecord[]> {
  return (await listRuntimeLinksInternal(config)).map(sanitizeRuntimeLink);
}

export async function getRuntimeLink(config: AtelMcpConfig, hostedDid: string): Promise<RuntimeLinkRecord | null> {
  const match = (await listRuntimeLinksInternal(config)).find((link) => link.hostedDid === hostedDid);
  return match ? sanitizeRuntimeLink(match) : null;
}

export async function getRuntimeLinkSecret(config: AtelMcpConfig, hostedDid: string): Promise<StoredRuntimeLinkRecord | null> {
  const match = (await listRuntimeLinksInternal(config)).find((link) => link.hostedDid === hostedDid);
  return match ?? null;
}

export async function upsertRuntimeLink(config: AtelMcpConfig, link: StoredRuntimeLinkRecord): Promise<RuntimeLinkRecord> {
  const path = resolveRuntimeLinksPath(config);
  const links = await listRuntimeLinksInternal(config);
  const filtered = links.filter((item) => item.hostedDid !== link.hostedDid);
  const next = sortLinks([...filtered, link]);
  await writeRuntimeLinkStore(path, next);
  return sanitizeRuntimeLink(link);
}

export async function removeRuntimeLink(config: AtelMcpConfig, hostedDid: string): Promise<boolean> {
  const path = resolveRuntimeLinksPath(config);
  const links = await listRuntimeLinksInternal(config);
  const next = links.filter((item) => item.hostedDid !== hostedDid);
  if (next.length === links.length) return false;
  await writeRuntimeLinkStore(path, next);
  return true;
}
