import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SyncDirection } from './types.js';

const FIXED_DENY_ROOTS = new Set(['.xangi', '.git', 'logs', 'memory']);
const SECRET_SEGMENT = /(?:^|[-_.])(token|secret|credential|credentials)(?:$|[-_.])/i;

export function assertSafeWorkspacePath(relativePath: string, direction: SyncDirection): void;
export function assertSafeWorkspacePath(
  relativePath: string,
  direction: SyncDirection,
  workspaceRoot: string
): Promise<void>;
export function assertSafeWorkspacePath(
  relativePath: string,
  direction: SyncDirection,
  workspaceRoot?: string
): void | Promise<void> {
  assertSafeLexicalPath(relativePath, direction);
  if (workspaceRoot !== undefined) return assertSafePathOnDisk(relativePath, workspaceRoot);
}

function assertSafeLexicalPath(relativePath: string, direction: SyncDirection): void {
  if (relativePath.length === 0 || relativePath.includes('\\') || isAbsolute(relativePath)) {
    throw new Error(`Unsafe sync path: ${relativePath}`);
  }

  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe sync path: ${relativePath}`);
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    throw new Error(`Hidden paths cannot be synchronized: ${relativePath}`);
  }
  if (FIXED_DENY_ROOTS.has(segments[0]!.toLowerCase())) {
    throw new Error(`Denied sync path: ${relativePath}`);
  }
  if (segments.some((segment) => SECRET_SEGMENT.test(segment))) {
    throw new Error(`Secret-like paths cannot be synchronized: ${relativePath}`);
  }
  if (direction === 'local-to-notion' && (segments[0] !== 'publish' || segments.length < 2)) {
    throw new Error('Local source documents must be below publish/');
  }
}

async function assertSafePathOnDisk(relativePath: string, workspaceRoot: string): Promise<void> {
  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot))
    throw new Error('Sync path escapes workspace');

  let cursor = root;
  for (const segment of relativePath.split('/')) {
    cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink())
        throw new Error(`Symlink paths cannot be synchronized: ${relativePath}`);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
