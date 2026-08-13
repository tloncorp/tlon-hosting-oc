import { describe, expect, it, vi } from 'vitest';

import {
  buildGeneratedProviderCatalog,
  extractOpenAICodexModels,
  extractSubscriptionModels,
  extractXaiOAuthModels,
  fetchXaiOAuthSubscriptionModels,
  isManagedConfigLockPermissionError,
  loadFreshSubscriptionModels,
  parseDeviceCodeVerificationMessage,
  parseOpenAIVerificationMessage,
} from './provider-auth-routes.js';

describe('buildGeneratedProviderCatalog', () => {
  it('projects discovered models without inventing provider model ids', () => {
    expect(
      buildGeneratedProviderCatalog({
        providerId: 'example-oauth',
        ownerPluginId: 'example-plugin',
        baseUrl: 'https://models.example/v1',
        api: 'openai-responses',
        auth: 'oauth',
        models: [
          { id: 'account-model-a', name: 'Account Model A' },
          { id: 'account-model-b' },
        ],
      })
    ).toEqual({
      generatedBy: 'openclaw-plugin-model-catalog-v1',
      providers: {
        'example-oauth': {
          baseUrl: 'https://models.example/v1',
          api: 'openai-responses',
          auth: 'oauth',
          models: [
            { id: 'account-model-a', name: 'Account Model A' },
            { id: 'account-model-b' },
          ],
        },
      },
    });
  });

  it('preserves other providers in the owning plugin catalog', () => {
    expect(
      buildGeneratedProviderCatalog(
        {
          providerId: 'next-oauth',
          ownerPluginId: 'shared-plugin',
          baseUrl: 'https://next.example/v1',
          api: 'openai-responses',
          auth: 'oauth',
          models: [{ id: 'next-account-model' }],
        },
        {
          generatedBy: 'openclaw-plugin-model-catalog-v1',
          providers: {
            'existing-oauth': {
              baseUrl: 'https://existing.example/v1',
              api: 'openai-responses',
              auth: 'oauth',
              models: [{ id: 'existing-account-model' }],
            },
          },
        }
      )
    ).toMatchObject({
      providers: {
        'existing-oauth': {
          models: [{ id: 'existing-account-model' }],
        },
        'next-oauth': {
          models: [{ id: 'next-account-model' }],
        },
      },
    });
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

describe('loadFreshSubscriptionModels', () => {
  it('bypasses the pre-login catalog cache for auth-dependent providers', async () => {
    const config = { plugins: { allow: ['xai'] } };
    const loadCatalog = vi.fn(async () => [
      {
        provider: 'xai',
        id: 'grok-account-model',
        name: 'Grok Account Model',
        api: 'openai-responses',
      },
    ]);
    const api = {
      runtime: { config: { current: () => config } },
      logger: { warn: vi.fn() },
    };

    await expect(
      loadFreshSubscriptionModels(api as never, loadCatalog as never)
    ).resolves.toEqual({
      openai: [],
      anthropic: [],
      xai: [{ id: 'grok-account-model', name: 'Grok Account Model' }],
    });
    expect(loadCatalog).toHaveBeenCalledWith({
      config,
      readOnly: false,
      useCache: false,
    });
  });

  it('logs discovery failures and returns an empty catalog', async () => {
    const warn = vi.fn();
    const api = {
      runtime: { config: { current: () => ({}) } },
      logger: { warn },
    };

    await expect(
      loadFreshSubscriptionModels(
        api as never,
        vi.fn(async () => {
          throw new Error('discovery unavailable');
        }) as never
      )
    ).resolves.toEqual({ openai: [], anthropic: [], xai: [] });
    expect(warn).toHaveBeenCalledWith(
      '[tlon-hosting] Subscription model catalog load failed: discovery unavailable'
    );
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
    'URL: https://accounts.x.ai/oauth2/device',
  ])('rejects an invalid or incomplete xAI handoff: %s', (message) => {
    expect(parseDeviceCodeVerificationMessage('xai', message)).toBeNull();
  });
});
