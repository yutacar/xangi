import { posix, win32 } from 'node:path';
import type {
  AppLayout,
  ReleaseArchitecture,
  ReleasePlatform,
  ResolveAppLayoutOptions,
} from './types.js';

const SUPPORTED: Readonly<Record<ReleasePlatform, readonly ReleaseArchitecture[]>> = {
  darwin: ['arm64', 'x64'],
  linux: ['arm64', 'x64'],
  win32: ['arm64', 'x64'],
};

export class UnsupportedPlatformError extends Error {
  constructor(
    readonly platform: string,
    readonly arch: string
  ) {
    super(`Unsupported platform or architecture: ${platform}/${arch}`);
    this.name = 'UnsupportedPlatformError';
  }
}

/** Pure path resolution: callers can reject unsupported targets before any write. */
export function resolveAppLayout(options: ResolveAppLayoutOptions): AppLayout {
  const { platform, arch, homeDir } = options;
  if (!isSupportedTarget(platform, arch)) {
    throw new UnsupportedPlatformError(platform, arch);
  }
  if (!homeDir) {
    throw new Error('homeDir is required');
  }
  const releaseArch = arch as ReleaseArchitecture;

  if (platform === 'darwin') {
    const dataRoot = posix.join(homeDir, 'Library', 'Application Support', 'xangi');
    return buildLayout(
      platform,
      releaseArch,
      posix,
      dataRoot,
      posix.join(homeDir, 'xangi-workspace')
    );
  }

  if (platform === 'linux') {
    const dataRoot = posix.join(
      resolveXdgHome(options.xdgDataHome, posix.join(homeDir, '.local', 'share'), 'XDG_DATA_HOME'),
      'xangi'
    );
    const stateDir = posix.join(
      resolveXdgHome(
        options.xdgStateHome,
        posix.join(homeDir, '.local', 'state'),
        'XDG_STATE_HOME'
      ),
      'xangi'
    );
    const configDir = posix.join(
      resolveXdgHome(options.xdgConfigHome, posix.join(homeDir, '.config'), 'XDG_CONFIG_HOME'),
      'xangi'
    );
    const appRoot = posix.join(dataRoot, 'app');
    return {
      platform,
      arch: releaseArch,
      appRoot,
      versionsDir: posix.join(appRoot, 'versions'),
      currentLink: posix.join(appRoot, 'current'),
      stagingDir: posix.join(appRoot, 'staging'),
      updateLock: posix.join(appRoot, 'update.lock'),
      workspaceDir: posix.join(homeDir, 'xangi-workspace'),
      stateDir,
      configDir,
      configFile: posix.join(configDir, 'xangi.json'),
    };
  }

  const localAppData = options.localAppData || win32.join(homeDir, 'AppData', 'Local');
  const dataRoot = win32.join(localAppData, 'Xangi');
  return buildLayout(
    platform,
    releaseArch,
    win32,
    dataRoot,
    win32.join(homeDir, 'xangi-workspace')
  );
}

function resolveXdgHome(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined || value === '') return fallback;
  if (!posix.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

export function isSupportedTarget(platform: string, arch: string): platform is ReleasePlatform {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return false;
  return (SUPPORTED[platform] as readonly string[]).includes(arch);
}

export function versionPath(layout: AppLayout, version: string): string {
  if (!isSafeVersionSegment(version)) {
    throw new Error(`Invalid version path segment: ${version}`);
  }
  const path = layout.platform === 'win32' ? win32 : posix;
  return path.join(layout.versionsDir, version);
}

function buildLayout(
  platform: ReleasePlatform,
  arch: ReleaseArchitecture,
  path: typeof posix,
  dataRoot: string,
  workspaceDir: string
): AppLayout {
  const appRoot = path.join(dataRoot, 'app');
  const configDir = path.join(dataRoot, 'config');
  return {
    platform,
    arch,
    appRoot,
    versionsDir: path.join(appRoot, 'versions'),
    currentLink: path.join(appRoot, 'current'),
    stagingDir: path.join(appRoot, 'staging'),
    updateLock: path.join(appRoot, 'update.lock'),
    workspaceDir,
    stateDir: path.join(dataRoot, 'state'),
    configDir,
    configFile: path.join(configDir, 'xangi.json'),
  };
}

function isSafeVersionSegment(version: string): boolean {
  return (
    version.length > 0 &&
    version !== '.' &&
    version !== '..' &&
    !version.includes('/') &&
    !version.includes('\\')
  );
}
