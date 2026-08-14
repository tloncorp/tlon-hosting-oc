import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  clearAuthProfileCooldown,
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  listAgentIds,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveDefaultAgentDir,
} from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { fetchLiveProviderModelRows } from 'openclaw/plugin-sdk/provider-catalog-live-runtime';
import {
  removeProviderAuthProfilesWithLock,
  upsertAuthProfileWithLock,
  validateAnthropicSetupToken,
} from 'openclaw/plugin-sdk/provider-auth';
import {
  type ModelsAuthLoginFlowOptions,
  runModelsAuthLoginFlow,
} from 'openclaw/plugin-sdk/provider-auth-login-flow-runtime';

export const PROVIDER_AUTH_ROUTE = '/tlon/provider-auth';

const FLOW_TTL_MS = 15 * 60_000;
const START_WAIT_MS = 15_000;
const MAX_BODY_BYTES = 16 * 1024;
const ANTHROPIC_PROFILE_ID = 'anthropic:default';
const DEFAULT_API_KEY_PROVIDER = 'openrouter';
const NON_LLM_API_KEY_PROVIDERS = new Set(['brave']);
const PLACEHOLDER_API_KEYS = new Set([
  'none',
  'null',
  'undefined',
  'not-set',
  'not_set',
]);
const OPENAI_CODEX_MODELS_URL =
  'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
const OPENAI_CODEX_MODELS_TIMEOUT_MS = 10_000;
const XAI_GROK_OAUTH_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models';
const XAI_GROK_OAUTH_MODELS_TIMEOUT_MS = 10_000;

type ProviderId = 'openai' | 'anthropic' | 'xai';
type DeviceCodeProviderId = Exclude<ProviderId, 'anthropic'>;
type FlowStatus =
  | 'awaiting_browser'
  | 'awaiting_token'
  | 'authenticating'
  | 'complete'
  | 'error';

type ProviderAuthFlow = {
  id: string;
  agentId: string;
  provider: ProviderId;
  status: FlowStatus;
  createdAt: number;
  expiresAt: number;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
};

type PublicProviderAuthFlow = Omit<ProviderAuthFlow, 'createdAt'>;

const flows = new Map<string, ProviderAuthFlow>();
const flowWaiters = new Map<string, Set<() => void>>();

type GatewayModelCatalogEntry = {
  provider?: unknown;
  id?: unknown;
  key?: unknown;
  name?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  available?: unknown;
};

type SubscriptionModel = {
  id: string;
  name?: string;
};

type SubscriptionModelCatalog = Partial<
  Record<ProviderId, SubscriptionModel[]>
>;
type LiveProviderModelRowsLoader = typeof fetchLiveProviderModelRows;

type OAuthSubscriptionModelAdapter = {
  providerId: DeviceCodeProviderId;
  displayName: string;
  discoverModels: (accessToken: string) => Promise<SubscriptionModel[]>;
};

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function publicFlow(flow: ProviderAuthFlow): PublicProviderAuthFlow {
  return {
    id: flow.id,
    agentId: flow.agentId,
    provider: flow.provider,
    status: flow.status,
    expiresAt: flow.expiresAt,
    ...(flow.verificationUrl ? { verificationUrl: flow.verificationUrl } : {}),
    ...(flow.userCode ? { userCode: flow.userCode } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  };
}

export type ProviderAuthAgentScope = {
  agentId: string;
  accountId: string | null;
  agentDir: string;
  isDefault: boolean;
};

export type ManagedProviderApiKey = {
  profileId: string;
  provider: string;
  key: string;
};

export function normalizeManagedProviderApiKeys(
  providerKeys: unknown
): ManagedProviderApiKey[] {
  if (
    !providerKeys ||
    typeof providerKeys !== 'object' ||
    Array.isArray(providerKeys)
  ) {
    throw new Error('providerKeys must be an object');
  }
  const keys = providerKeys as Record<string, unknown>;
  const managed: ManagedProviderApiKey[] = [];
  const add = (profileName: string, provider: string, value: unknown) => {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key || PLACEHOLDER_API_KEYS.has(key.toLowerCase())) {
      return;
    }
    managed.push({ profileId: `${profileName}:default`, provider, key });
  };

  const basic = keys.basic;
  const openrouter = keys[DEFAULT_API_KEY_PROVIDER];
  if (typeof basic === 'string' && basic.trim()) {
    add('basic', DEFAULT_API_KEY_PROVIDER, basic);
  } else {
    add(DEFAULT_API_KEY_PROVIDER, DEFAULT_API_KEY_PROVIDER, openrouter);
  }

  for (const [rawProvider, value] of Object.entries(keys).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const provider = rawProvider.trim().toLowerCase();
    if (
      !provider ||
      provider === 'basic' ||
      provider === DEFAULT_API_KEY_PROVIDER ||
      NON_LLM_API_KEY_PROVIDERS.has(provider)
    ) {
      continue;
    }
    add(provider, provider, value);
  }
  return managed;
}

