import { useSyncExternalStore } from 'react';
import { invoke, isDesktop, subscribe } from '../api';
import type { AiConfig, AiPrefs, AiProvider, ChatResult, ToolDef, WireMessage } from './types';

// The settings every AI surface reads; the settings dialog replaces them after each change.
let config: AiConfig | null = null;
let loading: Promise<AiConfig | null> | null = null;
const listeners = new Set<() => void>();
export function setAiConfig(next: AiConfig) {
  config = next;
  listeners.forEach((l) => l());
}
export function loadAiConfig(force = false): Promise<AiConfig | null> {
  if (!isDesktop) return Promise.resolve(null);
  if (config && !force) return Promise.resolve(config);
  loading ||= invoke<AiConfig>('ai-config')
    .then((c) => {
      setAiConfig(c);
      return c;
    })
    .catch(() => null)
    .finally(() => (loading = null));
  return loading;
}
export function useAiConfig() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!config) void loadAiConfig();
      return () => listeners.delete(l);
    },
    () => config,
  );
}
export function activeProvider(c: AiConfig | null): AiProvider | undefined {
  return c?.providers.find((p) => p.id === c.active) || c?.providers[0];
}
export function providerReady(p: AiProvider | undefined, c: AiConfig | null) {
  if (!p || !p.model) return false;
  const preset = c?.presets.find((x) => x.id === p.preset);
  return p.hasKey || !!preset?.noKey || p.preset === 'custom';
}
export async function savePrefs(patch: AiPrefs) {
  setAiConfig(await invoke<AiConfig>('ai-prefs', patch));
}

// “Error invoking remote method…” wrappers add nothing for the reader.
export function errorText(e: unknown) {
  return String((e as Error)?.message || e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}
export const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';
export const abortError = () => new DOMException('已停止', 'AbortError');

export type ChatRequest = {
  system?: string;
  messages: WireMessage[];
  tools?: ToolDef[];
  // Quick tasks (translate, explain) skip long reasoning where the service allows it.
  fast?: boolean;
  json?: boolean;
  // Room for a long reply, e.g. a whole notes page.
  maxTokens?: number;
  providerId?: string;
};
export type ChatHandlers = {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onTool?: (name: string) => void;
  signal?: AbortSignal;
};
export async function chat(request: ChatRequest, handlers: ChatHandlers = {}) {
  if (!isDesktop) throw Error('请在桌面版中使用 AI 功能');
  if (handlers.signal?.aborted) throw abortError();
  const requestId = crypto.randomUUID();
  const off = subscribe((e) => {
    if (e.type !== 'ai-delta' || e.requestId !== requestId) return;
    if (e.text) handlers.onText?.(e.text);
    if (e.reasoning) handlers.onReasoning?.(e.reasoning);
    if (e.tool) handlers.onTool?.(e.tool);
  });
  const cancel = () => void invoke('ai-cancel', { requestId }).catch(() => {});
  handlers.signal?.addEventListener('abort', cancel);
  try {
    const result = await invoke<ChatResult & { stopped?: boolean }>('ai-chat', {
      requestId,
      ...request,
    });
    if (result.stopped || handlers.signal?.aborted) throw abortError();
    return result;
  } catch (e) {
    if (isAbort(e)) throw e;
    throw Error(errorText(e));
  } finally {
    off();
    handlers.signal?.removeEventListener('abort', cancel);
  }
}

// Pulls the first JSON object or array out of a reply that may wrap it in prose or fences.
export function parseJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {}
  }
  return null;
}
