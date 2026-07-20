import { rm } from 'node:fs/promises';
import {
  resolveManagedLifecycle,
  type InstallerFlags,
  type ManagedCommandDependencies,
} from './update-cmd.js';

const REINSTALL_COMMAND =
  'curl -fsSL https://github.com/karaage0703/xangi/releases/latest/download/install.sh | bash';

function enabled(flags: InstallerFlags, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

export async function uninstallCmd(
  flags: InstallerFlags,
  dependencies: ManagedCommandDependencies = {}
): Promise<string> {
  const purge = enabled(flags, 'purge');
  if (purge && !enabled(flags, 'yes')) {
    throw new Error(
      '`xangi uninstall --purge` deletes settings, tokens, and state. Run again with `--purge --yes` to confirm. The workspace is never deleted.'
    );
  }

  const runtime = await resolveManagedLifecycle(dependencies);
  await runtime.updateScheduler.uninstall();
  await runtime.service.uninstall();
  await rm(runtime.layout.appRoot, { recursive: true, force: true });

  if (purge) {
    await Promise.all([
      rm(runtime.layout.configDir, { recursive: true, force: true }),
      rm(runtime.layout.stateDir, { recursive: true, force: true }),
    ]);
  }

  const retained = purge ? 'Kept workspace.' : 'Kept workspace, settings, tokens, and state.';
  return `Uninstalled xangi.\n${retained}\nReinstall: ${REINSTALL_COMMAND}`;
}
