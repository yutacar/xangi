import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SyncStateStore } from '../src/notion-sync/state-store.js';

const mapping = {
  id: 'agents',
  direction: 'notion-to-local' as const,
  localPath: 'AGENTS.md',
  notionPageId: 'page-agents',
};

describe('SyncStateStore', () => {
  it('treats prototype-like mapping ids as ordinary absent records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notion-state-'));
    const store = new SyncStateStore(root);
    const special = { ...mapping, id: 'constructor' };

    await expect(store.load(special)).resolves.toBeUndefined();
  });
  it('atomically persists strict mapping state with private permissions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-notion-state-'));
    const store = new SyncStateStore(dataDir);
    await store.save(mapping, {
      baseHash: 'abc',
      lastLocalHash: 'abc',
      lastNotionEditedTime: '2026-07-15T00:00:00.000Z',
      status: 'synced',
    });
    expect(await store.load(mapping)).toMatchObject({
      mappingId: 'agents',
      baseHash: 'abc',
      status: 'synced',
    });
    expect((await stat(join(dataDir, 'notion-sync', 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects unknown state fields and identity mismatch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-notion-state-'));
    const statePath = join(dataDir, 'notion-sync', 'state.json');
    const store = new SyncStateStore(dataDir);
    await store.save(mapping, {
      baseHash: 'a',
      lastLocalHash: 'a',
      lastNotionEditedTime: 't',
      status: 'synced',
    });
    const raw = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    (raw.records as Record<string, Record<string, unknown>>).agents.extra = true;
    await writeFile(statePath, JSON.stringify(raw));
    await expect(store.load(mapping)).rejects.toThrow(/state/i);

    delete (raw.records as Record<string, Record<string, unknown>>).agents.extra;
    (raw.records as Record<string, Record<string, unknown>>).agents.localPath = 'OTHER.md';
    await writeFile(statePath, JSON.stringify(raw));
    await expect(store.load(mapping)).rejects.toThrow(/identity/i);
  });

  it('returns undefined before the first successful sync', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'xangi-notion-state-'));
    expect(await new SyncStateStore(dataDir).load(mapping)).toBeUndefined();
  });
});