function isMonolithic(cfg: OpenClawConfig): boolean {
  return (
    (cfg.channels?.tlon as { deploymentMode?: string } | undefined)
      ?.deploymentMode === 'monolithic'
  );
}

/**
 * Resolve a provider-auth operation to one configured agent. Standalone
 * installs retain the historical default-agent behavior; centralized hosting
 * must explicitly supply the server-authorized agent id on every request.
 */
export function resolveProviderAuthAgentScope(
  cfg: OpenClawConfig,
  requestedAgentId?: unknown
): ProviderAuthAgentScope {
  const explicit =
    typeof requestedAgentId === 'string' ? requestedAgentId.trim() : '';
  if (isMonolithic(cfg) && !explicit) {
    throw new Error('agentId is required in monolithic deployment mode');
  }

  const defaultAgentId = resolveDefaultAgentId(cfg);
  const agentId = explicit || defaultAgentId;
  if (!listAgentIds(cfg).includes(agentId)) {
    throw new Error('agentId is not configured');
  }
  let accountId: string | null = null;
  if (isMonolithic(cfg)) {
    const accountIds = new Set<string>();
    for (const binding of cfg.bindings ?? []) {
      if (
        binding.type === 'acp' ||
        binding.agentId.trim() !== agentId ||
        binding.match.channel !== 'tlon' ||
        !binding.match.accountId ||
        binding.match.accountId === '*'
      ) {
        continue;
      }
      accountIds.add(binding.match.accountId.trim());
    }
    if (accountIds.size !== 1) {
      throw new Error(
        'agentId must have exactly one Tlon account binding in monolithic mode'
      );
    }
    accountId = [...accountIds][0] ?? null;
    const accounts = (
      cfg.channels?.tlon as { accounts?: Record<string, unknown> } | undefined
    )?.accounts;
    if (!accountId || !Object.hasOwn(accounts ?? {}, accountId)) {
      throw new Error('agentId Tlon account binding is not configured');
    }
  }
  return {
    agentId,
    accountId,
    agentDir: explicit
      ? resolveAgentDir(cfg, agentId)
      : resolveDefaultAgentDir(cfg),
    isDefault: agentId === defaultAgentId,
  };
}

function normalizeProvider(value: unknown): ProviderId | null {
  return value === 'openai' || value === 'anthropic' || value === 'xai'
    ? value
    : null;
}

function pruneFlows(now = Date.now()) {
  for (const [id, flow] of flows) {
    if (flow.expiresAt <= now) {
      flows.delete(id);
      notifyFlowWaiters(id);
    }
  }
}

function notifyFlowWaiters(flowId: string) {
  const waiters = flowWaiters.get(flowId);
  if (!waiters) {
    return;
  }
  flowWaiters.delete(flowId);
  for (const resolve of waiters) {
    resolve();
  }
}

function updateFlow(
  flowId: string,
  patch: Partial<Omit<ProviderAuthFlow, 'id' | 'provider' | 'createdAt'>>
) {
  const flow = flows.get(flowId);
  if (!flow) {
    return;
  }
  Object.assign(flow, patch);
  notifyFlowWaiters(flowId);
}

