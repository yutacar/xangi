import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { installCmd, requireSetupConfiguration } from '../src/cli/install-cmd.js';
import { updateCmd } from '../src/cli/update-cmd.js';
import { validateTarListing } from '../src/cli/update-cmd.js';
import { resolveAppLayout } from '../src/installer/layout.js';
import { canonicalManifestPayload, ManifestVerifier } from '../src/installer/manifest.js';
import type { ServiceAdapter } from '../src/installer/platform/darwin.js';
import type { UpdateSchedulerAdapter } from '../src/installer/platform/update-scheduler.js';
import type { ReleaseManifest, UnsignedReleaseManifest } from '../src/installer/types.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xangi-cli-'));
  roots.push(root);
  const layout = resolveAppLayout({ platform: 'darwin', arch: 'arm64', homeDir: root });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const artifact = Buffer.from('fixture-bundle');
  const unsigned: UnsignedReleaseManifest = {
    schemaVersion: 1,
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    asset: {
      url: 'https://releases.example/xangi.tar.gz',
      size: artifact.byteLength,
      sha256: createHash('sha256').update(artifact).digest('hex'),
    },
  };
  const manifest: ReleaseManifest = {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalManifestPayload(unsigned)), privateKey).toString(
      'base64'
    ),
  };
  return {
    root,
    layout,
    manifest,
    artifact,
    verifier: new ManifestVerifier(publicKey),
    publicKey,
  };
}

function fakeService(
  running = false
): ServiceAdapter & { installs: number; restarts: number; uninstalls: number } {
  return {
    installs: 0,
    restarts: 0,
    uninstalls: 0,
    async install() {
      this.installs += 1;
    },
    async restart() {
      this.restarts += 1;
    },
    async uninstall() {
      this.uninstalls += 1;
    },
    async status() {
      return { running, detail: 'fixture' };
    },
    async openBrowser() {},
  };
}

function fakeUpdateScheduler(installed = false): UpdateSchedulerAdapter & {
  installs: number;
  uninstalls: number;
} {
  return {
    installs: 0,
    uninstalls: 0,
    async install() {
      this.installs += 1;
    },
    async uninstall() {
      this.uninstalls += 1;
    },
    async status() {
      return { installed, detail: 'fixture' };
    },
  };
}

