import { useSyncExternalStore } from 'react';
import { answerNote } from './note-block';
import { invoke } from '../api';
import type { Anchor, Annotation } from '../types';
import type { AiHost } from './host';
import type {
  AgentStep,
  AiConfig,
  AiProvider,
  AiUse,
  ChatHistory,
  ChatMessage,
  ChatThread,
  CiteDoc,
  DocText,
  MessagePart,
  Quota,
  ToolCall,
  ToolDef,
  Usage,
  WireMessage,
} from './types';
import {
  chat,
  errorText,
  isAbort,
  loadAiConfig,
  parseJson,
  providerFor,
  providerReady,
  savePrefs,
} from './client';
import {
  chunkDocument,
  documentBudget,
  documentContext,
  estimateTokens,
  fileName,
  surrounding,
} from './context';
import type { Chunk } from './context';
import {
  agentSystem,
  annotationsList,
  askSelectionTask,
  explainTask,
  translateTask,
  chunkSummaryPrompt,
  combineSummaryPrompt,
  compactPrompt,
  compactSystem,
  comparePrompt,
  documentBlock,
  highlightKinds,
  highlightCount,
  highlightsPrompt,
  organizePrompt,
  questionsPrompt,
  readingSystem,
  selectionPrompt,
  summaryPrompt,
  unfinished,
  withDocuments,
  withSummary,
} from './prompts';
import { agentTools, prepareTool, readingTools, writeTools } from './agent-tools';
import {
  cleanCompanion,
  companionChunkPrompt,
  companionContinue,
  companionPage,
  companionPrompt,
  companionSystem,
  joinContinuation,
  notesRecord,
  unfinishedNotes,
} from './companion';
import { citations, citeKey, plainCites, plainText } from './plain';
export { citations, citeKey, plainCites, plainText } from './plain';
import { imageTokens, maxImages, refusesImages } from './images';
import { loadedModelOptions } from './levels';
import type { PreparedTool } from './agent-tools';

export type Scope = string; // a document id, or 'project' for the agent
export type ReadingContext = {
  scope: Scope;
  docs: CiteDoc[];
  selection?: string;
};
// Rounds of looking things up in a long document before it has to answer from what it found.
const lookupRounds = 15;
export type Task = 'summary' | 'highlights' | 'companion' | 'organize' | 'questions' | 'compare';
export const taskLabels: Record<Task, string> = {
  summary: '总结全文',
  highlights: 'AI 划重点',
  companion: '制作精读笔记',
  organize: '整理我的批注',
  questions: '出几道思考题',
  compare: '对比两篇文档',
};
// The card that answers about selected text: explain, translate or a quick question.
export type SelectionCard = {
  id: string;
  mode: 'explain' | 'translate' | 'ask';
  docId: string;
  path: string;
  anchor: Anchor;
  selection: string;
  question?: string;
  target?: string;
  text: string;
  status: 'idle' | 'streaming' | 'done' | 'error';
  error?: string;
  saved?: boolean;
};
export const cardLabels = { explain: '解释', translate: '翻译', ask: '提问' };
type State = {
  card: SelectionCard | null;
  histories: Record<Scope, ChatHistory | undefined>;
  running: Record<string, true>;
  drafts: Record<Scope, string>;
  // Pictures waiting to go with the next question.
  attachments: Record<Scope, string[]>;
  // Each run's "apply later changes automatically" choice.
  autoApply: Record<string, boolean>;
};
// A 精读笔记 under way: a long document's parts and the notes on those read, the request
// the page is written from, and the page so far.
type CompanionWork = {
  chunks?: Chunk[];
  notes: string[];
  ask?: WireMessage;
  reply: string;
  model: string;
  usage: Usage;
  quota: Quota | null;
};
const now = () => Date.now();
// What a question made only of pictures asks.
const imageQuestion = '请结合文档内容，解释图片里的内容。';
const imageRequest = '请看图片，告诉我图片里是什么，以及和项目里的哪些文档有关。';
const newId = () => crypto.randomUUID();
const emptyHistory = (): ChatHistory => ({ version: 1, threads: [] });
function titleFrom(message: ChatMessage) {
  return (
    (message.label || message.text).replace(/\s+/g, ' ').slice(0, 28) ||
    (message.images?.length ? '看图提问' : '新对话')
  );
}
// Earlier pictures go back to the model too, unless it can't look at them.
function userTurn(content: string, images: string[] | undefined, vision: boolean): WireMessage {
  if (!images?.length) return { role: 'user', content };
  if (!vision)
    return {
      role: 'user',
      content: `（这里附了 ${images.length} 张图片，当前模型看不到。）\n${content}`,
    };
  return { role: 'user', content, images };
}
const size = (list: WireMessage[]) =>
  list.reduce(
    (n, m) => n + estimateTokens(m.content) + (m.images?.length || 0) * imageTokens + 8,
    0,
  );
// How much of the window the conversation can take before its earlier part is summarized:
// what's left after the instructions and documents, and room for the reply.
function historyRoom(provider: AiProvider, systemTokens: number) {
  const reply = Math.min(32_000, Math.max(4_000, Math.floor(provider.context * 0.1)));
  return Math.max(6_000, Math.floor(provider.context * 0.85) - systemTokens - reply);
}
const sum = (a: Usage | null | undefined, b: Usage | null | undefined): Usage | null =>
  a && b
    ? { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached }
    : a || b || null;
// “继续” on its own, after a 精读笔记 that was stopped or broke off, goes on writing it.
const continuing = /^(继续|继续写|接着写|接着|接着来|go on|continue|keep going)[\s。.!！~～…]*$/i;
// A reply's request: what build() in stream() gives.
type Built = {
  system: string;
  messages: WireMessage[];
  web?: boolean;
  tools?: ToolDef[];
  session?: string;
  usage?: Usage | null;
};

