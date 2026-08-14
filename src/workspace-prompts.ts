import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { extract } from 'tar';

const BLOCK_END = '<!-- /idempotency-marker -->';
const MARKER_PATTERN =
  /(?<marker><!-- idempotency-marker:[^\s]+ -->)\n(?<content>.*?)\n<!-- \/idempotency-marker -->/gs;
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SHIPS_PATH_PATTERN =
  /(\/usr\/local\/share\/openclaw\/skills\/tlon\/ships\/)~([a-z0-9-]+\.json)/g;
const TILDE_JSON_SEGMENT_PATTERN = /\/~([a-z0-9-]+\.json)/g;
const TLON_FLAGS_PATTERN =
  /tlon\s+--url\s+\S+\s+--ship\s+\S+\s+--code\s+\S+\s+([^\n`]+)/g;
const HEARTBEAT_PROMPT_NAME = 'HEARTBEAT.md';
const HEARTBEAT_MARKER_PREFIX = '<!-- idempotency-marker:tlon-heartbeat:';
const BOOT_PROMPT_NAME = 'BOOT.md';
const BOOT_MARKER_PREFIX = '<!-- idempotency-marker:tlon-boot:';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

type Logger = {
  info(message: string): void;
  warn(message: string): void;
};

type ShipConfig = {
  ship: string;
  url?: string;
};

export type WorkspacePromptTarget = {
  agentId: string;
  accountId: string | null;
  workspaceDir: string;
};

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function truthy(value: string | undefined): boolean {
  return Boolean(
    value && ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase())
  );
}

function heartbeatsDisabled(): boolean {
  const override = envValue('TLON_DISABLE_HEARTBEATS');
  return override === undefined || truthy(override);
}

function normalizeShip(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/^~/, '').toLowerCase();
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : undefined;
}

async function readJsonObject(
  path: string
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readShipConfig(path: string): Promise<ShipConfig | null> {
  const config = await readJsonObject(path);
  if (!config) {
    return null;
  }
  const ship =
    normalizeShip(config.ship) ?? normalizeShip(basename(path, '.json'));
  if (!ship) {
    return null;
  }
  const url =
    typeof config.url === 'string' && config.url.trim()
      ? config.url.trim()
      : undefined;
  return { ship: `~${ship}`, ...(url ? { url } : {}) };
}

async function loadKnownShipConfigs(): Promise<Map<string, ShipConfig>> {
  const configs = new Map<string, ShipConfig>();
  const skillDir = envValue('TLON_SKILL_DIR');
  if (!skillDir) {
    return configs;
  }

  const shipsDir = join(skillDir, 'ships');
  let entries;
  try {
    entries = await readdir(shipsDir, { withFileTypes: true });
  } catch {
    return configs;
  }

  for (const entry of [...entries].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.json') ||
      entry.name === 'example.json'
    ) {
      continue;
    }
    const config = await readShipConfig(join(shipsDir, entry.name));
    const ship = normalizeShip(config?.ship);
    if (config && ship) {
      configs.set(ship, config);
    }
  }
  return configs;
}

function configuredOwnerShip(
  config: OpenClawConfig,
  activeShip: string | undefined,
  accountId?: string | null
): string | undefined {
  const channels = config.channels as Record<string, unknown> | undefined;
  const tlon =
    channels?.tlon &&
    typeof channels.tlon === 'object' &&
    !Array.isArray(channels.tlon)
      ? (channels.tlon as Record<string, unknown>)
      : undefined;
  const accounts =
    tlon?.accounts &&
    typeof tlon.accounts === 'object' &&
    !Array.isArray(tlon.accounts)
      ? (tlon.accounts as Record<string, Record<string, unknown>>)
      : undefined;
  const account = accountId ? accounts?.[accountId] : undefined;
  const envOwner = accountId
    ? undefined
    : normalizeShip(envValue('TLON_OWNER_SHIP'));
  return (
    normalizeShip(account?.ownerShip) ??
    envOwner ??
    normalizeShip(tlon?.ownerShip) ??
    activeShip
  );
}

async function buildInterpolationContext(
  config: OpenClawConfig,
  accountId?: string | null
): Promise<Record<string, string>> {
  const context = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
  const shipConfigs = await loadKnownShipConfigs();
  const tlon = config.channels?.tlon as
    | {
        accounts?: Record<
          string,
          { ship?: string; url?: string; ownerShip?: string }
        >;
      }
    | undefined;
  const account = accountId ? tlon?.accounts?.[accountId] : undefined;
  let activeShip =
    normalizeShip(account?.ship) ??
    (accountId ? undefined : normalizeShip(context.TLON_SHIP));
  const activeConfigPath = envValue('TLON_CONFIG_FILE');
  if (!accountId && activeConfigPath) {
    const activeConfig = await readShipConfig(activeConfigPath);
    const configuredShip = normalizeShip(activeConfig?.ship);
    if (activeConfig && configuredShip) {
      shipConfigs.set(configuredShip, activeConfig);
      activeShip ||= configuredShip;
    }
  }

  if (activeShip) {
    context.TLON_SHIP = activeShip;
    const activeUrl = account?.url ?? shipConfigs.get(activeShip)?.url;
    if (activeUrl) {
      context.TLON_URL = activeUrl;
    }
  }

  const ownerShip = configuredOwnerShip(config, activeShip, accountId);
  if (ownerShip) {
    context.TLON_OWNER_SHIP_ID = ownerShip;
    context.TLON_OWNER_SHIP = `~${ownerShip}`;
    context.TLON_OWNER_CONFIG_PATH = `/usr/local/share/openclaw/skills/tlon/ships/${ownerShip}.json`;
    const ownerUrl =
      shipConfigs.get(ownerShip)?.url ??
      (ownerShip === activeShip ? context.TLON_URL : undefined);
    if (ownerUrl) {
      context.TLON_OWNER_URL = ownerUrl;
    }
  }

  return context;
}

function interpolate(
  text: string,
  context: Readonly<Record<string, string>>
): string {
  return text.replace(
    ENV_VAR_PATTERN,
    (match, name: string) => context[name] ?? process.env[name] ?? match
  );
}

function normalizeToolsPrompt(
  text: string,
  context: Readonly<Record<string, string>>
): string {
  const ownerConfig =
    context.TLON_OWNER_CONFIG_PATH ?? '${TLON_OWNER_CONFIG_PATH}';
  return text
    .replace(SHIPS_PATH_PATTERN, '$1$2')
    .replace(TILDE_JSON_SEGMENT_PATTERN, '/$1')
    .replace(
      '/usr/local/share/openclaw/skills/tlon/ships/${TLON_OWNER_SHIP}.json',
      ownerConfig
    )
    .replace(
      '/usr/local/share/openclaw/skills/tlon/ships/${TLON_OWNER_SHIP_ID}.json',
      ownerConfig
    )
    .replace(TLON_FLAGS_PATTERN, `tlon --config ${ownerConfig} $1`)
    .replace('**Using flags (need ALL THREE):**', '**Using config file:**')
    .replace(
      '{"url": "${TLON_OWNER_URL}", "ship": "${TLON_OWNER_SHIP}", "code": "..."}',
      `{"config": "${ownerConfig}"}`
    );
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}`
  );
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

function markerBlockPattern(): RegExp {
  return new RegExp(MARKER_PATTERN.source, MARKER_PATTERN.flags);
}

async function removeManagedHeartbeat(
  workspaceDir: string,
  logger: Logger
): Promise<void> {
  const path = join(workspaceDir, HEARTBEAT_PROMPT_NAME);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return;
  }
  if (!text.includes(HEARTBEAT_MARKER_PREFIX) && text.trim()) {
    logger.warn(`leaving unmanaged heartbeat prompt in place: ${path}`);
    return;
  }
  await unlink(path);
  logger.info(`removed managed heartbeat prompt: ${path}`);
}

