import { describe, expect, it, vi } from 'vitest';

import {
  guardCronAccountScope,
  registerCronAccountGuard,
} from './cron-account-guard.js';

describe('cron account guard', () => {
  it('allows omitted and matching delivery accounts', () => {
    expect(
      guardCronAccountScope(
        { action: 'add', job: { delivery: { mode: 'announce' } } },
        'tenant-a'
      )
    ).toBeUndefined();
    expect(
      guardCronAccountScope(
        {
          action: 'add',
          job: {
            delivery: {
              accountId: 'tenant-a',
              failureDestination: { accountId: 'tenant-a' },
            },
          },
        },
        'tenant-a'
      )
    ).toBeUndefined();
  });

  it('blocks any foreign delivery account', () => {
    expect(
      guardCronAccountScope(
        {
          action: 'update',
          patch: {
            delivery: {
              accountId: 'tenant-a',
              failureDestination: { accountId: 'tenant-b' },
            },
          },
        },
        'tenant-a'
      )
    ).toMatchObject({ block: true });
  });

  it('resolves the trusted hook agent in monolithic mode', () => {
    let hook:
      | ((
          event: { toolName: string; params: Record<string, unknown> },
          ctx: { agentId?: string }
        ) => unknown)
      | undefined;
    const api = {
      logger: { warn: vi.fn() },
      on: vi.fn((_name, handler) => {
        hook = handler;
      }),
      runtime: {
        config: {
          current: () => ({
            channels: {
              tlon: {
                deploymentMode: 'monolithic',
                accounts: { 'tenant-a': {} },
              },
            },
            agents: { list: [{ id: 'agent-a' }] },
            bindings: [
              {
                agentId: 'agent-a',
                match: { channel: 'tlon', accountId: 'tenant-a' },
              },
            ],
          }),
        },
      },
    };
    registerCronAccountGuard(api as never);

    expect(
      hook?.(
        {
          toolName: 'cron',
          params: {
            action: 'add',
            job: { delivery: { accountId: 'tenant-b' } },
          },
        },
        { agentId: 'agent-a' }
      )
    ).toMatchObject({ block: true });
  });
});
