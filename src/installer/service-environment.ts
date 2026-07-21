import { delimiter, dirname, join } from 'node:path';
import type { AppLayout } from './types.js';

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

export function managedServicePath(
  layout: AppLayout,
  homeDir: string,
  backendExecutable?: string
): string {
  const backendDirectory = backendExecutable ? dirname(backendExecutable) : undefined;
  const common = [
    backendDirectory,
    join(homeDir, '.local', 'bin'),
    join(homeDir, '.npm-global', 'bin'),
    '/usr/local/bin',
  ].filter((value): value is string => Boolean(value));
  const platformPaths =
    layout.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/bin', '/bin'] : ['/usr/bin', '/bin'];
  return uniquePaths([...common, ...platformPaths]).join(delimiter);
}
