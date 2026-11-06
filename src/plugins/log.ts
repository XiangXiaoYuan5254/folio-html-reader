import { useEffect, useSyncExternalStore } from 'react';
import { invoke, isDesktop } from '../api';
import type { PluginLogEntry, PluginLogKind } from './types';

// Each plugin's run log, as 设置 › 插件 shows it: a run starting and ending, every tool it
// called, and what its script said with folio.log or threw. Written here as a run goes and kept
// by electron/plugins.cjs, a few at a time.
const KEEP = 400;
const logs = new Map<string, PluginLogEntry[]>();
const loaded = new Set<string>();
const listeners = new Set<() => void>();
const queued = new Map<string, PluginLogEntry[]>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const empty: PluginLogEntry[] = [];

function emit() {
  listeners.forEach((l) => l());
}
function flush() {
  flushTimer = undefined;
  for (const [id, add] of queued) {
    queued.delete(id);
    void invoke('plugin-log', { id, add }).catch(() => {});
  }
}

export function pluginLog(id: string, kind: PluginLogKind, text: string) {
  const entry = { at: Date.now(), kind, text: text.slice(0, 800) };
  logs.set(id, [...(logs.get(id) || []), entry].slice(-KEEP));
  emit();
  if (!isDesktop) return;
  queued.set(id, [...(queued.get(id) || []), entry]);
  flushTimer ||= setTimeout(flush, 300);
}

async function load(id: string) {
  if (loaded.has(id) || !isDesktop) return;
  loaded.add(id);
  try {
    const saved = await invoke<PluginLogEntry[]>('plugin-log', { id });
    // Written while it was being read: those already went to the app, after the saved ones.
    const written = (logs.get(id) || []).filter(
      (e) => !saved.some((s) => s.at === e.at && s.text === e.text),
    );
    logs.set(id, [...saved, ...written].slice(-KEEP));
    emit();
  } catch {
    loaded.delete(id);
  }
}

export function usePluginLog(id: string) {
  useEffect(() => void load(id), [id]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => logs.get(id) || empty,
  );
}

export async function clearPluginLog(id: string) {
  queued.delete(id);
  logs.set(id, []);
  emit();
  if (isDesktop) await invoke('plugin-log', { id, clear: true });
}

// A tool's input in a few words: its address or path, else its JSON, cut short.
export function inputSummary(input: unknown) {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['url', 'path', 'query', 'text'])
    if (typeof o[key] === 'string') return String(o[key]).slice(0, 120);
  try {
    const json = JSON.stringify(input);
    return json === '{}' ? '' : json.slice(0, 120);
  } catch {
    return '';
  }
}
