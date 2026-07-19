import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertSafeWorkspacePath } from './path-policy.js';
import type { DocumentSnapshot, WorkspacePort } from './types.js';

export interface WorkspaceFsAdapterOptions {
  workspaceRoot: string;
  dataDir: string;
  now?: () => Date;
}

/** Filesystem boundary for Notion sync. All workspace access is fail-closed. */
export class WorkspaceFsAdapter implements WorkspacePort {
  private readonly now: () => Date;

  constructor(private readonly options: WorkspaceFsAdapterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async read(relativePath: string): Promise<DocumentSnapshot | undefined> {
    const target = await this.resolveSafeWorkspaceTarget(relativePath);
    let handle;
    try {
      // O_NOFOLLOW makes the final path component fail closed if it changes after validation.
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissingPath(error)) return undefined;
      throw error;
    }

    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`Sync source is not a regular file: ${relativePath}`);
      const markdown = await handle.readFile('utf8');
      return snapshot(markdown, info.mtime);
    } finally {
      await handle.close();
    }
  }

  async backup(relativePath: string, markdown: string): Promise<void> {
    // Validate even though the content is supplied by the engine. This prevents unsafe
    // mapping paths from being reflected into the backup tree.
    await this.resolveSafeWorkspaceTarget(relativePath);

    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    const resolvedDataDir = await realpath(this.options.dataDir);
    const backupParent = resolve(resolvedDataDir, 'notion-sync', 'backups', relativePath);
    assertInside(resolvedDataDir, backupParent, 'Backup path escapes DATA_DIR');
    await ensureDirectoryTree(resolvedDataDir, relative(resolvedDataDir, backupParent));

    const timestamp = this.now().toISOString().replace(/:/g, '-');
    const destination = await availableBackupPath(backupParent, `${timestamp}.md`);
    await atomicWrite(destination, markdown, 0o600, async () => {
      await this.resolveSafeWorkspaceTarget(relativePath);
      await assertNoSymlinkComponents(resolvedDataDir, relative(resolvedDataDir, backupParent));
    });
  }

  async write(relativePath: string, markdown: string): Promise<DocumentSnapshot> {
    let target = await this.resolveSafeWorkspaceTarget(relativePath);
    const root = await realpath(this.options.workspaceRoot);
    await ensureDirectoryTree(root, relative(root, dirname(target)));
    // mkdir may have encountered a concurrently-created symlink, so resolve and check again.
    target = await this.resolveSafeWorkspaceTarget(relativePath);

    const existingMode = await regularFileMode(target, relativePath);
    await atomicWrite(target, markdown, existingMode ?? 0o600, async () => {
      const revalidated = await this.resolveSafeWorkspaceTarget(relativePath);
      if (revalidated !== target) throw new Error('Workspace path changed during sync write');
    });

    const persisted = await this.read(relativePath);
    if (persisted === undefined)
      throw new Error(`Synchronized file disappeared after write: ${relativePath}`);
    return persisted;
  }

  private async resolveSafeWorkspaceTarget(relativePath: string): Promise<string> {
    const root = await realpath(this.options.workspaceRoot);
    await assertSafeWorkspacePath(relativePath, 'notion-to-local', root);
    const target = resolve(root, relativePath);
    assertInside(root, target, 'Sync path escapes workspace');
    return target;
  }
}

function snapshot(markdown: string, modifiedAt: Date): DocumentSnapshot {
  return {
    markdown,
    hash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    editedTime: modifiedAt.toISOString(),
  };
}

async function regularFileMode(path: string, relativePath: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Sync destination is not a regular file: ${relativePath}`);
    return info.mode & 0o777;
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

async function atomicWrite(
  destination: string,
  content: string,
  mode: number,
  beforeCommit?: () => Promise<void>
): Promise<void> {
  const temporary = join(dirname(destination), `.${randomUUID()}.xangi-sync.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeCommit?.();
    await rename(temporary, destination);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissingPath(error)) throw error;
    });
  }
}

async function availableBackupPath(parent: string, basename: string): Promise<string> {
  const extensionIndex = basename.lastIndexOf('.');
  const stem = extensionIndex === -1 ? basename : basename.slice(0, extensionIndex);
  const extension = extensionIndex === -1 ? '' : basename.slice(extensionIndex);
  for (let index = 0; ; index += 1) {
    const candidate = join(parent, index === 0 ? basename : `${stem}-${index}${extension}`);
    try {
      await lstat(candidate);
    } catch (error) {
      if (isMissingPath(error)) return candidate;
      throw error;
    }
  }
}

async function ensureDirectoryTree(root: string, relativePath: string): Promise<void> {
  let cursor = root;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      await mkdir(cursor, { mode: 0o700 });
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink())
      throw new Error(`Symlink paths cannot be used for sync state: ${relativePath}`);
    if (!info.isDirectory())
      throw new Error(`Sync directory component is not a directory: ${relativePath}`);
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let cursor = root;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink())
      throw new Error(`Symlink paths cannot be used for sync state: ${relativePath}`);
  }
}

function assertInside(root: string, candidate: string, message: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error(message);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
