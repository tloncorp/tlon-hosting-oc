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
    expect(request).toHaveBeenCalledWith(
      'cron.update',
      {
        id: 'm3-job',
        patch: {
          payload: {
            kind: 'agentTurn',
            model: null,
            fallbacks: null,
          },
        },
      },
      { scopes: ['operator.admin'] }
    );
  });

  it('leaves budget-held jobs alone so the hold keeps recognising them', async () => {
    const request = vi.fn(
      async (method: string, _params: Record<string, unknown>) => {
        if (method === 'cron.list') {
          return {
            jobs: [
              {
                id: 'held-job',
                description: '[Paused: credit budget] Morning digest',
                payload: { kind: 'agentTurn', model: 'openai/gpt-5' },
              },
              {
                id: 'held-undescribed-job',
                description: '[Paused: credit budget]',
                payload: { kind: 'agentTurn', fallbacks: ['openai/gpt-5'] },
              },
              {
                id: 'unheld-job',
                description: 'Morning digest',
                payload: { kind: 'agentTurn', model: 'openai/gpt-5' },
              },
            ],
            total: 3,
          };
        }
        return { ok: true };
      }
    );

    const result = await migrateCurrentCronModels({
      logger: { info: vi.fn(), warn: vi.fn() },
      request,
    });

    expect(result.changedJobs).toEqual(['unheld-job']);
    const updatedIds = request.mock.calls
      .filter(([method]) => method === 'cron.update')
      .map(([, params]) => params.id);
    expect(updatedIds).toEqual(['unheld-job']);
  });

  it('requests operator.admin for cron.update through the gateway runtime', async () => {
    const gatewayRequest = vi.fn(async (method: string) => {
      if (method === 'cron.list') {
        return {
          jobs: [
            {
              id: 'pinned-job',
              payload: { kind: 'agentTurn', model: 'openai/gpt-5' },
            },
          ],
          total: 1,
        };
      }
      return { ok: true };
    });
    const registerService = vi.fn();
    registerCronModelMigration({
      registerService,
      runtime: { gateway: { request: gatewayRequest } },
    } as never);

    const service = registerService.mock.calls[0][0];
    const logger = { info: vi.fn(), warn: vi.fn() };
    await service.start({ logger });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(gatewayRequest).toHaveBeenCalledWith(
      'cron.update',
      expect.objectContaining({ id: 'pinned-job' }),
      { scopes: ['operator.admin'] }
    );
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
