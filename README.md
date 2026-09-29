# tlon-hosting-oc

OpenClaw plugin for Tlon's hosted OpenClaw control plane.

It exposes the gateway-authenticated `/tlon/provider-auth/*` routes used by
Pioneer and registers OpenClaw's bundled OpenAI and Anthropic provider
runtimes when Tlon's managed plugin allowlist would otherwise omit them.
It also removes hosted cron and persisted session model pins so they always
inherit their effective configured defaults. Cron changes go through the gateway
API, session changes go through OpenClaw's SQLite-backed session row API, and
OpenClaw remains responsible for storage-format and approval migrations.
At gateway service startup it also downloads Tlon's managed workspace prompts,
interpolates the ship-specific values, and idempotently updates the workspace.
The service runs again after a gateway restart, replacing the prompt refresh
previously owned by `tlawn.py`.

This package does not contain the Tlon Messenger channel plugin.

## User-turn outcomes

The gateway service observes the channel plugin's `tlon.agent_turn.terminal`
diagnostic log records and emits `tlon.hosting.turn.outcome`. The original
`execution` field describes dispatch completion, not user success, and is left
unchanged. The classification matches the existing Grafana terminal-turn query,
with Broken mapped to `failure`, Healthy to `success`, and Needs attention to
`unknown`. Failure conditions take precedence over healthy results.

| Outcome | Cases |
| --- | --- |
| `failure` | Failed, timed-out, cancelled, or abandoned execution; error-reply result; failed/partial delivery; reason `reply_not_delivered`; nonempty final error-reply count other than `0` |
| `success` | Reply, reply plus actions, action-only, or intentional silence, with none of the failure conditions |
| `unknown` | All remaining cases, including empty DM, mention, and background turns |

Skipped delivery alone is not a failure; it must meet one of the conditions
above. Healthy results do not require `execution=completed`.

The same classification is exported as the OpenTelemetry counter
`openclaw.turn.outcomes` (`openclaw_turn_outcomes_total` in Prometheus),
with `ship`, `outcome`, and normalized `reason` labels. The host must configure
the OpenTelemetry metric provider/exporter; Alloy supplies owner and cluster
identity. The counter avoids parsing Loki logs while retaining the final
error-reply-count check, which the original native turn counter cannot express.

Action-only is the channel recorder's classification; it does not prove every
tool succeeded. This policy does not retry turns, change model selection, or
send additional messages. Retries can duplicate tool side effects.

The derived event includes schema version 2, outcome, reason, run ID, ship,
trigger, execution, result, and delivery. It excludes session keys and message
content. Core diagnostic events and log export must be enabled. No events means
no coverage, not proof of health; this observer cannot detect a turn which
never emits a terminal event. Older channel versions without terminal records
need an upgrade before they are covered.

### Alert rollout

`observability/turn-failure-alert.json` is a Grafana file-provisioning document
for production's primary Loki (`bdtg19yurjapsa`) and existing
`tlonbot-alert-channel` contact point. Adjust these references for other
environments. It groups failures by bot and reason over five minutes, evaluates
every minute, and repeats notifications hourly. NoData is OK for this sparse
event query; query errors remain errors.

1. Build and deploy the hosting plugin to a canary gateway, then restart it.
2. Confirm `tlon.hosting.turn.outcome` appears beside terminal records in Loki
   (OTLP prefixes the structured keys with `openclaw.`). Inspect success and
   unknown outcomes too; do not use absence of failures as a rollout check.
3. Review/import the provisioning document, then expand the plugin rollout.
   It adds a rule rather than replacing the existing compaction/billing rules.
4. For a failure, correlate the derived event's run ID with the original turn
   and ContextLens logs before attempting recovery.

Local validation: the classifier and diagnostic subscription are exercised by
`src/turn-outcomes.test.ts`. The rule's LogQL was accepted by production Loki
before rollout; no derived events were expected yet. Production rule import
and canary notification delivery still need verification during deployment.

For the `mass-modules` Prometheus alert, deploy this plugin version first and
verify `openclaw_turn_outcomes_total` is present for the canary. Then roll out
the updated Alloy filter and `OpenClawTurnFailed` rule. Gateways running the old
plugin do not emit this counter and will not be covered by that rule. Use the
Prometheus alert or the standalone Grafana example, not both for the same bots.
The five-minute counter estimate includes initial samples, so rollout or a
telemetry gap can briefly recount historical failures.
