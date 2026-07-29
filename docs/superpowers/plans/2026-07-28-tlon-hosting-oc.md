# Tlon Hosting OpenClaw Auth Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the subscription authentication control plane into the standalone `tlon-hosting-oc` OpenClaw plugin and deploy/activate it in Tlon hosting.

**Architecture:** A small TypeScript plugin owns the existing provider-auth routes and provider runtime registration. Pioneer builds the plugin from Git and places its packed artifact in OpenClaw's extension directory, while Tlonbot explicitly enables it in the managed plugin allowlist. The Tlon channel plugin no longer contains or registers this functionality.

**Tech Stack:** TypeScript, OpenClaw 2026.7.1 plugin SDK, Vitest, pnpm, Docker, Python unittest.

## Global Constraints

- The package and plugin ID are exactly `tlon-hosting-oc`.
- The HTTP prefix remains exactly `/tlon/provider-auth`.
- Copy only the auth-control-plane modules added on `reid/TLON-6253/oauth-flow`.
- Support only OpenAI device-code and Anthropic setup-token subscription auth.
- Keep credentials in OpenClaw's auth-profile store.
- Do not change Horizon, Solaris, or Pioneer's Haskell proxy contract.

---

### Task 1: Standalone OpenClaw Plugin

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `openclaw.plugin.json`
- Create: `index.ts`
- Create: `index.test.ts`
- Create: `README.md`
- Create: `src/provider-auth-routes.ts`
- Create: `src/provider-auth-routes.test.ts`
- Create: `src/subscription-provider-runtime.ts`
- Create: `src/subscription-provider-runtime.test.ts`

**Interfaces:**
- Consumes: OpenClaw plugin APIs from `openclaw/plugin-sdk/*`.
- Produces: default OpenClaw plugin entry with ID `tlon-hosting-oc`; `registerTlonHostingOpenClaw(api: OpenClawPluginApi): void`; gateway route `/tlon/provider-auth/*`.

- [ ] **Step 1: Copy the focused tests before their implementations**

Move the two existing test files from `tlon-apps/packages/openclaw/src` into this package's `src` directory without changing their assertions. Add `index.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerRoutes = vi.fn();
const registerRuntimes = vi.fn();

vi.mock('./src/provider-auth-routes.js', () => ({
  registerProviderAuthRoutes: registerRoutes,
}));
vi.mock('./src/subscription-provider-runtime.js', () => ({
  registerSubscriptionProviderRuntimes: registerRuntimes,
}));

import plugin, { registerTlonHostingOpenClaw } from './index.js';

describe('tlon-hosting-oc plugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers subscription runtimes before provider auth routes', () => {
    const api = {} as never;
    registerTlonHostingOpenClaw(api);
    expect(registerRuntimes).toHaveBeenCalledWith(api);
    expect(registerRoutes).toHaveBeenCalledWith(api);
    expect(registerRuntimes.mock.invocationCallOrder[0]).toBeLessThan(
      registerRoutes.mock.invocationCallOrder[0]
    );
  });

  it('exports the expected plugin identity', () => {
    expect(plugin.id).toBe('tlon-hosting-oc');
  });
});
```

- [ ] **Step 2: Add package tooling and verify tests fail**

Create package metadata with `openclaw@2026.7.1`, TypeScript, Vitest, and Node types as development dependencies; an `openclaw >=2026.7.1` peer; `build`, `test`, `tsc`, and `pack` scripts; and packed files limited to `dist`, the manifest, and README. Run:

```bash
pnpm install
pnpm test
```

Expected: FAIL because the plugin entrypoint and extracted implementation modules do not exist.

- [ ] **Step 3: Add the minimal plugin entry and manifest**

Create `index.ts`:

```ts
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

import { registerProviderAuthRoutes } from './src/provider-auth-routes.js';
import { registerSubscriptionProviderRuntimes } from './src/subscription-provider-runtime.js';

export function registerTlonHostingOpenClaw(api: OpenClawPluginApi): void {
  registerSubscriptionProviderRuntimes(api);
  registerProviderAuthRoutes(api);
}

