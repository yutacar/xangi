import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceFsAdapter } from '../src/notion-sync/workspace-adapter.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-notion-workspace-'));
  const workspaceRoot = join(root, 'workspace');
  const dataDir = join(root, 'data');
  await mkdir(workspaceRoot);
  return {
    root,
    workspaceRoot,
    dataDir,
    adapter: new WorkspaceFsAdapter({
      workspaceRoot,
      dataDir,
      now: () => new Date('2026-07-15T00:12:34.567Z'),
    }),
  };
}

describe('WorkspaceFsAdapter', () => {
  it('reads a regular file as a hashed snapshot and returns undefined for a missing file', async () => {
    const { adapter, workspaceRoot } = await fixture();
    await writeFile(join(workspaceRoot, 'AGENTS.md'), 'hello\n');

    const snapshot = await adapter.read('AGENTS.md');

    expect(snapshot).toMatchObject({
      markdown: 'hello\n',
      hash: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
    });
    expect(Number.isNaN(Date.parse(snapshot!.editedTime))).toBe(false);
    await expect(adapter.read('USER.md')).resolves.toBeUndefined();
  });

  it('atomically writes below the workspace and preserves an existing file mode', async () => {
    const { adapter, workspaceRoot } = await fixture();
    await mkdir(join(workspaceRoot, 'profiles'));
    await writeFile(join(workspaceRoot, 'profiles', 'USER.md'), 'old', { mode: 0o640 });
    await chmod(join(workspaceRoot, 'profiles', 'USER.md'), 0o640);

    const snapshot = await adapter.write('profiles/USER.md', 'new contents');

    expect(snapshot.markdown).toBe('new contents');
    expect(await readFile(join(workspaceRoot, 'profiles', 'USER.md'), 'utf8')).toBe('new contents');
    expect((await stat(join(workspaceRoot, 'profiles', 'USER.md'))).mode & 0o777).toBe(0o640);
    expect(await readdir(join(workspaceRoot, 'profiles'))).toEqual(['USER.md']);
  });

  it('creates a new destination with private permissions', async () => {
    const { adapter, workspaceRoot } = await fixture();

    await adapter.write('profiles/CHARACTER.md', 'friendly');

    expect(await readFile(join(workspaceRoot, 'profiles', 'CHARACTER.md'), 'utf8')).toBe('friendly');
    expect((await stat(join(workspaceRoot, 'profiles', 'CHARACTER.md'))).mode & 0o777).toBe(0o600);
  });

  it('stores pull backups atomically below DATA_DIR using the workspace-relative path', async () => {
    const { adapter, dataDir } = await fixture();

    await adapter.backup('profiles/USER.md', 'before pull');

    const backupDir = join(dataDir, 'notion-sync', 'backups', 'profiles', 'USER.md');
    expect(await readdir(backupDir)).toEqual(['2026-07-15T00-12-34.567Z.md']);
    expect(await readFile(join(backupDir, '2026-07-15T00-12-34.567Z.md'), 'utf8')).toBe('before pull');
    expect((await stat(join(backupDir, '2026-07-15T00-12-34.567Z.md'))).mode & 0o777).toBe(0o600);
  });

  it('does not overwrite another backup created in the same millisecond', async () => {
    const { adapter, dataDir } = await fixture();

    await adapter.backup('USER.md', 'first');
    await adapter.backup('USER.md', 'second');

    const backupDir = join(dataDir, 'notion-sync', 'backups', 'USER.md');
    expect(await readdir(backupDir)).toEqual([
      '2026-07-15T00-12-34.567Z-1.md',
      '2026-07-15T00-12-34.567Z.md',
    ]);
    expect(await readFile(join(backupDir, '2026-07-15T00-12-34.567Z.md'), 'utf8')).toBe('first');
    expect(await readFile(join(backupDir, '2026-07-15T00-12-34.567Z-1.md'), 'utf8')).toBe('second');
  });

  it.each(['read', 'write', 'backup'] as const)('rejects workspace traversal during %s', async (operation) => {
    const { adapter } = await fixture();
    if (operation === 'read') await expect(adapter.read('../outside.md')).rejects.toThrow(/unsafe|escape/i);
    if (operation === 'write') await expect(adapter.write('../outside.md', 'bad')).rejects.toThrow(/unsafe|escape/i);
    if (operation === 'backup') await expect(adapter.backup('../outside.md', 'bad')).rejects.toThrow(/unsafe|escape/i);
  });

  it.each(['read', 'write', 'backup'] as const)('rejects a symlink destination during %s', async (operation) => {
    const { adapter, root, workspaceRoot } = await fixture();
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'outside');
    await symlink(outside, join(workspaceRoot, 'USER.md'));

    if (operation === 'read') await expect(adapter.read('USER.md')).rejects.toThrow(/symlink/i);
    if (operation === 'write') await expect(adapter.write('USER.md', 'bad')).rejects.toThrow(/symlink/i);
    if (operation === 'backup') await expect(adapter.backup('USER.md', 'bad')).rejects.toThrow(/symlink/i);
    expect((await lstat(join(workspaceRoot, 'USER.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('outside');
  });

  it('rejects a symlink introduced in a missing destination parent', async () => {
    const { adapter, root, workspaceRoot } = await fixture();
    const outsideDir = join(root, 'outside');
    await mkdir(outsideDir);
    await symlink(outsideDir, join(workspaceRoot, 'profiles'));

    await expect(adapter.write('profiles/USER.md', 'bad')).rejects.toThrow(/symlink/i);
    await expect(readFile(join(outsideDir, 'USER.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink inside the backup tree without writing outside DATA_DIR', async () => {
    const { adapter, dataDir, root } = await fixture();
    const outsideDir = join(root, 'outside-backups');
    await mkdir(join(dataDir, 'notion-sync'), { recursive: true });
    await mkdir(outsideDir);
    await symlink(outsideDir, join(dataDir, 'notion-sync', 'backups'));

    await expect(adapter.backup('USER.md', 'private')).rejects.toThrow(/symlink/i);
    expect(await readdir(outsideDir)).toEqual([]);
  });
});
