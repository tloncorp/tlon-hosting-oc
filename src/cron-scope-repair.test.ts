import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  repairCronScopeUpgrades,
  runCronScopeRepair,
} from './cron-scope-repair.js';

describe('cron scope repair', () => {
  it('approves only cron operator.admin repair requests', () => {
    const result = repairCronScopeUpgrades(
      {
        cron: {
          requestId: 'cron',
          deviceId: 'device-1',
          displayName: 'Cron',
          isRepair: true,
          requestedByTool: 'cron',
          scopes: ['operator.admin'],
          ts: 1,
        },
        other: {
          requestId: 'other',
          deviceId: 'device-2',
          isRepair: true,
          requestedByTool: 'other',
          scopes: ['operator.admin'],
        },
      },
      {
        'device-1': {
          deviceId: 'device-1',
          createdAtMs: 10,
          tokens: { operator: { token: 'secret', scopes: ['operator.read'] } },
        },
      },
      20
    );

    expect(result.approved).toBe(1);
    expect(result.pending).toEqual({
      other: expect.objectContaining({ requestId: 'other' }),
    });
    expect(result.paired['device-1']).toEqual(
      expect.objectContaining({
        deviceId: 'device-1',
        createdAtMs: 10,
        approvedAtMs: 20,
        scopes: ['operator.admin'],
        approvedScopes: ['operator.admin'],
        tokens: {
          operator: { token: 'secret', scopes: ['operator.admin'] },
        },
      })
    );
  });

  it('persists repaired device state under the OpenClaw state directory', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tlon-hosting-oc-'));
    try {
      const devicesDir = join(stateDir, 'devices');
      await mkdir(devicesDir, { recursive: true });
      await writeFile(
        join(devicesDir, 'pending.json'),
        JSON.stringify({
          request: {
            requestId: 'request',
            deviceId: 'device',
            isRepair: true,
            requestedByTool: 'cron',
            scopes: ['operator.admin'],
          },
        })
      );
      await writeFile(
        join(devicesDir, 'paired.json'),
        JSON.stringify({ device: { deviceId: 'device' } })
      );
      const logger = { info: vi.fn(), warn: vi.fn() };

      await runCronScopeRepair(stateDir, logger);

      expect(
        JSON.parse(await readFile(join(devicesDir, 'pending.json'), 'utf8'))
      ).toEqual({});
      expect(
        JSON.parse(await readFile(join(devicesDir, 'paired.json'), 'utf8'))
          .device.approvedScopes
      ).toEqual(['operator.admin']);
      expect(logger.info).toHaveBeenCalledWith(
        '[tlon-hosting] Auto-approved 1 pending cron operator.admin scope upgrade'
      );
    } finally {
      await rm(stateDir, { recursive: true });
    }
  });
});