export default definePluginEntry({
  id: 'tlon-hosting-oc',
  name: 'Tlon Hosting OpenClaw',
  description: 'Tlon hosting control plane for OpenClaw subscription authentication',
  register: registerTlonHostingOpenClaw,
});
```

Create `openclaw.plugin.json` with ID `tlon-hosting-oc`, startup activation, an empty strict config schema, and `contracts.gatewayMethodDispatch = ["authenticated-request"]`.

- [ ] **Step 4: Move the two implementations**

Copy `provider-auth-routes.ts` and `subscription-provider-runtime.ts` from the Tlon channel plugin. Preserve route behavior and OpenClaw SDK calls. Change only Tlon channel-plugin log prefixes to `[tlon-hosting-oc]`.

- [ ] **Step 5: Run standalone verification**

Run:

```bash
pnpm test
pnpm tsc
pnpm build
pnpm pack --pack-destination /tmp/tlon-hosting-oc-pack
tar -tzf /tmp/tlon-hosting-oc-pack/tlon-hosting-oc-*.tgz
```

Expected: tests, type checking, and build pass; the archive contains `dist/index.js`, `openclaw.plugin.json`, `package.json`, and `README.md`, with no test files.

- [ ] **Step 6: Commit the standalone package**

```bash
git add README.md index.ts index.test.ts openclaw.plugin.json package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json src
git commit -m "feat: add tlon-hosting-oc auth plugin"
```

### Task 2: Managed Plugin Activation

**Files:**
- Modify: `../tlonbot/entrypoint/test_tlawn.py`
- Modify: `../tlonbot/entrypoint/tlawn.py`

**Interfaces:**
- Consumes: installed OpenClaw plugin ID `tlon-hosting-oc`.
- Produces: `ensure_plugins_allow(...)` output containing `plugins.allow[] = "tlon-hosting-oc"` and `plugins.entries.tlon-hosting-oc.enabled = true`.

- [ ] **Step 1: Add a failing configuration test**

In the existing `EnsurePluginsAllowTests`, add:

```py
def test_enables_tlon_hosting_oc(self):
    plugins = self.ensure_plugins_allow()
    self.assertIn("tlon-hosting-oc", plugins["allow"])
    self.assertEqual(
        plugins["entries"]["tlon-hosting-oc"],
        {"enabled": True},
    )
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
python -m unittest entrypoint.test_tlawn.EnsurePluginsAllowTests.test_enables_tlon_hosting_oc
```

Expected: FAIL because the plugin is absent from the allowlist/entries.

- [ ] **Step 3: Enable the plugin in generated config**

Add:

```py
TLON_HOSTING_OC_PLUGIN_ID = "tlon-hosting-oc"
```

Update `ensure_plugins_allow` to add that constant alongside `tlon`, `document-extract`, and `diagnostics-otel`, and merge:

```py
hosting_entry = (
    next_entries.get(TLON_HOSTING_OC_PLUGIN_ID)
    if isinstance(next_entries.get(TLON_HOSTING_OC_PLUGIN_ID), dict)
    else {}
)
next_entries[TLON_HOSTING_OC_PLUGIN_ID] = {
    **hosting_entry,
    "enabled": True,
}
```

- [ ] **Step 4: Run Tlonbot tests**

Run:

```bash
python -m unittest entrypoint.test_tlawn
```

Expected: PASS.

- [ ] **Step 5: Commit activation**

```bash
git add entrypoint/tlawn.py entrypoint/test_tlawn.py
git commit -m "feat: enable tlon hosting auth plugin"
```

### Task 3: Pioneer Source-Build Installation

**Files:**
- Modify: `../ylem/var/containers/Runtime/pioneer/Dockerfile`
- Create: `../ylem/var/containers/Runtime/pioneer/test/tlon-hosting-oc-install.sh`
- Modify: `../ylem/docs/tlonbot-provider-auth.md`

**Interfaces:**
- Consumes: Git repository `tloncorp/tlon-hosting-oc` and build ref argument.
- Produces: `/usr/local/lib/node_modules/openclaw/dist/extensions/tlon-hosting-oc`.

- [ ] **Step 1: Add a failing Dockerfile contract test**

Create an executable shell test that reads the sibling Dockerfile and asserts it contains:

```sh
grep -F 'ARG TLON_HOSTING_OC_REF="master"' "$dockerfile"
grep -F 'ARG TLON_HOSTING_OC_REPO="tloncorp/tlon-hosting-oc"' "$dockerfile"
grep -F 'dist/extensions/tlon-hosting-oc' "$dockerfile"
grep -F 'pnpm build' "$dockerfile"
```

- [ ] **Step 2: Run the contract test and verify failure**

Run:

```bash
bash var/containers/Runtime/pioneer/test/tlon-hosting-oc-install.sh
```

Expected: FAIL because the Dockerfile has no standalone-plugin arguments or install path.

- [ ] **Step 3: Add the source-build installation**

Add Docker build arguments and environment variables for:

```dockerfile
ARG TLON_HOSTING_OC_REF="master"
ARG TLON_HOSTING_OC_REPO="tloncorp/tlon-hosting-oc"
ENV TLON_HOSTING_OC_REPO=$TLON_HOSTING_OC_REPO
ENV TLON_HOSTING_OC_CHECKOUT=/opt/tlon-hosting-oc
```

In the OpenClaw installation `RUN`, clone the configured ref, run `pnpm install --frozen-lockfile`, `pnpm build`, and `npm pack`; extract the archive into `dist/extensions/tlon-hosting-oc`; then run production dependency installation in that directory using the existing OpenClaw root npm cache.

- [ ] **Step 4: Update deployment documentation**

Replace references to the Tlon channel plugin owning the route with `tlon-hosting-oc`. Document `TLON_HOSTING_OC_REF` and require the standalone plugin commit to be available before building Pioneer.

- [ ] **Step 5: Verify the Dockerfile integration**

Run:

```bash
bash var/containers/Runtime/pioneer/test/tlon-hosting-oc-install.sh
docker build --check var/containers/Runtime/pioneer
```

Expected: contract test passes. Docker check passes when the installed Docker supports `--check`; otherwise report that check as unavailable and retain the passing contract test.

- [ ] **Step 6: Commit Pioneer integration**

```bash
git add var/containers/Runtime/pioneer/Dockerfile var/containers/Runtime/pioneer/test/tlon-hosting-oc-install.sh docs/tlonbot-provider-auth.md
git commit -m "feat: install tlon hosting auth plugin"
```

### Task 4: Remove Auth Control Plane from Tlon Channel Plugin

**Files:**
- Delete: `../tlon-apps/packages/openclaw/src/provider-auth-routes.ts`
- Delete: `../tlon-apps/packages/openclaw/src/provider-auth-routes.test.ts`
- Delete: `../tlon-apps/packages/openclaw/src/subscription-provider-runtime.ts`
- Delete: `../tlon-apps/packages/openclaw/src/subscription-provider-runtime.test.ts`
- Modify: `../tlon-apps/packages/openclaw/index.ts`
- Modify: `../tlon-apps/packages/openclaw/openclaw.plugin.json`
- Modify: `../tlon-apps/packages/openclaw/package.json`
- Modify: `../tlon-apps/pnpm-lock.yaml`

**Interfaces:**
- Consumes: standalone `tlon-hosting-oc` ownership of all extracted behavior.
- Produces: Tlon channel plugin with no provider-auth route or subscription runtime registration.

- [ ] **Step 1: Remove registrations and extracted files**

Delete the four moved files. Remove `registerProviderAuthRoutes` and `registerSubscriptionProviderRuntimes` imports/calls from `index.ts`. Remove the `authenticated-request` contract from the Tlon plugin manifest.

- [ ] **Step 2: Restore unrelated dependency metadata**

Restore the Tlon plugin's OpenClaw development dependency, peer minimum, and install minimum to their `develop` values. Restore lockfile changes from `develop` because they were caused only by the auth-driven OpenClaw upgrade.

- [ ] **Step 3: Verify the branch contains no duplicated auth implementation**

Run:

```bash
rg -n "registerProviderAuthRoutes|registerSubscriptionProviderRuntimes|/tlon/provider-auth" packages/openclaw
git diff --check
```

Expected: ripgrep returns no matches and `git diff --check` passes.

- [ ] **Step 4: Run Tlon plugin verification**

Run:

```bash
pnpm --filter @tloncorp/openclaw test
pnpm --filter @tloncorp/openclaw tsc
```

Expected: PASS.

- [ ] **Step 5: Commit cleanup**

```bash
git add packages/openclaw/index.ts packages/openclaw/openclaw.plugin.json packages/openclaw/package.json packages/openclaw/src/provider-auth-routes.ts packages/openclaw/src/provider-auth-routes.test.ts packages/openclaw/src/subscription-provider-runtime.ts packages/openclaw/src/subscription-provider-runtime.test.ts pnpm-lock.yaml
git commit -m "refactor: extract provider auth control plane"
```

### Task 5: Cross-Repository Final Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: evidence that the extracted package builds, activates, installs, and has no duplicate owner.

- [ ] **Step 1: Run all focused verification**

Run the standalone package test/type/build suite, Tlonbot unittest module, Pioneer install contract test, and Tlon channel package test/type suite again from clean commands.

- [ ] **Step 2: Inspect repository state**

Run `git status --short --branch` and `git log -3 --oneline` in `oc-auth-plane`, `tlonbot`, `ylem`, and `tlon-apps`. Confirm only pre-existing unrelated changes remain uncommitted.

- [ ] **Step 3: Review the final diff**

Confirm:

- the standalone repo contains only auth-control-plane code and packaging;
- `/tlon/provider-auth` is unchanged;
- `tlon-hosting-oc` is installed and enabled;
- Tlon channel behavior outside the extraction is untouched; and
- documentation names the standalone owner.
