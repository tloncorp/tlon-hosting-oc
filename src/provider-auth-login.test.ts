import { beforeEach, describe, expect, it, vi } from 'vitest';

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('openclaw/plugin-sdk/provider-auth-login-flow-runtime', () => ({
  runModelsAuthLoginFlow: login,
}));

import { runModelsAuthLoginFlow } from './provider-auth-routes.js';

describe('hosted provider login', () => {
  beforeEach(() => {
    login.mockReset();
  });

  it.each(['openai', 'xai'])(
    'defers %s model access after saving credentials',
    async (provider) => {
      const select = vi.fn(() => {
        throw new Error('provider requested an unsupported interactive prompt');
      });
      const log = vi.fn();
      const result = {
        providerId: provider,
        profiles: [{ profileId: `${provider}:default` }],
      };
      login.mockImplementation(async (options) => {
        // OpenClaw calls this hook after persisting credentials when the
        // current model policy restricts the connected provider's models.
        if (options.onModelAccessRequested) {
          options.onModelAccessRequested({ provider });
        } else {
          await options.prompter.select({ options: ['all', 'keep'] });
        }
        return result;
      });
      const options = {
        provider,
        method: 'device-code',
        agent: 'main',
        runtime: { log },
        prompter: { select },
        isRemote: true,
        openUrl: vi.fn(),
      } as never;

      await expect(runModelsAuthLoginFlow(options)).resolves.toBe(result);
      expect(select).not.toHaveBeenCalled();
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          method: 'device-code',
          onModelAccessRequested: expect.any(Function),
        })
      );
      expect(log).toHaveBeenCalledWith(
        'Model access selection deferred to Tlon settings.'
      );
    }
  );

  it('propagates login failures instead of treating them as a saved credential', async () => {
    const failure = new Error('authorization rejected');
    login.mockRejectedValue(failure);
    await expect(runModelsAuthLoginFlow({} as never)).rejects.toBe(failure);
  });
});
