import { invoke } from '../api';
import type { AiConfig, AiProvider, Balance } from './types';

// A balance is asked for again after a minute, so reopening the model menu stays quick.
// `of` is a saved AI service's id, or `speech:` and a speech service's.
const cache = new Map<string, { at: number; pending: Promise<Balance> }>();
export function loadBalance(of: string, refresh = false) {
  const hit = cache.get(of);
  if (hit && !refresh && Date.now() - hit.at < 60_000) return hit.pending;
  const speech = of.startsWith('speech:') ? of.slice('speech:'.length) : '';
  const pending = invoke<Balance>('ai-balance', speech ? { speech } : { id: of });
  cache.set(of, { at: Date.now(), pending });
  pending.catch(() => cache.get(of)?.pending === pending && cache.delete(of));
  return pending;
}
export const forgetBalance = (of: string) => cache.delete(of);
// Whether a saved service can say what's left: a key that can ask, a ChatGPT plan or a Kimi
// membership.
export function tellsBalance(p: AiProvider | undefined, config: AiConfig | null) {
  if (!p) return false;
  if (p.kind === 'codex' || p.kind === 'kimi') return true;
  return p.hasKey && !!config?.presets.find((x) => x.id === p.preset)?.balance;
}
export const money = (n: number, currency: 'CNY' | 'USD') =>
  `${n < 0 ? '-' : ''}${currency === 'USD' ? '$' : '¥'}${Math.abs(n).toFixed(2)}`;
// The span a plan's usage window covers: “5 小时”, “每周”, “每月”.
export function windowName(mins: number) {
  if (mins === 10_080) return '每周';
  if (mins === 43_200) return '每月';
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
