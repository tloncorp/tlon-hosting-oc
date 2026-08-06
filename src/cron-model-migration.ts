import {
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/plugin-runtime';
import {
  loadCronStore,
  resolveCronStorePath,
  saveCronStore,
} from 'openclaw/plugin-sdk/cron-store-runtime';

type JsonRecord = Record<string, unknown>;
type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;

export const LEGACY_HOSTED_CRON_MODEL =
  'openrouter/minimax/minimax-m2.7';
export const LOW_CREDIT_MODEL = 'openrouter/free';
export const RETIRED_HOSTED_MODEL_REFS: ReadonlySet<string> = new Set([
  'basic/minimax/minimax-m3',
  'minimax/minimax-m3',
  'openrouter/minimax/minimax-m3',
]);
export const HOSTED_MODEL_POLICY_REVISION = 'model-policy-v1';
export const CRON_MODEL_MIGRATION_MARKER =
  '.cron-model-migration-v1.json';

type CronStoreRuntime = {
  resolveStorePath: typeof resolveCronStorePath;
  loadStore: typeof loadCronStore;
  saveStore: typeof saveCronStore;
};

const OPENCLAW_CRON_STORE_RUNTIME: CronStoreRuntime = {
  resolveStorePath: resolveCronStorePath,
  loadStore: loadCronStore,
  saveStore: saveCronStore,
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function configuredPrimaryModel(config: unknown): string | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const model = defaults.model;
  if (typeof model === 'string') {
    return model.trim() || undefined;
  }
  if (isRecord(model) && typeof model.primary === 'string') {
    return model.primary.trim() || undefined;
  }
  return undefined;
}

function configuredCronStore(config: unknown): string | undefined {
  if (!isRecord(config) || !isRecord(config.cron)) {
    return undefined;
  }
  return typeof config.cron.store === 'string'
    ? config.cron.store.trim() || undefined
    : undefined;
}

function normalizedModelRef(model: string): string {
  return model.trim().toLowerCase();
}

function isLegacyHostedDefault(model: string): boolean {
  return normalizedModelRef(model) === LEGACY_HOSTED_CRON_MODEL;
}

function isRetiredHostedModel(model: string): boolean {
  return RETIRED_HOSTED_MODEL_REFS.has(normalizedModelRef(model));
}

function migrateFallbacks(
  value: unknown,
  currentPrimaryModel: string
): { changed: boolean; fallbacks: unknown[] } | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  let changed = false;
  const migratedFallbacks: unknown[] = [];
  for (const fallback of value) {
    if (typeof fallback === 'string' && isLegacyHostedDefault(fallback)) {
      changed = true;
      continue;
    }
    const migrated =
      typeof fallback === 'string' && isRetiredHostedModel(fallback)
        ? currentPrimaryModel
        : fallback;
    changed ||= migrated !== fallback;
    migratedFallbacks.push(migrated);
  }
  if (!changed) {
    return { changed: false, fallbacks: value };
  }

  const fallbacks: unknown[] = [];
  for (const fallback of migratedFallbacks) {
    if (!fallbacks.includes(fallback)) {
      fallbacks.push(fallback);
    }
  }
  return { changed, fallbacks };
}

function migrateCronPayload(
  payload: unknown,
  currentPrimaryModel: string
): boolean {
  if (!isRecord(payload) || payload.kind !== 'agentTurn') {
    return false;
  }

  let changed = false;
  if (typeof payload.model === 'string') {
    if (isLegacyHostedDefault(payload.model)) {
      delete payload.model;
      changed = true;
    } else if (isRetiredHostedModel(payload.model)) {
      payload.model = currentPrimaryModel;
      changed = true;
    }
  }

  const migratedFallbacks = migrateFallbacks(
    payload.fallbacks,
    currentPrimaryModel
  );
  if (migratedFallbacks?.changed) {
    payload.fallbacks = migratedFallbacks.fallbacks;
    changed = true;
  }
  return changed;
}

export function migrateCronStoreModelReferences(
  store: unknown,
  currentPrimaryModel: string
): string[] {
  if (!isRecord(store) || !Array.isArray(store.jobs)) {
    throw new Error('OpenClaw cron store has no jobs array');
  }

  const changedJobs: string[] = [];
  for (const job of store.jobs) {
    if (
      !isRecord(job) ||
      !migrateCronPayload(job.payload, currentPrimaryModel)
    ) {
      continue;
    }
    const jobId = String(job.id || job.name || '<unknown>').trim();
    changedJobs.push(jobId || '<unknown>');
  }
  return changedJobs;
}

