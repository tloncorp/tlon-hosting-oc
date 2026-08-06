import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

type JsonRecord = Record<string, unknown>;
type DeviceStore = Record<string, JsonRecord>;
type Logger = Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readStore(path: string): Promise<DeviceStore> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value)) {
      throw new Error('expected a JSON object');
    }
    if (!Object.values(value).every(isRecord)) {
      throw new Error('expected JSON object entries');
    }
    return value as DeviceStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeStore(path: string, value: DeviceStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await stat(path)
    .then(result => result.mode & 0o777)
    .catch(() => 0o600);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function repairCronScopeUpgrades(
  pendingStore: DeviceStore,
  pairedStore: DeviceStore,
  now = Date.now()
): { pending: DeviceStore; paired: DeviceStore; approved: number } {
  const pending = { ...pendingStore };
  const paired = { ...pairedStore };
  let approved = 0;

  for (const [requestId, request] of Object.entries(pendingStore)) {
    const scopes = Array.isArray(request.scopes) ? request.scopes : [];
    const deviceId =
      typeof request.deviceId === 'string' ? request.deviceId.trim() : '';
    if (
      !deviceId ||
      request.isRepair !== true ||
      request.requestedByTool !== 'cron' ||
      !scopes.includes('operator.admin')
    ) {
      continue;
    }

    const existing = paired[deviceId] ?? {};
    const existingTokens = isRecord(existing.tokens) ? existing.tokens : {};
    const operatorToken = isRecord(existingTokens.operator)
      ? existingTokens.operator
      : {};
    const {
      requestId: _requestId,
      isRepair: _isRepair,
      silent: _silent,
      ts: _ts,
      ...approvedRequest
    } = request;
    paired[deviceId] = {
      ...existing,
      ...approvedRequest,
      scopes: ['operator.admin'],
      approvedScopes: ['operator.admin'],
      approvedAtMs: now,
      createdAtMs: existing.createdAtMs ?? now,
      tokens: {
        operator: {
          ...operatorToken,
          scopes: ['operator.admin'],
        },
      },
    };
    delete pending[requestId];
    approved += 1;
  }

  return { pending, paired, approved };
}

export async function runCronScopeRepair(
  stateDir: string,
  logger: Logger
): Promise<void> {
  const devicesDir = join(stateDir, 'devices');
  const pendingPath = join(devicesDir, 'pending.json');
  const pairedPath = join(devicesDir, 'paired.json');
  try {
    const [pending, paired] = await Promise.all([
      readStore(pendingPath),
      readStore(pairedPath),
    ]);
    const repaired = repairCronScopeUpgrades(pending, paired);
    if (repaired.approved === 0) {
      return;
    }
    await writeStore(pairedPath, repaired.paired);
    await writeStore(pendingPath, repaired.pending);
    logger.info(
      `[tlon-hosting] Auto-approved ${repaired.approved} pending cron operator.admin scope upgrade${
        repaired.approved === 1 ? '' : 's'
      }`
    );
  } catch (error) {
    logger.warn(
      `[tlon-hosting] Failed to repair cron operator.admin scope: ${String(error)}`
    );
  }
}

export function registerCronScopeRepair(api: OpenClawPluginApi): void {
  api.registerService({
    id: 'tlon-hosting-cron-scope-repair',
    start: context => runCronScopeRepair(context.stateDir, context.logger),
  });
}
