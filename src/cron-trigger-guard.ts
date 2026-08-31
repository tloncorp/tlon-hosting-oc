import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

type BeforeToolCallResult = {
  block: true;
  blockReason: string;
};

type CronTriggerGuardApi = Pick<
  OpenClawPluginApi,
  'logger' | 'on' | 'runtime'
>;

const CONDITIONAL_TRIGGER_BLOCK_REASON =
  'Conditional cron trigger scripts are unavailable on this hosted runtime. ' +
  'If the user requested an ordinary time-based schedule, retry the same cron call without job.trigger or patch.trigger. ' +
  'If the user requested a conditional watcher, explain that it is unsupported.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function guardCronParams(
  params: Record<string, unknown>
): BeforeToolCallResult | undefined {
  const action = params.action;
  const containerKey =
    action === 'add' ? 'job' : action === 'update' ? 'patch' : undefined;
  if (!containerKey) {
    return undefined;
  }
  const container = params[containerKey];
  if (!isRecord(container) || !Object.hasOwn(container, 'trigger')) {
    return undefined;
  }
  if (action === 'update' && container.trigger === null) {
    return undefined;
  }
  return {
    block: true,
    blockReason: CONDITIONAL_TRIGGER_BLOCK_REASON,
  };
}

/**
 * Keep OpenClaw's scheduler enabled while enforcing Tlon Hosting's separate
 * default-off policy for unattended conditional trigger scripts.
 */
export function registerHostedCronTriggerGuard(
  api: CronTriggerGuardApi
): void {
  api.on('before_tool_call', (event) => {
    if (event.toolName !== 'cron') {
      return undefined;
    }
    const config = api.runtime.config.current();
    if (config.cron?.triggers?.enabled === true) {
      return undefined;
    }

    const result = guardCronParams(event.params);
    if (result?.block) {
      api.logger.warn(
        `[tlon-hosting] Blocked conditional trigger from cron.${String(event.params.action)}`
      );
    }
    return result;
  });
}
