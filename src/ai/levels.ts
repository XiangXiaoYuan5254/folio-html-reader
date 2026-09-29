import { invoke } from '../api';
import type { AiConfig, AiProvider, ModelOption } from './types';

const labels: Record<string, string> = {
  '': '自动',
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
export function modelOptions(providerId: string, refresh = false) {
  let pending = cache.get(providerId);
  if (!pending || refresh) {
    pending = invoke<ModelOption[]>('ai-models', { id: providerId });
    cache.set(providerId, pending);
    pending.catch(() => cache.delete(providerId));
  }
  return pending;
}
export function forgetModelOptions(providerId?: string) {
  if (providerId) cache.delete(providerId);
  else cache.clear();
}
// The levels to offer for a model: what it reports, else the service's list.
export function levelsFor(
  provider: AiProvider | undefined,
  config: AiConfig | null,
  options?: ModelOption[],
) {
  const option = options?.find((m) => m.id === provider?.model);
  if (option?.efforts.length) return option.efforts;
  return config?.presets.find((p) => p.id === provider?.preset)?.efforts || [];
}
