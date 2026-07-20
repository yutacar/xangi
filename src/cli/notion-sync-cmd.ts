import { mkdir, readFile } from 'node:fs/promises';
import { arch as hostArch, homedir, platform as hostPlatform } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { resolveAppLayout } from '../installer/layout.js';
import { SyncEngine } from '../notion-sync/engine.js';
import { parseSyncManifest } from '../notion-sync/manifest.js';
import { NotionMarkdownAdapter } from '../notion-sync/notion-adapter.js';
import { SyncStateStore } from '../notion-sync/state-store.js';
import type {
  NotionPort,
  SyncStatePort,
  WorkspaceMirrorNotionPort,
  WorkspacePort,
} from '../notion-sync/types.js';
import { WorkspaceFsAdapter } from '../notion-sync/workspace-adapter.js';
import { mirrorWorkspaceToNotion } from '../notion-sync/workspace-mirror.js';
import { parseSetupConfig, type SetupConfig } from '../setup/schema.js';
import { SecretStore } from '../setup/secret-store.js';
import { SetupStore } from '../setup/store.js';

export const NOTION_SYNC_ACTIONS = ['status', 'enable', 'disable', 'run'] as const;
export type NotionSyncAction = (typeof NOTION_SYNC_ACTIONS)[number];

export interface NotionSyncCommandDependencies {
  workspace?: WorkspacePort;
  notion?: NotionPort;
  state?: SyncStatePort;
  manifestText?: string;
  homeDir?: string;
  platform?: string;
  arch?: string;
  xdgDataHome?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  token?: string;
  promptForToken?: () => Promise<string>;
  parentPageId?: string;
}

interface ResolvedPaths {
  workspaceRoot: string;
  dataDir: string;
  manifestPath: string;
  configPath: string;
  secretPath: string;
  config?: SetupConfig;
}

export async function notionSyncCmd(
  actionValue: string,
  flags: Record<string, string | boolean>,
  dependencies: NotionSyncCommandDependencies = {}
): Promise<string> {
  const action = parseAction(actionValue);
  const paths = await resolvePaths(action, flags, dependencies);

  if (action === 'status') {
    return `Notion sync: ${requireSetupConfig(paths).notionSyncEnabled ? 'enabled' : 'disabled'}`;
  }
  if (action === 'disable') {
    await saveEnabled(paths, false);
    return 'Notion sync: disabled';
  }
  let token =
    resolveToken(dependencies) ??
    (await new SecretStore(paths.secretPath).get('XANGI_NOTION_TOKEN'));
  const parentPageId =
    dependencies.parentPageId ??
    process.env.XANGI_NOTION_PARENT_PAGE_ID ??
    (await new SecretStore(paths.secretPath).get('XANGI_NOTION_PARENT_PAGE_ID'));
  if (action === 'enable') {
    if (!token) {
      if (!dependencies.promptForToken) {
        throw new Error('Notionトークンが未設定です。`xangi settings`で入力してください');
      }
      token = requireSecret(await dependencies.promptForToken(), 'NOTION_TOKEN');
      await new SecretStore(paths.secretPath).set('XANGI_NOTION_TOKEN', token);
    }
    requireParentPageId(parentPageId);
    await saveEnabled(paths, true);
    return 'Notion sync: enabled（workspaceを正本としてNotionへミラーします）';
  }

  const once = booleanFlag(flags, 'once');
  if (!once && !requireSetupConfig(paths).notionSyncEnabled) {
    throw new Error(
      'Notion sync is disabled; run `xangi notion-sync enable` or use `run --once` for one explicit sync'
    );
  }
  if (dependencies.manifestText !== undefined || stringFlag(flags, 'sync-config')) {
    return executeSync(paths, dependencies, token);
  }
  const notion =
    dependencies.notion ??
    new NotionMarkdownAdapter({ token: requireSecret(token, 'NOTION_TOKEN') });
  if (!supportsWorkspaceMirror(notion)) {
    throw new Error('Notion mirror adapter does not support pages');
  }
  return withSyncLock(paths.dataDir, () =>
    mirrorWorkspaceToNotion({
      workspaceRoot: paths.workspaceRoot,
      dataDir: paths.dataDir,
      parentPageId: requireParentPageId(parentPageId),
      notion,
    })
  );
}

async function executeSync(
  paths: ResolvedPaths,
  dependencies: NotionSyncCommandDependencies,
  token: string | undefined
): Promise<string> {
  const manifest = await loadManifest(paths, dependencies);
  const workspace =
    dependencies.workspace ??
    new WorkspaceFsAdapter({ workspaceRoot: paths.workspaceRoot, dataDir: paths.dataDir });
  const notion =
    dependencies.notion ??
    new NotionMarkdownAdapter({
      token: requireSecret(token, 'NOTION_TOKEN'),
    });
  const state = dependencies.state ?? new SyncStateStore(paths.dataDir);
  if (dependencies.state !== undefined) {
    return runSync(manifest.mappings, workspace, notion, state);
  }

  return withSyncLock(paths.dataDir, () => runSync(manifest.mappings, workspace, notion, state));
}

