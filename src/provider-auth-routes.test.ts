import { describe, expect, it, vi } from 'vitest';

import {
  extractOpenAICodexModels,
  extractSubscriptionModels,
  isManagedConfigLockPermissionError,
  loadFreshSubscriptionModels,
  parseDeviceCodeVerificationMessage,
  parseOpenAIVerificationMessage,
} from './provider-auth-routes.js';

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
            id: 'grok-4.6',
            name: 'Grok 4.6',
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
      xai: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
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
            key: 'xai/grok-4.6',
            name: 'Grok 4.6',
          },
        ],
      })
    ).toEqual({
      openai: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
      anthropic: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
      xai: [{ id: 'grok-4.6', name: 'Grok 4.6' }],
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
        id: 'grok-4.3',
        name: 'Grok 4.3',
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
      xai: [{ id: 'grok-4.3', name: 'Grok 4.3' }],
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
