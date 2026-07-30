import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

import { registerCronScopeRepair } from './src/cron-scope-repair.js';
import { registerProviderAuthRoutes } from './src/provider-auth-routes.js';
import { registerSubscriptionProviderRuntimes } from './src/subscription-provider-runtime.js';

export function registerTlonHostingOpenClaw(api: OpenClawPluginApi): void {
  registerSubscriptionProviderRuntimes(api);
  registerCronScopeRepair(api);
  registerProviderAuthRoutes(api);
}

export default definePluginEntry({
  id: 'tlon-hosting-oc',
  name: 'Tlon Hosting OpenClaw',
  description:
    'Tlon hosting control plane for OpenClaw subscription authentication',
  register: registerTlonHostingOpenClaw,
});
