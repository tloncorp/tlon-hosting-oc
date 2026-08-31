import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

import { registerCronModelMigration } from './src/cron-model-migration.js';
import { registerHostedCronTriggerGuard } from './src/cron-trigger-guard.js';
import { registerProviderAuthRoutes } from './src/provider-auth-routes.js';
import { registerSessionModelMigration } from './src/session-model-migration.js';
import { registerSubscriptionProviderRuntimes } from './src/subscription-provider-runtime.js';
import { registerWorkspacePromptSync } from './src/workspace-prompts.js';

export function registerTlonHostingOpenClaw(api: OpenClawPluginApi): void {
  registerHostedCronTriggerGuard(api);
  registerSubscriptionProviderRuntimes(api);
  registerCronModelMigration(api);
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
