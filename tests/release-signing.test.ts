import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestVerifier } from '../src/installer/manifest.js';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release manifest signing', () => {
  it('creates an Ed25519-signed manifest matching the release bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-release-signing-'));
    roots.push(root);
    const keys = generateKeyPairSync('ed25519');
    const privateKey = join(root, 'private.pem');
    const publicKey = join(root, 'public.pem');
    const artifact = join(root, 'xangi-1.2.3-linux-arm64.tar.gz');
    const manifestPath = join(root, 'manifest.json');
    await writeFile(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(artifact, 'release fixture');

    await exec('node', [
      'packaging/sign-release-manifest.mjs',
      '--version',
      '1.2.3',
      '--platform',
      'linux',
      '--arch',
      'arm64',
      '--artifact',
      artifact,
      '--asset-url',
      'https://github.com/karaage0703/xangi/releases/download/v1.2.3/xangi-1.2.3-linux-arm64.tar.gz',
      '--private-key',
      privateKey,
      '--manifest-output',
      manifestPath,
      '--public-key-output',
      publicKey,
    ]);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const verifier = new ManifestVerifier(await readFile(publicKey, 'utf8'));
    const verified = verifier.verifyManifest(manifest, {
      expectedPlatform: 'linux',
      expectedArch: 'arm64',
    });
    verifier.verifyArtifact(await readFile(artifact), verified);
    expect(verified.version).toBe('1.2.3');
    expect(verified.asset.url).toContain('/releases/download/v1.2.3/');
  });

  it('rejects non-Ed25519 private keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-release-signing-'));
    roots.push(root);
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKey = join(root, 'private.pem');
    const artifact = join(root, 'bundle.tar.gz');
    await writeFile(privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(artifact, 'fixture');

    await expect(
      exec('node', [
        'packaging/sign-release-manifest.mjs',
        '--version',
        '1.2.3',
        '--platform',
        'linux',
        '--arch',
        'x64',
        '--artifact',
        artifact,
        '--asset-url',
        'https://releases.example/bundle.tar.gz',
        '--private-key',
        privateKey,
        '--manifest-output',
        join(root, 'manifest.json'),
        '--public-key-output',
        join(root, 'public.pem'),
      ])
    ).rejects.toThrow(/Ed25519 private key/);
  });
});