export class Assistant {
  private state: State = {
    card: null,
    histories: {},
    running: {},
    drafts: {},
    attachments: {},
    autoApply: {},
  };
  private listeners = new Set<() => void>();
  private frame = 0;
  private controllers = new Map<string, AbortController>();
  // What a 精读笔记 that was stopped or broke off got done, by its reply, so 接着写 goes on
  // from there instead of starting over. Kept while the app is open, as the draft is.
  private companionWork = new Map<string, CompanionWork>();
  private approvals = new Map<string, (ok: boolean) => void>();
  private saveTimers = new Map<Scope, ReturnType<typeof setTimeout>>();
  private loading = new Map<Scope, Promise<void>>();
  private texts = new Map<string, Promise<DocText>>();
  constructor(private host: AiHost) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.state;
  private emit(now = false) {
    if (now) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.listeners.forEach((l) => l());
      return;
    }
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.listeners.forEach((l) => l());
    });
  }
  private set(fn: (s: State) => State, immediate = false) {
    this.state = fn(this.state);
    this.emit(immediate);
  }

  // Switching projects starts from a clean slate.
  reset() {
    for (const c of this.controllers.values()) c.abort();
    this.companionWork.clear();
    for (const resolve of this.approvals.values()) resolve(false);
    this.approvals.clear();
    this.texts.clear();
    this.loading.clear();
    this.state = {
      card: null,
      histories: {},
      running: {},
      drafts: {},
      attachments: {},
      autoApply: {},
    };
    this.emit(true);
  }
  // Cached text of documents that are not on screen; visible ones are read live.
  forgetText(path?: string) {
    if (path) this.texts.delete(path);
    else this.texts.clear();
  }

  load(scope: Scope) {
    if (this.state.histories[scope] || !scope) return Promise.resolve();
    let pending = this.loading.get(scope);
    if (!pending) {
      pending = invoke<ChatHistory | null>('ai-history', { key: scope })
        .then((h) => {
          // Replies cut off when the app closed are shown as stopped.
          const saved = h || emptyHistory();
          for (const t of saved.threads)
            for (const m of t.messages) if (m.status === 'streaming') m.status = 'stopped';
          // A conversation started while loading stays, ahead of the saved ones.
          this.set((s) => {
            const current = s.histories[scope];
            const history = current
              ? {
                  ...saved,
                  active: current.active || saved.active,
                  threads: [
                    ...current.threads,
                    ...saved.threads.filter((t) => !current.threads.some((c) => c.id === t.id)),
                  ],
                }
              : saved;
            return { ...s, histories: { ...s.histories, [scope]: history } };
          }, true);
        })
        .catch(() =>
          this.set(
            (s) => ({
              ...s,
              histories: { ...s.histories, [scope]: s.histories[scope] || emptyHistory() },
            }),
            true,
          ),
        );
      this.loading.set(scope, pending);
    }
    return pending;
  }
  thread(scope: Scope): ChatThread | undefined {
    const h = this.state.histories[scope];
    return h?.threads.find((t) => t.id === h.active) || h?.threads[0];
  }
  private history(scope: Scope) {
    return this.state.histories[scope] || emptyHistory();
  }
  private putHistory(scope: Scope, history: ChatHistory, immediate = false) {
    // The open conversation has been seen.
    const active = history.active || history.threads[0]?.id;
    if (history.threads.some((t) => t.id === active && t.unseen))
      history = {
        ...history,
        threads: history.threads.map((t) => (t.id === active ? { ...t, unseen: false } : t)),
      };
    this.set((s) => ({ ...s, histories: { ...s.histories, [scope]: history } }), immediate);
    this.persist(scope);
  }
  private persist(scope: Scope) {
    clearTimeout(this.saveTimers.get(scope));
    this.saveTimers.set(
      scope,
      setTimeout(() => void this.save(scope), 500),
    );
  }
  private save(scope: Scope) {
    clearTimeout(this.saveTimers.get(scope));
    this.saveTimers.delete(scope);
    const history = this.state.histories[scope];
    if (!history) return Promise.resolve();
    const threads = history.threads
      .filter((t) => t.messages.length)
      .slice(0, 60)
      .map((t) => ({
        ...t,
        messages: t.messages.map(({ status, draft, ...m }) => ({
          ...m,
          status: status === 'streaming' ? ('stopped' as const) : status,
        })),
      }));
    return invoke('ai-save-history', { key: scope, data: { ...history, threads } })
      .then(() => {})
      .catch((e) => this.host.notify('对话记录保存失败：' + errorText(e), true));
  }
  // Writes conversations still waiting for their delayed save, before closing or switching.
  flush() {
    return Promise.all([...this.saveTimers.keys()].map((scope) => this.save(scope)));
  }
  newThread(scope: Scope, mode: ChatThread['mode'] = scope === 'project' ? 'agent' : 'doc') {
    const h = this.history(scope);
    const current = this.thread(scope);
    if (current && !current.messages.length) return current.id;
    const thread: ChatThread = {
      id: newId(),
      mode,
      title: '新对话',
      createdAt: now(),
      updatedAt: now(),
      messages: [],
    };
    this.putHistory(scope, { ...h, active: thread.id, threads: [thread, ...h.threads] }, true);
    return thread.id;
  }
  selectThread(scope: Scope, id: string) {
    this.putHistory(scope, { ...this.history(scope), active: id }, true);
  }
  deleteThread(scope: Scope, id: string) {
    this.stop(id);
    const h = this.history(scope);
    const threads = h.threads.filter((t) => t.id !== id);
    this.putHistory(scope, { ...h, threads, active: threads[0]?.id }, true);
  }
  setDraft(scope: Scope, text: string) {
    this.set((s) => ({ ...s, drafts: { ...s.drafts, [scope]: text } }), true);
  }
  notify(text: string, error = false) {
    this.host.notify(text, error);
  }
  setAttachments(scope: Scope, images: string[]) {
    this.set(
      (s) => ({ ...s, attachments: { ...s.attachments, [scope]: images.slice(0, maxImages) } }),
      true,
    );
  }
  stop(threadId: string) {
    this.controllers.get(threadId)?.abort();
    for (const [stepId, resolve] of this.approvals)
      if (stepId.startsWith(threadId + ':')) {
        resolve(false);
        this.approvals.delete(stepId);
      }
  }
  setAutoApply(threadId: string, value: boolean) {
    this.set((s) => ({ ...s, autoApply: { ...s.autoApply, [threadId]: value } }), true);
  }
  approve(stepId: string, ok: boolean) {
    this.approvals.get(stepId)?.(ok);
    this.approvals.delete(stepId);
  }

  private updateThread(scope: Scope, threadId: string, fn: (t: ChatThread) => ChatThread) {
    const h = this.history(scope);
    const threads = h.threads.map((t) => (t.id === threadId ? fn(t) : t));
    this.set((s) => ({ ...s, histories: { ...s.histories, [scope]: { ...h, threads } } }));
    this.persist(scope);
  }
  private patchMessage(
    scope: Scope,
    threadId: string,
    messageId: string,
    fn: (m: ChatMessage) => ChatMessage,
  ) {
    this.updateThread(scope, threadId, (t) => ({
      ...t,
      updatedAt: now(),
      messages: t.messages.map((m) => (m.id === messageId ? fn(m) : m)),
    }));
  }
  // Adds a question and an empty reply to the scope's current conversation and starts the
  // reply; nothing when the conversation has one going, so only one runs at a time.
  private begin(scope: Scope, user: Partial<ChatMessage>, reply: Partial<ChatMessage> = {}) {
    const busy = this.thread(scope);
    if (busy && this.controllers.has(busy.id)) return null;
    const { threadId, answerId, history } = this.add(scope, user, reply);
    return { threadId, answerId, history, signal: this.start(threadId) };
  }
  // Adds a question and its reply to the scope's current conversation.
  private add(scope: Scope, user: Partial<ChatMessage>, reply: Partial<ChatMessage>) {
    const mode = scope === 'project' ? 'agent' : 'doc';
    let thread = this.thread(scope);
    if (!thread || thread.mode !== mode) {
      this.newThread(scope, mode);
      thread = this.thread(scope)!;
    }
    const question: ChatMessage = {
      id: newId(),
      role: 'user',
      text: '',
      createdAt: now(),
      ...user,
    };
    const answer: ChatMessage = {
      id: newId(),
      role: 'assistant',
      text: '',
      createdAt: now(),
      status: 'streaming',
      ...reply,
    };
    const history = thread.messages;
    this.updateThread(scope, thread.id, (t) => ({
      ...t,
      title: t.messages.length ? t.title : titleFrom(question),
      updatedAt: now(),
      messages: [...t.messages, question, answer],
    }));
    return { threadId: thread.id, answerId: answer.id, history };
  }
  private start(threadId: string) {
    const controller = new AbortController();
    this.controllers.set(threadId, controller);
    this.set((s) => ({ ...s, running: { ...s.running, [threadId]: true } }), true);
    return controller.signal;
  }
  private finish(threadId: string) {
    this.controllers.delete(threadId);
    // Finished while another conversation was open: marked until it's opened.
    for (const [scope, h] of Object.entries(this.state.histories))
      if (h?.threads.some((t) => t.id === threadId) && this.thread(scope)?.id !== threadId)
        this.updateThread(scope, threadId, (t) => ({ ...t, unseen: true }));
    this.set((s) => {
      const running = { ...s.running };
      delete running[threadId];
      return { ...s, running };
    }, true);
  }
  // Settings, consent and per-project switch, checked before anything is sent.
  async provider(use: AiUse = 'chat'): Promise<{ provider: AiProvider; config: AiConfig }> {
    const config = await loadAiConfig();
    const provider = providerFor(config, use);
    if (!config || !providerReady(provider, config)) {
      this.host.openSettings();
      throw Error('请先在 AI 设置中添加服务、填写 API Key 并选择模型');
    }
    const root = this.host.root();
    if (root && config.prefs.disabledRoots?.includes(root))
      throw Error('这个项目已停用 AI。可以在 AI 设置中重新开启');
    if (!config.prefs.consented?.includes(provider!.id)) {
      const ok = await this.host.confirm({
        title: `把文档内容发送给 ${provider!.name}？`,
        message: `使用 AI 功能时，页间会把相关的文档文字、你的问题和批注发送给 ${provider!.name}（${provider!.model}）处理，由它按自己的隐私政策处理数据。页间不经过任何其他服务器。之后使用这个服务不再询问；可以在 AI 设置中为某个项目停用 AI。`,
        confirmLabel: '同意并继续',
      });
      if (!ok) throw new DOMException('已取消', 'AbortError');
      await savePrefs({ consented: [...(config.prefs.consented || []), provider!.id] });
    }
    return { provider: provider!, config: (await loadAiConfig()) || config };
  }
  text(path: string) {
    let pending = this.texts.get(path);
    if (!pending) {
      pending = this.host.docText(path);
      this.texts.set(path, pending);
      pending.catch(() => this.texts.delete(path));
    }
    return pending;
  }

  // A question about the open document(s), possibly with pictures.
  async ask(ctx: ReadingContext, text: string, selection = ctx.selection, images: string[] = []) {
    const question = text.trim();
    if (!question && !images.length) return;
    await this.load(ctx.scope);
    const notes =
      !images.length && !selection && continuing.test(question) && this.notesToGoOn(ctx.scope);
    if (notes) return this.continueNotes(ctx, question, notes);
    const started = this.begin(
      ctx.scope,
      { text: question, selection, ...(images.length ? { images } : {}) },
      { docs: ctx.docs },
    );
    if (!started) return;
    const { threadId, answerId, history, signal } = started;
    this.setDraft(ctx.scope, '');
    this.setAttachments(ctx.scope, []);
    await this.stream(ctx, threadId, answerId, signal, async (provider, config, how) => {
      const vision = !refusesImages(provider, loadedModelOptions(provider.id));
      const { system, partial } = await this.readingContext(
        ctx,
        provider,
        config,
        question + ' ' + (selection || ''),
        how.lookup,
      );
      const fitted = await this.fit(
        ctx.scope,
        threadId,
        history,
        system,
        provider,
        vision,
        signal,
        how.busy,
      );
      const asked = question || imageQuestion;
      return {
        system: fitted.system,
        messages: [
          ...fitted.messages,
          userTurn(selection ? selectionPrompt(selection, asked) : asked, images, vision),
        ],
        // Questions about the document may need the web too, which the model decides.
        web: true,
        tools: how.lookup && partial ? readingTools : undefined,
        session: threadId,
        usage: fitted.usage,
      };
    });
  }
  // The conversation's last reply, when it's a 精读笔记 that can go on.
  private notesToGoOn(scope: Scope) {
    const last = [...(this.thread(scope)?.messages || [])]
      .reverse()
      .find((m) => m.role === 'assistant');
    return last && this.companionWork.has(last.id) ? last : null;
  }
  // “继续” after a 精读笔记 that was stopped or broke off: a new reply writes the rest of it.
  private continueNotes(ctx: ReadingContext, question: string, from: ChatMessage) {
    const started = this.begin(
      ctx.scope,
      { text: question },
      { docs: ctx.docs, draft: from.draft },
    );
    if (!started) return;
    this.setDraft(ctx.scope, '');
    return this.companion(ctx, started.threadId, started.answerId, started.signal, from.id);
  }
  private async readingSystem(
    ctx: ReadingContext,
    provider: AiProvider,
    config: AiConfig,
    query: string,
  ) {
    return (await this.readingContext(ctx, provider, config, query, false)).system;
  }
  // The instructions with the open documents. One too long for the window goes in from its
  // start, the same every time, the rest to look up with readingTools (`lookup`); without
  // those, the parts closest to the question go in instead.
  private async readingContext(
    ctx: ReadingContext,
    provider: AiProvider,
    config: AiConfig,
    query: string,
    lookup: boolean,
  ) {
    const budget = documentBudget(provider) / Math.max(1, ctx.docs.length);
    const blocks: string[] = [];
    let partial = false;
    for (const [i, d] of ctx.docs.entries()) {
      const doc = await this.host.docText(d.path);
      const context = documentContext(doc, budget, lookup ? '' : query);
      partial ||= context.partial;
      if (!context.text.trim())
        blocks.push(
          documentBlock(
            doc,
            doc.kind === 'pdf'
              ? '（这篇 PDF 没有可读取的文字，可能是扫描件。）'
              : '（这篇文档没有可读取的文字。）',
            i + 1,
            false,
          ),
        );
      else blocks.push(documentBlock(doc, context.text, i + 1, context.partial, lookup));
    }
    return { system: withDocuments(readingSystem(config.prefs, ctx.docs.length), blocks), partial };
  }
  // A reply as the model is to see it in the conversation: what it's told the reply was, and
  // where an unfinished one broke off.
  private said(m: ChatMessage, vision: boolean, agent = false): WireMessage {
    if (m.role === 'user') {
      const asked = m.text || (agent ? imageRequest : imageQuestion);
      return userTurn(m.selection ? selectionPrompt(m.selection, asked) : asked, m.images, vision);
    }
    const text = (
      m.parts
        ? m.parts
            .map((p) =>
              p.type === 'text' ? p.text : `（${p.step.title}：${p.step.detail || p.step.status}）`,
            )
            .join('\n')
        : m.text
    ).trim();
    if (m.said !== undefined) return { role: 'assistant', content: m.said };
    const content =
      m.status === 'stopped'
        ? text
          ? `${text}\n\n${unfinished.stopped}`
          : unfinished.stopped
        : m.status === 'error'
          ? text
            ? `${text}\n\n${unfinished.error(m.error || '')}`
            : unfinished.empty(m.error || '')
          : text || '（没有回答）';
    return { role: 'assistant', content };
  }
  // The conversation before a question, from where its summary ends, as the model sees it.
  private conversation(thread: ChatThread, before: ChatMessage[], vision: boolean) {
    const from = thread.summary ? before.findIndex((m) => m.id === thread.summary!.upTo) + 1 : 0;
    const wire = before.slice(from).map((m) => this.said(m, vision, thread.mode === 'agent'));
    while (wire[0]?.role === 'assistant') wire.shift();
    return wire;
  }
  // The conversation to send with the instructions: all of it while it fits, as Codex keeps
  // its own, the instructions and earlier turns the same from one question to the next. Once
  // it doesn't fit, its earlier part is summarized (compactPrompt) and the summary goes into
  // the instructions, until it outgrows the room again.
  private async fit(
    scope: Scope,
    threadId: string,
    before: ChatMessage[],
    system: string,
    provider: AiProvider,
    vision: boolean,
    signal: AbortSignal,
    busy: () => void,
  ): Promise<{ system: string; messages: WireMessage[]; usage?: Usage | null }> {
    const thread = this.history(scope).threads.find((t) => t.id === threadId);
    if (!thread) return { system, messages: [] };
    const messages = this.conversation(thread, before, vision);
    const withEarlier = withSummary(system, thread.summary?.text);
    const room = historyRoom(provider, estimateTokens(withEarlier));
    if (size(messages) <= room) return { system: withEarlier, messages };
    // The latest turns stay as they are, about a third of the room; the rest is summarized.
    const from = thread.summary ? before.findIndex((m) => m.id === thread.summary!.upTo) + 1 : 0;
    const open = before.slice(from);
    let cut = open.length;
    for (let i = open.length - 1, kept = 0; i >= 0; i--) {
      kept += size([this.said(open[i], vision, thread.mode === 'agent')]);
      if (kept > room * 0.35) break;
      if (open[i].role === 'user') cut = i;
    }
    if (!cut) return { system: withEarlier, messages };
    busy();
    const lines = open.slice(0, cut).map((m) => {
      const turn = this.said(m, vision, thread.mode === 'agent');
      const pictures = m.images?.length ? `（附图 ${m.images.length} 张）` : '';
      return `${turn.role === 'user' ? '用户' : '助手'}：${pictures}${turn.content}`;
    });
    // What the model can read in one go; the oldest beyond that is left to the summary before.
    let transcript = '';
    for (const line of [...lines].reverse()) {
      if (estimateTokens(transcript + line) > provider.context * 0.5) {
        transcript = `（更早的部分太长，已省略）\n\n${transcript}`;
        break;
      }
      transcript = transcript ? `${line}\n\n${transcript}` : line;
    }
    const rest = this.conversation({ ...thread, summary: undefined }, open.slice(cut), vision);
    try {
      const result = await chat(
        {
          system: compactSystem,
          messages: [
            { role: 'user', content: compactPrompt(thread.summary?.text || '', transcript) },
          ],
          maxTokens: 4_000,
        },
        { signal },
      );
      const summary = result.text.trim();
      if (!summary) throw Error('没有生成摘要');
      this.updateThread(scope, threadId, (t) => ({
        ...t,
        summary: { text: summary, upTo: open[cut - 1].id },
      }));
      return { system: withSummary(system, summary), messages: rest, usage: result.usage };
    } catch (e) {
      if (isAbort(e)) throw e;
      // No summary this time: the earlier part is left out.
      return { system: withEarlier, messages: rest };
    }
  }
  // Runs a reply into an answer message and checks its citations afterwards. A reply that
  // looks things up (readingTools) goes back and forth until it answers.
  private async stream(
    ctx: ReadingContext,
    threadId: string,
    answerId: string,
    signal: AbortSignal,
    build: (
      provider: AiProvider,
      config: AiConfig,
      how: { lookup: boolean; busy: () => void },
    ) => Promise<Built | string>,
    options: { canSaveNote?: boolean } = {},
  ) {
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      this.patchMessage(ctx.scope, threadId, answerId, fn);
    const tidying = '正在整理较早的对话…';
    const how = { lookup: true, busy: () => patch((m) => ({ ...m, text: tidying })) };
    try {
      const { provider, config } = await this.provider();
      let request = await build(provider, config, how);
      if (typeof request === 'string') {
        patch((m) => ({ ...m, text: request as string, status: 'done' }));
        return;
      }
      patch((m) => (m.text === tidying ? { ...m, text: '' } : m));
      let usage = request.usage ?? null;
      let wire = request.messages;
      let result;
      let gap = false;
      for (let round = 0; ; round++) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        let streamed = false;
        try {
          result = await chat(
            {
              system: request.system,
              messages: wire,
              web: request.web,
              tools: request.tools,
              session: request.session,
            },
            {
              signal,
              onText: (d) => {
                streamed = true;
                patch((m) => ({ ...m, text: m.text + (gap && m.text ? '\n\n' : '') + d }));
                gap = false;
              },
              onReasoning: (d) => patch((m) => ({ ...m, reasoning: (m.reasoning || '') + d })),
              // Each search it ran, shown above the answer as a step.
              onSearch: ({ id, title, done }) =>
                this.step(patch, {
                  id: `web-${id}`,
                  tool: 'web_search',
                  title,
                  status: done ? 'done' : 'running',
                }),
            },
          );
        } catch (e) {
          // A service that can't take tools answers from the parts closest to the question.
          if (
            round === 0 &&
            !streamed &&
            request.tools &&
            !isAbort(e) &&
            /tool|function/i.test(errorText(e))
          ) {
            const again = await build(provider, config, { ...how, lookup: false });
            if (typeof again === 'string') throw e;
            request = again;
            wire = again.messages;
            round = -1;
            continue;
          }
          throw e;
        }
        usage = sum(usage, result.usage);
        if (!result.toolCalls.length) break;
        // It asked again after being told it was out of lookups.
        if (round > lookupRounds) {
          patch((m) => ({ ...m, error: '查阅文档的步骤太多，已停下。可以换个问法再试。' }));
          break;
        }
        // Out of lookups: its calls are answered with that, and it answers from what it found.
        const outOfLookups = round === lookupRounds;
        wire = [
          ...wire,
          {
            role: 'assistant',
            content: result.text,
            toolCalls: result.toolCalls,
            reasoning: result.reasoning,
            raw: result.raw,
          },
        ];
        for (const call of result.toolCalls) {
          if (signal.aborted) throw new DOMException('已停止', 'AbortError');
          wire.push({
            role: 'tool',
            toolCallId: call.id,
            ...(outOfLookups
              ? {
                  content:
                    '查阅次数已经用完，不能再查了。请根据已经查到的内容回答；没查到的部分，直接告诉用户没有查到。',
                }
              : await this.lookUp(ctx, call, patch)),
          });
        }
        gap = true;
      }
      const looked = wire !== request.messages;
      patch((m) => ({
        ...m,
        text: looked ? m.text : result.text || m.text,
        reasoning: result.reasoning || m.reasoning,
        status: 'done',
        model: `${result.provider} · ${result.model}`,
        quota: result.quota,
        usage,
        canSaveNote: options.canSaveNote,
        error:
          m.error ||
          (result.stopReason === 'max_tokens'
            ? '回答达到长度上限，被截断了'
            : result.stopReason === 'refusal'
              ? '模型拒绝回答这个问题'
              : undefined),
      }));
      void this.verify(ctx.scope, threadId, answerId);
    } catch (e) {
      patch((m) => (m.text === tidying ? { ...m, text: '' } : m));
      if (isAbort(e)) patch((m) => ({ ...m, status: 'stopped' }));
      else patch((m) => ({ ...m, status: 'error', error: errorText(e) }));
    } finally {
      this.finish(threadId);
    }
  }
  // A step shown above an answer: a web search, or a look into the document.
  private step(patch: (fn: (m: ChatMessage) => ChatMessage) => void, step: AgentStep) {
    patch((m) => {
      const searches = m.searches || [];
      return {
        ...m,
        searches: searches.some((s) => s.id === step.id)
          ? searches.map((s) => (s.id === step.id ? step : s))
          : [...searches, step],
      };
    });
  }
  // Runs one of readingTools on the open documents only.
  private async lookUp(
    ctx: ReadingContext,
    call: ToolCall,
    patch: (fn: (m: ChatMessage) => ChatMessage) => void,
  ) {
    if (!readingTools.some((t) => t.name === call.name))
      return { content: `没有名为 ${call.name} 的工具。`, isError: true };
    // The open documents, also one opened from outside the project.
    const files = () =>
      ctx.docs.map(
        (d) =>
          this.host.files().find((f) => f.path === d.path) || {
            path: d.path,
            kind: /\.pdf$/i.test(d.path) ? ('pdf' as const) : ('html' as const),
          },
      );
    const host = new Proxy(this.host, {
      get: (target, key) => (key === 'files' ? files : (target as any)[key]),
    });
    const tool = prepareTool(call.name, call.input, {
      host,
      text: (path) => this.text(path),
      progress: () => {},
    });
    const id = `read-${call.id}`;
    this.step(patch, { id, tool: call.name, title: tool.title, status: 'running' });
    try {
      const outcome = await tool.run();
      this.step(patch, {
        id,
        tool: call.name,
        title: tool.title,
        status: outcome.isError ? 'error' : 'done',
        detail: outcome.detail,
      });
      return { content: outcome.content, isError: outcome.isError };
    } catch (e) {
      const message = errorText(e);
      this.step(patch, {
        id,
        tool: call.name,
        title: tool.title,
        status: 'error',
        detail: message,
      });
      return { content: `出错：${message}`, isError: true };
    }
  }
  // Marks citations the document doesn't contain, so they aren't mistaken for quotes.
  async verify(scope: Scope, threadId: string, messageId: string) {
    const message = this.history(scope)
      .threads.find((t) => t.id === threadId)
      ?.messages.find((m) => m.id === messageId);
    if (!message) return;
    const text = [
      message.text,
      ...(message.parts || []).map((p) => (p.type === 'text' ? p.text : '')),
    ].join('\n');
    const cites = citations(text);
    if (!cites.length) return;
    const byPath = new Map<string, { doc: string; quote: string }[]>();
    for (const c of cites) {
      const path = this.citePath(message, c.doc);
      if (!path) continue;
      byPath.set(path, [...(byPath.get(path) || []), c]);
    }
    const found: Record<string, boolean> = {};
    for (const [path, list] of byPath) {
      try {
        const anchors = await this.host.anchors(
          path,
          list.map((c) => c.quote),
        );
        list.forEach((c, i) => (found[citeKey(c.doc, c.quote)] = !!anchors[i]));
      } catch {}
    }
    this.patchMessage(scope, threadId, messageId, (m) => ({ ...m, cites: found }));
  }
  citePath(message: ChatMessage, doc: string) {
    const files = this.host.files();
    if (message.docs?.length) {
      const index = doc ? Number(doc) - 1 : 0;
      if (Number.isInteger(index) && message.docs[index]) return message.docs[index].path;
    }
    if (doc && files.some((f) => f.path === doc)) return doc;
    const byName = doc && files.find((f) => fileName(f.path) === doc);
    if (byName) return byName.path;
    return message.docs?.[0]?.path || this.host.activePath();
  }
  async flash(message: ChatMessage, doc: string, quote: string) {
    const path = this.citePath(message, doc);
    if (!path) return;
    const ok = await this.host.flash(path, quote).catch(() => false);
    if (!ok) this.host.notify('没有在原文中找到这段引用', true);
  }
  async highlightQuote(message: ChatMessage, doc: string, quote: string) {
    const path = this.citePath(message, doc);
    if (!path) return;
    const [anchor] = await this.host.anchors(path, [quote]);
    if (!anchor) return this.host.notify('没有在原文中找到这段引用', true);
    await this.host.addAnnotations(path, [
      {
        id: newId(),
        type: 'highlight',
        color: highlightKinds.观点.color,
        quote: anchor,
        note: '',
        createdAt: now(),
        by: 'ai',
      },
    ]);
    this.host.notify('已添加高亮');
  }
  // Appends an answer to its document's note with the question it answers (see answerNote).
  async saveToNote(scope: Scope, threadId: string, message: ChatMessage, question?: ChatMessage) {
    const path = message.docs?.[0]?.path || this.host.activePath();
    if (!path) return;
    // A picture that can't be kept (an unusual format) is left out rather than failing the rest.
    const pictures: string[] = [];
    for (const image of question?.images || [])
      await this.host.saveNoteImage(image).then(
        (name) => pictures.push(name),
        () => {},
      );
    const { data } = await this.host.documentData(path);
    const block = answerNote({
      question,
      pictures,
      answer: plainCites(message.text).trim(),
      date: new Date().toLocaleDateString('zh-CN'),
    });
    await this.host.setNote(path, data.note.trim() ? `${data.note.trimEnd()}\n\n${block}` : block);
    this.patchMessage(scope, threadId, message.id, (m) => ({ ...m, savedNote: path }));
    this.host.notify(`已存入「${fileName(path)}」的笔记，可在右侧“笔记”页查看`);
  }
  showNote(path: string, find = '') {
    return this.host.showNote(path, find);
  }
  // Keeps a selection card's result as part of the document's conversation.
  keepExchange(scope: Scope, docs: CiteDoc[], user: Partial<ChatMessage>, answer: string) {
    this.add(scope, user, { docs, text: answer, status: 'done' });
  }

  private cardController: AbortController | null = null;
  private patchCard(id: string, fn: (c: SelectionCard) => SelectionCard) {
    this.set((s) => (s.card?.id === id ? { ...s, card: fn(s.card) } : s));
  }
  openCard(mode: SelectionCard['mode'], target: { docId: string; path: string; anchor: Anchor }) {
    this.cardController?.abort();
    const card: SelectionCard = {
      id: newId(),
      mode,
      ...target,
      selection: target.anchor.exact,
      text: '',
      status: 'idle',
    };
    this.set((s) => ({ ...s, card }), true);
    if (mode !== 'ask') void this.runCard(card.id);
  }
  askCard(question: string) {
    const card = this.state.card;
    if (!card || !question.trim()) return;
    this.patchCard(card.id, (c) => ({ ...c, question: question.trim() }));
    void this.runCard(card.id);
  }
  stopCard() {
    this.cardController?.abort();
  }
  closeCard() {
    this.cardController?.abort();
    this.set((s) => ({ ...s, card: null }), true);
  }
  private async runCard(id: string) {
    const card = this.state.card;
    if (!card || card.id !== id) return;
    const controller = new AbortController();
    this.cardController = controller;
    this.patchCard(id, (c) => ({ ...c, text: '', error: undefined, status: 'streaming' }));
    const use = card.mode === 'translate' ? 'translate' : 'explain';
    try {
      await this.provider(use);
      let task: { system: string; prompt: string; target?: string };
      if (card.mode === 'translate') task = translateTask(card.selection);
      else {
        const context = surrounding(await this.host.docText(card.path), card.selection);
        task =
          card.mode === 'explain'
            ? explainTask(card.selection, context)
            : askSelectionTask(card.selection, this.state.card?.question || '', context);
      }
      this.patchCard(id, (c) => ({ ...c, target: task.target }));
      const result = await chat(
        {
          system: task.system,
          messages: [{ role: 'user', content: task.prompt }],
          use,
        },
        {
          signal: controller.signal,
          onText: (d) => this.patchCard(id, (c) => ({ ...c, text: c.text + d })),
        },
      );
      this.patchCard(id, (c) => ({ ...c, text: result.text || c.text, status: 'done' }));
    } catch (e) {
      if (isAbort(e)) this.patchCard(id, (c) => ({ ...c, status: c.text ? 'done' : 'idle' }));
      else this.patchCard(id, (c) => ({ ...c, status: 'error', error: errorText(e) }));
    } finally {
      if (this.cardController === controller) this.cardController = null;
    }
  }
  // Saves the card's answer as a note on a new highlight of the selected text.
  async saveCard(color: string) {
    const card = this.state.card;
    if (!card?.text.trim()) return;
    const label =
      card.mode === 'translate'
        ? '译文'
        : card.mode === 'explain'
          ? 'AI 解释'
          : `问：${card.question}`;
    await this.host.addAnnotations(card.path, [
      {
        id: newId(),
        type: 'highlight',
        color,
        quote: card.anchor,
        note: `${label}\n${plainText(card.text)}`,
        createdAt: now(),
        by: 'ai',
      },
    ]);
    this.patchCard(card.id, (c) => ({ ...c, saved: true }));
  }
  // Moves the card's exchange into the document's conversation to keep asking there.
  continueCard(docs: CiteDoc[]) {
    const card = this.state.card;
    if (!card) return;
    const label = card.mode === 'ask' ? card.question || '' : `${cardLabels[card.mode]}选中的文字`;
    void this.load(card.docId).then(() => {
      this.keepExchange(
        card.docId,
        docs,
        { text: label, label: card.mode === 'ask' ? undefined : label, selection: card.selection },
        card.text,
      );
      this.closeCard();
    });
  }

  async runTask(ctx: ReadingContext, task: Task) {
    await this.load(ctx.scope);
    const started = this.begin(
      ctx.scope,
      { text: taskLabels[task], label: taskLabels[task] },
      { docs: ctx.docs },
    );
    if (!started) return;
    const { threadId, answerId, signal } = started;
    if (task === 'highlights') return this.highlights(ctx, threadId, answerId, signal);
    if (task === 'companion') return this.companion(ctx, threadId, answerId, signal);
    if (task === 'summary') return this.summary(ctx, threadId, answerId, signal);
    await this.stream(
      ctx,
      threadId,
      answerId,
      signal,
      async (provider, config) => {
        if (task === 'organize') {
          const { data } = await this.host.documentData(ctx.docs[0].path);
          const list = annotationsList(data.annotations);
          if (!list && !data.note.trim())
            return '这篇文档还没有文字批注或笔记。先高亮几处、写下想法，再让我帮你整理。';
          const system = await this.readingSystem(ctx, provider, config, list);
          return { system, messages: [{ role: 'user', content: organizePrompt(list, data.note) }] };
        }
        const prompt = task === 'compare' ? comparePrompt : questionsPrompt;
        const system = await this.readingSystem(ctx, provider, config, '');
        return { system, messages: [{ role: 'user', content: prompt }] };
      },
      { canSaveNote: true },
    );
  }
  // Whether a 精读笔记 that was stopped or broke off can go on from where it stopped.
  canResume(answerId: string) {
    return this.companionWork.has(answerId);
  }
  // Goes on writing it in the same reply.
  resumeCompanion(ctx: ReadingContext, threadId: string, answerId: string) {
    if (this.controllers.has(threadId) || !this.companionWork.has(answerId)) return;
    const signal = this.start(threadId);
    this.patchMessage(ctx.scope, threadId, answerId, (m) => ({
      ...m,
      status: 'streaming',
      error: undefined,
    }));
    return this.companion(ctx, threadId, answerId, signal);
  }
  private async summary(
    ctx: ReadingContext,
    threadId: string,
    answerId: string,
    signal: AbortSignal,
  ) {
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      this.patchMessage(ctx.scope, threadId, answerId, fn);
    await this.stream(
      ctx,
      threadId,
      answerId,
      signal,
      async (provider, config) => {
        const doc = await this.host.docText(ctx.docs[0].path);
        const budget = documentBudget(provider);
        const whole = documentContext(doc, budget);
        const system = readingSystem(config.prefs, 1);
        if (!whole.partial)
          return {
            system: withDocuments(system, [documentBlock(doc, whole.text, 1, false)]),
            messages: [{ role: 'user', content: summaryPrompt }],
          };
        // Too long for one request: summarize each part, then combine.
        const chunks = chunkDocument(doc, Math.min(40_000, Math.floor(budget * 0.8)));
        const parts: string[] = [];
        for (const [i, chunk] of chunks.entries()) {
          if (signal.aborted) throw new DOMException('已停止', 'AbortError');
          patch((m) => ({
            ...m,
            text: `正在阅读第 ${i + 1}/${chunks.length} 部分（${chunk.label}）…`,
          }));
          const result = await chat(
            {
              system: withDocuments(system, [documentBlock(doc, chunk.text, 1, false)]),
              messages: [{ role: 'user', content: chunkSummaryPrompt(chunk.label) }],
            },
            { signal },
          );
          parts.push(`【${chunk.label}】\n${result.text}`);
        }
        patch((m) => ({ ...m, text: '', partial: true }));
        return { system, messages: [{ role: 'user', content: combineSummaryPrompt(parts) }] };
      },
      { canSaveNote: true },
    );
  }
  // Writes a reading companion page for the document, saves it next to the document and
  // opens it alongside. `from` is a reply whose unfinished page this one goes on with.
  private async companion(
    ctx: ReadingContext,
    threadId: string,
    answerId: string,
    signal: AbortSignal,
    from = answerId,
  ) {
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      this.patchMessage(ctx.scope, threadId, answerId, fn);
    const source = ctx.docs[0].path;
    // Going on from a try that was stopped or broke off, or starting afresh.
    const work: CompanionWork = this.companionWork.get(from) || {
      notes: [],
      reply: '',
      model: '',
      usage: { input: 0, output: 0, cached: 0 },
      quota: null,
    };
    this.companionWork.delete(from);
    let finished = false;
    const track = (r: {
      provider: string;
      model: string;
      usage?: Usage | null;
      quota?: Quota | null;
    }) => {
      work.model = `${r.provider} · ${r.model}`;
      work.quota = r.quota ?? work.quota;
      if (r.usage)
        work.usage = {
          input: work.usage.input + r.usage.input,
          output: work.usage.output + r.usage.output,
          cached: work.usage.cached + r.usage.cached,
        };
    };
    try {
      const { provider, config } = await this.provider();
      const doc = await this.host.docText(source);
      if (!doc.text.trim() && !doc.pages?.some((p) => p.trim()))
        throw Error('这篇文档没有可读取的文字（可能是扫描版 PDF），无法制作精读笔记');
      // The model's thinking and what it is writing, open to look at while it works.
      const onReasoning = (d: string) =>
        patch((m) => ({ ...m, reasoning: (m.reasoning || '') + d }));
      const onDraft = (d: string) => patch((m) => ({ ...m, draft: (m.draft || '') + d }));
      const budget = documentBudget(provider, 0.5);
      const whole = documentContext(doc, budget);
      let material = documentBlock(doc, whole.text, 1, false);
      if (whole.partial && !work.ask) {
        // Too long for one request: take notes part by part, then write from the notes. Parts
        // read before an error aren't read again.
        const chunks = (work.chunks ||= chunkDocument(
          doc,
          Math.min(30_000, Math.floor(budget * 0.7)),
        ).slice(0, 24));
        const notes = work.notes;
        for (const [i, chunk] of chunks.entries()) {
          if (i < notes.length) continue;
          if (signal.aborted) throw new DOMException('已停止', 'AbortError');
          patch((m) => ({
            ...m,
            text: `正在通读第 ${i + 1}/${chunks.length} 部分（${chunk.label}）…`,
            draft: '',
          }));
          const r = await chat(
            {
              system: '你是细心的阅读助手，为稍后写精读笔记整理材料。用简体中文。',
              messages: [
                {
                  role: 'user',
                  content: `${documentBlock(doc, chunk.text, 1, false)}\n\n${companionChunkPrompt(chunk.label)}`,
                },
              ],
            },
            { signal, onText: onDraft, onReasoning },
          );
          track(r);
          notes.push(`【${chunk.label}】\n${r.text}`);
        }
        material = `${documentBlock(doc, chunks[0]?.text || '', 1, true)}\n\n各部分要点（按顺序）：\n\n${notes.join('\n\n')}`;
      }
      if (signal.aborted) throw new DOMException('已停止', 'AbortError');
      // A page cut off at the service's output limit, or by an error, is continued where it
      // stopped, so a long document still gets its whole notes page.
      const ask = (work.ask ||= {
        role: 'user',
        content: `${material}\n\n${companionPrompt(whole.partial)}`,
      });
      let reply = work.reply;
      let cut = false;
      let written = reply.length;
      let thought = 0;
      patch((m) =>
        reply
          ? { ...m, text: `正在接着写精读笔记…（已写 ${written.toLocaleString()} 字）` }
          : { ...m, text: '正在构思精读笔记…', draft: '' },
      );
      for (let round = 0; round < 8; round++) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        let current = '';
        const result = await chat(
          {
            system: companionSystem(config.prefs.profile),
            messages: reply
              ? [
                  ask,
                  { role: 'assistant', content: reply },
                  { role: 'user', content: companionContinue },
                ]
              : [ask],
            maxTokens: 32_000,
          },
          {
            signal,
            onReasoning: (d) => {
              thought += d.length;
              onReasoning(d);
              if (!written)
                patch((m) => ({
                  ...m,
                  text: `正在构思精读笔记…（已想 ${thought.toLocaleString()} 字，可展开“思考过程”查看）`,
                }));
            },
            onText: (d) => {
              written += d.length;
              current += d;
              onDraft(d);
              patch((m) => ({
                ...m,
                text: `正在写精读笔记…（已写 ${written.toLocaleString()} 字${round ? `，第 ${round + 1} 段` : ''}）`,
              }));
            },
          },
        ).catch((e) => {
          // What this round wrote is kept too.
          if (current) work.reply = reply ? joinContinuation(reply, current) : current;
          throw e;
        });
        track(result);
        reply = reply ? joinContinuation(reply, result.text) : result.text;
        work.reply = reply;
        cut = result.stopReason === 'max_tokens';
        if (!cut) break;
      }
      finished = true;
      const pdf = doc.kind === 'pdf' ? fileName(source) : undefined;
      const cleaned = cleanCompanion(reply, pdf);
      if (cleaned.sections < 3)
        throw Error(
          cut
            ? '笔记太长，续写多次仍没有写完。可以换用输出更长的模型再试。'
            : '模型没有写出完整的笔记，请再试一次。',
        );
      const page = companionPage({
        body: cleaned.body,
        title: cleaned.title,
        source,
        model: work.model,
        date: new Date().toLocaleDateString('zh-CN'),
      });
      const dir = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : '';
      const stem = fileName(source).replace(/\.[^.]+$/, '');
      const taken = new Set(this.host.files().map((f) => f.path));
      let target = `${dir}${stem}-精读笔记.html`;
      for (let n = 2; taken.has(target); n++) target = `${dir}${stem}-精读笔记（${n}）.html`;
      await this.host.createHtml(target, page);
      await this.host.openBeside(target, source);
      const text = [
        `已生成精读笔记 **${fileName(target)}**，保存在原文旁边，并在右栏打开。`,
        pdf ? '笔记里的页码可以点击，PDF 会跳到对应的页。' : '',
        '它是普通的 HTML 文档，可以像其他文档一样批注、修改源码。',
        cut ? '\n内容很长，续写多次后结尾仍可能不完整。' : '',
      ]
        .filter(Boolean)
        .join('');
      const { model, usage, quota } = work;
      const said = notesRecord(target, cleaned.body);
      patch((m) => ({ ...m, text, said, draft: undefined, status: 'done', model, usage, quota }));
      this.host.notify(`已生成精读笔记：${fileName(target)}`);
    } catch (e) {
      // Stopped, or broken off, before the page was all written: 接着写 goes on from the parts
      // read and the page so far.
      const progress = !finished && (work.reply || work.notes.length);
      if (progress) this.companionWork.set(answerId, work);
      const stopped = isAbort(e);
      const said = finished
        ? undefined
        : unfinishedNotes(work.reply, work.notes.length, stopped, stopped ? '' : errorText(e));
      if (stopped) patch((m) => ({ ...m, status: 'stopped', said }));
      else patch((m) => ({ ...m, status: 'error', error: errorText(e), said }));
    } finally {
      this.finish(threadId);
    }
  }
  private async highlights(
    ctx: ReadingContext,
    threadId: string,
    answerId: string,
    signal: AbortSignal,
  ) {
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      this.patchMessage(ctx.scope, threadId, answerId, fn);
    const path = ctx.docs[0].path;
    try {
      const { provider, config } = await this.provider();
      const doc = await this.host.docText(path);
      if (!doc.text.trim() && !doc.pages?.some((p) => p.trim()))
        throw Error('这篇文档没有可读取的文字');
      const budget = documentBudget(provider);
      const whole = documentContext(doc, budget);
      const system = readingSystem(config.prefs, 1);
      const requests = whole.partial
        ? chunkDocument(doc, Math.min(30_000, Math.floor(budget * 0.8)))
            .slice(0, 16)
            .map((c) => ({
              text: c.text,
              prompt: highlightsPrompt(highlightCount(c.tokens, 5), c.label),
              label: c.label,
            }))
        : [{ text: whole.text, prompt: highlightsPrompt(highlightCount(whole.tokens)), label: '' }];
      let model = '';
      let usage = { input: 0, output: 0, cached: 0 };
      let quota: Quota | null = null;
      const picked: { quote: string; note: string; kind: string }[] = [];
      for (const [i, r] of requests.entries()) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        patch((m) => ({
          ...m,
          text:
            requests.length > 1
              ? `正在挑选重点：第 ${i + 1}/${requests.length} 部分（${r.label}）…`
              : '正在通读全文、挑选重点…',
        }));
        const result = await chat(
          {
            system: withDocuments(system, [documentBlock(doc, r.text, 1, false)]),
            messages: [{ role: 'user', content: r.prompt }],
            json: true,
          },
          { signal },
        );
        model = `${result.provider} · ${result.model}`;
        quota = result.quota ?? quota;
        if (result.usage)
          usage = {
            input: usage.input + result.usage.input,
            output: usage.output + result.usage.output,
            cached: usage.cached + result.usage.cached,
          };
        const value = parseJson<{ highlights?: unknown[] } | unknown[]>(result.text);
        const list = Array.isArray(value) ? value : value?.highlights;
        if (!Array.isArray(list)) continue;
        for (const item of list as any[])
          if (typeof item?.quote === 'string' && item.quote.trim())
            picked.push({
              quote: item.quote.trim(),
              note: typeof item.note === 'string' ? item.note.trim() : '',
              kind: typeof item.kind === 'string' ? item.kind : '观点',
            });
      }
      const unique = picked.filter((p, i) => picked.findIndex((q) => q.quote === p.quote) === i);
      if (!unique.length) throw Error('模型没有返回可用的重点，请再试一次');
      patch((m) => ({ ...m, text: '正在把重点标到原文上…' }));
      const anchors = await this.host.anchors(
        path,
        unique.map((p) => p.quote),
      );
      const { data } = await this.host.documentData(path);
      const taken = data.annotations.filter((a) => a.quote).map((a) => a.quote!);
      const added: Annotation[] = [];
      const lines: string[] = [];
      const missing: string[] = [];
      let overlapping = 0;
      unique.forEach((p, i) => {
        const anchor = anchors[i];
        if (!anchor) return void missing.push(p.quote);
        if (taken.some((q) => q.start < anchor.end && anchor.start < q.end))
          return void overlapping++;
        if (added.some((a) => a.quote!.start < anchor.end && anchor.start < a.quote!.end)) return;
        const kind = highlightKinds[p.kind] || highlightKinds.观点;
        added.push({
          id: newId(),
          type: 'highlight',
          color: kind.color,
          quote: anchor,
          note: p.note ? `【${kind.label}】${p.note}` : `【${kind.label}】`,
          createdAt: now() + added.length,
          by: 'ai',
        });
        lines.push(`- **${kind.label}**：<cite>${p.quote}</cite>${p.note ? ` —— ${p.note}` : ''}`);
      });
      if (added.length) await this.host.addAnnotations(path, added);
      const undo = /Mac/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';
      const skipped = [
        overlapping ? `${overlapping} 处和已有的高亮重叠` : '',
        missing.length ? `${missing.length} 处没能在原文中找到` : '',
      ]
        .filter(Boolean)
        .join('，');
      const unfound = missing.length
        ? `\n\n没找到的句子（模型可能改写了原文）：\n${missing
            .slice(0, 3)
            .map((q) => `> ${q.slice(0, 120)}`)
            .join('\n>\n')}`
        : '';
      const text = added.length
        ? `已在原文中添加 **${added.length}** 处 AI 高亮，按颜色区分类型；每处都附了一句说明，点击高亮可以查看或修改。不满意可以按 ${undo} 一次全部撤销。\n\n${lines.join('\n')}` +
          (skipped ? `\n\n另有${skipped}，已跳过。` : '') +
          unfound
        : `没有添加新的高亮：挑出的 ${unique.length} 处里，${skipped}。${unfound}`;
      patch((m) => ({ ...m, text, status: 'done', model, usage, quota }));
      void this.verify(ctx.scope, threadId, answerId);
      if (added.length) this.host.notify(`已添加 ${added.length} 处 AI 高亮 · ${undo} 可撤销`);
    } catch (e) {
      if (isAbort(e)) patch((m) => ({ ...m, status: 'stopped' }));
      else patch((m) => ({ ...m, status: 'error', error: errorText(e) }));
    } finally {
      this.finish(threadId);
    }
  }

  // The project agent: the model reads, searches and proposes changes through tools; every
  // change waits for the user's approval unless they chose to apply the rest automatically.
  async agent(text: string, images: string[] = []) {
    const scope = 'project';
    const request = text.trim();
    if (!request && !images.length) return;
    await this.load(scope);
    const started = this.begin(
      scope,
      { text: request, ...(images.length ? { images } : {}) },
      { parts: [] },
    );
    if (!started) return;
    const { threadId, answerId, history, signal } = started;
    this.setDraft(scope, '');
    this.setAttachments(scope, []);
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      this.patchMessage(scope, threadId, answerId, fn);
    const setParts = (fn: (parts: MessagePart[]) => MessagePart[]) =>
      patch((m) => ({ ...m, parts: fn(m.parts || []) }));
    const patchStep = (id: string, fn: (s: AgentStep) => AgentStep) =>
      setParts((parts) =>
        parts.map((p) => (p.type === 'step' && p.step.id === id ? { ...p, step: fn(p.step) } : p)),
      );
    try {
      const { provider, config } = await this.provider();
      const files = this.host.files();
      if (!files.length) throw Error('项目中还没有 HTML 或 PDF 文档');
      const system = agentSystem(
        config.prefs,
        this.host.projectName(),
        files,
        this.host.activePath(),
      );
      const vision = !refusesImages(provider, loadedModelOptions(provider.id));
      const fitted = await this.fit(
        scope,
        threadId,
        history,
        system,
        provider,
        vision,
        signal,
        () => {},
      );
      const wire: WireMessage[] = [
        ...fitted.messages,
        userTurn(request || imageRequest, images, vision),
      ];
      let usage = fitted.usage ?? { input: 0, output: 0, cached: 0 };
      let model = '';
      let quota: Quota | null = null;
      for (let round = 0; round < 40; round++) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        this.trimWire(wire, provider);
        let partIndex = -1;
        const result = await chat(
          {
            system: fitted.system,
            messages: wire,
            tools: agentTools,
            web: true,
            session: threadId,
          },
          {
            signal,
            // A search the model ran on its own: a step that is done when the search is.
            onSearch: ({ id, title, done }) => {
              const stepId = `${threadId}:web-${id}`;
              const status = done ? 'done' : 'running';
              // What it writes after the search goes below it.
              if (!done) partIndex = -1;
              setParts((parts) =>
                parts.some((p) => p.type === 'step' && p.step.id === stepId)
                  ? parts.map((p) =>
                      p.type === 'step' && p.step.id === stepId
                        ? { ...p, step: { ...p.step, title, status } }
                        : p,
                    )
                  : [
                      ...parts,
                      { type: 'step', step: { id: stepId, tool: 'web_search', title, status } },
                    ],
              );
            },
            onText: (d) =>
              setParts((parts) => {
                if (partIndex === -1 || parts[partIndex]?.type !== 'text') {
                  partIndex = parts.length;
                  return [...parts, { type: 'text', text: d }];
                }
                return parts.map((p, i) =>
                  i === partIndex && p.type === 'text' ? { ...p, text: p.text + d } : p,
                );
              }),
            onReasoning: (d) => patch((m) => ({ ...m, reasoning: (m.reasoning || '') + d })),
          },
        );
        model = `${result.provider} · ${result.model}`;
        quota = result.quota ?? quota;
        if (result.usage)
          usage = {
            input: usage.input + result.usage.input,
            output: usage.output + result.usage.output,
            cached: usage.cached + result.usage.cached,
          };
        wire.push({
          role: 'assistant',
          content: result.text,
          toolCalls: result.toolCalls,
          reasoning: result.reasoning,
          raw: result.raw,
        });
        if (!result.toolCalls.length) {
          if (result.stopReason === 'max_tokens')
            patch((m) => ({ ...m, error: '回答达到长度上限，被截断了' }));
          break;
        }
        if (result.stopReason === 'max_tokens') {
          // A cut-off tool call has incomplete arguments; ask for a smaller step instead.
          for (const call of result.toolCalls)
            wire.push({
              role: 'tool',
              toolCallId: call.id,
              content:
                '输出达到长度上限，这次调用的参数不完整，没有执行。请把内容分成更小的几次调用。',
              isError: true,
            });
          continue;
        }
        for (const call of result.toolCalls) {
          if (signal.aborted) throw new DOMException('已停止', 'AbortError');
          const outcome = await this.runTool(threadId, call.name, call.input, {
            add: (step) => setParts((parts) => [...parts, { type: 'step', step }]),
            patch: patchStep,
          });
          wire.push({
            role: 'tool',
            toolCallId: call.id,
            content: outcome.content,
            isError: outcome.isError,
          });
        }
        if (round === 39)
          patch((m) => ({ ...m, error: '步骤太多，已暂停。可以回复“继续”让它接着做。' }));
      }
      patch((m) => ({ ...m, status: 'done', model, usage, quota }));
      void this.verify(scope, threadId, answerId);
    } catch (e) {
      if (isAbort(e)) patch((m) => ({ ...m, status: 'stopped' }));
      else patch((m) => ({ ...m, status: 'error', error: errorText(e) }));
      setParts((parts) =>
        parts.map((p) =>
          p.type === 'step' && (p.step.status === 'running' || p.step.status === 'waiting')
            ? { ...p, step: { ...p.step, status: 'skipped', detail: '已停止' } }
            : p,
        ),
      );
    } finally {
      this.finish(threadId);
    }
  }
  private async runTool(
    threadId: string,
    name: string,
    input: unknown,
    ui: {
      add: (step: AgentStep) => void;
      patch: (id: string, fn: (s: AgentStep) => AgentStep) => void;
    },
  ) {
    const stepId = `${threadId}:${newId()}`;
    const tool: PreparedTool & { prepare?: () => Promise<void> } = prepareTool(name, input, {
      host: this.host,
      text: (path) => this.text(path),
      progress: (detail) => ui.patch(stepId, (s) => ({ ...s, detail })),
    });
    ui.add({ id: stepId, tool: name, title: tool.title, status: 'running' });
    try {
      await tool.prepare?.();
      if (writeTools.has(name) && tool.preview) {
        ui.patch(stepId, (s) => ({
          ...s,
          title: tool.title,
          preview: tool.preview,
          status: 'waiting',
          detail: undefined,
        }));
        const ok =
          this.state.autoApply[threadId] ||
          (await new Promise<boolean>((resolve) => this.approvals.set(stepId, resolve)));
        if (!ok) {
          ui.patch(stepId, (s) => ({ ...s, status: 'skipped', detail: '已跳过' }));
          return {
            content: '用户没有同意这个修改，未执行。不要再次提出同样的修改。',
            isError: true,
          };
        }
        ui.patch(stepId, (s) => ({ ...s, status: 'running', detail: '正在应用…' }));
      }
      const outcome = await tool.run();
      ui.patch(stepId, (s) => ({
        ...s,
        status: outcome.isError ? 'error' : 'done',
        detail: outcome.detail || (outcome.isError ? outcome.content.slice(0, 120) : s.detail),
      }));
      if (writeTools.has(name) && !outcome.isError) this.forgetText();
      return outcome;
    } catch (e) {
      const message = errorText(e);
      ui.patch(stepId, (s) => ({ ...s, status: 'error', detail: message.slice(0, 160) }));
      return { content: `出错：${message}`, isError: true };
    }
  }
  // Keeps a long run within the model's window by dropping the oldest tool output first.
  private trimWire(wire: WireMessage[], provider: AiProvider) {
    const limit = Math.min(provider.context * 0.7, 400_000);
    let total = wire.reduce(
      (n, m) => n + estimateTokens(m.content) + (m.images?.length || 0) * imageTokens + 20,
      0,
    );
    for (let i = 0; i < wire.length - 3 && total > limit; i++) {
      const m = wire[i];
      if (m.role !== 'tool' || m.content.length < 400) continue;
      total -= estimateTokens(m.content);
      m.content = '（早先读取的内容已省略以节省空间；需要时请重新读取。）';
    }
  }
}

export function useAssistantState(store: Assistant) {
  return useSyncExternalStore(store.subscribe, store.get);
}
// Only the selection card, so the app shell doesn't re-render on every streamed word.
export function useAssistantCard(store: Assistant) {
  return useSyncExternalStore(store.subscribe, () => store.get().card);
}
