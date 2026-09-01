import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  registerCronGuard,
  registerCronMigration,
  registerPromptSync,
  registerRoutes,
  registerRuntimes,
  registerSessionMigration,
} = vi.hoisted(() => ({
    registerCronGuard: vi.fn(),
    registerCronMigration: vi.fn(),
    registerPromptSync: vi.fn(),
    registerRoutes: vi.fn(),
    registerRuntimes: vi.fn(),
    registerSessionMigration: vi.fn(),
  }));

vi.mock('./src/cron-model-migration.js', () => ({
  registerCronModelMigration: registerCronMigration,
}));
vi.mock('./src/cron-trigger-guard.js', () => ({
  registerHostedCronTriggerGuard: registerCronGuard,
}));
vi.mock('./src/provider-auth-routes.js', () => ({
  registerProviderAuthRoutes: registerRoutes,
}));
vi.mock('./src/session-model-migration.js', () => ({
  registerSessionModelMigration: registerSessionMigration,
}));
vi.mock('./src/subscription-provider-runtime.js', () => ({
  registerSubscriptionProviderRuntimes: registerRuntimes,
}));
vi.mock('./src/workspace-prompts.js', () => ({
  registerWorkspacePromptSync: registerPromptSync,
}));

import plugin, { registerTlonHostingOpenClaw } from './index.js';

describe('tlon-hosting-oc plugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers subscription runtimes before provider auth routes', () => {
    const api = {} as never;

    registerTlonHostingOpenClaw(api);

    expect(registerCronGuard).toHaveBeenCalledWith(api);
    expect(registerRuntimes).toHaveBeenCalledWith(api);
    expect(registerCronMigration).toHaveBeenCalledWith(api);
    expect(registerSessionMigration).toHaveBeenCalledWith(api);
    expect(registerRoutes).toHaveBeenCalledWith(api);
    expect(registerPromptSync).toHaveBeenCalledWith(api);
    expect(registerRuntimes.mock.invocationCallOrder[0]).toBeLessThan(
      registerRoutes.mock.invocationCallOrder[0]
    );
  });

  it('exports the expected plugin identity', () => {
    expect(plugin.id).toBe('tlon-hosting-oc');
  });
});
