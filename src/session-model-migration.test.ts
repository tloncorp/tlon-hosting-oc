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
  it('clears every session model pin without disturbing session identity', async () => {
    const store = createSessionStore({
      openrouter: {
        sessionId: 'one',
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
        fallbackNotice: {
          kind: 'active',
          selectedModel: 'minimax/minimax-m3',
          activeModel: 'anthropic/claude-opus-4-6',
        },
      },
      direct: {
        sessionId: 'two',
        updatedAt: 2,
        providerOverride: 'minimax',
        modelOverride: 'minimax-m3',
        authProfileOverride: 'minimax:default',
        authProfileOverrideSource: 'user',
      },
      'm2.5': {
        sessionId: 'm2.5',
        updatedAt: 3,
        providerOverride: 'openrouter',
        modelOverride: 'minimax/minimax-m2.5',
        modelOverrideSource: 'user',
      },
      'm2.7': {
        sessionId: 'm2.7',
        updatedAt: 4,
        providerOverride: 'minimax',
        modelOverride: 'minimax-m2.7',
        modelOverrideSource: 'user',
      },
      'm2.1': {
        sessionId: 'm2.1',
        updatedAt: 5,
        modelOverride: 'basic/minimax/minimax-m2.1',
        modelOverrideSource: 'user',
      },
      premium: {
        sessionId: 'three',
        updatedAt: 6,
        providerOverride: 'anthropic',
        modelOverride: 'claude-opus-4-6',
        modelOverrideSource: 'user',
        authProfileOverride: 'anthropic:custom',
        authProfileOverrideSource: 'user',
      },
      xai: {
        sessionId: 'four',
        updatedAt: 7,
        providerOverride: 'xai',
        modelOverride: 'grok-4.6',
        modelOverrideSource: 'user',
        authProfileOverride: 'xai:custom',
        authProfileOverrideSource: 'user',
        modelProvider: 'xai',
        model: 'grok-4.6',
      },
      inherited: {
        sessionId: 'five',
        updatedAt: 8,
        modelProvider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
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

    expect(result.changedSessions).toBe(7);
    expect(store.entries.openrouter).toMatchObject({
      sessionId: 'one',
      updatedAt: 1,
    });
    expect(store.entries.openrouter).not.toHaveProperty('providerOverride');
    expect(store.entries.openrouter).not.toHaveProperty('modelOverride');
    expect(store.entries.openrouter).not.toHaveProperty('modelOverrideSource');
    expect(store.entries.openrouter).not.toHaveProperty('modelProvider');
    expect(store.entries.openrouter).not.toHaveProperty('model');
    expect(store.entries.openrouter).not.toHaveProperty('contextTokens');
    expect(store.entries.openrouter).not.toHaveProperty('contextBudgetStatus');
    expect(store.entries.openrouter).not.toHaveProperty(
      'fallbackNotice'
    );
    for (const key of [
      'openrouter',
      'direct',
      'm2.1',
      'm2.5',
      'm2.7',
      'premium',
      'xai',
    ]) {
      expect(store.entries[key]).not.toHaveProperty('providerOverride');
      expect(store.entries[key]).not.toHaveProperty('modelOverride');
      expect(store.entries[key]).not.toHaveProperty('modelOverrideSource');
      expect(store.entries[key]).not.toHaveProperty('authProfileOverride');
      expect(store.entries[key]).not.toHaveProperty(
        'authProfileOverrideSource'
      );
    }
    expect(store.entries.inherited).toMatchObject({
      sessionId: 'five',
      updatedAt: 8,
      modelProvider: 'openrouter',
      model: 'openai/gpt-5.6-luna',
    });
  });

  it('clears every automatic override regardless of its fallback origin', async () => {
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

    expect(result.changedSessions).toBe(4);
    for (const key of ['basic', 'auto-m3', 'stale-auto', 'current-auto']) {
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