async function upsertBlock(params: {
  path: string;
  marker: string;
  content: string;
  managedMarkerPrefix?: string;
}): Promise<void> {
  if (!params.content) {
    return;
  }
  let text = '';
  try {
    text = await readFile(params.path, 'utf8');
  } catch {
    // A missing destination starts with only the managed block.
  }

  if (params.managedMarkerPrefix) {
    text = text
      .replace(markerBlockPattern(), (block, marker: string) =>
        marker.startsWith(params.managedMarkerPrefix!) ? '' : block
      )
      .replace(
        new RegExp(
          `${escapeRegExp(params.managedMarkerPrefix)}[^\\s]+ -->\\n?`,
          'g'
        ),
        ''
      )
      .replace(/\n+$/, '');
  } else if (!text.includes('<!-- idempotency-marker:')) {
    text = '';
  } else {
    text = text
      .replace(markerBlockPattern(), '')
      .replace(/<!-- idempotency-marker:[^\s]+ -->\n?/g, '')
      .replace(/\n+$/, '');
  }

  const block =
    `\n${params.marker}\n${params.content.replace(/\n+$/, '')}` +
    `\n${BLOCK_END}\n`;
  await atomicWrite(params.path, `${text}${block}`.replace(/^\n+/, ''));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
}

function destinationPath(
  workspaceDir: string,
  sourceRoot: string,
  source: string
) {
  const destination = resolve(workspaceDir, relative(sourceRoot, source));
  const root = resolve(workspaceDir);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new Error(`prompt archive path escaped workspace: ${source}`);
  }
  return destination;
}

