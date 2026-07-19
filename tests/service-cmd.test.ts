import { describe, expect, it } from 'vitest';
import { serviceCmd } from '../src/cli/service-cmd.js';
import type { ServiceAdapter } from '../src/installer/platform/service.js';

describe('service command', () => {
  it('restarts a managed service through its OS service adapter', async () => {
    let restarts = 0;
    const service: ServiceAdapter = {
      async install() {},
      async uninstall() {},
      async restart() {
        restarts += 1;
      },
      async status() {
        return { running: true, detail: 'active' };
      },
      async openBrowser() {},
    };

    await expect(
      serviceCmd('restart', {}, { installationKind: 'managed', managedService: service })
    ).resolves.toBe('Restarted xangi service');
    expect(restarts).toBe(1);
  });
});
