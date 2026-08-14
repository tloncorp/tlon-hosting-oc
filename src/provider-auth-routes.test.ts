import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  extractOpenAICodexModels,
  extractSubscriptionModels,
  extractXaiOAuthModels,
  fetchXaiOAuthSubscriptionModels,
  isManagedConfigLockPermissionError,
  parseDeviceCodeVerificationMessage,
  parseOpenAIVerificationMessage,
  normalizeManagedProviderApiKeys,
  registerProviderAuthRoutes,
  resolveProviderAuthAgentScope,
} from './provider-auth-routes.js';

function makeRequest(method: string, url: string, body?: unknown) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) {
        yield Buffer.from(JSON.stringify(body));
      }
    },
  } as unknown as IncomingMessage;
}

function makeResponse() {
  let payload: unknown;
  const response = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      payload = body ? JSON.parse(body) : undefined;
    }),
  } as unknown as ServerResponse;
  return { response, payload: () => payload };
}

function makeMonolithicRouteApi() {
  const config = {
    channels: {
      tlon: {
        deploymentMode: 'monolithic',
        accounts: {
          alpha: { ship: '~alpha' },
          beta: { ship: '~beta' },
        },
      },
    },
    agents: {
      list: [
        { id: 'main' },
        { id: 'tenant-alpha', agentDir: '/data/agents/tenant-alpha' },
        { id: 'tenant-beta', agentDir: '/data/agents/tenant-beta' },
      ],
    },
    bindings: [
      {
        agentId: 'tenant-alpha',
        match: { channel: 'tlon', accountId: 'alpha' },
      },
      {
        agentId: 'tenant-beta',
        match: { channel: 'tlon', accountId: 'beta' },
      },
    ],
  };
  let handler:
    | ((req: IncomingMessage, res: ServerResponse) => Promise<void> | void)
    | undefined;
  const api = {
    logger: { info: vi.fn(), warn: vi.fn() },
    registerHttpRoute: (route: { handler: typeof handler }) => {
      handler = route.handler;
    },
    runtime: { config: { current: () => config } },
  } as unknown as OpenClawPluginApi;
  registerProviderAuthRoutes(api);
  if (!handler) {
    throw new Error('provider auth handler was not registered');
  }
  return handler;
}

describe('resolveProviderAuthAgentScope', () => {
  it('preserves default-agent behavior for standalone self-hosters', () => {
    const scope = resolveProviderAuthAgentScope({});
    expect(scope.agentId).toBe('main');
    expect(scope.isDefault).toBe(true);
  });

  it('requires an explicit configured agent in monolithic mode', () => {
    const config = {
      channels: {
        tlon: {
          deploymentMode: 'monolithic',
          accounts: { alpha: { ship: '~alpha' } },
        },
      },
      agents: {
        list: [
          { id: 'main' },
          { id: 'tenant-alpha', agentDir: '/data/agents/tenant-alpha' },
        ],
      },
      bindings: [
        {
          agentId: 'tenant-alpha',
          match: { channel: 'tlon', accountId: 'alpha' },
        },
      ],
    };

    expect(() => resolveProviderAuthAgentScope(config)).toThrow(
      /agentId is required/
    );
    expect(resolveProviderAuthAgentScope(config, 'tenant-alpha')).toMatchObject(
      {
        agentId: 'tenant-alpha',
        accountId: 'alpha',
        agentDir: '/data/agents/tenant-alpha',
        isDefault: false,
      }
    );
    expect(() => resolveProviderAuthAgentScope(config, 'missing')).toThrow(
      /not configured/
    );
    expect(() => resolveProviderAuthAgentScope(config, 'main')).toThrow(
      /exactly one Tlon account binding/
    );
  });
});

describe('monolithic provider-auth routes', () => {
  it('reports health only for an exactly bound tenant agent', async () => {
    const handler = makeMonolithicRouteApi();
    const alpha = makeResponse();
    await handler(
      makeRequest('GET', '/tlon/provider-auth/health?agentId=tenant-alpha'),
      alpha.response
    );
    expect(alpha.response.statusCode).toBe(200);
    expect(alpha.payload()).toEqual({
      running: true,
      agentId: 'tenant-alpha',
      accountId: 'alpha',
    });

    const unbound = makeResponse();
    await handler(
      makeRequest('GET', '/tlon/provider-auth/health?agentId=main'),
      unbound.response
    );
    expect(unbound.response.statusCode).toBe(400);
  });

  it('does not expose one tenant provider flow to another tenant', async () => {
    const handler = makeMonolithicRouteApi();
    const started = makeResponse();
    await handler(
      makeRequest('POST', '/tlon/provider-auth/start', {
        agentId: 'tenant-alpha',
        provider: 'anthropic',
      }),
      started.response
    );
    expect(started.response.statusCode).toBe(202);
    const flowId = (started.payload() as { flow: { id: string } }).flow.id;

    const beta = makeResponse();
    await handler(
      makeRequest(
        'GET',
        `/tlon/provider-auth/flow?agentId=tenant-beta&flowId=${flowId}`
      ),
      beta.response
    );
    expect(beta.response.statusCode).toBe(404);

    const alpha = makeResponse();
    await handler(
      makeRequest(
        'GET',
        `/tlon/provider-auth/flow?agentId=tenant-alpha&flowId=${flowId}`
      ),
      alpha.response
    );
    expect(alpha.response.statusCode).toBe(200);
    expect(alpha.payload()).toMatchObject({
      flow: { id: flowId, agentId: 'tenant-alpha' },
    });
  });
});

