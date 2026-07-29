# tlon-hosting-oc

OpenClaw plugin for Tlon's hosted subscription-authentication control plane.

It exposes the gateway-authenticated `/tlon/provider-auth/*` routes used by
Pioneer and registers OpenClaw's bundled OpenAI and Anthropic provider
runtimes when Tlon's managed plugin allowlist would otherwise omit them.

This package does not contain the Tlon Messenger channel plugin.
