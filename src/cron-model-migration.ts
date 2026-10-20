import type { OpenClawPluginServiceContext } from 'openclaw/plugin-sdk/core';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
type CronJob = {
  id: string;
  description?: string;
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

// Mirrors BUDGET_HOLD_PREFIX in tloncorp/tlon-apps
// packages/openclaw/src/cron-budget-hold.ts. The credit-budget hold recognises
// its own pause only while job.updatedAtMs still equals the hold's revision, and
// any cron.update restamps updatedAtMs, so editing a held job here would orphan
// the hold. Held jobs migrate on a later boot once the hold resumes them. The
// hold writes `(prefix + description).trimEnd()`, so an empty original
// description leaves the prefix without its trailing space.
const BUDGET_HOLD_PREFIX = '[Paused: credit budget] ';

function isBudgetHeld(job: CronJob): boolean {
  return (job.description ?? '').startsWith(BUDGET_HOLD_PREFIX.trimEnd());
}

type GatewayRequest = (
  method: string,
  params: Record<string, unknown>,
  options?: { scopes?: 'operator.admin'[] }
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
      (job.payload.model === undefined && job.payload.fallbacks === undefined) ||
      isBudgetHeld(job)
    ) {
      continue;
    }
    // cron.update requires operator.admin; plugin requests default to operator.write.
    await request(
      'cron.update',
      {
        id: job.id,
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
          request: (method, params, options) =>
            api.runtime.gateway.request(method, params, options),
        });
      } catch (error) {
        context.logger.warn(
          `[tlon-hosting] Failed to migrate current cron models: ${String(error)}`
        );
      }
    },
  });
}
