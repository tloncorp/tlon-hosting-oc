import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerCronRepair, registerRoutes, registerRuntimes } = vi.hoisted(() => ({
  registerCronRepair: vi.fn(),
  registerRoutes: vi.fn(),
  registerRuntimes: vi.fn(),
}));

vi.mock('./src/cron-scope-repair.js', () => ({
  registerCronScopeRepair: registerCronRepair,
}));
vi.mock('./src/provider-auth-routes.js', () => ({
  registerProviderAuthRoutes: registerRoutes,
}));
vi.mock('./src/subscription-provider-runtime.js', () => ({
  registerSubscriptionProviderRuntimes: registerRuntimes,
}));

import plugin, { registerTlonHostingOpenClaw } from './index.js';

describe('tlon-hosting-oc plugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers subscription runtimes before provider auth routes', () => {
    const api = {} as never;

    registerTlonHostingOpenClaw(api);

    expect(registerRuntimes).toHaveBeenCalledWith(api);
    expect(registerCronRepair).toHaveBeenCalledWith(api);
    expect(registerRoutes).toHaveBeenCalledWith(api);
    expect(registerRuntimes.mock.invocationCallOrder[0]).toBeLessThan(
      registerRoutes.mock.invocationCallOrder[0]
    );
  });

  it('exports the expected plugin identity', () => {
    expect(plugin.id).toBe('tlon-hosting-oc');
  });
});
