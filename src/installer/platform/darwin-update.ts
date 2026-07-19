import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdateSchedulerAdapter, UpdateSchedulerStatus } from './update-scheduler.js';

export interface DarwinUpdateSchedulerOptions {
  label: string;
  plistPath: string;
  launcherPath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  intervalSeconds?: number;
}

export interface DarwinUpdateCommandRunner {
  run(command: string, args: string[], allowFailure?: boolean): string;
  status(command: string, args: string[]): { status: number | null; output: string };
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validatedInterval(value = 21_600): number {
  if (!Number.isSafeInteger(value) || value < 300 || value > 2_592_000) {
    throw new Error('Update interval must be an integer between 300 and 2592000 seconds');
  }
  return value;
}

export function renderUpdateLaunchAgentPlist(options: DarwinUpdateSchedulerOptions): string {
  const interval = validatedInterval(options.intervalSeconds);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(options.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(options.launcherPath)}</string>`,
    '    <string>update</string>',
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(options.workingDirectory)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>StartInterval</key>',
    `  <integer>${interval}</integer>`,
    '  <key>StandardOutPath</key>',
    `  <string>${xml(options.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(options.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function launchctlDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('LaunchAgent requires a numeric user id');
  return `gui/${uid}`;
}

function run(command: string, args: string[], allowFailure = false): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  if (!allowFailure && (result.status ?? 1) !== 0) {
    throw new Error(output.trim() || `${command} ${args.join(' ')} failed`);
  }
  return output.trim();
}

const defaultCommands: DarwinUpdateCommandRunner = {
  run,
  status(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return {
      status: result.status,
      output: (String(result.stdout ?? '') + String(result.stderr ?? '')).trim(),
    };
  },
};

export function createDarwinUpdateScheduler(
  options: DarwinUpdateSchedulerOptions,
  commands: DarwinUpdateCommandRunner = defaultCommands
): UpdateSchedulerAdapter {
  const domain = launchctlDomain();
  return {
    async install(): Promise<void> {
      mkdirSync(dirname(options.plistPath), { recursive: true });
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      mkdirSync(dirname(options.stderrPath), { recursive: true });
      const temporary = `${options.plistPath}.tmp-${process.pid}`;
      try {
        writeFileSync(temporary, renderUpdateLaunchAgentPlist(options), { mode: 0o644 });
        chmodSync(temporary, 0o644);
        renameSync(temporary, options.plistPath);
        commands.run('launchctl', ['bootout', domain, options.plistPath], true);
        commands.run('launchctl', ['bootstrap', domain, options.plistPath]);
      } catch (error) {
        rmSync(temporary, { force: true });
        commands.run('launchctl', ['bootout', domain, options.plistPath], true);
        rmSync(options.plistPath, { force: true });
        throw error;
      }
    },
    async uninstall(): Promise<void> {
      commands.run('launchctl', ['bootout', domain, options.plistPath], true);
      rmSync(options.plistPath, { force: true });
    },
    async status(): Promise<UpdateSchedulerStatus> {
      const result = commands.status('launchctl', ['print', `${domain}/${options.label}`]);
      return { installed: result.status === 0, detail: result.output };
    },
  };
}