export type CurrentCronModelMigrationResult =
  | { status: 'skipped' }
  | {
      status: 'completed' | 'completed-no-matches';
      changedJobs: string[];
      storePath: string;
    };

export async function migrateCurrentCronModels(params: {
  config: unknown;
  currentPrimaryModel?: string;
  logger: Logger;
  runtime?: CronStoreRuntime;
}): Promise<CurrentCronModelMigrationResult> {
  const currentPrimaryModel = params.currentPrimaryModel?.trim();
  if (
    !currentPrimaryModel ||
    isLegacyHostedDefault(currentPrimaryModel) ||
    isRetiredHostedModel(currentPrimaryModel) ||
    normalizedModelRef(currentPrimaryModel) === LOW_CREDIT_MODEL
  ) {
    return { status: 'skipped' };
  }

  const runtime = params.runtime ?? OPENCLAW_CRON_STORE_RUNTIME;
  let storePath: string;
  try {
    storePath = runtime.resolveStorePath(configuredCronStore(params.config));
    const store = await runtime.loadStore(storePath);
    const changedJobs = migrateCronStoreModelReferences(
      store,
      currentPrimaryModel
    );
    if (changedJobs.length === 0) {
      return {
        status: 'completed-no-matches',
        changedJobs,
        storePath,
      };
    }

    await runtime.saveStore(storePath, store);
    params.logger.info(
      JSON.stringify({
        event: 'tlon.model.policy.migrated',
        migrationSource: 'cron_store_runtime',
        policyRevision: HOSTED_MODEL_POLICY_REVISION,
        currentPrimaryModel,
        cronStorePath: storePath,
        migratedCurrentCronJobs: changedJobs.length,
        migratedCurrentCronJobIds: changedJobs.slice(0, 50),
      })
    );
    return { status: 'completed', changedJobs, storePath };
  } catch (error) {
    params.logger.warn(
      `[tlon-hosting] Failed to migrate current cron models: ${String(error)}`
    );
    return { status: 'skipped' };
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    });
}

