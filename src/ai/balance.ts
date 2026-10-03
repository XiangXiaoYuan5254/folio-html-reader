import { invoke } from '../api';
import type { AiConfig, AiProvider, Balance } from './types';

// A balance is asked for again after a minute, so reopening the model menu stays quick.
const cache = new Map<string, { at: number; pending: Promise<Balance> }>();
export function loadBalance(providerId: string, refresh = false) {
  const hit = cache.get(providerId);
  if (hit && !refresh && Date.now() - hit.at < 60_000) return hit.pending;
  const pending = invoke<Balance>('ai-balance', { id: providerId });
  cache.set(providerId, { at: Date.now(), pending });
  pending.catch(() => cache.get(providerId)?.pending === pending && cache.delete(providerId));
  return pending;
}
export const forgetBalance = (providerId: string) => cache.delete(providerId);
// Whether a saved service can say what's left: a key that can ask, or a ChatGPT plan.
export function tellsBalance(p: AiProvider | undefined, config: AiConfig | null) {
  if (!p) return false;
  if (p.kind === 'codex') return true;
  return p.hasKey && !!config?.presets.find((x) => x.id === p.preset)?.balance;
}
export const money = (n: number, currency: 'CNY' | 'USD') =>
  `${n < 0 ? '-' : ''}${currency === 'USD' ? '$' : '¥'}${Math.abs(n).toFixed(2)}`;
// The span a ChatGPT plan's usage window covers: “5 小时”, “每周”.
export function windowName(mins: number) {
  if (mins === 10_080) return '每周';
  if (mins >= 1_440 && mins % 1_440 === 0) return `${mins / 1_440} 天`;
  if (mins >= 60) return `${Math.round(mins / 60)} 小时`;
  return mins ? `${mins} 分钟` : '当前周期';
}
export function resetText(at: number) {
  if (!at) return '';
  const d = new Date(at);
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = d.toDateString() === new Date().toDateString();
  return `${today ? '' : `${d.getMonth() + 1}月${d.getDate()}日 `}${time} 重置`;
}
export function dayText(at: number) {
  const d = new Date(at);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日`;
}
