import { spawn } from 'node:child_process';

export const MAX_TAR_LISTING_ENTRIES = 1_000_000;
export const MAX_TAR_LISTING_LINE_BYTES = 64 * 1024;
const MAX_TAR_STDERR_BYTES = 1024 * 1024;

export async function streamTarListing(
  archivePath: string,
  verbose: boolean,
  onLine: (line: string) => void
): Promise<void> {
  const args = [verbose ? '-tvzf' : '-tzf', archivePath];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let entries = 0;
    let stderr = '';
    let failure: Error | undefined;

    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
    };
    const processLine = (line: string) => {
      if (!line) return;
      if (Buffer.byteLength(line) > MAX_TAR_LISTING_LINE_BYTES) {
        fail(
          new Error(
            `Archive listing line exceeds ${MAX_TAR_LISTING_LINE_BYTES} bytes; archive is not supported`
          )
        );
        return;
      }
      entries += 1;
      if (entries > MAX_TAR_LISTING_ENTRIES) {
        fail(
          new Error(
            `Archive contains more than ${MAX_TAR_LISTING_ENTRIES} entries; archive is not supported`
          )
        );
        return;
      }
      try {
        onLine(line);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (failure) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_TAR_LISTING_LINE_BYTES && !buffer.includes('\n')) {
        fail(
          new Error(
            `Archive listing line exceeds ${MAX_TAR_LISTING_LINE_BYTES} bytes; archive is not supported`
          )
        );
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr) < MAX_TAR_STDERR_BYTES) stderr += chunk;
    });
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      if (!failure && buffer) processLine(buffer.replace(/\r$/, ''));
      if (failure) reject(failure);
      else if (code !== 0) {
        reject(new Error(`tar listing failed with exit ${code}: ${stderr.trim() || 'no details'}`));
      } else resolve();
    });
  });
}
