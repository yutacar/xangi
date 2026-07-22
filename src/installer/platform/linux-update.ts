import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdateSchedulerAdapter, UpdateSchedulerStatus } from './update-scheduler.js';
import { systemdPathValue } from './linux.js';

export interface SystemdUpdateSchedulerOptions {
  serviceName: string;
  servicePath: string;
  timerName: string;
  timerPath: string;
  launcherPath: string;
  workingDirectory: string;
  intervalSeconds?: number;
}

export interface LinuxUpdateCommandRunner {
  run(command: string, args: string[], allowFailure?: boolean): string;
  status(command: string, args: string[]): { status: number | null; output: string };
}

function systemdValue(value: string): string {
  if ([...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('systemd unit values may not contain control characters');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function unitName(value: string, suffix: 'service' | 'timer'): string {
  if (!new RegExp(`^[A-Za-z0-9_.@-]+\\.${suffix}$`).test(value)) {
    throw new Error(`Invalid systemd ${suffix} name: ${value}`);
  }
  return value;
}

function validatedInterval(value = 21_600): number {
  if (!Number.isSafeInteger(value) || value < 300 || value > 2_592_000) {
    throw new Error('Update interval must be an integer between 300 and 2592000 seconds');
  }
  return value;
}

export function renderSystemdUpdateService(options: SystemdUpdateSchedulerOptions): string {
  unitName(options.serviceName, 'service');
  return [
    '[Unit]',
    'Description=Update xangi from its signed release channel',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${systemdValue(options.launcherPath)} update`,
    `WorkingDirectory=${systemdPathValue(options.workingDirectory)}`,
    '',
  ].join('\n');
}

export function renderSystemdUpdateTimer(options: SystemdUpdateSchedulerOptions): string {
  const serviceName = unitName(options.serviceName, 'service');
  unitName(options.timerName, 'timer');
  const interval = validatedInterval(options.intervalSeconds);
  return [
    '[Unit]',
    'Description=Periodically check for signed xangi updates',
    '',
    '[Timer]',
    'OnBootSec=5m',
    `OnUnitActiveSec=${interval}s`,
    'Persistent=true',
    `Unit=${serviceName}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

function run(command: string, args: string[], allowFailure = false): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  if (!allowFailure && (result.status ?? 1) !== 0) {
    throw new Error(output.trim() || `${command} ${args.join(' ')} failed`);
  }
  return output.trim();
}

const defaultCommands: LinuxUpdateCommandRunner = {
  run,
  status(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return {
      status: result.status,
      output: (String(result.stdout ?? '') + String(result.stderr ?? '')).trim(),
    };
  },
};

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, path);
}

export function createLinuxUpdateScheduler(
  options: SystemdUpdateSchedulerOptions,
  commands: LinuxUpdateCommandRunner = defaultCommands
): UpdateSchedulerAdapter {
  return {
    async install(): Promise<void> {
      const availability = commands.status('systemctl', ['--user', 'show-environment']);
      if (availability.status !== 0) {
        throw new Error('systemd user timer is unavailable');
      }
      mkdirSync(dirname(options.servicePath), { recursive: true });
      mkdirSync(dirname(options.timerPath), { recursive: true });
      try {
        writeAtomic(options.servicePath, renderSystemdUpdateService(options));
        writeAtomic(options.timerPath, renderSystemdUpdateTimer(options));
        commands.run('systemctl', ['--user', 'daemon-reload']);
        commands.run('systemctl', ['--user', 'enable', '--now', options.timerName]);
      } catch (error) {
        commands.run('systemctl', ['--user', 'disable', '--now', options.timerName], true);
        rmSync(options.servicePath, { force: true });
        rmSync(options.timerPath, { force: true });
        commands.run('systemctl', ['--user', 'daemon-reload'], true);
        throw error;
      }
    },
    async uninstall(): Promise<void> {
      commands.run('systemctl', ['--user', 'disable', '--now', options.timerName], true);
      rmSync(options.servicePath, { force: true });
      rmSync(options.timerPath, { force: true });
      commands.run('systemctl', ['--user', 'daemon-reload'], true);
    },
    async status(): Promise<UpdateSchedulerStatus> {
      const enabled = commands.status('systemctl', ['--user', 'is-enabled', options.timerName]);
      const active = commands.status('systemctl', ['--user', 'is-active', options.timerName]);
      return {
        installed:
          enabled.status === 0 &&
          enabled.output.trim() === 'enabled' &&
          active.status === 0 &&
          active.output.trim() === 'active',
        detail: `${enabled.output}; ${active.output}`,
      };
    },
  };
}
