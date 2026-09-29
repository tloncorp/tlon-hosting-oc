import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { describe, expect, it, vi } from 'vitest';

import { registerHostedCronTriggerGuard } from './cron-trigger-guard.js';

type BeforeToolCallHandler = (
  event: { toolName: string; params: Record<string, unknown> },
  ctx: { toolName: string; runId: string; sessionKey: string }
) =>
  | { block: true; blockReason: string }
  | void
  | Promise<{ block: true; blockReason: string } | void>;

function registerGuard(
  config: OpenClawPluginApi['config'] = {},
  currentConfig: OpenClawPluginApi['config'] = config
) {
  let handler: BeforeToolCallHandler | undefined;
  const api = {
    config,
    runtime: {
      config: {
        current: () => currentConfig,
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    on(name: string, candidate: BeforeToolCallHandler) {
      if (name === 'before_tool_call') {
        handler = candidate;
      }
    },
  } as unknown as Pick<
    OpenClawPluginApi,
    'config' | 'logger' | 'on' | 'runtime'
  >;

  registerHostedCronTriggerGuard(api);
  if (!handler) {
    throw new Error('before_tool_call handler was not registered');
  }
  return { api, handler };
}

async function callGuard(
  handler: BeforeToolCallHandler,
  params: Record<string, unknown>,
  toolName = 'cron'
) {
  return await handler(
    { toolName, params },
    { toolName, runId: 'run-1', sessionKey: 'agent:main:tlon:direct:~zod' }
  );
}

describe('registerHostedCronTriggerGuard', () => {
  it.each(['x', 'return { fire: true };'])(
    'blocks add trigger %j when hosted triggers are disabled',
    async (script) => {
      const { api, handler } = registerGuard();
      const params = {
        action: 'add',
        job: {
          name: 'morning-weather',
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          trigger: { script, once: false },
          payload: { kind: 'agentTurn', message: 'Send the weather.' },
        },
      };

      const result = await callGuard(handler, params);

      expect(result).toMatchObject({
        block: true,
        blockReason: expect.stringContaining(
          'Conditional cron trigger scripts are unavailable'
        ),
      });
      expect(result).not.toHaveProperty('params');
      expect(params.job.trigger).toEqual({ script, once: false });
      expect(api.logger.warn).toHaveBeenCalledOnce();
    }
  );

  it('allows an ordinary cron add without a trigger', async () => {
    const { handler } = registerGuard();

    const result = await callGuard(handler, {
      action: 'add',
      job: {
        name: 'morning-weather',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        payload: { kind: 'agentTurn', message: 'Send the weather.' },
      },
    });

    expect(result).toBeUndefined();
  });

  it('blocks a trigger in an update patch', async () => {
    const { handler } = registerGuard();

    const result = await callGuard(handler, {
      action: 'update',
      jobId: 'job-1',
      patch: {
        trigger: { script: ' ', once: false },
        description: 'Run every afternoon.',
      },
    });

    expect(result).toMatchObject({
      block: true,
      blockReason: expect.stringContaining(
        'Conditional cron trigger scripts are unavailable'
      ),
    });
  });

  it('preserves null when an update explicitly clears an existing trigger', async () => {
    const { handler } = registerGuard();

    const result = await callGuard(handler, {
      action: 'update',
      jobId: 'job-1',
      patch: { trigger: null },
    });

    expect(result).toBeUndefined();
  });

  it('does not erase once-only trigger semantics', async () => {
    const { handler } = registerGuard();

    const result = await callGuard(handler, {
      action: 'add',
      job: {
        trigger: { script: 'return { fire: true };', once: true },
      },
    });

    expect(result).toMatchObject({
      block: true,
      blockReason: expect.stringContaining(
        'Conditional cron trigger scripts are unavailable'
      ),
    });
  });

  it('blocks substantive conditional trigger scripts on hosted bots', async () => {
    const { api, handler } = registerGuard();

    const result = await callGuard(handler, {
      action: 'add',
      job: {
        trigger: {
          script: 'const weather = await tools.weather({ city: "Milwaukee" }); return { fire: weather.temp < 20 };',
        },
      },
    });

    expect(result).toMatchObject({
      block: true,
      blockReason: expect.stringContaining(
        'Conditional cron trigger scripts are unavailable'
      ),
    });
    expect(api.logger.warn).toHaveBeenCalledOnce();
  });

  it('does not alter cron calls when trigger scripts are enabled', async () => {
    const { handler } = registerGuard({
      cron: { enabled: true, triggers: { enabled: true } },
    });

    const result = await callGuard(handler, {
      action: 'add',
      job: { trigger: { script: 'x' } },
    });

    expect(result).toBeUndefined();
  });

  it('uses the live config when trigger policy changes after startup', async () => {
    const enabled = { cron: { enabled: true, triggers: { enabled: true } } };
    const disabled = { cron: { enabled: true, triggers: { enabled: false } } };
    const params = {
      action: 'add',
      job: { trigger: { script: 'return { fire: true };', once: false } },
    };

    const enabledAtRuntime = registerGuard(disabled, enabled);
    expect(await callGuard(enabledAtRuntime.handler, params)).toBeUndefined();

    const disabledAtRuntime = registerGuard(enabled, disabled);
    expect(await callGuard(disabledAtRuntime.handler, params)).toMatchObject({
      block: true,
      blockReason: expect.stringContaining(
        'Conditional cron trigger scripts are unavailable'
      ),
    });
  });

  it('ignores non-cron tools', async () => {
    const { handler } = registerGuard();

    const result = await callGuard(
      handler,
      { action: 'add', job: { trigger: { script: 'x' } } },
      'message'
    );

    expect(result).toBeUndefined();
  });
});
