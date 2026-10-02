import { useSyncExternalStore } from 'react';
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
import {
  agentSystem,
  annotationsList,
  askSelectionTask,
  explainTask,
  translateTask,
  chunkSummaryPrompt,
  combineSummaryPrompt,
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
  withDocuments,
} from './prompts';
import { agentTools, prepareTool, writeTools } from './agent-tools';
import {
  cleanCompanion,
  companionChunkPrompt,
  companionContinue,
  companionPage,
  companionPrompt,
  companionSystem,
  joinContinuation,
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
  // Adds a question and an empty reply to the scope's current conversation.
  private begin(scope: Scope, user: Partial<ChatMessage>, reply: Partial<ChatMessage> = {}) {
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
    const history = thread.messages.filter((m) => m.status !== 'error');
    this.updateThread(scope, thread.id, (t) => ({
      ...t,
      title: t.messages.length ? t.title : titleFrom(question),
      updatedAt: now(),
      messages: [...t.messages, question, answer],
    }));
    const controller = new AbortController();
    this.controllers.set(thread.id, controller);
    this.set((s) => ({ ...s, running: { ...s.running, [thread!.id]: true } }), true);
    return { threadId: thread.id, answerId: answer.id, history, signal: controller.signal };
  }
  private finish(threadId: string) {
    this.controllers.delete(threadId);
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
    this.setDraft(ctx.scope, '');
    this.setAttachments(ctx.scope, []);
    await this.load(ctx.scope);
    const { threadId, answerId, history, signal } = this.begin(
      ctx.scope,
      { text: question, selection, ...(images.length ? { images } : {}) },
      { docs: ctx.docs },
    );
    await this.stream(ctx, threadId, answerId, signal, async (provider, config) => {
      const system = await this.readingSystem(
        ctx,
        provider,
        config,
        question + ' ' + (selection || ''),
      );
      const vision = !refusesImages(provider, loadedModelOptions(provider.id));
      const messages: WireMessage[] = [];
      let budget = Math.max(4_000, provider.context * 0.15);
      for (const m of [...history].reverse()) {
        if (m.role === 'assistant' && m.status !== 'done' && m.status !== 'stopped') continue;
        const content =
          m.role === 'user'
            ? m.selection
              ? selectionPrompt(m.selection, m.text || imageQuestion)
              : m.text || imageQuestion
            : m.text || '（没有回答）';
        budget -= estimateTokens(content) + (vision ? (m.images?.length || 0) * imageTokens : 0);
        if (budget < 0) break;
        messages.unshift(
          m.role === 'user' ? userTurn(content, m.images, vision) : { role: 'assistant', content },
        );
      }
      while (messages[0]?.role === 'assistant') messages.shift();
      const asked = question || imageQuestion;
      messages.push(
        userTurn(selection ? selectionPrompt(selection, asked) : asked, images, vision),
      );
      // Questions about the document may need the web too, which the model decides.
      return { system, messages, web: true };
    });
  }
  private async readingSystem(
    ctx: ReadingContext,
    provider: AiProvider,
    config: AiConfig,
    query: string,
  ) {
    const budget = documentBudget(provider) / Math.max(1, ctx.docs.length);
    const blocks: string[] = [];
    for (const [i, d] of ctx.docs.entries()) {
      const doc = await this.host.docText(d.path);
      const context = documentContext(doc, budget, query);
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
      else blocks.push(documentBlock(doc, context.text, i + 1, context.partial));
    }
    return withDocuments(readingSystem(config.prefs, ctx.docs.length), blocks);
  }
  // Runs one streamed reply into an answer message and checks its citations afterwards.
  private async stream(
    ctx: ReadingContext,
    threadId: string,
    answerId: string,
    signal: AbortSignal,
    build: (
      provider: AiProvider,
      config: AiConfig,
    ) => Promise<{ system: string; messages: WireMessage[]; web?: boolean } | string>,
    options: { canSaveNote?: boolean } = {},
  ) {
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      this.patchMessage(ctx.scope, threadId, answerId, fn);
    try {
      const { provider, config } = await this.provider();
      const request = await build(provider, config);
      if (typeof request === 'string') {
        patch((m) => ({ ...m, text: request, status: 'done' }));
        return;
      }
      if (signal.aborted) throw new DOMException('已停止', 'AbortError');
      const result = await chat(request, {
        signal,
        onText: (d) => patch((m) => ({ ...m, text: m.text + d })),
        onReasoning: (d) => patch((m) => ({ ...m, reasoning: (m.reasoning || '') + d })),
        // Each search it ran, shown above the answer as a step.
        onSearch: ({ id, title, done }) =>
          patch((m) => {
            const step = {
              id: `web-${id}`,
              tool: 'web_search',
              title,
              status: done ? 'done' : 'running',
            } as const;
            const searches = m.searches || [];
            return {
              ...m,
              searches: searches.some((s) => s.id === step.id)
                ? searches.map((s) => (s.id === step.id ? step : s))
                : [...searches, step],
            };
          }),
      });
      patch((m) => ({
        ...m,
        text: result.text || m.text,
        reasoning: result.reasoning || m.reasoning,
        status: 'done',
        model: `${result.provider} · ${result.model}`,
        quota: result.quota,
        usage: result.usage,
        canSaveNote: options.canSaveNote,
        error:
          result.stopReason === 'max_tokens'
            ? '回答达到长度上限，被截断了'
            : result.stopReason === 'refusal'
              ? '模型拒绝回答这个问题'
              : undefined,
      }));
      void this.verify(ctx.scope, threadId, answerId);
    } catch (e) {
      if (isAbort(e)) patch((m) => ({ ...m, status: 'stopped' }));
      else patch((m) => ({ ...m, status: 'error', error: errorText(e) }));
    } finally {
      this.finish(threadId);
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
  async saveToNote(scope: Scope, threadId: string, message: ChatMessage, heading: string) {
    const path = message.docs?.[0]?.path || this.host.activePath();
    if (!path) return;
    const { data } = await this.host.documentData(path);
    const date = new Date().toLocaleDateString('zh-CN');
    const block = `## ${heading}（${date}）\n\n${plainCites(message.text).trim()}`;
    await this.host.setNote(path, data.note.trim() ? `${data.note.trimEnd()}\n\n${block}` : block);
    this.patchMessage(scope, threadId, message.id, (m) => ({ ...m, savedNote: path }));
    this.host.notify(`已存入「${fileName(path)}」的笔记，可在右侧“笔记”页查看`);
  }
  showNote(path: string) {
    return this.host.showNote(path);
  }
  // Keeps a selection card's result as part of the document's conversation.
  keepExchange(scope: Scope, docs: CiteDoc[], user: Partial<ChatMessage>, answer: string) {
    const { threadId, answerId } = this.begin(scope, user, { docs });
    this.patchMessage(scope, threadId, answerId, (m) => ({ ...m, text: answer, status: 'done' }));
    this.finish(threadId);
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
    const { threadId, answerId, signal } = this.begin(
      ctx.scope,
      { text: taskLabels[task], label: taskLabels[task] },
      { docs: ctx.docs },
    );
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
  // opens it alongside.
  private async companion(
    ctx: ReadingContext,
    threadId: string,
    answerId: string,
    signal: AbortSignal,
  ) {
    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      this.patchMessage(ctx.scope, threadId, answerId, fn);
    const source = ctx.docs[0].path;
    let model = '';
    let usage = { input: 0, output: 0, cached: 0 };
    let quota: Quota | null = null;
    const track = (r: {
      provider: string;
      model: string;
      usage?: Usage | null;
      quota?: Quota | null;
    }) => {
      model = `${r.provider} · ${r.model}`;
      quota = r.quota ?? quota;
      if (r.usage)
        usage = {
          input: usage.input + r.usage.input,
          output: usage.output + r.usage.output,
          cached: usage.cached + r.usage.cached,
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
      if (whole.partial) {
        // Too long for one request: take notes part by part, then write from the notes.
        const chunks = chunkDocument(doc, Math.min(30_000, Math.floor(budget * 0.7))).slice(0, 24);
        const notes: string[] = [];
        for (const [i, chunk] of chunks.entries()) {
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
      patch((m) => ({ ...m, text: '正在构思精读笔记…', draft: '' }));
      // A page cut off at the service's output limit is continued where it stopped, so a
      // long document still gets its whole notes page.
      const ask: WireMessage = {
        role: 'user',
        content: `${material}\n\n${companionPrompt(whole.partial)}`,
      };
      let reply = '';
      let cut = false;
      let written = 0;
      let thought = 0;
      for (let round = 0; round < 8; round++) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        const result = await chat(
          {
            system: companionSystem(config.prefs.profile),
            messages: round
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
              onDraft(d);
              patch((m) => ({
                ...m,
                text: `正在写精读笔记…（已写 ${written.toLocaleString()} 字${round ? `，第 ${round + 1} 段` : ''}）`,
              }));
            },
          },
        );
        track(result);
        reply = round ? joinContinuation(reply, result.text) : result.text;
        cut = result.stopReason === 'max_tokens';
        if (!cut) break;
      }
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
        model,
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
      patch((m) => ({ ...m, text, draft: undefined, status: 'done', model, usage, quota }));
      this.host.notify(`已生成精读笔记：${fileName(target)}`);
    } catch (e) {
      if (isAbort(e)) patch((m) => ({ ...m, status: 'stopped' }));
      else patch((m) => ({ ...m, status: 'error', error: errorText(e) }));
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
    this.setDraft(scope, '');
    this.setAttachments(scope, []);
    await this.load(scope);
    const { threadId, answerId, history, signal } = this.begin(
      scope,
      { text: request, ...(images.length ? { images } : {}) },
      { parts: [] },
    );
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
      const wire: WireMessage[] = [];
      for (const m of history) {
        if (m.role === 'user') wire.push(userTurn(m.text || imageRequest, m.images, vision));
        else {
          const said = (m.parts || [])
            .map((p) =>
              p.type === 'text' ? p.text : `（${p.step.title}：${p.step.detail || p.step.status}）`,
            )
            .join('\n')
            .trim();
          if (said) wire.push({ role: 'assistant', content: said });
        }
      }
      while (wire[0]?.role === 'assistant') wire.shift();
      wire.push(userTurn(request || imageRequest, images, vision));
      let usage = { input: 0, output: 0, cached: 0 };
      let model = '';
      let quota: Quota | null = null;
      for (let round = 0; round < 40; round++) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        this.trimWire(wire, provider);
        let partIndex = -1;
        const result = await chat(
          { system, messages: wire, tools: agentTools, web: true },
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
