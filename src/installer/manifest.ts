import { createHash, timingSafeEqual, verify, type KeyLike } from 'node:crypto';
import type {
  ManifestVerificationOptions,
  ReleaseArchitecture,
  ReleaseAsset,
  ReleaseManifest,
  ReleasePlatform,
  UnsignedReleaseManifest,
} from './types.js';

const MANIFEST_KEYS = [
  'schemaVersion',
  'version',
  'platform',
  'arch',
  'asset',
  'signature',
] as const;
const ASSET_KEYS = ['url', 'size', 'sha256'] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class ManifestVerificationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SCHEMA'
      | 'SIGNATURE'
      | 'PLATFORM'
      | 'ARCHITECTURE'
      | 'VERSION'
      | 'DOWNGRADE'
      | 'ARTIFACT_SIZE'
      | 'ARTIFACT_HASH'
  ) {
    super(message);
    this.name = 'ManifestVerificationError';
  }
}

/** Parse untrusted JSON using an exact, non-coercing schema. */
export function parseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    throw schemaError('Manifest must contain only the documented fields');
  }
  if (value.schemaVersion !== 1) throw schemaError('Unsupported manifest schemaVersion');
  if (!isSemVer(value.version)) throw schemaError('Manifest version must be valid SemVer');
  if (!isReleasePlatform(value.platform)) throw schemaError('Invalid manifest platform');
  if (!isReleaseArchitecture(value.arch)) throw schemaError('Invalid manifest architecture');
  if (!isRecord(value.asset) || !hasExactKeys(value.asset, ASSET_KEYS)) {
    throw schemaError('Manifest asset must contain only url, size, and sha256');
  }

  const asset = parseAsset(value.asset);
  if (typeof value.signature !== 'string' || !isEd25519Signature(value.signature)) {
    throw schemaError('Manifest signature must be a base64 encoded Ed25519 signature');
  }

  return {
    schemaVersion: 1,
    version: value.version,
    platform: value.platform,
    arch: value.arch,
    asset,
    signature: value.signature,
  };
}

/** Canonical JSON recursively sorts object keys and always omits the top-level signature. */
export function canonicalManifestPayload(
  manifest: ReleaseManifest | UnsignedReleaseManifest | Record<string, unknown>
): string {
  const unsigned = Object.fromEntries(
    Object.entries(manifest as Record<string, unknown>).filter(([key]) => key !== 'signature')
  );
  return JSON.stringify(sortJson(unsigned));
}

export class ManifestVerifier {
  constructor(private readonly publicKey: KeyLike) {}

  verifyManifest(value: unknown, options: ManifestVerificationOptions): ReleaseManifest {
    const manifest = parseManifest(value);
    const payload = Buffer.from(canonicalManifestPayload(manifest));
    const signature = Buffer.from(manifest.signature, 'base64');

    let validSignature = false;
    try {
      validSignature = verify(null, payload, this.publicKey, signature);
    } catch {
      validSignature = false;
    }
    if (!validSignature) {
      throw new ManifestVerificationError('Manifest signature verification failed', 'SIGNATURE');
    }
    if (manifest.platform !== options.expectedPlatform) {
      throw new ManifestVerificationError(
        `Manifest platform mismatch: expected ${options.expectedPlatform}, got ${manifest.platform}`,
        'PLATFORM'
      );
    }
    if (manifest.arch !== options.expectedArch) {
      throw new ManifestVerificationError(
        `Manifest architecture mismatch: expected ${options.expectedArch}, got ${manifest.arch}`,
        'ARCHITECTURE'
      );
    }
    if (options.currentVersion !== undefined) {
      if (!isSemVer(options.currentVersion)) {
        throw new ManifestVerificationError('Current version must be valid SemVer', 'VERSION');
      }
      if (!options.allowDowngrade && compareSemVer(manifest.version, options.currentVersion) < 0) {
        throw new ManifestVerificationError(
          `Downgrade from ${options.currentVersion} to ${manifest.version} requires explicit permission`,
          'DOWNGRADE'
        );
      }
    }
    return manifest;
  }

  verifyArtifact(artifact: Uint8Array, manifest: ReleaseManifest): void {
    if (artifact.byteLength !== manifest.asset.size) {
      throw new ManifestVerificationError(
        `Artifact size mismatch: expected ${manifest.asset.size}, got ${artifact.byteLength}`,
        'ARTIFACT_SIZE'
      );
    }
    const actual = createHash('sha256').update(artifact).digest();
    const expected = Buffer.from(manifest.asset.sha256, 'hex');
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new ManifestVerificationError('Artifact SHA-256 verification failed', 'ARTIFACT_HASH');
    }
  }
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseAsset(value: Record<string, unknown>): ReleaseAsset {
  if (typeof value.url !== 'string') throw schemaError('Asset URL must be a string');
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw schemaError('Asset URL must be valid');
  }
  if (url.protocol !== 'https:') throw schemaError('Asset URL must use HTTPS');
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw schemaError('Asset size must be a non-negative safe integer');
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw schemaError('Asset sha256 must be 64 lowercase hexadecimal characters');
  }
  return { url: value.url, size: value.size as number, sha256: value.sha256 };
}

function isEd25519Signature(value: string): boolean {
  if (!BASE64_PATTERN.test(value)) return false;
  return Buffer.from(value, 'base64').byteLength === 64;
}

function isSemVer(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_PATTERN.test(value);
}

function parseSemVer(value: string): { core: [bigint, bigint, bigint]; prerelease: string[] } {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new ManifestVerificationError(`Invalid SemVer: ${value}`, 'VERSION');
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function isReleasePlatform(value: unknown): value is ReleasePlatform {
  return value === 'darwin' || value === 'linux' || value === 'win32';
}

function isReleaseArchitecture(value: unknown): value is ReleaseArchitecture {
  return value === 'arm64' || value === 'x64';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function schemaError(message: string): ManifestVerificationError {
  return new ManifestVerificationError(message, 'SCHEMA');
}