describe('normalizeManagedProviderApiKeys', () => {
  it('maps the hosted basic key to OpenRouter and ignores non-LLM keys', () => {
    expect(
      normalizeManagedProviderApiKeys({
        basic: 'tenant-key',
        brave: 'search-key',
        anthropic: 'anthropic-key',
      })
    ).toEqual([
      {
        profileId: 'basic:default',
        provider: 'openrouter',
        key: 'tenant-key',
      },
      {
        profileId: 'anthropic:default',
        provider: 'anthropic',
        key: 'anthropic-key',
      },
    ]);
  });

  it('does not return empty or placeholder credentials', () => {
    expect(
      normalizeManagedProviderApiKeys({ basic: 'not-set', openai: '  ' })
    ).toEqual([]);
  });
});

describe('extractSubscriptionModels', () => {
  it('keeps available subscription-compatible models separate by provider', () => {
    expect(
      extractSubscriptionModels({
        models: [
          {
            provider: 'openai',
            id: 'gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            api: 'openai-chatgpt-responses',
            available: true,
          },
          {
            provider: 'openai',
            id: 'gpt-5.6',
            name: 'GPT-5.6',
            api: 'openai-responses',
            available: true,
          },
          {
            provider: 'openai',
            id: 'gpt-5.6-luna',
            name: 'GPT-5.6 Luna API',
            api: 'openai-responses',
            available: true,
          },
          {
            provider: 'anthropic',
            id: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
            api: 'anthropic-messages',
            available: true,
          },
          {
            provider: 'anthropic',
            id: 'claude-opus-4-8',
            name: 'Claude Opus 4.8',
            api: 'anthropic-messages',
            available: false,
          },
          {
            provider: 'xai',
            id: 'grok-account-model',
            name: 'Grok Account Model',
            api: 'openai-responses',
            available: true,
          },
        ],
      })
    ).toEqual({
      openai: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
      anthropic: [
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      ],
      xai: [{ id: 'grok-account-model', name: 'Grok Account Model' }],
    });
  });

  it('accepts the normalized models.list key projection', () => {
    expect(
      extractSubscriptionModels({
        models: [
          {
            key: 'openai/gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            available: true,
          },
          {
            key: 'openai/gpt-5.3-chat-latest',
            name: 'GPT-5.3 Chat',
            available: true,
          },
          {
            key: 'anthropic/claude-sonnet-5',
            name: 'Claude Sonnet 5',
          },
          {
            key: 'xai/grok-account-model',
            name: 'Grok Account Model',
          },
        ],
      })
    ).toEqual({
      openai: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
      anthropic: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
      xai: [{ id: 'grok-account-model', name: 'Grok Account Model' }],
    });
  });

  it('deduplicates model ids and ignores malformed catalog rows', () => {
    expect(
      extractSubscriptionModels({
        models: [
          {
            provider: 'openai',
            id: 'gpt-5.6-luna',
            api: 'openai-chatgpt-responses',
            available: true,
          },
          {
            provider: 'openai',
            id: 'gpt-5.6-luna',
            name: 'Duplicate',
            api: 'openai-chatgpt-responses',
            available: true,
          },
          null,
          { provider: 'anthropic', id: '', available: true },
        ],
      })
    ).toEqual({
      openai: [{ id: 'gpt-5.6-luna' }],
      anthropic: [],
      xai: [],
    });
  });
});

describe('extractXaiOAuthModels', () => {
  it('returns chat-capable models from xAI OAuth discovery', () => {
    expect(
      extractXaiOAuthModels([
        {
          id: 'grok-account-model',
          name: 'Grok Account Model',
          api_backend: 'responses',
        },
        { model: 'grok-code-fast-1', backend: 'chat' },
        { id: 'grok-imagine-image' },
        { id: 'grok-4.20-multi-agent', backend: 'language' },
        { id: 'grok-voice', backend: 'audio' },
      ])
    ).toEqual([
      { id: 'grok-account-model', name: 'Grok Account Model' },
      { id: 'grok-code-fast-1' },
    ]);
  });

  it('accepts the OpenAI-compatible data envelope and deduplicates ids', () => {
    expect(
      extractXaiOAuthModels({
        data: [
          { id: 'grok-account-model', object: 'model' },
          { id: 'grok-account-model', name: 'Duplicate' },
          null,
        ],
      })
    ).toEqual([{ id: 'grok-account-model' }]);
  });
});

