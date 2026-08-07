# tlon-hosting-oc

OpenClaw plugin for Tlon's hosted OpenClaw control plane.

It exposes the gateway-authenticated `/tlon/provider-auth/*` routes used by
Pioneer and registers OpenClaw's bundled OpenAI and Anthropic provider
runtimes when Tlon's managed plugin allowlist would otherwise omit them.
It also repairs cron-requested `operator.admin` device scopes at gateway
startup and migrates hosted cron jobs and persisted session model selections to
the current hosted model policy. Current cron and session updates go through
OpenClaw's store runtimes instead of editing their backing stores directly; the
OpenClaw doctor remains responsible for storage-format migrations.
At gateway service startup it also downloads Tlon's managed workspace prompts,
interpolates the ship-specific values, and idempotently updates the workspace.
The service runs again after a gateway restart, replacing the prompt refresh
previously owned by `tlawn.py`.

This package does not contain the Tlon Messenger channel plugin.
