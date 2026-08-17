import type {
  OpenClawPluginApi,
  PluginHookBeforeToolCallResult,
} from 'openclaw/plugin-sdk/plugin-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';

import { resolveProviderAuthAgentScope } from './provider-auth-routes.js';

type GuardApi = Pick<OpenClawPluginApi, 'logger' | 'on' | 'runtime'>;

function collectAccountIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectAccountIds(entry, ids);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'accountId' && typeof entry === 'string' && entry.trim()) {
      ids.add(entry.trim());
    } else {
      collectAccountIds(entry, ids);
    }
  }
}

export function guardCronAccountScope(
  params: Record<string, unknown>,
  accountId: string
): PluginHookBeforeToolCallResult | undefined {
  const requested = new Set<string>();
  collectAccountIds(params, requested);
  return [...requested].some((value) => value !== accountId)
    ? {
        block: true,
        blockReason:
          'Cron delivery must use the Tlon account bound to this agent.',
      }
    : undefined;
}

export function registerCronAccountGuard(api: GuardApi): void {
  api.on('before_tool_call', (event, ctx) => {
    if (event.toolName !== 'cron') return undefined;
    const config = api.runtime.config.current() as OpenClawConfig;
    const monolithic =
      (config.channels?.tlon as { deploymentMode?: string } | undefined)
        ?.deploymentMode === 'monolithic';
    if (!monolithic) return undefined;
    try {
      const scope = resolveProviderAuthAgentScope(config, ctx.agentId);
      const result = scope.accountId
        ? guardCronAccountScope(event.params, scope.accountId)
        : undefined;
      if (result?.block) {
        api.logger.warn(
          `[tlon-hosting] Blocked cross-account cron delivery from ${scope.agentId}`
        );
      }
      return result;
    } catch {
      return {
        block: true,
        blockReason: 'Cron requires an exact Tlon account binding.',
      };
    }
  });
}
