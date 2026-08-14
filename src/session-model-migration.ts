import {
  listSessionEntries,
  patchSessionEntry,
  type SessionEntry,
} from 'openclaw/plugin-sdk/session-store-runtime';
import { resolveAgentEffectiveModelPrimary } from 'openclaw/plugin-sdk/agent-runtime';
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/plugin-runtime';

import {
  BASIC_PROVIDER,
  HOSTED_DEFAULT_PROVIDER,
  normalizeModelRef,
  RETIRED_HOSTED_MODEL_REFS,
} from './hosted-model-policy.js';

type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
type SessionStoreRuntime = {
  listSessionEntries: (params: {
    agentId: string;
    env: NodeJS.ProcessEnv;
  }) => Array<{ sessionKey: string; entry: SessionEntry }>;
  patchSessionEntry: (params: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionKey: string;
    replaceEntry: boolean;
    update: (
      entry: SessionEntry
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  }) => Promise<SessionEntry | null>;
};

const SESSION_MODEL_RUNTIME_FIELDS: ReadonlyArray<keyof SessionEntry> = [
  'modelProvider',
  'model',
  'contextTokens',
  'contextBudgetStatus',
  'fallbackNoticeSelectedModel',
  'fallbackNoticeActiveModel',
  'fallbackNoticeReason',
  'liveModelSwitchPending',
];

const SESSION_MODEL_OVERRIDE_FIELDS: ReadonlyArray<keyof SessionEntry> = [
  'providerOverride',
  'modelOverride',
  'modelOverrideSource',
  'modelOverrideFallbackOriginProvider',
  'modelOverrideFallbackOriginModel',
];

function modelFieldsUseRetiredModel(
  entry: SessionEntry,
  providerField: 'providerOverride' | 'modelOverrideFallbackOriginProvider',
  modelField: 'modelOverride' | 'modelOverrideFallbackOriginModel'
): boolean {
  const provider = normalizeModelRef(entry[providerField]);
  const model = normalizeModelRef(entry[modelField]);
  if (!model) {
    return false;
  }
  return (
    RETIRED_HOSTED_MODEL_REFS.has(model) ||
    (provider !== '' && RETIRED_HOSTED_MODEL_REFS.has(`${provider}/${model}`))
  );
}

function sessionUsesRetiredModel(entry: SessionEntry): boolean {
  return modelFieldsUseRetiredModel(entry, 'providerOverride', 'modelOverride');
}

function sessionHasRetiredFallbackOrigin(entry: SessionEntry): boolean {
  return modelFieldsUseRetiredModel(
    entry,
    'modelOverrideFallbackOriginProvider',
    'modelOverrideFallbackOriginModel'
  );
}

function sessionUsesBasicOverride(entry: SessionEntry): boolean {
  const provider = normalizeModelRef(entry.providerOverride);
  const model = normalizeModelRef(entry.modelOverride);
  return provider === BASIC_PROVIDER || model.startsWith(`${BASIC_PROVIDER}/`);
}

function sessionHasAutomaticModelOverride(entry: SessionEntry): boolean {
  const source = normalizeModelRef(entry.modelOverrideSource);
  if (source === 'auto') {
    return true;
  }
  if (source) {
    return false;
  }
  const hasOverride = Boolean(
    normalizeModelRef(entry.providerOverride) ||
      normalizeModelRef(entry.modelOverride)
  );
  const hasFallbackOrigin = Boolean(
    normalizeModelRef(entry.modelOverrideFallbackOriginProvider) &&
      normalizeModelRef(entry.modelOverrideFallbackOriginModel)
  );
  return hasOverride && hasFallbackOrigin;
}

function sessionFallbackOriginRef(entry: SessionEntry): string | undefined {
  const provider = String(
    entry.modelOverrideFallbackOriginProvider ?? ''
  ).trim();
  const model = String(entry.modelOverrideFallbackOriginModel ?? '').trim();
  if (!model) {
    return undefined;
  }
  return provider ? `${provider}/${model}` : model;
}

function sessionHasStaleAutomaticOverride(
  entry: SessionEntry,
  currentPrimaryModel: string | undefined
): boolean {
  if (!sessionHasAutomaticModelOverride(entry)) {
    return false;
  }
  if (
    sessionUsesRetiredModel(entry) ||
    sessionHasRetiredFallbackOrigin(entry)
  ) {
    return true;
  }
  const fallbackOrigin = sessionFallbackOriginRef(entry);
  return Boolean(
    fallbackOrigin &&
      currentPrimaryModel &&
      normalizeModelRef(fallbackOrigin) !==
        normalizeModelRef(currentPrimaryModel)
  );
}

function deleteFields(
  entry: SessionEntry,
  fields: ReadonlyArray<keyof SessionEntry>
): void {
  for (const field of fields) {
    delete entry[field];
  }
}

