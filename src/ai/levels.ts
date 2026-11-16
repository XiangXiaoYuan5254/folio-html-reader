import { invoke } from '../api';
import type { AiConfig, AiPreset, AiProvider, AiUse, ModelOption } from './types';

const labels: Record<string, string> = {
  off: '不思考',
  on: '思考',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};
export const effortLabel = (effort: string) => labels[effort] ?? effort;

// Model lists are fetched once per service and kept while the app runs.
const cache = new Map<string, Promise<ModelOption[]>>();
// The lists that have arrived, for code that can't wait for one.
const loaded = new Map<string, ModelOption[]>();
export function modelOptions(providerId: string, refresh = false) {
  let pending = cache.get(providerId);
  if (!pending || refresh) {
    pending = invoke<ModelOption[]>('ai-models', { id: providerId, refresh });
    cache.set(providerId, pending);
    pending.then(
      (list) => cache.get(providerId) === pending && loaded.set(providerId, list),
      () => cache.delete(providerId),
    );
  }
  return pending;
}
export const loadedModelOptions = (providerId: string | undefined) =>
  providerId ? loaded.get(providerId) : undefined;
export function rememberModelOptions(providerId: string, list: ModelOption[]) {
  cache.set(providerId, Promise.resolve(list));
  loaded.set(providerId, list);
}
export function forgetModelOptions(providerId?: string) {
  if (providerId) {
    cache.delete(providerId);
    loaded.delete(providerId);
  } else {
    cache.clear();
    loaded.clear();
  }
}
// The levels a service's model offers and the one it uses until another is picked, as
// electron/ai-providers.cjs works them out.
export function modelLevels(preset: AiPreset | undefined, model: string | undefined) {
  const rule = preset?.levels?.find(([pattern]) => new RegExp(pattern, 'i').test(model || ''));
  return rule
    ? { efforts: rule[1], effort: rule[2] }
    : { efforts: preset?.efforts || [], effort: preset?.effort || '' };
}
// Reasoning levels from least to most; `on` thinks as deeply as the model likes.
const depth: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  on: 4,
  high: 4,
  xhigh: 5,
  max: 6,
};
const thinks = (level: string) => depth[level] >= 2;
const least = (levels: string[]) => levels.reduce((a, b) => (depth[b] < depth[a] ? b : a));
// The next level down from `effort` that still thinks, to suggest when thinking takes long;
// '' when there is none.
export function lowerLevel(levels: string[], effort: string) {
  return levels
    .filter((l) => l in depth && thinks(l) && l !== 'on' && depth[l] < (depth[effort] ?? 0))
    .reduce((a, b) => (!a || depth[b] > depth[a] ? b : a), '');
}
// The level a model uses, as electron/ai-providers.cjs works it out for requests. One
// picked that the model doesn't have becomes the nearest it has, thinking or not as picked
// where it can, the higher of two as near. With none picked, a part of the app starts at
// its own: translation at the least, explanations and the whiteboard at the least that
// still thinks (not thinking, for a model only switched on or off), chat and source edits
// at the model's default.
export function levelFor(levels: string[], fallback: string, picked: string, use: AiUse) {
  const known = levels.filter((l) => l in depth);
  if (levels.includes(picked) || !known.length) return levels.includes(picked) ? picked : fallback;
  if (picked in depth) {
    const same = known.filter((l) => thinks(l) === thinks(picked));
    const off = (l: string) => Math.abs(depth[l] - depth[picked]);
    return (same.length ? same : known).reduce((a, b) =>
      off(b) < off(a) || (off(b) === off(a) && depth[b] > depth[a]) ? b : a,
    );
  }
  if (use === 'translate') return least(known);
  if (use === 'explain' || use === 'board') {
    const graded = known.filter((l) => thinks(l) && l !== 'on');
    if (graded.length) return least(graded);
    if (known.includes('off')) return 'off';
  }
  return fallback;
}
// The levels to offer for a model, from its list or else the service, and the level in use
// for a part of the app (one following chat is chat).
export function levelsFor(
  provider: AiProvider | undefined,
  config: AiConfig | null,
  options?: ModelOption[],
  use: AiUse = 'chat',
) {
  const option = options?.find((m) => m.id === provider?.model);
  const preset = config?.presets.find((p) => p.id === provider?.preset);
  const { efforts, effort } = option
    ? { efforts: option.efforts, effort: option.defaultEffort }
    : modelLevels(preset, provider?.model);
  return { levels: efforts, effort: levelFor(efforts, effort, provider?.effort || '', use) };
}
