import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import type { WorkspaceMirrorNotionPort } from './types.js';

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.xangi',
  '.cache',
  'node_modules',
  'dist',
  'coverage',
  'logs',
]);

interface MirrorState {
  version: 1;
  parentPageId: string;
  folders: Record<string, string>;
  files: Record<string, string>;
}

export interface WorkspaceMirrorOptions {
  workspaceRoot: string;
  dataDir: string;
  parentPageId: string;
  notion: WorkspaceMirrorNotionPort;
}

export async function mirrorWorkspaceToNotion(options: WorkspaceMirrorOptions): Promise<string> {
  const markdownFiles = await discoverMarkdownFiles(options.workspaceRoot);
  const statePath = join(options.dataDir, 'notion-sync', 'workspace-mirror.json');
  const state = await loadState(statePath, options.parentPageId);
  let created = 0;
  let updated = 0;

  for (const localPath of markdownFiles) {
    const parentId = await ensureFolderHierarchy(localPath, options, state, () => created++);
    const markdown = await readFile(join(options.workspaceRoot, localPath), 'utf8');
    const pageId = state.files[localPath];
    if (pageId) {
      await options.notion.write(pageId, markdown);
      updated++;
    } else {
      state.files[localPath] = await options.notion.createPage(
        parentId,
        basename(localPath, extname(localPath)),
        markdown
      );
      created++;
    }
    await saveState(statePath, state);
  }

  return `Notion workspace mirror: ${markdownFiles.length} files（created ${created}, updated ${updated}）`;
}

export async function discoverMarkdownFiles(workspaceRoot: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || EXCLUDED_SEGMENTS.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        found.push(relative(workspaceRoot, absolute).split(sep).join('/'));
      }
    }
  }
  await visit(workspaceRoot);
  return found.sort();
}

async function ensureFolderHierarchy(
  localPath: string,
  options: WorkspaceMirrorOptions,
  state: MirrorState,
  onCreate: () => void
): Promise<string> {
  const segments = dirname(localPath) === '.' ? [] : dirname(localPath).split('/');
  let parentId = options.parentPageId;
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!state.folders[current]) {
      state.folders[current] = await options.notion.createPage(parentId, segment, '');
      onCreate();
    }
    parentId = state.folders[current]!;
  }
  return parentId;
}

async function loadState(path: string, parentPageId: string): Promise<MirrorState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as MirrorState;
    if (value.version === 1 && value.parentPageId === parentPageId) return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { version: 1, parentPageId, folders: {}, files: {} };
}

async function saveState(path: string, state: MirrorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    created = false;
    await chmod(path, 0o600);
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}
