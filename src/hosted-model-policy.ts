export const BASIC_PROVIDER = 'basic';
export const HOSTED_DEFAULT_PROVIDER = 'openrouter';
const RETIRED_HOSTED_MODEL_IDS = [
  'minimax/minimax-m2.1',
  'minimax/minimax-m2.5',
  'minimax/minimax-m2.7',
  'minimax/minimax-m3',
] as const;

export const RETIRED_HOSTED_MODEL_REFS: ReadonlySet<string> = new Set(
  RETIRED_HOSTED_MODEL_IDS.flatMap(model => [
    `${BASIC_PROVIDER}/${model}`,
    model,
    `${HOSTED_DEFAULT_PROVIDER}/${model}`,
  ])
);

function isRecord(value: unknown): value is Record<string, unknown> {
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

export function normalizeModelRef(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