function waitForFlowUpdate(flowId: string): Promise<void> {
  return new Promise((resolve) => {
    const waiters = flowWaiters.get(flowId) ?? new Set();
    waiters.add(resolve);
    flowWaiters.set(flowId, waiters);
    const timeout = setTimeout(() => {
      waiters.delete(resolve);
      if (waiters.size === 0) {
        flowWaiters.delete(flowId);
      }
      resolve();
    }, START_WAIT_MS);
    timeout.unref();
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error('request body is too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function readModelCatalogEntries(value: unknown): GatewayModelCatalogEntry[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const models = (value as { models?: unknown }).models;
  return Array.isArray(models)
    ? models.filter(
        (entry): entry is GatewayModelCatalogEntry =>
          Boolean(entry) && typeof entry === 'object'
      )
    : [];
}

function normalizeCatalogEntry(entry: GatewayModelCatalogEntry): {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  available?: boolean;
} | null {
  let provider =
    typeof entry.provider === 'string' ? entry.provider.trim() : '';
  let id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if ((!provider || !id) && typeof entry.key === 'string') {
    const separator = entry.key.indexOf('/');
    if (separator > 0 && separator < entry.key.length - 1) {
      provider ||= entry.key.slice(0, separator).trim();
      id ||= entry.key.slice(separator + 1).trim();
    }
  }
  if (!provider || !id) {
    return null;
  }
  return {
    provider,
    id,
    ...(typeof entry.name === 'string' && entry.name.trim()
      ? { name: entry.name.trim() }
      : {}),
    ...(typeof entry.api === 'string' && entry.api.trim()
      ? { api: entry.api.trim() }
      : {}),
    ...(typeof entry.baseUrl === 'string' && entry.baseUrl.trim()
      ? { baseUrl: entry.baseUrl.trim() }
      : {}),
    ...(typeof entry.available === 'boolean'
      ? { available: entry.available }
      : {}),
  };
}

function isOpenAISubscriptionModel(entry: {
  id: string;
  api?: string;
  baseUrl?: string;
}): boolean {
  if (entry.api) {
    return entry.api === 'openai-chatgpt-responses';
  }
  if (entry.baseUrl) {
    return entry.baseUrl.includes('chatgpt.com/backend-api');
  }

  // Some models.list projections omit transport metadata and expose only a
  // provider-qualified key. These are the native Codex ids supported by 7.1.
  return (
    entry.id.includes('codex') ||
    /^gpt-5\.(?:4(?:-(?:mini|pro))?|5(?:-pro)?|6-(?:sol|terra|luna))$/.test(
      entry.id
    )
  );
}

export function extractSubscriptionModels(
  value: unknown
): SubscriptionModelCatalog {
  const catalog: SubscriptionModelCatalog = {};
  const entries = readModelCatalogEntries(value)
    .map(normalizeCatalogEntry)
    .filter((entry) => entry !== null);

  for (const provider of ['openai', 'anthropic', 'xai'] as const) {
    const seen = new Set<string>();
    catalog[provider] = entries
      .filter((entry) => {
        if (entry.provider !== provider || !entry.id) {
          return false;
        }

        // OpenAI's canonical provider contains both direct Platform API rows
        // and native ChatGPT/Codex subscription rows. Only the latter can be
        // powered by the OAuth profile created by this flow.
        if (provider === 'openai' && !isOpenAISubscriptionModel(entry)) {
          return false;
        }

        const id = entry.id;
        if (seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      })
      .map((entry) => ({
        id: entry.id,
        ...(entry.name ? { name: entry.name } : {}),
      }));
  }

  return catalog;
}

export function extractOpenAICodexModels(value: unknown): SubscriptionModel[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const rows = (value as { models?: unknown }).models;
  if (!Array.isArray(rows)) {
    return [];
  }

  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return [];
    }
    const model = row as Record<string, unknown>;
    const visibility =
      typeof model.visibility === 'string'
        ? model.visibility.trim().toLowerCase()
        : '';
    if (visibility && visibility !== 'list') {
      return [];
    }
    if (model.show_in_picker === false || model.showInPicker === false) {
      return [];
    }

    const rawId =
      typeof model.slug === 'string'
        ? model.slug
        : typeof model.id === 'string'
          ? model.id
          : '';
    const id = rawId.trim();
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);

    const rawName =
      typeof model.display_name === 'string'
        ? model.display_name
        : typeof model.displayName === 'string'
          ? model.displayName
          : typeof model.name === 'string'
            ? model.name
            : '';
    const name = rawName.trim();
    return [{ id, ...(name ? { name } : {}) }];
  });
}

export function extractXaiOAuthModels(value: unknown): SubscriptionModel[] {
  const rows = Array.isArray(value)
    ? value
    : value &&
        typeof value === 'object' &&
        Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : [];
  const seen = new Set<string>();

  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return [];
    }
    const model = row as Record<string, unknown>;
    const rawId =
      typeof model.id === 'string'
        ? model.id
        : typeof model.model === 'string'
          ? model.model
          : '';
    const id = rawId.trim();
    if (
      !id ||
      seen.has(id) ||
      id.includes('multi-agent') ||
      id === 'grok-imagine-image' ||
      id === 'grok-imagine-image-quality'
    ) {
      return [];
    }

    const rawBackend =
      typeof model.api_backend === 'string'
        ? model.api_backend
        : typeof model.apiBackend === 'string'
          ? model.apiBackend
          : typeof model.backend === 'string'
            ? model.backend
            : '';
    const backend = rawBackend.trim().toLowerCase();
    if (backend && !['responses', 'chat', 'language'].includes(backend)) {
      return [];
    }

    seen.add(id);
    const rawName = typeof model.name === 'string' ? model.name : '';
    const name = rawName.trim();
    return [{ id, ...(name ? { name } : {}) }];
  });
}

