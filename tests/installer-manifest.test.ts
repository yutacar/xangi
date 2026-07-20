import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareSemVer,
  ManifestVerificationError,
  ManifestVerifier,
  canonicalManifestPayload,
  parseManifest,
} from '../src/installer/manifest.js';
import type { ReleaseManifest, UnsignedReleaseManifest } from '../src/installer/types.js';

const artifact = Buffer.from('verified xangi bundle');
const keys = generateKeyPairSync('ed25519');

function unsignedManifest(
  overrides: Partial<UnsignedReleaseManifest> = {}
): UnsignedReleaseManifest {
  return {
    schemaVersion: 1,
    version: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    asset: {
      url: 'https://example.com/xangi-1.2.3-darwin-arm64.tar.gz',
      size: artifact.byteLength,
      sha256: createHash('sha256').update(artifact).digest('hex'),
    },
    ...overrides,
  };
}

function signedManifest(overrides: Partial<UnsignedReleaseManifest> = {}): ReleaseManifest {
  const unsigned = unsignedManifest(overrides);
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalManifestPayload(unsigned)),
      keys.privateKey
    ).toString('base64'),
  };
}

describe('manifest schema', () => {
  it('署名対象から signature を除外し、key 順によらない canonical JSON を生成する', () => {
    const manifest = signedManifest();
    const reordered = {
      signature: manifest.signature,
      asset: {
        sha256: manifest.asset.sha256,
        size: manifest.asset.size,
        url: manifest.asset.url,
      },
      arch: manifest.arch,
      platform: manifest.platform,
      version: manifest.version,
      schemaVersion: manifest.schemaVersion,
    };

    expect(canonicalManifestPayload(reordered)).toBe(canonicalManifestPayload(manifest));
    expect(canonicalManifestPayload(manifest)).not.toContain('signature');
  });

  it('unknown field を含む manifest を strict に拒否する', () => {
    expect(() => parseManifest({ ...signedManifest(), unexpected: true })).toThrow(
      ManifestVerificationError
    );
    expect(() =>
      parseManifest({
        ...signedManifest(),
        asset: { ...signedManifest().asset, unexpected: true },
      })
    ).toThrow(ManifestVerificationError);
  });
});

describe('ManifestVerifier', () => {
  const verifier = new ManifestVerifier(keys.publicKey);

  it('正しい署名、platform、architecture、version、artifactを検証する', () => {
    const manifest = verifier.verifyManifest(signedManifest(), {
      expectedPlatform: 'darwin',
      expectedArch: 'arm64',
      currentVersion: '1.0.0',
    });

    expect(manifest.version).toBe('1.2.3');
    expect(() => verifier.verifyArtifact(artifact, manifest)).not.toThrow();
  });

  it('tamperされた manifest を拒否する', () => {
    const manifest = { ...signedManifest(), version: '1.2.4' };

    expect(() =>
      verifier.verifyManifest(manifest, {
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
      })
    ).toThrow(/signature/i);
  });

  it('wrong platform/architecture を拒否する', () => {
    expect(() =>
      verifier.verifyManifest(signedManifest(), {
        expectedPlatform: 'darwin',
        expectedArch: 'x64',
      })
    ).toThrow(/architecture/i);
  });

  it('明示許可のない downgrade を拒否し、許可時だけ受け入れる', () => {
    const manifest = signedManifest({ version: '1.2.2' });
    const options = {
      expectedPlatform: 'darwin' as const,
      expectedArch: 'arm64' as const,
      currentVersion: '1.2.3',
    };

    expect(() => verifier.verifyManifest(manifest, options)).toThrow(/downgrade/i);
    expect(verifier.verifyManifest(manifest, { ...options, allowDowngrade: true }).version).toBe(
      '1.2.2'
    );
  });

  it('prerelease を含む SemVer の precedence で downgrade を判定する', () => {
    const manifest = signedManifest({ version: '2.0.0-beta.1' });

    expect(() =>
      verifier.verifyManifest(manifest, {
        expectedPlatform: 'darwin',
        expectedArch: 'arm64',
        currentVersion: '2.0.0',
      })
    ).toThrow(/downgrade/i);
  });

  it('safe integerを超えるcoreとprereleaseも精度を落とさず比較する', () => {
    expect(compareSemVer('9007199254740993.0.0', '9007199254740992.0.0')).toBe(1);
    expect(compareSemVer('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBe(1);
  });

  it('sizeまたはSHA-256が異なるartifactを拒否する', () => {
    const manifest = signedManifest();

    expect(() => verifier.verifyArtifact(Buffer.from('tampered'), manifest)).toThrow(
      /size|sha-256/i
    );
    const sameSizeTamper = Buffer.from(artifact);
    sameSizeTamper[0] ^= 1;
    expect(() => verifier.verifyArtifact(sameSizeTamper, manifest)).toThrow(/sha-256/i);
  });
});
