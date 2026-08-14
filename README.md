# tlon-hosting-oc

OpenClaw plugin for Tlon's hosted OpenClaw control plane.

It exposes the gateway-authenticated `/tlon/provider-auth/*` routes used by
Pioneer and registers OpenClaw's bundled OpenAI, Anthropic, and xAI provider
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

## Deployment modes

Self-hosted and existing single-tenant installs keep the normal OpenClaw
default-agent behavior. No additional route parameters are required.

Central gateways opt in with
`channels.tlon.deploymentMode: "monolithic"`. In that mode every provider-auth
request must include the control-plane-resolved `agentId` (query parameter for
GET/DELETE requests and JSON field for POST requests). Login flows are bound to
that agent, and polling or completing a flow as another agent returns “not
found.” Auth status, refresh, model discovery, token storage, and disconnects
all use the selected agent's auth directory.

`GET /tlon/provider-auth/health?agentId=<id>` is the lightweight shared-mode
readiness handshake used by Pioneer. It returns `running: true` only after the
agent resolves to exactly one configured Tlon account binding. Like the other
routes, it requires gateway authentication and is not a public health endpoint.

Hosted prompt sync also follows exact Tlon account bindings in monolithic
mode, updating each agent workspace with interpolation values from its own
`channels.tlon.accounts.<accountId>` entry. The prompt archive is downloaded
once per sync pass.

The gateway route is an internal operator surface, not the customer
authorization boundary. The hosting control plane must derive `agentId` from
the authenticated ship/customer and must never accept a customer-supplied
agent ID directly.
