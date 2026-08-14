import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/plugin-runtime';
import {
  loadCronStore,
  resolveCronStorePath,
  saveCronStore,
} from 'openclaw/plugin-sdk/cron-store-runtime';

type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
type CronStoreFile = Awaited<ReturnType<typeof loadCronStore>>;
type CronStoreRuntime = {
  resolveCronStorePath: (storePath?: string) => string;
  loadCronStore: (storePath: string) => Promise<CronStoreFile>;
  saveCronStore: (storePath: string, store: CronStoreFile) => Promise<void>;
};

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
      delete job.payload.model;
      changed = true;
    }
    if (job.payload.fallbacks !== undefined) {
      delete job.payload.fallbacks;
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
      }; jobs now follow their configured defaults`
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