function clearSessionModelRuntimeCache(entry: SessionEntry): void {
  deleteFields(entry, SESSION_MODEL_RUNTIME_FIELDS);
}

function clearSessionModelOverride(entry: SessionEntry): void {
  deleteFields(entry, SESSION_MODEL_OVERRIDE_FIELDS);
  const authSource = normalizeModelRef(entry.authProfileOverrideSource);
  const recoveredAutomaticAuth =
    !authSource && entry.authProfileOverrideCompactionCount !== undefined;
  if (authSource === 'auto' || recoveredAutomaticAuth) {
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
  }
  clearSessionModelRuntimeCache(entry);
}

export function migrateHostedSessionEntry(
  entry: SessionEntry,
  currentPrimaryModel: string | undefined
): SessionEntry | null {
  const migrated = { ...entry };
  const usesRetiredModel = sessionUsesRetiredModel(migrated);

  // Basic and automatic selections follow the configured default. Removing
  // their concrete override lets OpenClaw resolve that default on the next turn.
  if (
    sessionUsesBasicOverride(migrated) ||
    sessionHasStaleAutomaticOverride(migrated, currentPrimaryModel)
  ) {
    clearSessionModelOverride(migrated);
    return migrated;
  }
  if (!usesRetiredModel) {
    return null;
  }

  // Retired pins are cleared rather than rewritten to a replacement model so
  // the session follows the configured default from the next turn onward.
  const previousProvider = normalizeModelRef(migrated.providerOverride);
  clearSessionModelOverride(migrated);
  if (
    previousProvider !== '' &&
    previousProvider !== BASIC_PROVIDER &&
    previousProvider !== HOSTED_DEFAULT_PROVIDER
  ) {
    delete migrated.authProfileOverride;
    delete migrated.authProfileOverrideSource;
    delete migrated.authProfileOverrideCompactionCount;
  }
  return migrated;
}

function configuredAgentIds(
  config: OpenClawPluginServiceContext['config']
): string[] {
  const ids = new Set<string>();
  for (const agent of config.agents?.list ?? []) {
    const id = agent.id?.trim();
    if (id) {
      ids.add(id);
    }
  }
  if (ids.size === 0) {
    ids.add('main');
  }
  return [...ids];
}

export type SessionModelMigrationResult = {
  changedSessions: number;
};

export async function migrateHostedSessionModels(params: {
  stateDir: string;
  config: OpenClawPluginServiceContext['config'];
  logger: Logger;
  sessionStore?: SessionStoreRuntime;
}): Promise<SessionModelMigrationResult> {
  const { config, logger, stateDir } = params;
  const sessionStore: SessionStoreRuntime = params.sessionStore ?? {
    listSessionEntries: (options) => listSessionEntries(options),
    patchSessionEntry: (options) => patchSessionEntry(options),
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  };
  let changedSessions = 0;

  for (const agentId of configuredAgentIds(config)) {
    const currentPrimaryModel = resolveAgentEffectiveModelPrimary(
      config,
      agentId
    );
    let sessions;
    try {
      sessions = sessionStore.listSessionEntries({ agentId, env });
    } catch (error) {
      logger.warn(
        `[tlon-hosting] Session model migration skipped agent ${agentId}: ${String(error)}`
      );
      continue;
    }

    for (const { sessionKey } of sessions) {
      try {
        let changed = false;
        await sessionStore.patchSessionEntry({
          agentId,
          env,
          sessionKey,
          replaceEntry: true,
          update: (entry) => {
            const migrated = migrateHostedSessionEntry(
              entry,
              currentPrimaryModel
            );
            changed = migrated !== null;
            return migrated;
          },
        });
        if (changed) {
          changedSessions += 1;
        }
      } catch (error) {
        logger.warn(
          `[tlon-hosting] Session model migration skipped ${agentId}/${sessionKey}: ${String(error)}`
        );
      }
    }
  }

  if (changedSessions > 0) {
    logger.info(
      `[tlon-hosting] Migrated ${changedSessions} hosted session model selection${
        changedSessions === 1 ? '' : 's'
      }; retired model selections now follow the configured default`
    );
  }
  return { changedSessions };
}

export function registerSessionModelMigration(api: OpenClawPluginApi): void {
  api.registerService({
    id: 'tlon-hosting-session-model-migration',
    start: async (context: OpenClawPluginServiceContext) => {
      try {
        await migrateHostedSessionModels({
          stateDir: context.stateDir,
          config: context.config,
          logger: context.logger,
        });
      } catch (error) {
        context.logger.warn(
          `[tlon-hosting] Failed to migrate hosted session models: ${String(error)}`
        );
      }
    },
  });
}