describe('fetchXaiOAuthSubscriptionModels', () => {
  it('loads the account model list directly with the OAuth access token', async () => {
    const loadRows = vi.fn(async () => [
      { id: 'grok-account-model', name: 'Grok Account Model' },
    ]);

    await expect(
      fetchXaiOAuthSubscriptionModels('oauth-access-token', loadRows as never)
    ).resolves.toEqual([
      { id: 'grok-account-model', name: 'Grok Account Model' },
    ]);
    expect(loadRows).toHaveBeenCalledWith({
      providerId: 'xai',
      endpoint: 'https://cli-chat-proxy.grok.com/v1/models',
      discoveryApiKey: 'oauth-access-token',
      timeoutMs: 10_000,
      auditContext: 'tlon-xai-oauth-model-discovery',
    });
  });
});

describe('extractOpenAICodexModels', () => {
  it('returns only models exposed in the account picker', () => {
    expect(
      extractOpenAICodexModels({
        models: [
          {
            slug: 'gpt-5.6-luna',
            display_name: 'GPT-5.6 Luna',
            visibility: 'list',
            show_in_picker: true,
          },
          {
            id: 'gpt-5.6-sol',
            name: 'GPT-5.6 Sol',
            visibility: 'list',
          },
          {
            slug: 'hidden-model',
            visibility: 'hide',
          },
          {
            slug: 'disabled-model',
            visibility: 'list',
            show_in_picker: false,
          },
        ],
      })
    ).toEqual([
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ]);
  });

  it('deduplicates model ids and ignores malformed rows', () => {
    expect(
      extractOpenAICodexModels({
        models: [
          { slug: 'gpt-5.6-luna' },
          { id: 'gpt-5.6-luna', name: 'Duplicate' },
          { slug: '' },
          null,
        ],
      })
    ).toEqual([{ id: 'gpt-5.6-luna' }]);
  });
});

describe('isManagedConfigLockPermissionError', () => {
  it('recognizes the root-managed config lock failure', () => {
    expect(
      isManagedConfigLockPermissionError(
        new Error(
          "EACCES: permission denied, open '/opt/openclaw-managed/moon/openclaw.json.lock'"
        )
      )
    ).toBe(true);
  });

  it.each([
    "EACCES: permission denied, open '/pier/moon/auth-profiles.json.lock'",
    "ENOENT: no such file, open '/opt/openclaw-managed/moon/openclaw.json.lock'",
    'OpenAI device authorization expired',
  ])('does not swallow a different auth failure: %s', (message) => {
    expect(isManagedConfigLockPermissionError(new Error(message))).toBe(false);
  });
});

describe('parseOpenAIVerificationMessage', () => {
  it('extracts the OpenAI device URL and one-time code', () => {
    expect(
      parseOpenAIVerificationMessage(
        [
          'Open this URL in your browser.',
          'URL: https://auth.openai.com/codex/device',
          'Code: ABCD-EFGH',
        ].join('\n')
      )
    ).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
  });

  it.each([
    'URL: http://auth.openai.com/codex/device\nCode: ABCD-EFGH',
    'URL: https://evil.example/codex/device\nCode: ABCD-EFGH',
    'URL: https://auth.openai.com.evil.example/codex/device\nCode: ABCD-EFGH',
    'URL: https://auth.openai.com/codex/other\nCode: ABCD-EFGH',
    'URL: https://auth.openai.com/codex/device',
  ])('rejects an invalid or incomplete handoff: %s', (message) => {
    expect(parseOpenAIVerificationMessage(message)).toBeNull();
  });
});

describe('parseDeviceCodeVerificationMessage', () => {
  it('extracts the xAI device URL and one-time code', () => {
    expect(
      parseDeviceCodeVerificationMessage(
        'xai',
        [
          'Open this URL in your LOCAL browser and enter the code below.',
          'URL: https://accounts.x.ai/oauth2/device?user_code=ABCD-1234',
          'Code: ABCD-1234',
        ].join('\n')
      )
    ).toEqual({
      verificationUrl:
        'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234',
      userCode: 'ABCD-1234',
    });
  });

  it.each([
    'URL: http://accounts.x.ai/oauth2/device\nCode: ABCD-1234',
    'URL: https://accounts.x.ai.evil.example/oauth2/device\nCode: ABCD-1234',
    'URL: https://auth.x.ai/oauth2/device\nCode: ABCD-1234',
    'URL: https://accounts.x.ai/oauth2/other\nCode: ABCD-1234',
    'URL: https://accounts.x.ai/oauth2/device?user_code=WXYZ-9999\nCode: ABCD-1234',
    'URL: https://accounts.x.ai/oauth2/device',
  ])('rejects an invalid or incomplete xAI handoff: %s', (message) => {
    expect(parseDeviceCodeVerificationMessage('xai', message)).toBeNull();
  });
});