export async function upsertPromptFiles(params: {
  sourceDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  logger: Logger;
  accountId?: string | null;
}): Promise<void> {
  const context = await buildInterpolationContext(
    params.config,
    params.accountId
  );
  for (const source of await listFiles(params.sourceDir)) {
    const destination = destinationPath(
      params.workspaceDir,
      params.sourceDir,
      source
    );
    const name = basename(source).toUpperCase();
    if (heartbeatsDisabled() && name === HEARTBEAT_PROMPT_NAME.toUpperCase()) {
      await removeManagedHeartbeat(params.workspaceDir, params.logger);
      continue;
    }

    let text = interpolate(await readFile(source, 'utf8'), context);
    if (name === 'TOOLS.MD') {
      text = normalizeToolsPrompt(text, context);
    }
    const blocks = [...text.matchAll(markerBlockPattern())];
    if (blocks.length === 0) {
      await atomicWrite(destination, text);
      continue;
    }
    for (const block of blocks) {
      const marker = block.groups?.marker;
      const content = block.groups?.content;
      if (!marker || content === undefined) {
        continue;
      }
      await upsertBlock({
        path: destination,
        marker,
        content,
        ...(name === BOOT_PROMPT_NAME.toUpperCase()
          ? { managedMarkerPrefix: BOOT_MARKER_PREFIX }
          : {}),
      });
    }
  }
}

function promptArchiveUrl(): string {
  const explicit = envValue('TLAWN_PROMPTS_URL');
  if (explicit) {
    return explicit;
  }
  return `https://storage.googleapis.com/tlon-${envValue('PIONEER_ENV')}-bots/prompts.tar.gz`;
}

export function resolveWorkspacePromptTargets(
  config: OpenClawConfig,
  standaloneWorkspaceDir?: string | null
): WorkspacePromptTarget[] {
  const tlon = config.channels?.tlon as
    | {
        deploymentMode?: string;
        accounts?: Record<string, unknown>;
      }
    | undefined;
  if (tlon?.deploymentMode !== 'monolithic') {
    return standaloneWorkspaceDir
      ? [
          {
            agentId: resolveDefaultAgentId(config),
            accountId: null,
            workspaceDir: standaloneWorkspaceDir,
          },
        ]
      : [];
  }

  const configuredAgents = new Set(listAgentIds(config));
  const targets = new Map<string, WorkspacePromptTarget>();
  for (const binding of config.bindings ?? []) {
    if (
      binding.type === 'acp' ||
      binding.match.channel !== 'tlon' ||
      !binding.match.accountId ||
      binding.match.accountId === '*'
    ) {
      continue;
    }
    const agentId = binding.agentId.trim();
    const accountId = binding.match.accountId.trim();
    if (
      !configuredAgents.has(agentId) ||
      !Object.hasOwn(tlon.accounts ?? {}, accountId)
    ) {
      throw new Error(
        `invalid monolithic Tlon binding: ${agentId} -> ${accountId}`
      );
    }
    const existing = targets.get(agentId);
    if (existing && existing.accountId !== accountId) {
      throw new Error(`agent ${agentId} is bound to multiple Tlon accounts`);
    }
    targets.set(agentId, {
      agentId,
      accountId,
      workspaceDir: resolveAgentWorkspaceDir(config, agentId),
    });
  }
  if (targets.size === 0) {
    throw new Error('monolithic mode has no exact Tlon account bindings');
  }
  return [...targets.values()];
}

async function syncWorkspacePromptTargets(params: {
  targets: WorkspacePromptTarget[];
  config: OpenClawConfig;
  logger: Logger;
}): Promise<void> {
  if (params.targets.length === 0) {
    return;
  }
  const url = promptArchiveUrl();
  params.logger.info(`fetching prompts from ${url}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tlon-hosting-prompts-'));
  try {
    const archive = join(temporaryRoot, 'prompts.tar.gz');
    const extracted = join(temporaryRoot, 'extracted');
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`prompt download returned HTTP ${response.status}`);
    }
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await mkdir(extracted);
    await extract({
      file: archive,
      cwd: extracted,
      strict: true,
      filter: (_path, entry) =>
        !('type' in entry) ||
        (entry.type !== 'SymbolicLink' && entry.type !== 'Link'),
    });
    for (const target of params.targets) {
      await upsertPromptFiles({
        sourceDir: extracted,
        workspaceDir: target.workspaceDir,
        config: params.config,
        logger: params.logger,
        accountId: target.accountId,
      });
      params.logger.info(
        `upserted prompts into ${target.workspaceDir} for agent ${target.agentId}`
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function syncWorkspacePrompts(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  logger: Logger;
}): Promise<void> {
  await syncWorkspacePromptTargets({
    targets: [
      {
        agentId: resolveDefaultAgentId(params.config),
        accountId: null,
        workspaceDir: params.workspaceDir,
      },
    ],
    config: params.config,
    logger: params.logger,
  });
}

export function registerWorkspacePromptSync(api: OpenClawPluginApi): void {
  api.registerService({
    id: 'tlon-hosting-workspace-prompts',
    start: async (context) => {
      try {
        const targets = resolveWorkspacePromptTargets(
          context.config,
          context.workspaceDir
        );
        if (targets.length === 0) {
          context.logger.warn(
            '[tlon-hosting] workspace unavailable; skipping hosted prompt sync'
          );
          return;
        }
        await syncWorkspacePromptTargets({
          targets,
          config: context.config,
          logger: context.logger,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.logger.warn(
          `[tlon-hosting] failed to sync hosted workspace prompts: ${message}`
        );
      }
    },
  });
}