export async function fetchXaiOAuthSubscriptionModels(
  discoveryApiKey: string,
  loadRows: LiveProviderModelRowsLoader = fetchLiveProviderModelRows
): Promise<SubscriptionModel[]> {
  const rows = await loadRows({
    providerId: 'xai',
    endpoint: XAI_GROK_OAUTH_MODELS_URL,
    discoveryApiKey,
    timeoutMs: XAI_GROK_OAUTH_MODELS_TIMEOUT_MS,
    auditContext: 'tlon-xai-oauth-model-discovery',
  });
  return extractXaiOAuthModels(rows);
}

function errorMessage(error: unknown, secret?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return secret ? raw.split(secret).join('[redacted]') : raw;
}

export function isManagedConfigLockPermissionError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /\bEACCES\b/.test(message) &&
    /(?:^|[/\\])openclaw\.json\.lock(?:['"]|$)/.test(message)
  );
}

export function parseOpenAIVerificationMessage(
  message: string
): { verificationUrl: string; userCode: string } | null {
  return parseDeviceCodeVerificationMessage('openai', message);
}

export function parseDeviceCodeVerificationMessage(
  provider: DeviceCodeProviderId,
  message: string
): { verificationUrl: string; userCode: string } | null {
  const urlMatch = /^URL:\s*(\S+)\s*$/im.exec(message);
  const codeMatch = /^Code:\s*(\S+)\s*$/im.exec(message);
  if (!urlMatch?.[1] || !codeMatch?.[1]) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(urlMatch[1]);
  } catch {
    return null;
  }
  const trustedUrl =
    provider === 'openai'
      ? url.hostname === 'auth.openai.com' && url.pathname === '/codex/device'
      : url.hostname === 'accounts.x.ai' && url.pathname === '/oauth2/device';
  const urlUserCode = url.searchParams.get('user_code');
  if (
    url.protocol !== 'https:' ||
    !trustedUrl ||
    (provider === 'xai' && urlUserCode !== null && urlUserCode !== codeMatch[1])
  ) {
    return null;
  }
  return {
    verificationUrl: url.toString(),
    userCode: codeMatch[1],
  };
}

function createRuntime(api: OpenClawPluginApi) {
  return {
    log: (...args: unknown[]) => {
      api.logger.info(
        `[tlon-hosting] Provider auth: ${args.map(String).join(' ')}`
      );
    },
    error: (...args: unknown[]) => {
      api.logger.warn(
        `[tlon-hosting] Provider auth: ${args.map(String).join(' ')}`
      );
    },
    exit: (code: number) => {
      throw new Error(`provider auth exited with code ${code}`);
    },
  };
}

function unsupportedPrompt(): never {
  throw new Error('provider requested an unsupported interactive prompt');
}

