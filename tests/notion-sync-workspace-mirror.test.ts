import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverMarkdownFiles,
  mirrorWorkspaceToNotion,
} from '../src/notion-sync/workspace-mirror.js';
import type { DocumentSnapshot } from '../src/notion-sync/types.js';

class NotionFixture {
  next = 1;
  created: Array<{ parent: string; title: string; markdown: string; id: string }> = [];
  updated: Array<{ id: string; markdown: string }> = [];

  async createPage(parent: string, title: string, markdown: string): Promise<string> {
    const id = `page-${this.next++}`;
    this.created.push({ parent, title, markdown, id });
    return id;
  }

  async write(id: string, markdown: string): Promise<DocumentSnapshot> {
    this.updated.push({ id, markdown });
    return { markdown, hash: `hash:${markdown}`, editedTime: 'now' };
  }
}

describe('workspace Notion mirror', () => {
  it('discovers Markdown while excluding runtime and dependency directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-mirror-discovery-'));
    await mkdir(join(root, 'memory'), { recursive: true });
    await mkdir(join(root, 'logs'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Readme');
    await writeFile(join(root, 'memory', 'today.md'), '# Today');
    await writeFile(join(root, 'logs', 'private.md'), '# Log');
    await writeFile(join(root, 'node_modules', 'pkg', 'README.md'), '# Package');

    await expect(discoverMarkdownFiles(root)).resolves.toEqual([
      'README.md',
      'memory/today.md',
    ]);
  });

  it('creates folder hierarchy once and updates the same pages on later runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-mirror-'));
    const state = await mkdtemp(join(tmpdir(), 'xangi-mirror-state-'));
    await mkdir(join(root, 'memory'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Readme');
    await writeFile(join(root, 'memory', 'profile.md'), '# Profile');
    const notion = new NotionFixture();

    await expect(
      mirrorWorkspaceToNotion({ workspaceRoot: root, dataDir: state, parentPageId: 'root', notion })
    ).resolves.toBe('Notion workspace mirror: 2 files（created 3, updated 0）');
    expect(notion.created.map(({ parent, title }) => ({ parent, title }))).toEqual([
      { parent: 'root', title: 'README' },
      { parent: 'root', title: 'memory' },
      { parent: 'page-2', title: 'profile' },
    ]);

    await writeFile(join(root, 'memory', 'profile.md'), '# Updated');
    await mirrorWorkspaceToNotion({
      workspaceRoot: root,
      dataDir: state,
      parentPageId: 'root',
      notion,
    });
    expect(notion.created).toHaveLength(3);
    expect(notion.updated).toEqual([
      { id: 'page-1', markdown: '# Readme' },
      { id: 'page-3', markdown: '# Updated' },
    ]);
    const statePath = join(state, 'notion-sync', 'workspace-mirror.json');
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(statePath, 'utf8')).toContain('memory/profile.md');
  });
});
