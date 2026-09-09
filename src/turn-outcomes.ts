import { onInternalDiagnosticEvent } from 'openclaw/plugin-sdk/diagnostic-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { createSubsystemLogger } from 'openclaw/plugin-sdk/runtime-env';

type Attributes = Record<string, string | number | boolean>;
type Outcome = { outcome: 'success' | 'failure' | 'ignored' | 'unknown'; reason: string };

function field(attributes: Attributes, name: string): string {
  // Core normalizes structured logger keys before publishing diagnostic events.
  const value = attributes[`openclaw.tlon.turn.${name}`] ?? attributes[`tlon.turn.${name}`];
  return typeof value === 'string' ? value : '';
}

/** Hosting policy; execution=completed alone is deliberately not a success signal. */
export function classifyTurnOutcome(attributes: Attributes): Outcome {
  const execution = field(attributes, 'execution');
  const result = field(attributes, 'result');
  const delivery = field(attributes, 'delivery');
  const trigger = field(attributes, 'trigger');
  if (execution === 'cancelled') return { outcome: 'ignored', reason: 'cancelled' };
  if (['failed', 'timed_out', 'abandoned'].includes(execution)) {
    return { outcome: 'failure', reason: execution };
  }
  if (execution !== 'completed') return { outcome: 'unknown', reason: 'unknown_execution' };
  if (result === 'error_reply' || result === 'error_reply_and_action') {
    return { outcome: 'failure', reason: 'error_reply' };
  }
  if (delivery === 'failed' || delivery === 'partial') {
    return { outcome: 'failure', reason: `delivery_${delivery}` };
  }
  if (result === 'intentional_silence') {
    return { outcome: 'ignored', reason: 'intentional_silence' };
  }
  if (result === 'empty') {
    return trigger === 'dm' || trigger === 'mention'
      ? { outcome: 'failure', reason: 'unexpected_empty' }
      : { outcome: 'ignored', reason: 'empty_background_turn' };
  }
  if (result === 'action_only') return { outcome: 'success', reason: 'action_only' };
  if (result === 'reply' || result === 'reply_and_action') {
    if (delivery === 'delivered') return { outcome: 'success', reason: result };
    // Core's message-tool-only suppression does not prove delivery. Keep it
    // visible as unknown rather than page on an intentional delivery policy.
    if (field(attributes, 'reason') === 'source_reply_delivery_mode_message_tool_only') {
      return { outcome: 'unknown', reason: 'message_tool_delivery_unverified' };
    }
    return { outcome: 'failure', reason: 'reply_not_delivered' };
  }
  return { outcome: 'unknown', reason: 'unknown_result' };
}

export function registerHostedTurnOutcomes(api: Pick<OpenClawPluginApi, 'registerService'>): void {
  let unsubscribe: (() => void) | undefined;
  const logger = createSubsystemLogger('tlon-hosting/turn-outcomes');
  api.registerService({
    id: 'tlon-hosting-turn-outcomes',
    start: () => {
      unsubscribe?.();
      unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type !== 'log.record' || event.message !== 'tlon.agent_turn.terminal') return;
        const attributes = event.attributes ?? {};
        const runId = field(attributes, 'run_id');
        const ship = field(attributes, 'ship');
        if (!runId || !ship) return;
        const classification = classifyTurnOutcome(attributes);
        // An allowlist prevents copying conversation content or provider errors.
        // A separate event preserves the channel plugin's execution semantics.
        const meta: Record<string, unknown> = {
          'tlon.hosting.turn.schema_version': 1,
          'tlon.hosting.turn.outcome': classification.outcome,
          'tlon.hosting.turn.reason': classification.reason,
          'tlon.hosting.turn.run_id': runId,
          'tlon.hosting.turn.ship': ship,
          'tlon.hosting.turn.trigger': field(attributes, 'trigger'),
          'tlon.hosting.turn.execution': field(attributes, 'execution'),
          'tlon.hosting.turn.result': field(attributes, 'result'),
          'tlon.hosting.turn.delivery': field(attributes, 'delivery'),
          ...(event.trace ? { trace: event.trace } : {}),
        };
        if (classification.outcome === 'failure') logger.warn('tlon.hosting.turn.outcome', meta);
        else logger.info('tlon.hosting.turn.outcome', meta);
      });
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  });
}