async function withSyncLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const syncDir = join(dataDir, 'notion-sync');
  await mkdir(syncDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(syncDir, {
    realpath: false,
    retries: 0,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function loadManifest(
  paths: ResolvedPaths,
  dependencies: NotionSyncCommandDependencies
): Promise<ReturnType<typeof parseSyncManifest>> {
  const text = dependencies.manifestText ?? (await readFile(paths.manifestPath, 'utf8'));
  return parseSyncManifest(text);
}

async function saveEnabled(paths: ResolvedPaths, enabled: boolean): Promise<void> {
  const config = requireSetupConfig(paths);
  await new SetupStore(paths.configPath).save({ ...config, notionSyncEnabled: enabled });
}

function requireSetupConfig(paths: ResolvedPaths): SetupConfig {
  if (!paths.config) {
    throw new Error(
      `Setup configuration is required: ${paths.configPath}; run \`xangi setup\` first`
    );
  }
  return paths.config;
}

async function runSync(
  mappings: ReturnType<typeof parseSyncManifest>['mappings'],
  workspace: WorkspacePort,
  notion: NotionPort,
  state: SyncStatePort
): Promise<string> {
  const engine = new SyncEngine(workspace, notion, state);
  const results = [];
  for (const mapping of mappings) {
    results.push(await engine.sync(mapping));
  }
  return results.length === 0
    ? 'Notion sync: no mappings'
    : results.map((result) => `${result.mappingId}: ${result.action}`).join('\n');
}

async function resolvePaths(
  action: NotionSyncAction,
  flags: Record<string, string | boolean>,
  dependencies: NotionSyncCommandDependencies
): Promise<ResolvedPaths> {
  const homeDir = dependencies.homeDir ?? homedir();
  const layout = resolveAppLayout({
    platform: dependencies.platform ?? hostPlatform(),
    arch: dependencies.arch ?? hostArch(),
    homeDir,
    xdgDataHome: dependencies.xdgDataHome ?? process.env.XDG_DATA_HOME,
    xdgConfigHome: dependencies.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
    xdgStateHome: dependencies.xdgStateHome ?? process.env.XDG_STATE_HOME,
  });
  const configPath = stringFlag(flags, 'setup-config') ?? layout.configFile;
  const explicitWorkspace = stringFlag(flags, 'workspace');
  const environmentWorkspace = process.env.WORKSPACE_PATH;
  const explicitDataDir = stringFlag(flags, 'data-dir') ?? process.env.DATA_DIR;
  let config: SetupConfig | undefined;
  try {
    config = parseSetupConfig(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (
      action !== 'run' ||
      !booleanFlag(flags, 'once') ||
      !(explicitWorkspace ?? environmentWorkspace) ||
      !explicitDataDir
    ) {
      throw new Error(`Setup configuration not found: ${configPath}; run \`xangi setup\` first`);
    }
  }

  const workspaceRoot = explicitWorkspace ?? config?.workspacePath ?? environmentWorkspace;
  if (!workspaceRoot) throw new Error('Workspace path is required');
  const dataDir = explicitDataDir ?? layout.stateDir;
  const manifestPath = stringFlag(flags, 'sync-config') ?? join(workspaceRoot, 'notion-sync.yaml');
  const secretPath = join(layout.configDir, 'secrets.json');
  return { workspaceRoot, dataDir, manifestPath, configPath, secretPath, config };
}

function parseAction(value: string): NotionSyncAction {
  if (!(NOTION_SYNC_ACTIONS as readonly string[]).includes(value)) {
    throw new Error(`Unknown notion-sync action: ${value}`);
  }
  return value as NotionSyncAction;
}

function resolveToken(dependencies: NotionSyncCommandDependencies): string | undefined {
  return dependencies.token ?? process.env.NOTION_TOKEN ?? process.env.XANGI_NOTION_TOKEN;
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanFlag(flags: Record<string, string | boolean>, key: string): boolean {
  const value = flags[key];
  return value === true || value === 'true';
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required in the environment`);
  return value;
}

function requireParentPageId(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Notionの同期先親ページが未設定です。`xangi settings`で入力してください');
  }
  const trimmed = value.trim();
  const match = trimmed.match(/([0-9a-fA-F]{32})(?:[?#].*)?$/);
  return match?.[1] ?? trimmed;
}

function supportsWorkspaceMirror(
  value: NotionPort
): value is NotionPort & WorkspaceMirrorNotionPort {
  return 'createPage' in value && typeof value.createPage === 'function';
}
