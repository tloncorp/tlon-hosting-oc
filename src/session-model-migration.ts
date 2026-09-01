import {
  listSessionEntries,
  patchSessionEntry,
  type SessionEntry,
} from 'openclaw/plugin-sdk/session-store-runtime';
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/core';

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
  'fallbackNotice',
  'liveModelSwitchPending',
];

const SESSION_MODEL_OVERRIDE_FIELDS: ReadonlyArray<keyof SessionEntry> = [
  'providerOverride',
  'modelOverride',
  'modelOverrideSource',
  'modelOverrideFallbackOriginProvider',
  'modelOverrideFallbackOriginModel',
  'modelOverrideRouteResolution',
];

const SESSION_AUTH_PROFILE_OVERRIDE_FIELDS: ReadonlyArray<keyof SessionEntry> = [
  'authProfileOverride',
  'authProfileOverrideSource',
  'authProfileOverrideCompactionCount',
];

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
  deleteFields(entry, SESSION_AUTH_PROFILE_OVERRIDE_FIELDS);
  clearSessionModelRuntimeCache(entry);
}

export function migrateHostedSessionEntry(
  entry: SessionEntry
): SessionEntry | null {
  const hasModelOverride = SESSION_MODEL_OVERRIDE_FIELDS.some(field =>
    Object.hasOwn(entry, field)
  );
  if (!hasModelOverride) {
    return null;
  }

  // Hosted sessions always inherit their effective configured default. Remove
  // every concrete model and associated auth selection instead of copying the
  // current default into the session, so future default changes flow through.
  const migrated = { ...entry };
  clearSessionModelOverride(migrated);
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
            const migrated = migrateHostedSessionEntry(entry);
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
      }; sessions now follow their configured defaults`
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
