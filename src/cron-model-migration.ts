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

type JsonRecord = Record<string, unknown>;
type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;

export const LEGACY_HOSTED_CRON_MODEL =
  'openrouter/minimax/minimax-m2.7';
export const LOW_CREDIT_MODEL = 'openrouter/free';
export const CRON_MODEL_MIGRATION_MARKER =
  '.cron-model-migration-v1.json';

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
      try {
        await migrateLegacyCronModels({
          stateDir: context.stateDir,
          currentPrimaryModel: configuredPrimaryModel(context.config),
          logger: context.logger,
        });
      } catch (error) {
        context.logger.warn(
          `[tlon-hosting] Failed to migrate legacy cron models: ${String(error)}`
        );
      }
    },
  });
}
