# tlon-hosting-oc

OpenClaw plugin for Tlon's hosted OpenClaw control plane.

It exposes the gateway-authenticated `/tlon/provider-auth/*` routes used by
Pioneer and registers OpenClaw's bundled OpenAI and Anthropic provider
runtimes when Tlon's managed plugin allowlist would otherwise omit them.
It also repairs cron-requested `operator.admin` device scopes at gateway
startup and removes hosted cron and persisted session model pins so they always
inherit their effective configured defaults. Current cron and session updates
go through OpenClaw's store runtimes instead of editing their backing stores
directly; the OpenClaw doctor remains responsible for storage-format migrations.
At gateway service startup it also downloads Tlon's managed workspace prompts,
interpolates the ship-specific values, and idempotently updates the workspace.
The service runs again after a gateway restart, replacing the prompt refresh
previously owned by `tlawn.py`.

This package does not contain the Tlon Messenger channel plugin.

## User-turn outcomes

The gateway service observes the channel plugin's `tlon.agent_turn.terminal`
diagnostic log records and emits `tlon.hosting.turn.outcome`. The original
`execution` field describes dispatch completion, not user success, and is left
unchanged. Hosting classifies the combined execution, result, delivery, and
trigger fields:

| Outcome | Cases |
| --- | --- |
| `failure` | Failed, timed-out, or abandoned dispatch; error reply; failed/partial delivery; undelivered reply; empty DM or explicit mention |
| `ignored` | Cancelled dispatch, intentional silence, empty background turn (including owner-listen, owner-blob, cron) |
| `success` | Delivered normal reply, delivered reply plus actions, or action-only result |
| `unknown` | Unrecognized execution/result, or message-tool-only delivery without confirmation |

Action-only is the channel recorder's classification; it does not prove every
tool succeeded. This policy does not retry turns, change model selection, or
send additional messages. Retries can duplicate tool side effects.

The derived event includes schema version, outcome, reason, run ID, ship,
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
   ignored outcomes too; do not use absence of failures as a rollout check.
3. Review/import the provisioning document, then expand the plugin rollout.
   It adds a rule rather than replacing the existing compaction/billing rules.
4. For a failure, correlate the derived event's run ID with the original turn
   and ContextLens logs before attempting recovery. An empty explicit mention
   warrants investigation; the classifier cannot infer conversational intent.

Local validation: the classifier and diagnostic subscription are exercised by
`src/turn-outcomes.test.ts`. The rule's LogQL was accepted by production Loki
before rollout; no derived events were expected yet. Production rule import
and canary notification delivery still need verification during deployment.
