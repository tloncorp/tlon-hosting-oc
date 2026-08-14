import {
  ensureAuthProfileStore,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

function isMonolithic(config: OpenClawConfig): boolean {
  return (
    (config.channels?.tlon as { deploymentMode?: string } | undefined)
      ?.deploymentMode === 'monolithic'
  );
}

export function assertMonolithicDefaultAuthStoreEmpty(
  config: OpenClawConfig,
  profileIds: string[]
): void {
  if (!isMonolithic(config) || profileIds.length === 0) {
    return;
  }
  throw new Error(
    '[tlon-hosting] Refusing to start a monolithic gateway with credentials in the default agent auth store; OpenClaw exposes default-agent auth as a fallback to every tenant agent'
  );
}

/**
 * OpenClaw intentionally lets secondary agents read through to the default
 * agent's auth profiles. A hosting shard therefore uses an unbound, sterile
 * default agent and stores every customer credential only in that customer's
 * explicitly bound agentDir.
 */
export function registerAuthIsolationGuard(api: OpenClawPluginApi): void {
  api.registerService({
    id: 'tlon-hosting-auth-isolation',
    start: async (context) => {
      const config = context.config as OpenClawConfig;
      if (!isMonolithic(config)) {
        return;
      }
      const agentDir = resolveDefaultAgentDir(config);
      const store = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
        config,
      });
      assertMonolithicDefaultAuthStoreEmpty(config, Object.keys(store.profiles));
      context.logger.info(
        `[tlon-hosting] Auth isolation active: default agent ${resolveDefaultAgentId(config)} has no shared credentials`
      );
    },
  });
}
