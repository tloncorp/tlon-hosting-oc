import { describe, expect, it, vi } from 'vitest';
import { emitDiagnosticEvent, waitForDiagnosticEventsDrained } from 'openclaw/plugin-sdk/diagnostic-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

const { info, warn, add, createCounter, getMeterProvider } = vi.hoisted(() => {
  const add = vi.fn();
  const createCounter = vi.fn(() => ({ add }));
  const provider = { getMeter: vi.fn(() => ({ createCounter })) };
  return { info: vi.fn(), warn: vi.fn(), add, createCounter, getMeterProvider: vi.fn(() => provider) };
});
vi.mock('@opentelemetry/api', () => ({ metrics: { getMeterProvider } }));
vi.mock('openclaw/plugin-sdk/runtime-env', () => ({
  createSubsystemLogger: () => ({ info, warn }),
}));

import { classifyTurnOutcome, registerHostedTurnOutcomes } from './turn-outcomes.js';

const terminal = (overrides: Record<string, string | number> = {}) => Object.fromEntries(
  Object.entries({
    execution: 'completed', result: 'reply', delivery: 'delivered', trigger: 'dm',
    run_id: 'run-1', ship: 'zod', ...overrides,
  }).map(([key, value]) => [`openclaw.tlon.turn.${key}`, value])
);

describe('hosted turn outcomes', () => {
  it.each([
    [{ result: 'error_reply' }, 'failure', 'error_reply'],
    [{ result: 'error_reply_and_action' }, 'failure', 'error_reply'],
    [{ result: 'empty', delivery: 'not_applicable' }, 'unknown', 'needs_attention'],
    [{ result: 'empty', trigger: 'mention' }, 'unknown', 'needs_attention'],
    [{ delivery: 'partial' }, 'failure', 'delivery_partial'],
    [{ delivery: 'failed' }, 'failure', 'delivery_failed'],
    [{ delivery: 'skipped' }, 'success', 'reply'],
    [{ reason: 'reply_not_delivered' }, 'failure', 'reply_not_delivered'],
    [{ execution: 'timed_out' }, 'failure', 'timed_out'],
    [{ execution: 'abandoned' }, 'failure', 'abandoned'],
    [{ execution: 'failed' }, 'failure', 'failed'],
    [{ execution: 'cancelled', result: 'empty' }, 'failure', 'cancelled'],
    [{ result: 'intentional_silence', delivery: 'not_applicable' }, 'success', 'intentional_silence'],
    [{ result: 'intentional_silence', delivery: 'failed' }, 'failure', 'delivery_failed'],
    [{ result: 'empty', trigger: 'cron' }, 'unknown', 'needs_attention'],
    [{ result: 'action_only', delivery: 'not_applicable' }, 'success', 'action_only'],
    [{ result: 'reply_and_action' }, 'success', 'reply_and_action'],
    [{ delivery: 'skipped', reason: 'source_reply_delivery_mode_message_tool_only' }, 'success', 'reply'],
    [{ execution: 'new_execution' }, 'success', 'reply'],
    [{ execution: '', result: 'error_reply' }, 'failure', 'error_reply'],
    [{ result: 'new_result' }, 'unknown', 'needs_attention'],
    [{ final_error_reply_count: 1 }, 'failure', 'final_error_reply'],
    [{ final_error_reply_count: '2', result: 'reply_and_action' }, 'failure', 'final_error_reply'],
    [{ final_error_reply_count: 0 }, 'success', 'reply'],
    [{ final_error_reply_count: '0' }, 'success', 'reply'],
    [{ final_error_reply_count: '' }, 'success', 'reply'],
  ] as const)('classifies %j as %s/%s', (overrides, outcome, reason) => {
    expect(classifyTurnOutcome(terminal(overrides))).toEqual({ outcome, reason });
  });

  it('supports raw channel logger attributes too', () => {
    const raw = Object.fromEntries(Object.entries(terminal()).map(([key, value]) => [key.replace(/^openclaw\./, ''), value]));
    expect(classifyTurnOutcome(raw)).toEqual({ outcome: 'success', reason: 'reply' });
  });

  it('still emits the outcome log if the metric provider fails', async () => {
    warn.mockClear();
    const registerService = vi.fn<OpenClawPluginApi['registerService']>();
    registerHostedTurnOutcomes({ registerService });
    const service = registerService.mock.calls[0][0];
    const context = {} as Parameters<NonNullable<typeof service.start>>[0];
    getMeterProvider.mockImplementationOnce(() => { throw new Error('metrics unavailable'); });
    try {
      await service.start(context);
      emitDiagnosticEvent({
        type: 'log.record', level: 'INFO', message: 'tlon.agent_turn.terminal',
        attributes: terminal({ execution: 'cancelled' }),
      });
      await waitForDiagnosticEventsDrained();
      expect(warn).toHaveBeenCalledWith('tlon.hosting.turn.outcome', expect.objectContaining({
        'tlon.hosting.turn.outcome': 'failure', 'tlon.hosting.turn.reason': 'cancelled',
      }));
    } finally {
      await service.stop?.(context);
    }
  });

  it('subscribes once, emits only safe metadata, and unsubscribes on stop', async () => {
    info.mockClear(); warn.mockClear(); add.mockClear(); createCounter.mockClear();
    const registerService = vi.fn<OpenClawPluginApi['registerService']>();
    registerHostedTurnOutcomes({ registerService });
    const service = registerService.mock.calls[0][0];
    const context = {} as Parameters<NonNullable<typeof service.start>>[0];
    const emit = (message = 'tlon.agent_turn.terminal') => emitDiagnosticEvent({
      type: 'log.record', level: 'INFO', message,
      attributes: { ...terminal({ final_error_reply_count: 1 }), 'private.message': 'do not copy', 'tlon.turn.session_key': 'private-session' },
    });
    try {
      await service.start(context);
      await service.start(context);
      emit();
      emit('tlon.hosting.turn.outcome'); // Our own event must never recurse.
      await waitForDiagnosticEventsDrained();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('tlon.hosting.turn.outcome');
      expect(warn.mock.calls[0][1]).toMatchObject({
        'tlon.hosting.turn.outcome': 'failure',
        'tlon.hosting.turn.reason': 'final_error_reply',
        'tlon.hosting.turn.run_id': 'run-1',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
      expect(createCounter).toHaveBeenCalledWith('openclaw.turn.outcomes', expect.any(Object));
      expect(add).toHaveBeenCalledExactlyOnceWith(1, {
        ship: 'zod', outcome: 'failure', reason: 'final_error_reply',
      });
      emitDiagnosticEvent({ type: 'log.record', level: 'INFO', message: 'tlon.agent_turn.terminal', attributes: {} });
      await waitForDiagnosticEventsDrained();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await service.stop?.(context);
    }
    emit();
    await waitForDiagnosticEventsDrained();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
  });
});