async function assertNoSymlinks(root: string, path: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const suffix = relative(absoluteRoot, absolutePath);
  if (suffix.startsWith('..') || suffix === '') {
    if (suffix !== '') {
      throw new Error(`path escaped state directory: ${path}`);
    }
  }

  const parts = suffix ? suffix.split(/[\\/]/) : [];
  let candidate = absoluteRoot;
  for (const part of ['', ...parts]) {
    if (part) {
      candidate = join(candidate, part);
    }
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        throw new Error(`refusing symlink in path: ${candidate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function readJsonNoFollow(path: string): Promise<JsonRecord> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const file = await handle.stat();
    if (!file.isFile()) {
      throw new Error(`not a regular file: ${path}`);
    }
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!isRecord(parsed)) {
      throw new Error(`expected a JSON object: ${path}`);
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(
  path: string,
  value: JsonRecord,
  mode = 0o644
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function writeMarker(
  stateDir: string,
  currentPrimaryModel: string,
  cronStorePath: string,
  changedJobs: string[],
  status: string,
  now: number
): Promise<void> {
  await atomicWriteJson(join(stateDir, CRON_MODEL_MIGRATION_MARKER), {
    version: 1,
    status,
    completedAt: Math.floor(now / 1000),
    currentPrimaryModel,
    legacyModelOverrides: [LEGACY_HOSTED_CRON_MODEL],
    cronStorePath,
    changedJobCount: changedJobs.length,
    changedJobIds: changedJobs.slice(0, 50),
  });
}

export type CronModelMigrationResult =
  | { status: 'skipped' }
  | {
      status: 'completed' | 'completed-no-store' | 'completed-no-matches';
      changedJobs: string[];
      backupPath?: string;
    };

export async function migrateLegacyCronModels(params: {
  stateDir: string;
  currentPrimaryModel?: string;
  logger: Logger;
  now?: number;
}): Promise<CronModelMigrationResult> {
  const { stateDir, logger } = params;
  const currentPrimaryModel = params.currentPrimaryModel?.trim();
  if (
    !currentPrimaryModel ||
    currentPrimaryModel === LEGACY_HOSTED_CRON_MODEL ||
    currentPrimaryModel === LOW_CREDIT_MODEL
  ) {
    return { status: 'skipped' };
  }

  const markerPath = join(stateDir, CRON_MODEL_MIGRATION_MARKER);
  if (await pathExists(markerPath)) {
    return { status: 'skipped' };
  }

  const cronStorePath = join(stateDir, 'cron', 'jobs.json');
  try {
    await assertNoSymlinks(stateDir, cronStorePath);
  } catch (error) {
    logger.warn(
      `[tlon-hosting] Cron model migration skipped: ${String(error)}`
    );
    return { status: 'skipped' };
  }

  const now = params.now ?? Date.now();
  if (!(await pathExists(cronStorePath))) {
    await writeMarker(
      stateDir,
      currentPrimaryModel,
      cronStorePath,
      [],
      'completed-no-store',
      now
    );
    logger.info(
      `[tlon-hosting] Marked cron model migration complete; store does not exist at ${cronStorePath}`
    );
    return { status: 'completed-no-store', changedJobs: [] };
  }

  let store: JsonRecord;
  try {
    store = await readJsonNoFollow(cronStorePath);
  } catch (error) {
    logger.warn(
      `[tlon-hosting] Cron model migration skipped; failed to read ${cronStorePath}: ${String(error)}`
    );
    return { status: 'skipped' };
  }

  if (!Array.isArray(store.jobs)) {
    logger.warn(
      `[tlon-hosting] Cron model migration skipped; store has no jobs array: ${cronStorePath}`
    );
    return { status: 'skipped' };
  }

  const changedJobs: string[] = [];
  for (const job of store.jobs) {
    if (!isRecord(job) || !isRecord(job.payload)) {
      continue;
    }
    if (
      job.payload.kind !== 'agentTurn' ||
      typeof job.payload.model !== 'string' ||
      job.payload.model.trim() !== LEGACY_HOSTED_CRON_MODEL
    ) {
      continue;
    }
    delete job.payload.model;
    const jobId = String(job.id || job.name || '<unknown>').trim();
    changedJobs.push(jobId || '<unknown>');
  }

  if (changedJobs.length === 0) {
    await writeMarker(
      stateDir,
      currentPrimaryModel,
      cronStorePath,
      [],
      'completed-no-matches',
      now
    );
    logger.info(
      `[tlon-hosting] Marked cron model migration complete; no jobs used ${LEGACY_HOSTED_CRON_MODEL}`
    );
    return { status: 'completed-no-matches', changedJobs: [] };
  }

  const existing = await lstat(cronStorePath);
  if (!existing.isFile() || existing.isSymbolicLink()) {
    logger.warn(
      `[tlon-hosting] Cron model migration skipped; store is not a regular file: ${cronStorePath}`
    );
    return { status: 'skipped' };
  }

  const backupPath = `${cronStorePath}.bak-tlon-model-migration-${Math.floor(
    now / 1000
  )}-${process.pid}`;
  await copyFile(cronStorePath, backupPath, constants.COPYFILE_EXCL);
  try {
    await atomicWriteJson(cronStorePath, store, existing.mode & 0o777);
  } catch (error) {
    await rm(backupPath, { force: true });
    throw error;
  }
  await writeMarker(
    stateDir,
    currentPrimaryModel,
    cronStorePath,
    changedJobs,
    'completed',
    now
  );

  logger.info(
    `[tlon-hosting] Migrated ${changedJobs.length} cron job${
      changedJobs.length === 1 ? '' : 's'
    } from ${LEGACY_HOSTED_CRON_MODEL} to the inherited default ${currentPrimaryModel}; backup=${backupPath}`
  );
  return { status: 'completed', changedJobs, backupPath };
}

export function registerCronModelMigration(api: OpenClawPluginApi): void {
  api.registerService({
    id: 'tlon-hosting-cron-model-migration',
    start: async (context: OpenClawPluginServiceContext) => {
      const currentPrimaryModel = configuredPrimaryModel(context.config);
      try {
        await migrateLegacyCronModels({
          stateDir: context.stateDir,
          currentPrimaryModel,
          logger: context.logger,
        });
      } catch (error) {
        context.logger.warn(
          `[tlon-hosting] Failed to migrate legacy JSON cron models: ${String(error)}`
        );
      }
      await migrateCurrentCronModels({
        config: context.config,
        currentPrimaryModel,
        logger: context.logger,
      });
    },
  });
}
