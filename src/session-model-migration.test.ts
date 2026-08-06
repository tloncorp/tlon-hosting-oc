import type { SessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  migrateHostedSessionModels,
  registerSessionModelMigration,
} from './session-model-migration.js';

function createSessionStore(initial: Record<string, SessionEntry>) {
  const entries = structuredClone(initial);
  return {
    entries,
    runtime: {
      listSessionEntries: () =>
        Object.entries(entries).map(([sessionKey, entry]) => ({
          sessionKey,
          entry: structuredClone(entry),
        })),
      patchSessionEntry: async (params: {
        sessionKey: string;
        replaceEntry?: boolean;
        update: (
          entry: SessionEntry
        ) =>
          | Promise<Partial<SessionEntry> | null>
          | Partial<SessionEntry>
          | null;
      }) => {
        const existing = entries[params.sessionKey];
        if (!existing) {
          return null;
        }
        const patch = await params.update(structuredClone(existing));
        if (!patch) {
          return structuredClone(existing);
        }
        const next = params.replaceEntry
          ? (structuredClone(patch) as SessionEntry)
          : { ...existing, ...structuredClone(patch) };
        entries[params.sessionKey] = next;
        return structuredClone(next);
      },
    },
  };
}

describe('session model migration', () => {
  it('rewrites exact retired session pins without disturbing session identity or premium models', async () => {
    const store = createSessionStore({
      openrouter: {
        sessionId: 'one',
        sessionFile: 'one.jsonl',
        updatedAt: 1,
        providerOverride: 'openrouter',
        modelOverride: 'minimax/minimax-m3',
        modelOverrideSource: 'user',
        authProfileOverride: 'openrouter:custom',
        authProfileOverrideSource: 'user',
        modelProvider: 'openrouter',
        model: 'minimax/minimax-m3',
        contextTokens: 200000,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: 'pre-prompt-estimate',
          updatedAt: 1,
          provider: 'openrouter',
          model: 'minimax/minimax-m3',
          route: 'fits',
          shouldCompact: false,
          estimatedPromptTokens: 1000,
          contextTokenBudget: 200000,
          promptBudgetBeforeReserve: 190000,
          reserveTokens: 10000,
          effectiveReserveTokens: 10000,
          remainingPromptBudgetTokens: 189000,
          overflowTokens: 0,
          toolResultReducibleChars: 0,
          messageCount: 2,
          unwindowedMessageCount: 2,
        },
        fallbackNoticeSelectedModel: 'minimax/minimax-m3',
      },
      direct: {
        sessionId: 'two',
        updatedAt: 2,
        providerOverride: 'minimax',
        modelOverride: 'minimax-m3',
        authProfileOverride: 'minimax:default',
        authProfileOverrideSource: 'user',
      },
      premium: {
        sessionId: 'three',
        updatedAt: 3,
        providerOverride: 'anthropic',
        modelOverride: 'claude-opus-4-6',
        modelOverrideSource: 'user',
      },
    });

    const result = await migrateHostedSessionModels({
      stateDir: '/unused-in-memory-state',
      config: {
        agents: {
          defaults: { model: 'openrouter/openai/gpt-5.6-luna' },
          list: [{ id: 'main' }],
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      sessionStore: store.runtime,
    });

    expect(result.changedSessions).toBe(2);
    expect(store.entries.openrouter).toMatchObject({
      sessionId: 'one',
      sessionFile: 'one.jsonl',
      updatedAt: 1,
      providerOverride: 'openrouter',
      modelOverride: 'openai/gpt-5.6-luna',
      modelOverrideSource: 'user',
      authProfileOverride: 'openrouter:custom',
      authProfileOverrideSource: 'user',
    });
    expect(store.entries.openrouter).not.toHaveProperty('modelProvider');
    expect(store.entries.openrouter).not.toHaveProperty('model');
    expect(store.entries.openrouter).not.toHaveProperty('contextTokens');
    expect(store.entries.openrouter).not.toHaveProperty('contextBudgetStatus');
    expect(store.entries.openrouter).not.toHaveProperty(
      'fallbackNoticeSelectedModel'
    );
    expect(store.entries.direct).toMatchObject({
      sessionId: 'two',
      updatedAt: 2,
      providerOverride: 'openrouter',
      modelOverride: 'openai/gpt-5.6-luna',
      modelOverrideSource: 'user',
    });
    expect(store.entries.direct).not.toHaveProperty('authProfileOverride');
    expect(store.entries.direct).not.toHaveProperty(
      'authProfileOverrideSource'
    );
    expect(store.entries.premium).toMatchObject({
      providerOverride: 'anthropic',
      modelOverride: 'claude-opus-4-6',
      modelOverrideSource: 'user',
    });
  });

  it('clears Basic and stale automatic overrides while preserving current automatic state', async () => {
    const store = createSessionStore({
      basic: {
        sessionId: 'basic',
        updatedAt: 1,
        providerOverride: 'basic',
        modelOverride: 'historical-default',
        modelOverrideSource: 'user',
        authProfileOverride: 'basic:auto',
        authProfileOverrideSource: 'auto',
      },
      'auto-m3': {
        sessionId: 'auto-m3',
        updatedAt: 2,
        providerOverride: 'openrouter',
        modelOverride: 'deepseek/deepseek-v4-flash',
        modelOverrideSource: 'auto',
        modelOverrideFallbackOriginProvider: 'openrouter',
        modelOverrideFallbackOriginModel: 'minimax/minimax-m3',
        authProfileOverride: 'openrouter:fallback',
        authProfileOverrideSource: 'auto',
      },
      'stale-auto': {
        sessionId: 'stale-auto',
        updatedAt: 3,
        providerOverride: 'openrouter',
        modelOverride: 'deepseek/deepseek-v4-flash',
        modelOverrideSource: 'auto',
        modelOverrideFallbackOriginProvider: 'openrouter',
        modelOverrideFallbackOriginModel: 'openai/gpt-5.6-luna',
      },
      'current-auto': {
        sessionId: 'current-auto',
        updatedAt: 4,
        providerOverride: 'openrouter',
        modelOverride: 'deepseek/deepseek-v4-flash',
        modelOverrideSource: 'auto',
        modelOverrideFallbackOriginProvider: 'openrouter',
        modelOverrideFallbackOriginModel: 'example/next-default',
      },
    });

    const result = await migrateHostedSessionModels({
      stateDir: '/unused-in-memory-state',
      config: {
        agents: {
          defaults: { model: 'openrouter/example/next-default' },
          list: [{ id: 'main' }],
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      sessionStore: store.runtime,
    });

    expect(result.changedSessions).toBe(3);
    for (const key of ['basic', 'auto-m3', 'stale-auto']) {
      expect(store.entries[key]).not.toHaveProperty('providerOverride');
      expect(store.entries[key]).not.toHaveProperty('modelOverride');
      expect(store.entries[key]).not.toHaveProperty('modelOverrideSource');
      expect(store.entries[key]).not.toHaveProperty(
        'modelOverrideFallbackOriginProvider'
      );
      expect(store.entries[key]).not.toHaveProperty(
        'modelOverrideFallbackOriginModel'
      );
    }
    expect(store.entries.basic).not.toHaveProperty('authProfileOverride');
    expect(store.entries['auto-m3']).not.toHaveProperty('authProfileOverride');
    expect(store.entries['current-auto']).toMatchObject({
      providerOverride: 'openrouter',
      modelOverride: 'deepseek/deepseek-v4-flash',
      modelOverrideSource: 'auto',
      modelOverrideFallbackOriginProvider: 'openrouter',
      modelOverrideFallbackOriginModel: 'example/next-default',
    });
  });

  it('registers an awaited OpenClaw service', () => {
    const registerService = vi.fn();

    registerSessionModelMigration({ registerService } as never);

    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tlon-hosting-session-model-migration',
        start: expect.any(Function),
      })
    );
  });
});