function createPrompter(params: {
  onNote?: (message: string, title?: string) => void;
  token?: string;
}): ModelsAuthLoginFlowOptions['prompter'] {
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => params.onNote?.(message, title),
    plain: async (message) => params.onNote?.(message),
    select: async () => unsupportedPrompt(),
    multiselect: async () => unsupportedPrompt(),
    text: async ({ validate }) => {
      if (!params.token) {
        unsupportedPrompt();
      }
      const validationError = validate?.(params.token);
      if (validationError) {
        throw new Error(validationError);
      }
      return params.token;
    },
    confirm: async () => unsupportedPrompt(),
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

async function runDeviceCodeFlow(
  api: OpenClawPluginApi,
  flowId: string,
  provider: DeviceCodeProviderId,
  agentId: string
) {
  try {
    await runModelsAuthLoginFlow({
      provider,
      method: 'device-code',
      agent: agentId,
      runtime: createRuntime(api),
      prompter: createPrompter({
        onNote: (message) => {
          const verification = parseDeviceCodeVerificationMessage(
            provider,
            message
          );
          if (verification) {
            updateFlow(flowId, {
              ...verification,
              status: 'awaiting_browser',
            });
          }
        },
      }),
      isRemote: true,
      openUrl: async () => {},
    });
    await refreshGatewayAuthState(api, agentId);
    updateFlow(flowId, { status: 'complete' });
  } catch (error) {
    // OpenClaw 7.1 persists the auth profile before applying the provider's
    // optional model-allowlist patch. Tlon's generated config is intentionally
    // root-managed, so that final write cannot acquire openclaw.json.lock.
    // The credential is already durable in the pier-backed auth store.
    if (isManagedConfigLockPermissionError(error)) {
      api.logger.info(
        `[tlon-hosting] ${provider} auth saved; skipped optional root-managed config patch`
      );
      await refreshGatewayAuthState(api, agentId);
      updateFlow(flowId, { status: 'complete' });
      return;
    }
    updateFlow(flowId, { status: 'error', error: errorMessage(error) });
  }
}

async function runAnthropicFlow(
  api: OpenClawPluginApi,
  flowId: string,
  token: string,
  scope: ProviderAuthAgentScope
) {
  updateFlow(flowId, { status: 'authenticating', error: undefined });
  try {
    const normalizedToken = token.replaceAll(/\s+/g, '').trim();
    const validationError = validateAnthropicSetupToken(normalizedToken);
    if (validationError) {
      throw new Error(validationError);
    }

    const store = await upsertAuthProfileWithLock({
      profileId: ANTHROPIC_PROFILE_ID,
      credential: {
        type: 'token',
        provider: 'anthropic',
        token: normalizedToken,
      },
      agentDir: scope.agentDir,
    });
    if (!store) {
      throw new Error(
        'Failed to update the auth profile store; please try again'
      );
    }
    await clearAuthProfileCooldown({
      store,
      profileId: ANTHROPIC_PROFILE_ID,
      agentDir: scope.agentDir,
    });
    await refreshGatewayAuthState(api, scope.agentId);
    updateFlow(flowId, { status: 'complete' });
  } catch (error) {
    updateFlow(flowId, {
      status: 'error',
      error: errorMessage(error, token),
    });
  }
}

async function refreshExpiredOAuthProfiles(
  api: OpenClawPluginApi,
  agentDir: string
) {
  const cfg = api.runtime.config.current() as OpenClawConfig;
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
    config: cfg,
  });

  for (const provider of ['openai', 'xai'] as const) {
    for (const profileId of listProfilesForProvider(store, provider)) {
      const credential = store.profiles[profileId];
      if (
        credential?.type !== 'oauth' ||
        !credential.expires ||
        credential.expires > Date.now() + 60_000
      ) {
        continue;
      }
      try {
        await resolveApiKeyForProfile({
          cfg,
          store,
          profileId,
          agentDir,
          forceRefresh: true,
        });
      } catch {
        api.logger.warn(
          `[tlon-hosting] ${provider} auth refresh failed for ${profileId}; re-login may be required`
        );
      }
    }
  }
}

async function requestFreshGatewayAuthState(api: OpenClawPluginApi) {
  clearRuntimeAuthProfileStoreSnapshots();
  return await api.runtime.gateway.request('models.authStatus', {
    refresh: true,
  });
}

function buildAgentAuthStatus(
  cfg: OpenClawConfig,
  agentDir: string
): Record<string, unknown> {
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
    config: cfg,
  });
  const now = Date.now();
  const providers = (['openai', 'anthropic', 'xai'] as const).map(
    (provider) => {
      const profileIds = listProfilesForProvider(store, provider).filter(
        (profileId) => {
          const credential = store.profiles[profileId];
          return provider === 'anthropic'
            ? credential?.type === 'oauth' || credential?.type === 'token'
            : credential?.type === 'oauth';
        }
      );
      const expiries = profileIds.flatMap((profileId) => {
        const credential = store.profiles[profileId];
        const expires =
          credential?.type === 'oauth' ? credential.expires : undefined;
        return typeof expires === 'number' ? [expires] : [];
      });
      const earliestExpiry = expiries.length > 0 ? Math.min(...expiries) : null;
      const status =
        profileIds.length === 0
          ? 'missing'
          : earliestExpiry !== null && earliestExpiry <= now
            ? 'expired'
            : earliestExpiry !== null &&
                earliestExpiry <= now + 24 * 60 * 60_000
              ? 'expiring'
              : 'ok';
      return {
        provider,
        status,
        profiles: profileIds.map((profileId) => ({
          profileId,
          provider,
          type: store.profiles[profileId]?.type,
        })),
        ...(earliestExpiry !== null
          ? {
              expiry: {
                at: earliestExpiry,
                remainingMs: earliestExpiry - now,
                label: new Date(earliestExpiry).toISOString(),
              },
            }
          : {}),
      };
    }
  );
  return { ts: now, providers };
}

async function requestAgentAuthState(
  api: OpenClawPluginApi,
  scope: ProviderAuthAgentScope
): Promise<unknown> {
  if (scope.isDefault) {
    return await requestFreshGatewayAuthState(api);
  }
  clearRuntimeAuthProfileStoreSnapshots();
  return buildAgentAuthStatus(
    api.runtime.config.current() as OpenClawConfig,
    scope.agentDir
  );
}

