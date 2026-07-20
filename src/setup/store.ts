import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseSetupConfig, type SetupConfig } from './schema.js';

export { parseSetupConfig, SetupValidationError, type SetupConfig } from './schema.js';

export interface SetupConfigWriter {
  save(config: SetupConfig): Promise<void>;
}

export class SetupStore {
  constructor(readonly configPath: string) {}

  async save(input: unknown): Promise<void> {
    const config = parseSetupConfig(input);
    const directory = dirname(this.configPath);
    const temporaryPath = join(
      directory,
      `.${basename(this.configPath)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
    );
    const body = `${JSON.stringify(config, null, 2)}\n`;

    await mkdir(directory, { recursive: true, mode: 0o700 });

    let temporaryCreated = false;
    try {
      const file = await open(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      try {
        await file.writeFile(body, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }

      await rename(temporaryPath, this.configPath);
      temporaryCreated = false;
      await chmod(this.configPath, 0o600);
    } finally {
      if (temporaryCreated) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }
}
