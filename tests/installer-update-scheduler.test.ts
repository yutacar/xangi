import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDarwinUpdateScheduler,
  renderUpdateLaunchAgentPlist,
  type DarwinUpdateCommandRunner,
  type DarwinUpdateSchedulerOptions,
} from '../src/installer/platform/darwin-update.js';
import {
  createLinuxUpdateScheduler,
  renderSystemdUpdateService,
  renderSystemdUpdateTimer,
  type LinuxUpdateCommandRunner,
  type SystemdUpdateSchedulerOptions,
} from '../src/installer/platform/linux-update.js';

describe('macOS update LaunchAgent', () => {
  function fixture(root: string): DarwinUpdateSchedulerOptions {
    return {
      label: 'dev.xangi.update',
      plistPath: join(root, 'LaunchAgents', 'dev.xangi.update.plist'),
      launcherPath: '/Users/Test User/Library/Application Support/xangi/app/bin/xangi',
      workingDirectory: '/Users/Test User/Library/Application Support/xangi/app/current',
      stdoutPath: join(root, 'logs', 'update.log'),
      stderrPath: join(root, 'logs', 'update.error.log'),
      intervalSeconds: 3600,
    };
  }

  it('renders a separate one-shot periodic signed update invocation', () => {
    const plist = renderUpdateLaunchAgentPlist(fixture('/tmp/xangi'));
    expect(plist).toContain('<string>dev.xangi.update</string>');
    expect(plist).toContain('<string>update</string>');
    expect(plist).toContain('<key>StartInterval</key>\n  <integer>3600</integer>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
  });

  it('installs, reports, and removes only the update LaunchAgent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-update-darwin-'));
    const calls: Array<[string, string[], boolean | undefined]> = [];
    const commands: DarwinUpdateCommandRunner = {
      run: vi.fn((command, args, allowFailure) => {
        calls.push([command, args, allowFailure]);
        return '';
      }),
      status: vi.fn(() => ({ status: 0, output: 'loaded' })),
    };
    const options = fixture(root);
    const scheduler = createDarwinUpdateScheduler(options, commands);

    await scheduler.install();
    expect((await stat(options.plistPath)).mode & 0o777).toBe(0o644);
    expect(await scheduler.status()).toEqual({ installed: true, detail: 'loaded' });
    await scheduler.uninstall();
    await expect(access(options.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls.map((call) => call[1][0])).toEqual(['bootout', 'bootstrap', 'bootout']);
  });
});

describe('Linux update systemd timer', () => {
  function fixture(root: string): SystemdUpdateSchedulerOptions {
    const unitDir = join(root, '.config', 'systemd', 'user');
    return {
      serviceName: 'xangi-update.service',
      servicePath: join(unitDir, 'xangi-update.service'),
      timerName: 'xangi-update.timer',
      timerPath: join(unitDir, 'xangi-update.timer'),
      launcherPath: '/home/Test User/.local/share/xangi/app/bin/xangi',
      workingDirectory: '/home/Test User/.local/share/xangi/app/current',
      intervalSeconds: 7200,
    };
  }

  it('renders a oneshot service and persistent timer', () => {
    const options = fixture('/tmp/xangi');
    const service = renderSystemdUpdateService(options);
    const timer = renderSystemdUpdateTimer(options);
    expect(service).toContain('Type=oneshot');
    expect(service).toContain(' update');
    expect(service).toContain(
      'WorkingDirectory=/home/Test\\x20User/.local/share/xangi/app/current'
    );
    expect(service).not.toContain('WorkingDirectory="');
    expect(timer).toContain('OnUnitActiveSec=7200s');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=xangi-update.service');
  });

  it('installs and uninstalls both user units symmetrically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xangi-update-linux-'));
    const calls: Array<[string, string[], boolean | undefined]> = [];
    const commands: LinuxUpdateCommandRunner = {
      run: vi.fn((command, args, allowFailure) => {
        calls.push([command, args, allowFailure]);
        return '';
      }),
      status: vi.fn((command, args) => {
        if (args.includes('show-environment')) return { status: 0, output: 'PATH=/usr/bin' };
        if (args.includes('is-active')) return { status: 0, output: 'active' };
        return { status: 0, output: 'enabled' };
      }),
    };
    const options = fixture(root);
    const scheduler = createLinuxUpdateScheduler(options, commands);

    await scheduler.install();
    expect(await readFile(options.servicePath, 'utf8')).toContain('/bin/xangi" update');
    expect(await readFile(options.timerPath, 'utf8')).toContain('timers.target');
    expect(await scheduler.status()).toEqual({ installed: true, detail: 'enabled; active' });
    await scheduler.uninstall();
    await expect(access(options.servicePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(options.timerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload'], undefined],
      ['systemctl', ['--user', 'enable', '--now', 'xangi-update.timer'], undefined],
      ['systemctl', ['--user', 'disable', '--now', 'xangi-update.timer'], true],
      ['systemctl', ['--user', 'daemon-reload'], true],
    ]);
  });

  it('treats an enabled but stopped timer as not installed so install repairs it', async () => {
    const options = fixture('/tmp/xangi-stopped');
    const commands: LinuxUpdateCommandRunner = {
      run: vi.fn(() => ''),
      status: vi.fn((_command, args) =>
        args.includes('is-enabled')
          ? { status: 0, output: 'enabled' }
          : { status: 3, output: 'inactive' }
      ),
    };
    await expect(createLinuxUpdateScheduler(options, commands).status()).resolves.toEqual({
      installed: false,
      detail: 'enabled; inactive',
    });
  });
});
