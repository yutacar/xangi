import type { KeyLike } from 'node:crypto';

export const RELEASE_PLATFORMS = ['darwin', 'linux', 'win32'] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

export const RELEASE_ARCHITECTURES = ['arm64', 'x64'] as const;
export type ReleaseArchitecture = (typeof RELEASE_ARCHITECTURES)[number];

/**
 * Platform adapters share these logical locations. App releases are disposable;
 * workspace, state, and config are deliberately outside appRoot.
 */
export interface AppLayout {
  platform: ReleasePlatform;
  arch: ReleaseArchitecture;
  appRoot: string;
  versionsDir: string;
  currentLink: string;
  stagingDir: string;
  updateLock: string;
  workspaceDir: string;
  stateDir: string;
  configDir: string;
  configFile: string;
}

export interface ResolveAppLayoutOptions {
  platform: string;
  arch: string;
  homeDir: string;
  /** Required only when resolving a Windows layout outside Windows. */
  localAppData?: string;
  /** Linux XDG overrides. Defaults follow the XDG Base Directory specification. */
  xdgDataHome?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
}

export interface ReleaseAsset {
  url: string;
  size: number;
  sha256: string;
}

export interface UnsignedReleaseManifest {
  schemaVersion: 1;
  version: string;
  platform: ReleasePlatform;
  arch: ReleaseArchitecture;
  asset: ReleaseAsset;
}

export interface ReleaseManifest extends UnsignedReleaseManifest {
  /** Base64 encoded Ed25519 signature over canonicalManifestPayload(). */
  signature: string;
}

export interface ManifestVerificationOptions {
  expectedPlatform: ReleasePlatform;
  expectedArch: ReleaseArchitecture;
  currentVersion?: string;
  allowDowngrade?: boolean;
}

export type ManifestPublicKey = KeyLike;
