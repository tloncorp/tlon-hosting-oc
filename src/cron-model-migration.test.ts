import { describe, expect, it, vi } from 'vitest';

import {
  migrateCurrentCronModels,
  registerCronModelMigration,
} from './cron-model-migration.js';

describe('cron model migration', () => {
  it('unpins current cron models through the supported gateway API', async () => {
    const request = vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        if (method === 'cron.list') {
          return {
            jobs: [
              {
                id: 'm3-job',
                payload: {
                  kind: 'agentTurn',
                  message: 'run',
                  model: 'openrouter/minimax/minimax-m3',
                  fallbacks: ['anthropic/claude-opus-4-6'],
                },
              },
              {
                id: 'inherited-job',
                payload: { kind: 'agentTurn', message: 'run' },
              },
              {
                id: 'system-job',
                payload: { kind: 'systemEvent', text: 'run' },
              },
            ],
            total: 3,
            offset: params.offset,
            limit: params.limit,
          };
        }
        if (method === 'cron.update') {
          return { ok: true };
        }
        throw new Error(`unexpected method ${method}`);
      }
    );

    const result = await migrateCurrentCronModels({
      logger: { info: vi.fn(), warn: vi.fn() },
      request,
    });

    expect(result.changedJobs).toEqual(['m3-job']);
    expect(request).toHaveBeenCalledWith('cron.update', {
      id: 'm3-job',
      patch: {
        payload: {
          kind: 'agentTurn',
          model: null,
          fallbacks: null,
        },
      },
    });
  });

  it('registers an awaited OpenClaw service', () => {
    const registerService = vi.fn();

    registerCronModelMigration({ registerService } as never);

    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tlon-hosting-cron-model-migration',
        start: expect.any(Function),
      })
    );
  });
});
