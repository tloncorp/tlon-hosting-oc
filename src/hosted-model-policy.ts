export const BASIC_PROVIDER = 'basic';
export const HOSTED_DEFAULT_PROVIDER = 'openrouter';
export const HOSTED_DEFAULT_MODEL_ID = 'openai/gpt-5.6-luna';
export const HOSTED_DEFAULT_MODEL = `${HOSTED_DEFAULT_PROVIDER}/${HOSTED_DEFAULT_MODEL_ID}`;
export const RETIRED_HOSTED_MODEL_REFS: ReadonlySet<string> = new Set([
  'basic/minimax/minimax-m3',
  'minimax/minimax-m3',
  'openrouter/minimax/minimax-m3',
]);

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
