import { describe, expect, it } from 'vitest';
import { SyncEngine } from '../src/notion-sync/engine.js';
import type {
  DocumentSnapshot,
  MappingState,
  MappingStateUpdate,
  SyncMapping,
} from '../src/notion-sync/types.js';

const pullMapping: SyncMapping = {
  id: 'agents',
  direction: 'notion-to-local',
  localPath: 'AGENTS.md',
  notionPageId: 'notion-agents',
};
const pushMapping: SyncMapping = {
  id: 'note',
  direction: 'local-to-notion',
  localPath: 'publish/note.md',
  notionPageId: 'notion-note',
};

class DocumentFixture {
  writes: string[] = [];
  backups: string[] = [];
  constructor(public snapshot: DocumentSnapshot | undefined) {}
  async read(): Promise<DocumentSnapshot | undefined> {
    return this.snapshot;
  }
  async backup(_id: string, markdown: string): Promise<void> {
    this.backups.push(markdown);
  }
  async write(_id: string, markdown: string): Promise<DocumentSnapshot> {
    this.writes.push(markdown);
    this.snapshot = { markdown, hash: `hash:${markdown}`, editedTime: 'written' };
    return this.snapshot;
  }
}

class StateFixture {
  value: MappingState | undefined;
  saves: MappingStateUpdate[] = [];
  async load(): Promise<MappingState | undefined> {
    return this.value;
  }
  async save(mapping: SyncMapping, update: MappingStateUpdate): Promise<void> {
    this.saves.push(update);
    this.value = {
      mappingId: mapping.id,
      localPath: mapping.localPath,
      notionPageId: mapping.notionPageId,
      direction: mapping.direction,
      ...update,
    };
  }
}

const snap = (markdown: string, editedTime = 'now'): DocumentSnapshot => ({
  markdown,
  hash: `hash:${markdown}`,
  editedTime,
});

describe('SyncEngine', () => {
  it('pulls from a Notion source and persists state only after the write', async () => {
    const workspace = new DocumentFixture(undefined);
    const notion = new DocumentFixture(snap('from notion'));
    const state = new StateFixture();
    const result = await new SyncEngine(workspace, notion, state).sync(pullMapping);
    expect(result.action).toBe('pull');
    expect(workspace.writes).toEqual(['from notion']);
    expect(state.value).toMatchObject({ baseHash: 'hash:from notion', status: 'synced' });
  });

  it('pushes from a local source', async () => {
    const workspace = new DocumentFixture(snap('from local'));
    const notion = new DocumentFixture(undefined);
    const state = new StateFixture();
    const result = await new SyncEngine(workspace, notion, state).sync(pushMapping);
    expect(result.action).toBe('push');
    expect(notion.writes).toEqual(['from local']);
  });

  it('backs up an existing local destination before applying a Notion change', async () => {
    const workspace = new DocumentFixture(snap('old local'));
    const notion = new DocumentFixture(snap('new notion'));
    const state = new StateFixture();
    state.value = {
      mappingId: pullMapping.id,
      localPath: pullMapping.localPath,
      notionPageId: pullMapping.notionPageId,
      direction: pullMapping.direction,
      baseHash: 'hash:old local',
      lastLocalHash: 'hash:old local',
      lastNotionEditedTime: 'before',
      status: 'synced',
    };

    await new SyncEngine(workspace, notion, state).sync(pullMapping);

    expect(workspace.backups).toEqual(['old local']);
    expect(workspace.writes).toEqual(['new notion']);
  });

  it('does not write content when the non-source side diverged', async () => {
    const workspace = new DocumentFixture(snap('local edit'));
    const notion = new DocumentFixture(snap('notion edit'));
    const state = new StateFixture();
    state.value = {
      mappingId: pullMapping.id,
      localPath: pullMapping.localPath,
      notionPageId: pullMapping.notionPageId,
      direction: pullMapping.direction,
      baseHash: 'hash:base',
      lastLocalHash: 'hash:base',
      lastNotionEditedTime: 'before',
      status: 'synced',
    };
    const result = await new SyncEngine(workspace, notion, state).sync(pullMapping);
    expect(result.action).toBe('conflict');
    expect(workspace.writes).toEqual([]);
    expect(notion.writes).toEqual([]);
    expect(state.value?.status).toBe('conflict');
  });

  it('does not advance state when an adapter write fails', async () => {
    const workspace = new DocumentFixture(undefined);
    workspace.write = async () => {
      throw new Error('fixture unavailable');
    };
    const notion = new DocumentFixture(snap('source'));
    const state = new StateFixture();
    await expect(new SyncEngine(workspace, notion, state).sync(pullMapping)).rejects.toThrow(
      'fixture unavailable'
    );
    expect(state.saves).toEqual([]);
  });

  it('clears a conflict after both sides are restored to the saved base', async () => {
    const workspace = new DocumentFixture(snap('base'));
    const notion = new DocumentFixture(snap('base', 'restored'));
    const state = new StateFixture();
    state.value = {
      mappingId: pullMapping.id,
      localPath: pullMapping.localPath,
      notionPageId: pullMapping.notionPageId,
      direction: pullMapping.direction,
      baseHash: 'hash:base',
      lastLocalHash: 'hash:local edit',
      lastNotionEditedTime: 'conflicted',
      status: 'conflict',
    };

    const result = await new SyncEngine(workspace, notion, state).sync(pullMapping);

    expect(result.action).toBe('noop');
    expect(state.value).toMatchObject({ status: 'synced', baseHash: 'hash:base' });
  });

  it('rejects programmatic local-to-Notion mappings outside publish/', async () => {
    const workspace = new DocumentFixture(snap('private'));
    const notion = new DocumentFixture(undefined);
    const state = new StateFixture();
    const unsafe = { ...pushMapping, localPath: 'private.md' };

    await expect(new SyncEngine(workspace, notion, state).sync(unsafe)).rejects.toThrow(/publish/);
    expect(notion.writes).toEqual([]);
  });

  it('fails when a Notion source page is missing instead of reporting noop', async () => {
    const workspace = new DocumentFixture(snap('existing local'));
    const notion = new DocumentFixture(undefined);
    const state = new StateFixture();

    await expect(new SyncEngine(workspace, notion, state).sync(pullMapping)).rejects.toThrow(
      'Notion source document is unavailable'
    );
    expect(state.saves).toEqual([]);
  });

  it('fails when a local source file is missing instead of reporting noop', async () => {
    const workspace = new DocumentFixture(undefined);
    const notion = new DocumentFixture(snap('existing notion'));
    const state = new StateFixture();

    await expect(new SyncEngine(workspace, notion, state).sync(pushMapping)).rejects.toThrow(
      'Local source document is unavailable'
    );
    expect(state.saves).toEqual([]);
  });
});
