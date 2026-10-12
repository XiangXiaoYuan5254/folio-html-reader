import { useSyncExternalStore } from 'react';
import { invoke, isDesktop, subscribe } from '../api';
import { requireMember } from '../license';
import type {
  AiConfig,
  AiPrefs,
  AiProvider,
  AiUse,
  ChatResult,
  ToolDef,
  WireMessage,
} from './types';

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
// The settings as last loaded, for code that runs outside React.
export const currentAiConfig = () => config;
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
// The parts of the app that can each have their own model and reasoning level.
export const useInfo: Record<AiUse, { label: string; hint: string }> = {
  chat: { label: '助手聊天', hint: '右侧助手的对话、总结、划重点、精读笔记和项目助手' },
  explain: { label: '解释与提问', hint: '选中文字后的“解释”和“提问”' },
  translate: { label: '翻译', hint: '选中文字后的“翻译”' },
  board: { label: '白板讲解', hint: '页老师在白板上边写边讲' },
  edit: { label: 'AI 修改源码', hint: '源码模式里描述想怎么改，由 AI 生成修改' },
};
// A part's own choice, while its service is still there; none means it follows chat.
export function useChoice(c: AiConfig | null, use: AiUse) {
  const choice = use === 'chat' ? undefined : c?.uses?.[use];
  return choice && c?.providers.some((p) => p.id === choice.provider) ? choice : undefined;
}
// The service, model and reasoning level a part of the app asks with.
export function providerFor(c: AiConfig | null, use: AiUse = 'chat'): AiProvider | undefined {
  const choice = useChoice(c, use);
  if (choice) {
    const p = c!.providers.find((x) => x.id === choice.provider)!;
    return { ...p, model: choice.model || p.model, effort: choice.effort };
  }
  return activeProvider(c);
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
  json?: boolean;
  // Room for a long reply, e.g. a whole notes page.
  maxTokens?: number;
  // The part of the app asking, which picks the service and model; chat by default.
  use?: AiUse;
  // Lets the model search the web when it decides to, where the service can.
  web?: boolean;
  // Sends it again beside itself when its thinking stops coming in, where the service streams
  // thinking word by word (electron/ai-providers.cjs).
  resend?: boolean;
};
export type ChatHandlers = {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onTool?: (name: string) => void;
  onSearch?: (search: { id: string; title: string; done: boolean }) => void;
  // With `resend`: the request is watched, and a pause of `ms` in it means stuck.
  onWatch?: (ms: number) => void;
  // Its thinking stopped that long, and it was sent again.
  onResent?: () => void;
  signal?: AbortSignal;
};
// What the membership dialog says was asked for.
const memberReason: Record<AiUse, string> = {
  chat: 'AI 助手',
  explain: 'AI 解释与提问',
  translate: 'AI 翻译',
  board: '白板讲解',
  edit: 'AI 修改源码',
};
export async function chat(request: ChatRequest, handlers: ChatHandlers = {}) {
  if (!isDesktop) throw Error('请在桌面版中使用 AI 功能');
  if (handlers.signal?.aborted) throw abortError();
  if (!(await requireMember(memberReason[request.use || 'chat'])))
    throw Error('需要会员：开通会员或免费试用后就能用 AI 功能');
  const requestId = crypto.randomUUID();
  // Whether the model takes pictures is learned from sending some (electron/ai.cjs).
  const pictures = request.messages.some((m) => m.images?.length);
  let streamed = '';
  const off = subscribe((e) => {
    if (e.type !== 'ai-delta' || e.requestId !== requestId) return;
    if (e.text) {
      streamed += e.text;
      handlers.onText?.(e.text);
    }
    if (e.reasoning) handlers.onReasoning?.(e.reasoning);
    if (e.tool) handlers.onTool?.(e.tool);
    if (e.search) handlers.onSearch?.(e.search);
    if (e.watch) handlers.onWatch?.(e.watch);
    if (e.resent) handlers.onResent?.();
  });
  const cancel = () => void invoke('ai-cancel', { requestId }).catch(() => {});
  handlers.signal?.addEventListener('abort', cancel);
  try {
    const result = await invoke<ChatResult & { stopped?: boolean }>('ai-chat', {
      requestId,
      ...request,
    });
    if (result.stopped || handlers.signal?.aborted) throw abortError();
    if (pictures) void loadAiConfig(true);
    // A reply that comes in one burst can get here before its last pieces do.
    if (result.text?.length > streamed.length && result.text.startsWith(streamed))
      handlers.onText?.(result.text.slice(streamed.length));
    return result;
  } catch (e) {
    if (isAbort(e)) throw e;
    if (pictures) void loadAiConfig(true);
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
