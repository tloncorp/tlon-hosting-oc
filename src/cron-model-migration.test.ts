import { describe, expect, it, vi } from 'vitest';

import {
  LEGACY_HOSTED_CRON_MODEL,
  migrateCurrentCronModels,
  registerCronModelMigration,
} from './cron-model-migration.js';
import { configuredPrimaryModel } from './hosted-model-policy.js';

type CronStoreFile = Awaited<
  ReturnType<
    (typeof import('openclaw/plugin-sdk/cron-store-runtime'))['loadCronStore']
  >
>;

describe('cron model migration', () => {
  it('reads string and object primary model configuration', () => {
    expect(
      configuredPrimaryModel({ agents: { defaults: { model: 'openai/gpt-5' } } })
    ).toBe('openai/gpt-5');
    expect(
      configuredPrimaryModel({
        agents: { defaults: { model: { primary: 'anthropic/claude' } } },
      })
    ).toBe('anthropic/claude');
  });

  it('migrates current SQLite-backed cron models through the OpenClaw store runtime', async () => {
    const sourceStore: CronStoreFile = {
      version: 1 as const,
      jobs: [
        {
          id: 'm3-job',
          name: 'M3 job',
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: 'every' as const, everyMs: 60_000 },
          sessionTarget: 'isolated' as const,
          wakeMode: 'now' as const,
          payload: {
            kind: 'agentTurn' as const,
            message: 'run',
            model: 'openrouter/minimax/minimax-m3',
            fallbacks: [
              'minimax/minimax-m3',
              'anthropic/claude-opus-4-6',
            ],
          },
          state: {},
        },
        {
          id: 'legacy-default-job',
          name: 'Legacy default job',
          enabled: true,
          createdAtMs: 2,
          updatedAtMs: 2,
          schedule: { kind: 'every' as const, everyMs: 60_000 },
          sessionTarget: 'isolated' as const,
          wakeMode: 'now' as const,
          payload: {
            kind: 'agentTurn' as const,
            message: 'run',
            model: LEGACY_HOSTED_CRON_MODEL,
            fallbacks: [LEGACY_HOSTED_CRON_MODEL],
          },
          state: {},
        },
        {
          id: 'premium-job',
          name: 'Premium job',
          enabled: true,
          createdAtMs: 3,
          updatedAtMs: 3,
          schedule: { kind: 'every' as const, everyMs: 60_000 },
          sessionTarget: 'isolated' as const,
          wakeMode: 'now' as const,
          payload: {
            kind: 'agentTurn' as const,
            message: 'run',
            model: 'anthropic/claude-opus-4-6',
            fallbacks: [],
          },
          state: {},
        },
      ],
    };
    let persistedStore: CronStoreFile = structuredClone(sourceStore);

    const result = await migrateCurrentCronModels({
      config: { cron: { store: '/state/cron/jobs.json' } },
      logger: { info: vi.fn(), warn: vi.fn() },
      cronStore: {
        resolveCronStorePath: path => path ?? '/default/cron/jobs.json',
        loadCronStore: async () => structuredClone(sourceStore),
        saveCronStore: async (_path, store) => {
          persistedStore = structuredClone(store);
        },
      },
    });

    expect(result.changedJobs).toEqual(['m3-job', 'legacy-default-job']);
    expect(persistedStore.jobs[0].payload).toEqual({
      kind: 'agentTurn',
      message: 'run',
      fallbacks: ['anthropic/claude-opus-4-6'],
    });
    expect(persistedStore.jobs[1].payload).toEqual({
      kind: 'agentTurn',
      message: 'run',
    });
    expect(persistedStore.jobs[2].payload).toEqual({
      kind: 'agentTurn',
      message: 'run',
      model: 'anthropic/claude-opus-4-6',
      fallbacks: [],
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