async function refreshGatewayAuthState(
  api: OpenClawPluginApi,
  agentId: string
) {
  const cfg = api.runtime.config.current() as OpenClawConfig;
  clearRuntimeAuthProfileStoreSnapshots();
  if (agentId !== resolveDefaultAgentId(cfg)) {
    return;
  }
  try {
    await requestFreshGatewayAuthState(api);
  } catch (error) {
    api.logger.warn(
      `[tlon-hosting] Provider auth state refresh failed: ${errorMessage(error)}`
    );
  }
}

async function syncManagedProviderApiKeys(
  api: OpenClawPluginApi,
  scope: ProviderAuthAgentScope,
  providerKeys: unknown
): Promise<ManagedProviderApiKey[]> {
  const managed = normalizeManagedProviderApiKeys(providerKeys);
  for (const entry of managed) {
    const store = await upsertAuthProfileWithLock({
      profileId: entry.profileId,
      credential: {
        type: 'api_key',
        provider: entry.provider,
        key: entry.key,
      },
      agentDir: scope.agentDir,
    });
    if (!store) {
      throw new Error(`failed to update provider auth for ${entry.provider}`);
    }
    await clearAuthProfileCooldown({
      store,
      profileId: entry.profileId,
      agentDir: scope.agentDir,
    });
  }
  await refreshGatewayAuthState(api, scope.agentId);
  return managed;
}

async function loadOpenAISubscriptionModels(
  api: OpenClawPluginApi,
  agentDir: string
): Promise<SubscriptionModel[]> {
  const cfg = api.runtime.config.current() as OpenClawConfig;
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
    config: cfg,
  });
  const models: SubscriptionModel[] = [];
  const seen = new Set<string>();

  for (const profileId of listProfilesForProvider(store, 'openai')) {
    const credential = store.profiles[profileId];
    if (credential?.type !== 'oauth') {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId,
        agentDir,
      });
      if (!resolved?.apiKey || resolved.profileType !== 'oauth') {
        continue;
      }
      const resolvedCredential =
        resolved.credential?.type === 'oauth'
          ? resolved.credential
          : credential;
      const response = await fetch(OPENAI_CODEX_MODELS_URL, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
          ...(resolvedCredential.accountId
            ? { 'ChatGPT-Account-ID': resolvedCredential.accountId }
            : {}),
        },
        signal: AbortSignal.timeout(OPENAI_CODEX_MODELS_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `Codex model discovery returned HTTP ${response.status}`
        );
      }
      const discovered = extractOpenAICodexModels(await response.json());
      for (const model of discovered) {
        if (!seen.has(model.id)) {
          seen.add(model.id);
          models.push(model);
        }
      }
    } catch (error) {
      api.logger.warn(
        `[tlon-hosting] OpenAI subscription model discovery failed for ${profileId}: ${errorMessage(
          error
        )}`
      );
    }
  }

  return models;
}

async function loadOAuthSubscriptionModels(
  api: OpenClawPluginApi,
  adapter: OAuthSubscriptionModelAdapter,
  agentDir: string
): Promise<SubscriptionModel[]> {
  const cfg = api.runtime.config.current() as OpenClawConfig;
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
    config: cfg,
  });
  const models: SubscriptionModel[] = [];
  const seen = new Set<string>();
  let hasOAuthProfile = false;

  for (const profileId of listProfilesForProvider(store, adapter.providerId)) {
    const credential = store.profiles[profileId];
    if (credential?.type !== 'oauth') {
      continue;
    }
    hasOAuthProfile = true;
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId,
        agentDir,
      });
      if (!resolved?.apiKey || resolved.profileType !== 'oauth') {
        continue;
      }
      const discovered = await adapter.discoverModels(resolved.apiKey);
      if (discovered.length > 0) {
        api.logger.info(
          `[tlon-hosting] ${adapter.displayName} OAuth model discovery returned ${discovered.length} model(s) for ${profileId}`
        );
      }
      for (const model of discovered) {
        if (!seen.has(model.id)) {
          seen.add(model.id);
          models.push(model);
        }
      }
    } catch (error) {
      api.logger.warn(
        `[tlon-hosting] ${adapter.displayName} OAuth model discovery failed for ${profileId}: ${errorMessage(
          error
        )}`
      );
    }
  }

  if (models.length === 0 && hasOAuthProfile) {
    api.logger.warn(
      `[tlon-hosting] ${adapter.displayName} OAuth is connected but exposed no selectable models`
    );
  }
  return models;
}

const xaiOAuthModelAdapter: OAuthSubscriptionModelAdapter = {
  providerId: 'xai',
  displayName: 'xAI',
  discoverModels: fetchXaiOAuthSubscriptionModels,
};

