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

Prompt archives must be authenticated by setting `TLAWN_PROMPTS_SHA256` to the
archive's lowercase hexadecimal SHA-256 digest. A missing or mismatched digest
causes prompt synchronization to fail closed without changing the workspace.

This package does not contain the Tlon Messenger channel plugin.
