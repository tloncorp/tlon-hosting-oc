# Tlon Hosting OpenClaw Auth Plugin Design

## Goal

Extract the subscription-provider authentication control plane from the Tlon
Messenger OpenClaw channel plugin into a standalone OpenClaw plugin. The new
package and plugin ID are `tlon-hosting-oc`.

The extraction must preserve the existing Pioneer-facing HTTP contract and
must not copy unrelated Tlon channel functionality.

## Scope

The standalone plugin owns only:

- the gateway-authenticated `/tlon/provider-auth/*` HTTP routes;
- OpenAI device-code and Anthropic setup-token flows;
- provider authentication status, removal, refresh, and subscription model
  discovery;
- registration of the bundled OpenAI and Anthropic provider runtimes when a
  restrictive OpenClaw plugin allowlist would otherwise omit them; and
- tests for the extracted behavior.

The Tlon channel plugin continues to own Tlon/Urbit messaging, channel
configuration, tools, telemetry, and all other existing behavior.

## Repository and Package Structure

The existing local repository at `../oc-auth-plane` will contain the
standalone package. Its package metadata, OpenClaw manifest, and plugin entry
use `tlon-hosting-oc` as the package/plugin identity. Repository metadata and
Pioneer build defaults target `tloncorp/tlon-hosting-oc`.

The package contains:

```text
index.ts
openclaw.plugin.json
package.json
tsconfig.json
src/
  provider-auth-routes.ts
  provider-auth-routes.test.ts
  subscription-provider-runtime.ts
  subscription-provider-runtime.test.ts
```

The entrypoint uses OpenClaw's standard plugin entry helper. During
registration it first registers the missing subscription provider runtimes,
then registers the provider-auth HTTP routes.

The manifest declares startup activation and the authenticated gateway request
contract needed by the trusted-operator HTTP route. The package targets
OpenClaw 2026.7.1, the first version used by the existing implementation.

## HTTP Contract and Data Flow

The route prefix remains `/tlon/provider-auth` so Pioneer and the upstream
Solaris/Horizon contract do not change.

The endpoints remain:

- `GET /status`
- `POST /start`
- `GET /flow`
- `POST /complete`
- `DELETE /provider`

Pioneer authenticates the caller, reads the ship-local OpenClaw gateway token,
and forwards the request to the loopback gateway. OpenClaw authenticates the
gateway request and requires the trusted-operator scope. The standalone plugin
then invokes OpenClaw's auth-profile and provider APIs. Credentials remain in
OpenClaw's auth-profile store and are never persisted by Pioneer.

The existing flow lifetime, request-size limit, verification URL allowlist,
secret redaction, no-store responses, and root-managed config-lock handling
remain unchanged.

## Deployment and Activation

Pioneer's Dockerfile gains source-build arguments for the new plugin, including
repository and ref defaults. The image build clones
`tloncorp/tlon-hosting-oc`, installs development dependencies, builds and packs
the plugin, extracts it into OpenClaw's
`dist/extensions/tlon-hosting-oc`, and installs its production dependencies.
This follows the image's existing packed-plugin installation convention while
allowing development directly from Git until the package is published.

Installing files alone does not activate a non-bundled plugin under Tlonbot's
restrictive OpenClaw configuration. Tlonbot's configuration generator will
therefore:

- include `tlon-hosting-oc` in `plugins.allow`; and
- set `plugins.entries.tlon-hosting-oc.enabled` to `true`.

The plugin's runtime helper will continue to add only missing, non-disabled
`openai` and `anthropic` provider runtimes through an in-memory allowlist
overlay. It will not mutate the root-managed OpenClaw configuration.

## Tlon Channel Plugin Cleanup

The `tlon-apps` branch will remove:

- `provider-auth-routes.ts` and its tests;
- `subscription-provider-runtime.ts` and its tests;
- both registrations from `packages/openclaw/index.ts`;
- the authenticated gateway request contract added solely for these routes;
- the OpenClaw 2026.7.1 dependency/minimum-host bump if no remaining branch
  change requires it; and
- lockfile changes attributable only to that bump.

This ensures the extracted behavior has one owner and cannot be registered
twice.

## Error Handling

The standalone package preserves the existing behavior:

- malformed input and oversized bodies return 400 responses;
- missing or expired flows return 404;
- invalid flow state returns 409;
- unexpected failures return sanitized 500 responses;
- provider runtime loading failures warn without preventing gateway startup;
- failed OpenAI refreshes surface as expired/reconnectable state;
- auth-profile changes refresh gateway auth state; and
- provider secrets are removed from errors before logging or returning them.

## Testing and Verification

The extraction moves the existing focused unit tests into the standalone
package and adds a plugin registration smoke test if registration is not
otherwise covered.

Verification includes:

1. standalone package unit tests, type checking, and production build;
2. Tlonbot tests proving the new plugin is allowed and enabled while preserving
   existing plugin configuration;
3. Tlon channel plugin tests and type checking after removal;
4. static inspection of the packed standalone artifact and Pioneer install
   path; and
5. relevant Pioneer/Ylem tests for the unchanged provider-auth proxy contract.

The full Pioneer image build may require network credentials and external
artifacts. If it cannot run locally, verification will cover the individual
package build/pack/install commands and report the unexecuted image build
explicitly.

## Documentation

Ylem's provider-auth documentation will describe `tlon-hosting-oc` as the owner
of the provider-auth route and update deployment ordering to require the
standalone plugin ref rather than a Tlon channel plugin build containing the
route.

## Out of Scope

- changes to Horizon or Solaris request/response contracts;
- changes to the Pioneer Haskell proxy route;
- publishing the package to npm;
- model providers other than OpenAI and Anthropic;
- changes to the ship `%oauth` agent or OAuth connector relay; and
- unrelated refactors of the Tlon channel plugin or Tlonbot configuration
  generator.