async function loadSubscriptionModelCatalog(
  api: OpenClawPluginApi,
  agentDir: string
): Promise<SubscriptionModelCatalog> {
  const [openai, xai, gatewayResult] = await Promise.all([
    loadOpenAISubscriptionModels(api, agentDir),
    loadOAuthSubscriptionModels(api, xaiOAuthModelAdapter, agentDir),
    api.runtime.gateway
      .request('models.list', { view: 'all' })
      .catch((error: unknown) => {
        api.logger.warn(
          `[tlon-hosting] Anthropic subscription model catalog load failed: ${errorMessage(
            error
          )}`
        );
        return {};
      }),
  ]);
  const gatewayCatalog = extractSubscriptionModels(gatewayResult);
  return {
    openai,
    anthropic: gatewayCatalog.anthropic ?? [],
    xai,
  };
}

function includeDetectedAuthFailures(
  api: OpenClawPluginApi,
  value: unknown,
  agentDir: string
): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result = value as {
    providers?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(result.providers)) {
    return value;
  }

  const cfg = api.runtime.config.current() as OpenClawConfig;
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
    config: cfg,
  });
  const authFailureReasons = new Set([
    'auth',
    'auth_permanent',
    'session_expired',
  ]);

  return {
    ...result,
    providers: result.providers.map((provider) => {
      const providerId =
        typeof provider.provider === 'string' ? provider.provider : '';
      const profiles = Array.isArray(provider.profiles)
        ? (provider.profiles as Array<Record<string, unknown>>)
        : [];
      const hasSubscriptionProfile = profiles.some((profile) => {
        if (providerId === 'openai' || providerId === 'xai') {
          return profile.type === 'oauth';
        }
        if (providerId === 'anthropic') {
          return profile.type === 'oauth' || profile.type === 'token';
        }
        return true;
      });
      const subscriptionStatus =
        (providerId === 'openai' ||
          providerId === 'anthropic' ||
          providerId === 'xai') &&
        !hasSubscriptionProfile
          ? { ...provider, status: 'missing', expiry: undefined }
          : provider;
      const hasDetectedFailure = listProfilesForProvider(
        store,
        providerId
      ).some((profileId) => {
        const credential = store.profiles[profileId];
        if (credential?.type !== 'oauth' && credential?.type !== 'token') {
          return false;
        }
        const usage = store.usageStats?.[profileId];
        return (
          authFailureReasons.has(usage?.disabledReason ?? '') ||
          authFailureReasons.has(usage?.cooldownReason ?? '')
        );
      });
      return hasDetectedFailure
        ? {
            ...subscriptionStatus,
            status: 'expired',
            reason: 'auth_failure',
          }
        : subscriptionStatus;
    }),
  };
}

function createFlow(provider: ProviderId, agentId: string): ProviderAuthFlow {
  const now = Date.now();
  const flow: ProviderAuthFlow = {
    id: randomUUID(),
    agentId,
    provider,
    status: provider === 'anthropic' ? 'awaiting_token' : 'awaiting_browser',
    createdAt: now,
    expiresAt: now + FLOW_TTL_MS,
  };
  flows.set(flow.id, flow);
  return flow;
}

