import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CRON_MODEL_MIGRATION_MARKER,
  LEGACY_HOSTED_CRON_MODEL,
  configuredPrimaryModel,
  migrateLegacyCronModels,
  registerCronModelMigration,
} from './cron-model-migration.js';

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

  it('removes only the legacy agent-turn override and creates a backup', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tlon-hosting-cron-'));
    try {
      const cronDir = join(stateDir, 'cron');
      const storePath = join(cronDir, 'jobs.json');
      await mkdir(cronDir);
      await writeFile(
        storePath,
        JSON.stringify({
          jobs: [
            {
              id: 'legacy',
              payload: {
                kind: 'agentTurn',
                model: LEGACY_HOSTED_CRON_MODEL,
                message: 'run',
              },
            },
            {
              id: 'custom',
              payload: { kind: 'agentTurn', model: 'openai/gpt-5' },
            },
            {
              id: 'other-kind',
              payload: { kind: 'systemEvent', model: LEGACY_HOSTED_CRON_MODEL },
            },
          ],
        })
      );
      const logger = { info: vi.fn(), warn: vi.fn() };

      const result = await migrateLegacyCronModels({
        stateDir,
        currentPrimaryModel: 'anthropic/claude',
        logger,
        now: 1_700_000_000_000,
      });

      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        throw new Error(`unexpected migration status: ${result.status}`);
      }
      expect(result.changedJobs).toEqual(['legacy']);
      const store = JSON.parse(await readFile(storePath, 'utf8'));
      expect(store.jobs[0].payload).toEqual({
        kind: 'agentTurn',
        message: 'run',
      });
      expect(store.jobs[1].payload.model).toBe('openai/gpt-5');
      expect(store.jobs[2].payload.model).toBe(
        LEGACY_HOSTED_CRON_MODEL
      );
      expect(await lstat(result.backupPath!)).toBeDefined();
      expect(
        JSON.parse(
          await readFile(
            join(stateDir, CRON_MODEL_MIGRATION_MARKER),
            'utf8'
          )
        )
      ).toMatchObject({
        status: 'completed',
        currentPrimaryModel: 'anthropic/claude',
        changedJobCount: 1,
        changedJobIds: ['legacy'],
      });
    } finally {
      await rm(stateDir, { recursive: true });
    }
  });

  it('marks a missing store complete without creating the cron directory', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tlon-hosting-cron-'));
    try {
      const result = await migrateLegacyCronModels({
        stateDir,
        currentPrimaryModel: 'openai/gpt-5',
        logger: { info: vi.fn(), warn: vi.fn() },
        now: 1_700_000_000_000,
      });

      expect(result.status).toBe('completed-no-store');
      expect(
        JSON.parse(
          await readFile(
            join(stateDir, CRON_MODEL_MIGRATION_MARKER),
            'utf8'
          )
        ).status
      ).toBe('completed-no-store');
    } finally {
      await rm(stateDir, { recursive: true });
    }
  });

  it('refuses a symlinked cron path', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tlon-hosting-cron-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'tlon-hosting-outside-'));
    try {
      await symlink(outsideDir, join(stateDir, 'cron'));
      const logger = { info: vi.fn(), warn: vi.fn() };

      const result = await migrateLegacyCronModels({
        stateDir,
        currentPrimaryModel: 'openai/gpt-5',
        logger,
      });

      expect(result.status).toBe('skipped');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('refusing symlink')
      );
    } finally {
      await rm(stateDir, { recursive: true });
      await rm(outsideDir, { recursive: true });
    }
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
