import type {
  OpenClawPluginApi,
  PluginHookBeforeToolCallResult,
} from 'openclaw/plugin-sdk/plugin-runtime';

type CronTriggerGuardApi = Pick<
  OpenClawPluginApi,
  'logger' | 'on' | 'runtime'
>;

const INERT_TRIGGER_SCRIPTS = new Set([
  '',
  'x',
  'noop',
  'no-op',
  'none',
  'disabled',
  'disabled-placeholder',
  'placeholder',
  'true',
  'always',
]);

const TRUE_TRIGGER_OBJECT = String.raw`\{\s*["']?fire["']?\s*:\s*true\s*\}`;
const ALWAYS_TRUE_TRIGGER_PATTERNS = [
  new RegExp(
    String.raw`^(?:return\s+)?\(?\s*${TRUE_TRIGGER_OBJECT}\s*\)?\s*;?$`,
    'i'
  ),
  new RegExp(
    String.raw`^(?:return\s+)?json\s*\(\s*${TRUE_TRIGGER_OBJECT}\s*\)\s*;?$`,
    'i'
  ),
];

const CONDITIONAL_TRIGGER_BLOCK_REASON =
  'Conditional cron trigger scripts are unavailable on this hosted runtime. ' +
  'If the user requested an ordinary time-based schedule, retry the same cron call without job.trigger or patch.trigger. ' +
  'Do not use a placeholder or always-true trigger. If the user requested a conditional watcher, explain that it is unsupported.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInertTrigger(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.script !== 'string' ||
    (value.once !== undefined && value.once !== false)
  ) {
    return false;
  }
  const script = value.script.trim();
  if (INERT_TRIGGER_SCRIPTS.has(script.toLowerCase())) {
    return true;
  }
  return ALWAYS_TRUE_TRIGGER_PATTERNS.some((pattern) => pattern.test(script));
}

function guardCronParams(
  params: Record<string, unknown>
): PluginHookBeforeToolCallResult | undefined {
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
  if (container.trigger === null || isInertTrigger(container.trigger)) {
    const nextContainer = { ...container };
    delete nextContainer.trigger;
    return {
      params: {
        ...params,
        [containerKey]: nextContainer,
      },
    };
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
    if (result?.params) {
      api.logger.info(
        `[tlon-hosting] Removed inert trigger from cron.${String(event.params.action)}`
      );
    } else if (result?.block) {
      api.logger.warn(
        `[tlon-hosting] Blocked conditional trigger from cron.${String(event.params.action)}`
      );
    }
    return result;
  });
}
