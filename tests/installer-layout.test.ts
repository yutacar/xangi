import { describe, expect, it } from 'vitest';
import {
  UnsupportedPlatformError,
  resolveAppLayout,
  versionPath,
} from '../src/installer/layout.js';

describe('resolveAppLayout', () => {
  it('Darwin のアプリ本体と利用者データを独立した領域へ配置する', () => {
    const layout = resolveAppLayout({
      platform: 'darwin',
      arch: 'arm64',
      homeDir: '/Users/example',
    });

    expect(layout).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      appRoot: '/Users/example/Library/Application Support/xangi/app',
      versionsDir: '/Users/example/Library/Application Support/xangi/app/versions',
      currentLink: '/Users/example/Library/Application Support/xangi/app/current',
      stagingDir: '/Users/example/Library/Application Support/xangi/app/staging',
      updateLock: '/Users/example/Library/Application Support/xangi/app/update.lock',
      workspaceDir: '/Users/example/xangi-workspace',
      stateDir: '/Users/example/Library/Application Support/xangi/state',
      configDir: '/Users/example/Library/Application Support/xangi/config',
      configFile: '/Users/example/Library/Application Support/xangi/config/xangi.json',
    });
    expect(versionPath(layout, '1.2.3')).toBe(
      '/Users/example/Library/Application Support/xangi/app/versions/1.2.3'
    );
  });

  it('将来の Windows adapter が同じ logical layout を利用できる', () => {
    const layout = resolveAppLayout({
      platform: 'win32',
      arch: 'x64',
      homeDir: 'C:\\Users\\example',
      localAppData: 'D:\\Local Data',
    });

    expect(layout.appRoot).toBe('D:\\Local Data\\Xangi\\app');
    expect(layout.workspaceDir).toBe('C:\\Users\\example\\xangi-workspace');
    expect(layout.stateDir).toBe('D:\\Local Data\\Xangi\\state');
    expect(layout.configFile).toBe('D:\\Local Data\\Xangi\\config\\xangi.json');
  });

  it('Linux は XDG data/config/state と利用者 workspace を分離する', () => {
    const layout = resolveAppLayout({
      platform: 'linux',
      arch: 'x64',
      homeDir: '/home/example',
      xdgDataHome: '/mnt/data',
      xdgConfigHome: '/mnt/config',
      xdgStateHome: '/mnt/state',
    });

    expect(layout).toEqual({
      platform: 'linux',
      arch: 'x64',
      appRoot: '/mnt/data/xangi/app',
      versionsDir: '/mnt/data/xangi/app/versions',
      currentLink: '/mnt/data/xangi/app/current',
      stagingDir: '/mnt/data/xangi/app/staging',
      updateLock: '/mnt/data/xangi/app/update.lock',
      workspaceDir: '/home/example/xangi-workspace',
      stateDir: '/mnt/state/xangi',
      configDir: '/mnt/config/xangi',
      configFile: '/mnt/config/xangi/xangi.json',
    });
    expect(versionPath(layout, '2.0.0')).toBe('/mnt/data/xangi/app/versions/2.0.0');
  });

  it('Linux は未指定の XDG path に標準 default を使う', () => {
    const layout = resolveAppLayout({
      platform: 'linux',
      arch: 'arm64',
      homeDir: '/home/example',
    });
    expect(layout.appRoot).toBe('/home/example/.local/share/xangi/app');
    expect(layout.configDir).toBe('/home/example/.config/xangi');
    expect(layout.stateDir).toBe('/home/example/.local/state/xangi');
  });

  it('Linux は relative XDG override を拒否する', () => {
    expect(() =>
      resolveAppLayout({
        platform: 'linux',
        arch: 'x64',
        homeDir: '/home/example',
        xdgConfigHome: 'relative/config',
      })
    ).toThrow(/XDG_CONFIG_HOME.*absolute/);
  });

  it.each([
    [{ platform: 'freebsd', arch: 'x64', homeDir: '/home/example' }],
    [{ platform: 'darwin', arch: 'riscv64', homeDir: '/Users/example' }],
    [{ platform: 'win32', arch: 'ia32', homeDir: 'C:\\Users\\example' }],
  ])('unsupported OS/architecture を path 解決時に拒否する: %o', (input) => {
    expect(() => resolveAppLayout(input)).toThrow(UnsupportedPlatformError);
  });

  it('version directory から脱出できる version を拒否する', () => {
    const layout = resolveAppLayout({
      platform: 'darwin',
      arch: 'x64',
      homeDir: '/Users/example',
    });

    expect(() => versionPath(layout, '../state')).toThrow(/version/i);
  });
});
