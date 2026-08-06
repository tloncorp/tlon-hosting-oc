import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/plugin-runtime';
import {
  loadCronStore,
  resolveCronStorePath,
  saveCronStore,
} from 'openclaw/plugin-sdk/cron-store-runtime';

import { RETIRED_HOSTED_MODEL_REFS } from './hosted-model-policy.js';

type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
type CronStoreFile = Awaited<ReturnType<typeof loadCronStore>>;
type CronStoreRuntime = {
  resolveCronStorePath: (storePath?: string) => string;
  loadCronStore: (storePath: string) => Promise<CronStoreFile>;
  saveCronStore: (storePath: string, store: CronStoreFile) => Promise<void>;
};

export const LEGACY_HOSTED_CRON_MODEL =
  'openrouter/minimax/minimax-m2.7';

// Legacy-default and retired pins are removed rather than rewritten so the
// job resolves the configured default model at run time.
function migrateCurrentCronModelRef(model: string): string | undefined {
  const normalized = model.trim().toLowerCase();
  if (
    normalized === LEGACY_HOSTED_CRON_MODEL ||
    RETIRED_HOSTED_MODEL_REFS.has(normalized)
  ) {
    return undefined;
  }
  return model;
}

function migrateCurrentCronFallbacks(
  fallbacks: string[] | undefined
): { fallbacks: string[] | undefined; changed: boolean } {
  if (!fallbacks) {
    return { fallbacks, changed: false };
  }
  const migrated: string[] = [];
  let changed = false;
  for (const fallback of fallbacks) {
    const next = migrateCurrentCronModelRef(fallback);
    if (next === undefined || migrated.includes(next)) {
      changed = true;
      continue;
    }
    migrated.push(next);
  }
  if (!changed) {
    return { fallbacks, changed };
  }
  // A defined-but-empty fallback list disables OpenClaw's default fallback
  // resolution; dropping the field restores inheritance instead.
  return { fallbacks: migrated.length > 0 ? migrated : undefined, changed };
}

export async function migrateCurrentCronModels(params: {
  config: OpenClawPluginServiceContext['config'];
  logger: Logger;
  cronStore?: CronStoreRuntime;
}): Promise<{ changedJobs: string[] }> {
  const { config, logger } = params;
  const cronStore: CronStoreRuntime = params.cronStore ?? {
    resolveCronStorePath: storePath => resolveCronStorePath(storePath),
    loadCronStore: storePath => loadCronStore(storePath),
    saveCronStore: (storePath, store) => saveCronStore(storePath, store),
  };
  const storePath = cronStore.resolveCronStorePath(config.cron?.store);
  const store = await cronStore.loadCronStore(storePath);
  const changedJobs: string[] = [];

  for (const job of store.jobs) {
    if (job.payload.kind !== 'agentTurn') {
      continue;
    }
    let changed = false;
    if (job.payload.model !== undefined) {
      const model = migrateCurrentCronModelRef(job.payload.model);
      if (model !== job.payload.model) {
        if (model === undefined) {
          delete job.payload.model;
        } else {
          job.payload.model = model;
        }
        changed = true;
      }
    }
    const fallbacks = migrateCurrentCronFallbacks(job.payload.fallbacks);
    if (fallbacks.changed) {
      if (fallbacks.fallbacks === undefined) {
        delete job.payload.fallbacks;
      } else {
        job.payload.fallbacks = fallbacks.fallbacks;
      }
      changed = true;
    }
    if (changed) {
      changedJobs.push(job.id);
    }
  }

  if (changedJobs.length > 0) {
    await cronStore.saveCronStore(storePath, store);
    logger.info(
      `[tlon-hosting] Migrated ${changedJobs.length} current cron model selection${
        changedJobs.length === 1 ? '' : 's'
      } through the OpenClaw cron store runtime`
    );
  }
  return { changedJobs };
}

export function registerCronModelMigration(api: OpenClawPluginApi): void {
  api.registerService({
    id: 'tlon-hosting-cron-model-migration',
    start: async (context: OpenClawPluginServiceContext) => {
      try {
        await migrateCurrentCronModels({
          config: context.config,
          logger: context.logger,
        });
      } catch (error) {
        context.logger.warn(
          `[tlon-hosting] Failed to migrate current cron models: ${String(error)}`
        );
      }
    },
  });
}
