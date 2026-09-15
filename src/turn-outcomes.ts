import { metrics, type Counter, type MeterProvider } from '@opentelemetry/api';
import { onInternalDiagnosticEvent } from 'openclaw/plugin-sdk/diagnostic-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { createSubsystemLogger } from 'openclaw/plugin-sdk/runtime-env';

type Attributes = Record<string, string | number | boolean>;
type Outcome = { outcome: 'success' | 'failure' | 'unknown'; reason: string };

function field(attributes: Attributes, name: string): string {
  // Core normalizes structured logger keys before publishing diagnostic events.
  const value = attributes[`openclaw.tlon.turn.${name}`] ?? attributes[`tlon.turn.${name}`];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Matches the dashboard's Broken / Healthy / Needs attention classification. */
export function classifyTurnOutcome(attributes: Attributes): Outcome {
  const execution = field(attributes, 'execution');
  const result = field(attributes, 'result');
  const delivery = field(attributes, 'delivery');
  const finalErrorReplies = field(attributes, 'final_error_reply_count');
  if (['failed', 'timed_out', 'cancelled', 'abandoned'].includes(execution)) {
    return { outcome: 'failure', reason: execution };
  }
  if (result === 'error_reply' || result === 'error_reply_and_action') {
    return { outcome: 'failure', reason: 'error_reply' };
  }
  if (delivery === 'failed' || delivery === 'partial') {
    return { outcome: 'failure', reason: `delivery_${delivery}` };
  }
  if (field(attributes, 'reason') === 'reply_not_delivered') {
    return { outcome: 'failure', reason: 'reply_not_delivered' };
  }
  // Match LogQL's string comparison, including numeric attributes rendered as strings.
  if (finalErrorReplies !== '' && finalErrorReplies !== '0') {
    return { outcome: 'failure', reason: 'final_error_reply' };
  }
  if (['reply', 'reply_and_action', 'action_only', 'intentional_silence'].includes(result)) {
    return { outcome: 'success', reason: result };
  }
  return { outcome: 'unknown', reason: 'needs_attention' };
}

export function registerHostedTurnOutcomes(api: Pick<OpenClawPluginApi, 'registerService'>): void {
  let unsubscribe: (() => void) | undefined;
  let activeProvider: MeterProvider | undefined;
  let counter: Counter | undefined;
  const recordOutcome = (classification: Outcome, ship: string) => {
    const provider = metrics.getMeterProvider();
    if (provider !== activeProvider || !counter) {
      counter = provider.getMeter('tlon.hosting').createCounter('openclaw.turn.outcomes', {
        description: 'Terminal turn health using the Grafana dashboard classification',
        unit: '1',
      });
      activeProvider = provider;
    }
    counter.add(1, { ship, outcome: classification.outcome, reason: classification.reason });
  };
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
        // Telemetry failure must not interfere with the derived log or the turn.
        try { recordOutcome(classification, ship); } catch { /* best-effort metrics */ }
        // An allowlist prevents copying conversation content or provider errors.
        // A separate event preserves the channel plugin's execution semantics.
        const meta: Record<string, unknown> = {
          'tlon.hosting.turn.schema_version': 2,
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