export function registerProviderAuthRoutes(api: OpenClawPluginApi): boolean {
  api.registerHttpRoute({
    path: PROVIDER_AUTH_ROUTE,
    auth: 'gateway',
    match: 'prefix',
    gatewayRuntimeScopeSurface: 'trusted-operator',
    handler: async (req, res) => {
      pruneFlows();
      const url = new URL(req.url ?? PROVIDER_AUTH_ROUTE, 'http://localhost');
      const suffix = url.pathname.slice(PROVIDER_AUTH_ROUTE.length);

      try {
        if (req.method === 'GET' && suffix === '/health') {
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const scope = resolveProviderAuthAgentScope(
            cfg,
            url.searchParams.get('agentId')
          );
          writeJson(res, 200, {
            running: true,
            agentId: scope.agentId,
            accountId: scope.accountId,
          });
          return;
        }

        if (req.method === 'GET' && suffix === '/status') {
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const scope = resolveProviderAuthAgentScope(
            cfg,
            url.searchParams.get('agentId')
          );
          await refreshExpiredOAuthProfiles(api, scope.agentDir);
          // Refresh auth first so auth-dependent provider catalogs (notably
          // xAI OAuth) cannot race model discovery with stale credentials.
          const result = await requestAgentAuthState(api, scope);
          const subscriptionModels = await loadSubscriptionModelCatalog(
            api,
            scope.agentDir
          );
          const status = includeDetectedAuthFailures(
            api,
            result,
            scope.agentDir
          );
          writeJson(res, 200, {
            ...(status && typeof status === 'object' ? status : {}),
            subscriptionModels,
          });
          return;
        }

        if (req.method === 'POST' && suffix === '/sync') {
          const body = asRecord(await readJsonBody(req));
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const scope = resolveProviderAuthAgentScope(cfg, body.agentId);
          if (!isMonolithic(cfg)) {
            writeJson(res, 400, {
              error: 'provider auth sync is only available in monolithic mode',
            });
            return;
          }
          const managed = await syncManagedProviderApiKeys(
            api,
            scope,
            body.providerKeys
          );
          writeJson(res, 200, {
            agentId: scope.agentId,
            accountId: scope.accountId,
            profiles: managed.map(({ profileId, provider }) => ({
              profileId,
              provider,
            })),
          });
          return;
        }

        if (req.method === 'POST' && suffix === '/start') {
          const body = asRecord(await readJsonBody(req));
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const scope = resolveProviderAuthAgentScope(cfg, body.agentId);
          const provider = normalizeProvider(body.provider);
          if (!provider) {
            writeJson(res, 400, {
              error: 'provider must be openai, anthropic, or xai',
            });
            return;
          }

          const flow = createFlow(provider, scope.agentId);
          if (provider !== 'anthropic') {
            void runDeviceCodeFlow(api, flow.id, provider, scope.agentId);
            if (!flow.verificationUrl && flow.status === 'awaiting_browser') {
              await waitForFlowUpdate(flow.id);
            }
          }
          writeJson(res, 202, { flow: publicFlow(flow) });
          return;
        }

        if (req.method === 'GET' && suffix === '/flow') {
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const scope = resolveProviderAuthAgentScope(
            cfg,
            url.searchParams.get('agentId')
          );
          const flowId = url.searchParams.get('flowId');
          const flow = flowId ? flows.get(flowId) : undefined;
          if (!flow || flow.agentId !== scope.agentId) {
            writeJson(res, 404, { error: 'flow not found or expired' });
            return;
          }
          writeJson(res, 200, { flow: publicFlow(flow) });
          return;
        }

        if (req.method === 'POST' && suffix === '/complete') {
          const body = asRecord(await readJsonBody(req));
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const scope = resolveProviderAuthAgentScope(cfg, body.agentId);
          const flowId =
            typeof body.flowId === 'string' ? body.flowId.trim() : '';
          const token = typeof body.token === 'string' ? body.token.trim() : '';
          const flow = flows.get(flowId);
          if (
            !flow ||
            flow.provider !== 'anthropic' ||
            flow.agentId !== scope.agentId
          ) {
            writeJson(res, 404, { error: 'flow not found or expired' });
            return;
          }
          if (flow.status !== 'awaiting_token' && flow.status !== 'error') {
            writeJson(res, 409, {
              error: `flow cannot be completed while ${flow.status}`,
            });
            return;
          }
          if (!token) {
            writeJson(res, 400, { error: 'token is required' });
            return;
          }

          await runAnthropicFlow(api, flow.id, token, scope);
          const completedFlow = flows.get(flow.id) ?? flow;
          writeJson(res, completedFlow.status === 'complete' ? 200 : 400, {
            flow: publicFlow(completedFlow),
          });
          return;
        }

        if (req.method === 'DELETE' && suffix === '/provider') {
          const provider = normalizeProvider(url.searchParams.get('provider'));
          if (!provider) {
            writeJson(res, 400, {
              error: 'provider must be openai, anthropic, or xai',
            });
            return;
          }
          const cfg = api.runtime.config.current() as OpenClawConfig;
          const scope = resolveProviderAuthAgentScope(
            cfg,
            url.searchParams.get('agentId')
          );
          const store = ensureAuthProfileStore(scope.agentDir, {
            allowKeychainPrompt: false,
            config: cfg,
          });
          const removedProfiles = listProfilesForProvider(store, provider);
          const updated = await removeProviderAuthProfilesWithLock({
            provider,
            agentDir: scope.agentDir,
          });
          if (!updated) {
            throw new Error(
              'Failed to update the auth profile store; please try again'
            );
          }
          await refreshGatewayAuthState(api, scope.agentId);
          writeJson(res, 200, { provider, removedProfiles });
          return;
        }

        writeJson(res, 404, { error: 'not found' });
      } catch (error) {
        const message = errorMessage(error);
        const statusCode =
          message.includes('JSON') ||
          message.includes('request body') ||
          message.includes('too large') ||
          message.includes('agentId')
            ? 400
            : 500;
        writeJson(res, statusCode, { error: message });
      }
    },
  });

  api.logger.info(
    '[tlon-hosting] Provider auth routes registered (auth: gateway)'
  );
  return true;
}
