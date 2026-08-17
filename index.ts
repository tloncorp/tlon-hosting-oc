import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

import { registerAuthIsolationGuard } from './src/auth-isolation-guard.js';
import { registerCronAccountGuard } from './src/cron-account-guard.js';
import { registerCronModelMigration } from './src/cron-model-migration.js';
import { registerCronScopeRepair } from './src/cron-scope-repair.js';
import { registerHostedCronTriggerGuard } from './src/cron-trigger-guard.js';
import { registerProviderAuthRoutes } from './src/provider-auth-routes.js';
import { registerSessionModelMigration } from './src/session-model-migration.js';
import { registerSubscriptionProviderRuntimes } from './src/subscription-provider-runtime.js';
import { registerWorkspacePromptSync } from './src/workspace-prompts.js';

export function registerTlonHostingOpenClaw(api: OpenClawPluginApi): void {
  registerAuthIsolationGuard(api);
  registerCronAccountGuard(api);
  registerHostedCronTriggerGuard(api);
  registerSubscriptionProviderRuntimes(api);
  registerCronModelMigration(api);
  registerCronScopeRepair(api);
  registerSessionModelMigration(api);
  registerProviderAuthRoutes(api);
  registerWorkspacePromptSync(api);
}

export default definePluginEntry({
  id: 'tlon-hosting-oc',
  name: 'Tlon Hosting OpenClaw',
  description:
    'Tlon hosting control plane for managed OpenClaw gateways',
  register: registerTlonHostingOpenClaw,
});
