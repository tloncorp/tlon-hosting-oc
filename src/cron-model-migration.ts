import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/core';

type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
type CronJob = {
  id: string;
  payload: {
    kind: string;
    model?: string;
    fallbacks?: string[];
  };
};
type CronListResult = {
  jobs?: CronJob[];
  total?: number;
};
type GatewayRequest = (
  method: string,
  params: Record<string, unknown>
) => Promise<unknown>;

async function listCronJobs(request: GatewayRequest): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  const limit = 200;
  let offset = 0;

  while (true) {
    const page = (await request('cron.list', {
      includeDisabled: true,
      includeDeliveryPreviews: false,
      limit,
      offset,
    })) as CronListResult;
    const pageJobs = Array.isArray(page.jobs) ? page.jobs : [];
    jobs.push(...pageJobs);
    offset += pageJobs.length;
    if (pageJobs.length === 0 || offset >= (page.total ?? offset)) {
      return jobs;
    }
  }
}

export async function migrateCurrentCronModels(params: {
  logger: Logger;
  request: GatewayRequest;
}): Promise<{ changedJobs: string[] }> {
  const { logger, request } = params;
  const changedJobs: string[] = [];

  for (const job of await listCronJobs(request)) {
    if (
      job.payload.kind !== 'agentTurn' ||
      (job.payload.model === undefined && job.payload.fallbacks === undefined)
    ) {
      continue;
    }
    await request('cron.update', {
      id: job.id,
      patch: {
        payload: {
          kind: 'agentTurn',
          model: null,
          fallbacks: null,
        },
      },
    });
    changedJobs.push(job.id);
  }

  if (changedJobs.length > 0) {
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
          logger: context.logger,
          request: (method, params) =>
            api.runtime.gateway.request(method, params),
        });
      } catch (error) {
        context.logger.warn(
          `[tlon-hosting] Failed to migrate current cron models: ${String(error)}`
        );
      }
    },
  });
}
