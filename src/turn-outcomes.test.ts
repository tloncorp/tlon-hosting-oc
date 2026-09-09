import { describe, expect, it, vi } from 'vitest';
import { emitDiagnosticEvent, waitForDiagnosticEventsDrained } from 'openclaw/plugin-sdk/diagnostic-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

const { info, warn } = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('openclaw/plugin-sdk/runtime-env', () => ({
  createSubsystemLogger: () => ({ info, warn }),
}));

import { classifyTurnOutcome, registerHostedTurnOutcomes } from './turn-outcomes.js';

const terminal = (overrides: Record<string, string> = {}) => Object.fromEntries(
  Object.entries({
    execution: 'completed', result: 'reply', delivery: 'delivered', trigger: 'dm',
    run_id: 'run-1', ship: 'zod', ...overrides,
  }).map(([key, value]) => [`openclaw.tlon.turn.${key}`, value])
);

describe('hosted turn outcomes', () => {
  it.each([
    [{ result: 'error_reply' }, 'failure', 'error_reply'],
    [{ result: 'error_reply_and_action' }, 'failure', 'error_reply'],
    [{ result: 'empty', delivery: 'not_applicable' }, 'failure', 'unexpected_empty'],
    [{ result: 'empty', trigger: 'mention' }, 'failure', 'unexpected_empty'],
    [{ delivery: 'partial' }, 'failure', 'delivery_partial'],
    [{ delivery: 'failed' }, 'failure', 'delivery_failed'],
    [{ delivery: 'skipped' }, 'failure', 'reply_not_delivered'],
    [{ execution: 'timed_out' }, 'failure', 'timed_out'],
    [{ execution: 'abandoned' }, 'failure', 'abandoned'],
    [{ execution: 'failed' }, 'failure', 'failed'],
    [{ execution: 'cancelled', result: 'empty' }, 'ignored', 'cancelled'],
    [{ result: 'intentional_silence', delivery: 'not_applicable' }, 'ignored', 'intentional_silence'],
    [{ result: 'empty', trigger: 'owner-listen' }, 'ignored', 'empty_background_turn'],
    [{ result: 'empty', trigger: 'owner-blob' }, 'ignored', 'empty_background_turn'],
    [{ result: 'empty', trigger: 'cron' }, 'ignored', 'empty_background_turn'],
    [{ result: 'action_only', delivery: 'not_applicable' }, 'success', 'action_only'],
    [{ result: 'reply_and_action' }, 'success', 'reply_and_action'],
    [{ delivery: 'skipped', reason: 'source_reply_delivery_mode_message_tool_only' }, 'unknown', 'message_tool_delivery_unverified'],
    [{ execution: 'new_execution' }, 'unknown', 'unknown_execution'],
    [{ result: 'new_result' }, 'unknown', 'unknown_result'],
  ] as const)('classifies %j as %s/%s', (overrides, outcome, reason) => {
    expect(classifyTurnOutcome(terminal(overrides))).toEqual({ outcome, reason });
  });

  it('supports raw channel logger attributes too', () => {
    const raw = Object.fromEntries(Object.entries(terminal()).map(([key, value]) => [key.replace(/^openclaw\./, ''), value]));
    expect(classifyTurnOutcome(raw)).toEqual({ outcome: 'success', reason: 'reply' });
  });

  it('subscribes once, emits only safe metadata, and unsubscribes on stop', async () => {
    info.mockClear(); warn.mockClear();
    const registerService = vi.fn<OpenClawPluginApi['registerService']>();
    registerHostedTurnOutcomes({ registerService });
    const service = registerService.mock.calls[0][0];
    const context = {} as Parameters<NonNullable<typeof service.start>>[0];
    const emit = (message = 'tlon.agent_turn.terminal') => emitDiagnosticEvent({
      type: 'log.record', level: 'INFO', message,
      attributes: { ...terminal({ result: 'empty' }), 'private.message': 'do not copy', 'tlon.turn.session_key': 'private-session' },
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
        'tlon.hosting.turn.reason': 'unexpected_empty',
        'tlon.hosting.turn.run_id': 'run-1',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
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
  });
});