describe('managed installer CLI integration', () => {
  it('requires AI-guided setup configuration instead of opening a browser fallback', async () => {
    const { layout } = await fixture();

    await expect(requireSetupConfiguration(layout)).rejects.toThrow(
      '先に `xangi setup` を実行してください'
    );

    await mkdir(layout.configDir, { recursive: true });
    await writeFile(layout.configFile, '{}');
    await expect(requireSetupConfiguration(layout)).resolves.toBeUndefined();
  });

  it('installs a verified fixture bundle, provisions the service, and preserves personal data', async () => {
    const { layout, manifest, artifact, verifier } = await fixture();
    const service = fakeService();
    const updateScheduler = fakeUpdateScheduler();
    await mkdir(layout.workspaceDir, { recursive: true });
    await mkdir(layout.stateDir, { recursive: true });
    await writeFile(join(layout.workspaceDir, 'AGENTS.md'), 'my assistant');
    await writeFile(join(layout.stateDir, 'session.json'), '{"kept":true}');

    const output = await installCmd(
      { manifest: 'https://releases.example/manifest.json' },
      {
        layout,
        manifestVerifier: verifier,
        fetchManifest: async () => manifest,
        download: async () => artifact,
        extractArtifact: async (_bytes, destination) => {
          await mkdir(join(destination, 'dist'), { recursive: true });
          await writeFile(join(destination, 'dist', 'index.js'), 'fixture');
        },
        service,
        updateScheduler,
        healthCheck: async () => true,
        ensureConfigured: async () => undefined,
        initializeWorkspace: async () => ({ workspacePath: layout.workspaceDir }),
      }
    );

    expect(output).toContain('Installed xangi 1.0.0');
    expect(service.installs).toBe(1);
    expect(service.restarts).toBe(0);
    expect(updateScheduler.installs).toBe(1);
    expect(await readlink(layout.currentLink)).toBe(join(layout.versionsDir, '1.0.0'));
    expect(await readFile(join(layout.workspaceDir, 'AGENTS.md'), 'utf8')).toBe('my assistant');
    expect(await readFile(join(layout.stateDir, 'session.json'), 'utf8')).toBe('{"kept":true}');
  });

  it('cleans up a newly provisioned service and timer when timer installation fails', async () => {
    const { layout, manifest, artifact, verifier } = await fixture();
    const service = fakeService();
    const updateScheduler = fakeUpdateScheduler();
    updateScheduler.install = async () => {
      updateScheduler.installs += 1;
      throw new Error('timer registration failed');
    };

    await expect(
      installCmd(
        { manifest: 'https://releases.example/manifest.json' },
        {
          layout,
          manifestVerifier: verifier,
          fetchManifest: async () => manifest,
          download: async () => artifact,
          extractArtifact: async (_bytes, destination) => {
            await writeFile(join(destination, 'version.txt'), '1.0.0');
          },
          service,
          updateScheduler,
          healthCheck: async () => true,
          ensureConfigured: async () => undefined,
          initializeWorkspace: async () => ({ workspacePath: layout.workspaceDir }),
        }
      )
    ).rejects.toThrow('timer registration failed');

    expect(service.installs).toBe(1);
    expect(service.uninstalls).toBe(1);
    expect(updateScheduler.installs).toBe(1);
    expect(updateScheduler.uninstalls).toBe(1);
  });

  it('updates without restarting the service and preserves personal data', async () => {
    const first = await fixture();
    const service = fakeService(true);
    await mkdir(join(first.layout.versionsDir, '0.9.0'), { recursive: true });
    await mkdir(first.layout.workspaceDir, { recursive: true });
    await mkdir(first.layout.stateDir, { recursive: true });
    await writeFile(join(first.layout.workspaceDir, 'USER.md'), 'private preference');
    await writeFile(join(first.layout.stateDir, 'sync.json'), 'private state');
    const { symlink } = await import('node:fs/promises');
    await symlink(join(first.layout.versionsDir, '0.9.0'), first.layout.currentLink, 'dir');

    await expect(
      updateCmd(
        { manifest: 'https://releases.example/manifest.json' },
        {
          layout: first.layout,
          manifestVerifier: first.verifier,
          fetchManifest: async () => first.manifest,
          download: async () => first.artifact,
          extractArtifact: async (_bytes, destination) => {
            await writeFile(join(destination, 'version.txt'), '1.0.0');
          },
          service,
          healthCheck: async () => false,
          healthTimeoutMs: 25,
          healthRetryIntervalMs: 5,
        }
      )
    ).resolves.toBe('Updated xangi to 1.0.0 (previous 0.9.0)');

    expect(service.installs).toBe(0);
    expect(service.restarts).toBe(0);
    expect(await readlink(first.layout.currentLink)).toBe(join(first.layout.versionsDir, '1.0.0'));
    expect(await readFile(join(first.layout.workspaceDir, 'USER.md'), 'utf8')).toBe(
      'private preference'
    );
    expect(await readFile(join(first.layout.stateDir, 'sync.json'), 'utf8')).toBe('private state');
  });

  it('uninstalls a newly provisioned LaunchAgent when the first health check fails', async () => {
    const { layout, manifest, artifact, verifier } = await fixture();
    const service = fakeService();

    await expect(
      installCmd(
        { manifest: 'https://releases.example/manifest.json' },
        {
          layout,
          manifestVerifier: verifier,
          fetchManifest: async () => manifest,
          download: async () => artifact,
          extractArtifact: async (_bytes, destination) => {
            await writeFile(join(destination, 'version.txt'), '1.0.0');
          },
          service,
          healthCheck: async () => false,
          healthTimeoutMs: 25,
          healthRetryIntervalMs: 5,
          ensureConfigured: async () => undefined,
          initializeWorkspace: async () => ({ workspacePath: layout.workspaceDir }),
        }
      )
    ).rejects.toThrow('rolled back');

    expect(service.installs).toBe(1);
    expect(service.uninstalls).toBe(1);
  });

  it('uses installer-persisted release trust defaults when flags and env are absent', async () => {
    const { layout, manifest, artifact, publicKey } = await fixture();
    const service = fakeService();
    await mkdir(join(layout.appRoot, 'trust'), { recursive: true });
    await mkdir(layout.configDir, { recursive: true });
    await writeFile(
      join(layout.appRoot, 'trust', 'release-public-key.pem'),
      publicKey.export({ type: 'spki', format: 'pem' })
    );
    await writeFile(
      join(layout.configDir, 'release.json'),
      JSON.stringify({ manifestUrl: 'https://releases.example/manifest.json' }),
      { mode: 0o600 }
    );
    let requestedUrl = '';

    await updateCmd(
      {},
      {
        layout,
        service,
        initializeWorkspace: async () => ({ workspacePath: layout.workspaceDir }),
        fetchManifest: async (url) => {
          requestedUrl = url;
          return manifest;
        },
        download: async () => artifact,
        extractArtifact: async (_bytes, destination) => {
          await writeFile(join(destination, 'version.txt'), '1.0.0');
        },
        healthCheck: async () => true,
      }
    );

    expect(requestedUrl).toBe('https://releases.example/manifest.json');
  });

  it('registers LaunchAgent when bootstrap installed current files but no service', async () => {
    const { layout, manifest, artifact, verifier } = await fixture();
    const service = fakeService(false);
    await mkdir(join(layout.versionsDir, '1.0.0'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(join(layout.versionsDir, '1.0.0'), layout.currentLink, 'dir');

    await installCmd(
      { manifest: 'https://releases.example/manifest.json' },
      {
        layout,
        manifestVerifier: verifier,
        fetchManifest: async () => manifest,
        download: async () => artifact,
        extractArtifact: async () => undefined,
        service,
        healthCheck: async () => true,
        ensureConfigured: async () => undefined,
        initializeWorkspace: async () => ({ workspacePath: layout.workspaceDir }),
      }
    );

    expect(service.installs).toBe(1);
    expect(service.restarts).toBe(0);
  });

  it('rejects traversal paths and links before extracting a release archive', () => {
    expect(() => validateTarListing('../escape', '-rw-r--r-- escape')).toThrow('Unsafe');
    expect(() =>
      validateTarListing('bundle/link\n', 'lrwxr-xr-x user/group 0 date bundle/link -> /tmp')
    ).toThrow('only regular files');
    expect(() =>
      validateTarListing(
        'bundle/dist/index.js\n',
        '-rw-r--r-- user/group 1 date bundle/dist/index.js'
      )
    ).not.toThrow();
    expect(() =>
      validateTarListing(
        'bundle/dist/index.js\nother/file.txt\n',
        '-rw-r--r-- user/group 1 date bundle/dist/index.js\n-rw-r--r-- user/group 1 date other/file.txt'
      )
    ).toThrow('one top-level');
  });

  it('keeps a pre-existing service installed when an idempotent install rolls back', async () => {
    const { layout, manifest, artifact, verifier } = await fixture();
    const service = fakeService(true);
    await mkdir(join(layout.versionsDir, '0.9.0'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(join(layout.versionsDir, '0.9.0'), layout.currentLink, 'dir');

    await expect(
      installCmd(
        { manifest: 'https://releases.example/manifest.json' },
        {
          layout,
          manifestVerifier: verifier,
          fetchManifest: async () => manifest,
          download: async () => artifact,
          extractArtifact: async (_bytes, destination) => {
            await writeFile(join(destination, 'version.txt'), '1.0.0');
          },
          service,
          healthCheck: async () => false,
          healthTimeoutMs: 25,
          healthRetryIntervalMs: 5,
          ensureConfigured: async () => undefined,
          initializeWorkspace: async () => ({ workspacePath: layout.workspaceDir }),
        }
      )
    ).rejects.toThrow('rolled back');

    expect(service.installs).toBe(0);
    expect(service.restarts).toBe(2);
    expect(service.uninstalls).toBe(0);
    expect(await readlink(layout.currentLink)).toBe(join(layout.versionsDir, '0.9.0'));
  });
});
