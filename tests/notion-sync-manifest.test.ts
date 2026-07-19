import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseSyncManifest } from '../src/notion-sync/manifest.js';
import { assertSafeWorkspacePath } from '../src/notion-sync/path-policy.js';

describe('parseSyncManifest', () => {
  it('accepts explicit one-way mappings', () => {
    const manifest = parseSyncManifest(`
version: 1
mappings:
  - id: agents
    direction: notion-to-local
    localPath: AGENTS.md
    notionPageId: page-agents
  - id: diary
    direction: local-to-notion
    localPath: publish/diary.md
    notionPageId: page-diary
`);
    expect(manifest.mappings).toHaveLength(2);
    expect(manifest.mappings[1]?.direction).toBe('local-to-notion');
  });

  it.each([
    ['unknown top-level field', 'version: 1\nmappings: []\ntoken: secret'],
    ['unknown mapping field', 'version: 1\nmappings:\n  - id: a\n    direction: notion-to-local\n    localPath: A.md\n    notionPageId: p\n    extra: true'],
    ['invalid direction', 'version: 1\nmappings:\n  - id: a\n    direction: both\n    localPath: A.md\n    notionPageId: p'],
    ['unsafe mapping id', 'version: 1\nmappings:\n  - id: __proto__\n    direction: notion-to-local\n    localPath: A.md\n    notionPageId: p'],
    ['duplicate local path', 'version: 1\nmappings:\n  - { id: a, direction: notion-to-local, localPath: A.md, notionPageId: p1 }\n  - { id: b, direction: notion-to-local, localPath: A.md, notionPageId: p2 }'],
    ['duplicate notion page', 'version: 1\nmappings:\n  - { id: a, direction: notion-to-local, localPath: A.md, notionPageId: p1 }\n  - { id: b, direction: notion-to-local, localPath: B.md, notionPageId: p1 }'],
    ['publish path outside publish root', 'version: 1\nmappings:\n  - { id: a, direction: local-to-notion, localPath: notes/a.md, notionPageId: p1 }'],
    ['fixed deny path', 'version: 1\nmappings:\n  - { id: a, direction: notion-to-local, localPath: memory/a.md, notionPageId: p1 }'],
  ])('rejects %s', (_name, input) => {
    expect(() => parseSyncManifest(input)).toThrow();
  });
});

describe('assertSafeWorkspacePath', () => {
  it.each(['../AGENTS.md', '/tmp/a.md', '.env', '.xangi/state.json', '.hidden/a.md', 'publish/api-token.md'])('rejects unsafe path %s', (relativePath) => {
    expect(() => assertSafeWorkspacePath(relativePath, 'notion-to-local')).toThrow();
  });

  it('rejects a symlink path when workspace is available', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'xangi-notion-policy-'));
    await mkdir(join(workspace, 'publish'));
    await writeFile(join(workspace, 'outside.md'), 'secret');
    await symlink(join(workspace, 'outside.md'), join(workspace, 'publish', 'linked.md'));
    await expect(assertSafeWorkspacePath('publish/linked.md', 'local-to-notion', workspace)).rejects.toThrow(/symlink/i);
  });
});
