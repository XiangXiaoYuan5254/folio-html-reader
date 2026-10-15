import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  BookOpenText,
  Bot,
  Brain,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleStop,
  CircleX,
  Copy,
  FileText,
  Highlighter,
  ImagePlus,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Plus,
  MinusCircle,
  NotebookPen,
  Quote,
  RotateCcw,
  Scale,
  Settings2,
  Sparkle,
  SquareDashedMousePointer,
  Trash2,
  X,
} from 'lucide-react';
import { invoke } from '../api';
import { activeProvider, providerReady, useAiConfig } from '../ai/client';
import type { AgentStep, ChatMessage, ChatThread } from '../ai/types';
import { citeKey, plainCites, taskLabels, useAssistantState } from '../ai/assistant';
import type { Assistant, ReadingContext, Task } from '../ai/assistant';
import { Markdown } from '../ai/Markdown';
import { fileName } from '../ai/context';
import { draftText } from '../ai/companion';
import { DiffView } from './DiffView';
import { ModelMenu } from './ModelMenu';
import { IconButton } from './IconButton';
import { RegionCapture } from './RegionCapture';
import { ImageViewer } from './ImageViewer';
import { isImageFile, maxImages, prepareImage, refusesImages } from '../ai/images';
import { loadedModelOptions } from '../ai/levels';

export type AssistantMode = 'doc' | 'project';
const taskIcons: Record<Task, typeof FileText> = {
  summary: FileText,
  highlights: Highlighter,
  companion: BookOpenText,
  organize: ListChecks,
  questions: Lightbulb,
  compare: Scale,
};
const agentExamples = [
  '给每篇文档写三句话摘要，追加到各自的笔记里',
  '找出所有提到“方法”或“实验”的段落，告诉我分别在哪几篇',
  '把我在各篇文档里的批注整理成一篇复习讲义 HTML',
];

export function AssistantPanel(p: {
  store: Assistant;
  mode: AssistantMode;
  onMode: (mode: AssistantMode) => void;
  reading: ReadingContext | null;
  selection: string;
  onClearSelection: () => void;
  onOpenSettings: () => void;
  hasFiles: boolean;
}) {
  const config = useAiConfig();
  const state = useAssistantState(p.store);
  const scope = p.mode === 'project' ? 'project' : p.reading?.scope || '';
  useEffect(() => {
    if (scope) void p.store.load(scope);
  }, [scope]);
  const history = scope ? state.histories[scope] : undefined;
  const thread =
    history?.threads.find((t) => t.id === history.active) || history?.threads[0] || undefined;
  const running = !!thread && !!state.running[thread.id];
  const draft = state.drafts[scope] || '';
  const [attach, setAttach] = useState(true);
  useEffect(() => setAttach(true), [p.selection]);
  const attached = p.mode === 'doc' && attach && p.selection.trim() ? p.selection.trim() : '';
  const provider = activeProvider(config);
  const ready = providerReady(provider, config);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const images = state.attachments[scope] || [];
  const [capturing, setCapturing] = useState(false);
  const [viewing, setViewing] = useState('');
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // Pictures are scaled down as they arrive; the latest list is read when each one is ready.
  async function addImages(sources: (Blob | string)[]) {
    if (!scope || !sources.length) return;
    const room = maxImages - (p.store.get().attachments[scope]?.length || 0);
    if (room <= 0) return p.store.notify(`每次最多附 ${maxImages} 张图片`, true);
    try {
      const ready = await Promise.all(sources.slice(0, room).map((s) => prepareImage(s)));
      p.store.setAttachments(scope, [...(p.store.get().attachments[scope] || []), ...ready]);
      if (sources.length > room) p.store.notify(`每次最多附 ${maxImages} 张图片`, true);
    } catch {
      p.store.notify('这张图片读取不了，换成 PNG 或 JPG 再试', true);
    }
    input.current?.focus();
  }
  const blocked = images.length > 0 && refusesImages(provider, loadedModelOptions(provider?.id));
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(180, el.scrollHeight) + 'px';
  }, [draft]);
  function send() {
    const text = draft.trim();
    if ((!text && !images.length) || blocked || running || !scope) return;
    stick.current = true;
    if (p.mode === 'project') void p.store.agent(text, images);
    else if (p.reading) {
      void p.store.ask(p.reading, text, attached || undefined, images);
      if (attached) p.onClearSelection();
    }
  }
  function task(t: Task) {
    if (!p.reading || running) return;
    stick.current = true;
    void p.store.runTask(p.reading, t);
  }
  const tasks: Task[] = ['summary', 'highlights', 'companion', 'organize', 'questions'];
  if ((p.reading?.docs.length || 0) > 1) tasks.push('compare');
  const noDocument = p.mode === 'doc' && !p.reading;
  return (
    <div
      className={`assistant-panel${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!scope || noDocument || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length && !files.some(isImageFile))
          return p.store.notify('只能拖入图片（PNG、JPG、WebP、GIF）', true);
        void addImages(files.filter(isImageFile));
      }}
    >
      <div className="assistant-bar">
        <div className="assistant-mode" role="tablist" aria-label="助手范围">
          <button
            role="tab"
            aria-selected={p.mode === 'doc'}
            className={p.mode === 'doc' ? 'active' : ''}
            onClick={() => p.onMode('doc')}
            title="就当前文档提问（双栏时包含两篇）"
          >
            {p.reading && p.reading.docs.length > 1 ? '这两篇' : '本文'}
          </button>
          <button
            role="tab"
            aria-selected={p.mode === 'project'}
            className={p.mode === 'project' ? 'active' : ''}
            onClick={() => p.onMode('project')}
            title="让 AI 在整个项目里阅读、搜索和整理"
          >
            <Bot size={13} />
            整个项目
          </button>
        </div>
        <div className="assistant-threads">
          <button
            className="assistant-thread-button"
            disabled={!history?.threads.length}
            onClick={() => setThreadsOpen((v) => !v)}
            aria-expanded={threadsOpen}
            title="历史对话"
          >
            <span>{thread?.messages.length ? thread.title : '新对话'}</span>
            <ChevronDown size={13} />
          </button>
          {threadsOpen && history ? (
            <ThreadMenu
              threads={history.threads}
              active={thread?.id}
              running={state.running}
              onPick={(id) => {
                p.store.selectThread(scope, id);
                setThreadsOpen(false);
              }}
              onDelete={(id) => p.store.deleteThread(scope, id)}
              onClose={() => setThreadsOpen(false)}
            />
          ) : null}
        </div>
        <button
          type="button"
          className="assistant-new"
          title="开始一段新对话，之前的对话在左边的下拉列表里"
          disabled={!scope || !thread?.messages.length}
          onClick={() => {
            p.store.newThread(scope);
            input.current?.focus();
          }}
        >
          <Plus size={13} />
          新对话
        </button>
        <IconButton label="AI 设置" onClick={p.onOpenSettings}>
          <Settings2 size={15} />
        </IconButton>
      </div>
      <div
        className="assistant-messages"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {config && !config.providers.length ? (
          <SetupCard onOpen={p.onOpenSettings} />
        ) : noDocument ? (
          <div className="assistant-empty">
            <FileText size={24} />
            <h3>打开一篇文档后提问</h3>
            <p>也可以切换到“整个项目”，让 AI 在所有文档里搜索和整理。</p>
          </div>
        ) : p.mode === 'project' && !p.hasFiles ? (
          <div className="assistant-empty">
            <h3>项目里还没有文档</h3>
            <p>把 HTML 或 PDF 放进项目文件夹后再试。</p>
          </div>
        ) : !thread?.messages.length ? (
          <div className="assistant-empty">
            <div className="empty-icon assistant-icon">
              {p.mode === 'project' ? <Bot size={24} /> : <Sparkle size={24} />}
            </div>
            <h3>{p.mode === 'project' ? '让 AI 在整个项目里干活' : '问问这篇文档'}</h3>
            <p>
              {p.mode === 'project'
                ? 'AI 会自己阅读、搜索文档。添加高亮、写笔记、修改或新建 HTML 之前，都会先请你确认。'
                : '回答会标出原文出处，点击编号即可跳到原文。选中文字后提问，会针对选中的部分回答。'}
            </p>
            {p.mode === 'doc' ? (
              <div className="assistant-tasks">
                {tasks.map((t) => {
                  const Icon = taskIcons[t];
                  return (
                    <button key={t} onClick={() => task(t)} disabled={!ready}>
                      <Icon size={14} />
                      {taskLabels[t]}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="assistant-examples">
                {agentExamples.map((e) => (
                  <button key={e} onClick={() => p.store.setDraft(scope, e)}>
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          thread.messages.map((m) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} message={m} onView={setViewing} />
            ) : (
              <AnswerMessage
                key={m.id}
                message={m}
                thread={thread}
                store={p.store}
                scope={scope}
                running={running}
                autoApply={!!state.autoApply[thread.id]}
              />
            ),
          )
        )}
      </div>
      {p.mode === 'doc' && thread?.messages.length && p.reading ? (
        <div className="assistant-chips">
          {tasks.map((t) => (
            <button key={t} onClick={() => task(t)} disabled={running || !ready}>
              {taskLabels[t]}
            </button>
          ))}
        </div>
      ) : null}
      <div className={`assistant-composer ${noDocument ? 'disabled' : ''}`}>
        {images.length ? (
          <div className="assistant-images" aria-label="要发送的图片">
            {images.map((src, i) => (
              <figure key={i}>
                <img src={src} alt={`图片 ${i + 1}`} onClick={() => setViewing(src)} />
                <button
                  type="button"
                  aria-label={`移除图片 ${i + 1}`}
                  onClick={() =>
                    p.store.setAttachments(
                      scope,
                      images.filter((_, j) => j !== i),
                    )
                  }
                >
                  <X size={11} />
                </button>
              </figure>
            ))}
          </div>
        ) : null}
        {blocked ? (
          <p className="assistant-vision-note" role="alert">
            {provider?.model} 不能看图。在下方换一个标有
            <ImagePlus size={11} aria-label="能看图" />
            的模型，或移除图片。
          </p>
        ) : null}
        {attached ? (
          <div className="assistant-attached">
            <Quote size={12} />
            <span>{attached}</span>
            <button aria-label="不引用选中的文字" onClick={() => setAttach(false)}>
              <X size={12} />
            </button>
          </div>
        ) : null}
        <textarea
          ref={input}
          rows={1}
          aria-label="向 AI 提问"
          disabled={noDocument || !scope}
          placeholder={
            p.mode === 'project'
              ? '让 AI 在项目里帮你做事…'
              : attached
                ? '就选中的文字提问…'
                : '就这篇文档提问…'
          }
          value={draft}
          onChange={(e) => scope && p.store.setDraft(scope, e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter(isImageFile);
            if (!files.length) return;
            if (!e.clipboardData.getData('text/plain')) e.preventDefault();
            void addImages(files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="assistant-composer-foot">
          <ModelMenu onOpenSettings={p.onOpenSettings} />
          <IconButton
            className="assistant-tool"
            label="框选区域问 AI"
            help="在窗口里拖出一个框，把框住的图表、公式或扫描页发给 AI"
            disabled={noDocument || !scope}
            onClick={() => setCapturing(true)}
          >
            <SquareDashedMousePointer size={15} />
          </IconButton>
          <IconButton
            className="assistant-tool"
            label="添加图片"
            help="也可以直接粘贴截图，或把图片拖到这里"
            disabled={noDocument || !scope}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus size={15} />
          </IconButton>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              void addImages(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
          {running ? (
            <button
              className="assistant-send stop"
              aria-label="停止"
              title="停止"
              onClick={() => thread && p.store.stop(thread.id)}
            >
              <CircleStop size={16} />
            </button>
          ) : (
            <button
              className="assistant-send"
              aria-label="发送"
              title="发送（Enter）· 换行（Shift+Enter）"
              disabled={(!draft.trim() && !images.length) || blocked || !scope || noDocument}
              onClick={send}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      {capturing ? (
        <RegionCapture
          onCancel={() => setCapturing(false)}
          onError={(message) => {
            setCapturing(false);
            p.store.notify(message, true);
          }}
          onCapture={(png) => {
            setCapturing(false);
            void addImages([png]);
          }}
        />
      ) : null}
      {viewing ? <ImageViewer src={viewing} onClose={() => setViewing('')} /> : null}
    </div>
  );
}

function SetupCard({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="assistant-empty assistant-setup">
      <div className="empty-icon assistant-icon">
        <Sparkle size={24} />
      </div>
      <h3>接入你自己的 AI</h3>
      <p>
        填入 API Key 即可使用 DeepSeek、通义千问、Kimi、智谱、豆包、Claude、OpenAI、Gemini；也可以用
        ChatGPT 账号（通过 Codex 登录）、Kimi 会员（通过 Kimi Code 登录），或在本机运行的 Ollama。
      </p>
      <button className="primary-button" onClick={onOpen}>
        配置 AI 服务
      </button>
      <ul>
        <li>总结全文、标出重点、整理批注</li>
        <li>选中文字即可解释、翻译、提问</li>
        <li>让 AI 在整个项目里搜索、写笔记、改 HTML</li>
      </ul>
    </div>
  );
}

function ThreadMenu(p: {
  threads: ChatThread[];
  active?: string;
  // Conversations with a reply going, marked so none runs out of sight.
  running: Record<string, true>;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      if (!menu.current?.parentElement?.contains(e.target as Node)) p.onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, []);
  const shown = p.threads.filter((t) => t.messages.length);
  return (
    <div className="assistant-thread-menu" ref={menu} role="menu">
      {shown.length ? (
        shown.map((t) => (
          <div key={t.id} className={`assistant-thread-item ${t.id === p.active ? 'active' : ''}`}>
            <button role="menuitem" onClick={() => p.onPick(t.id)}>
              <span>
                {p.running[t.id] ? (
                  <LoaderCircle className="spin" size={11} aria-label="正在回答" />
                ) : t.unseen ? (
                  <i className="assistant-thread-unseen" aria-label="有新回复，还没看" />
                ) : null}
                {t.title}
              </span>
              <time>{when(t.updatedAt)}</time>
            </button>
            <IconButton label="删除这段对话" onClick={() => p.onDelete(t.id)}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))
      ) : (
        <p>还没有历史对话</p>
      )}
    </div>
  );
}
function when(time: number) {
  const d = new Date(time);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function UserMessage({ message, onView }: { message: ChatMessage; onView: (src: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="chat-user">
      {message.selection ? (
        <blockquote className="chat-selection" title={message.selection}>
          {message.selection}
        </blockquote>
      ) : null}
      {message.images?.length ? (
        <div className="chat-images">
          {message.images.map((src, i) => (
            <img key={i} src={src} alt={`图片 ${i + 1}`} onClick={() => onView(src)} />
          ))}
        </div>
      ) : null}
      {message.label || message.text ? (
        <div className={`chat-bubble ${message.label ? 'task' : ''}`}>
          {message.label || message.text}
        </div>
      ) : null}
      {message.text && !message.label ? (
        <button
          className="chat-user-copy"
          title="复制这条消息"
          onClick={() => {
            void navigator.clipboard.writeText(message.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      ) : null}
    </div>
  );
}

// What a long piece has written so far, followed to its end unless scrolled back.
function LiveDraft({ draft }: { draft: string }) {
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const toEnd = () => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(toEnd, [draft]);
  return (
    <details className="chat-reasoning chat-draft" onToggle={toEnd}>
      <summary>
        <FileText size={12} />
        查看正在写的内容
      </summary>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {draftText(draft)}
      </div>
    </details>
  );
}

function AnswerMessage(p: {
  message: ChatMessage;
  thread: ChatThread;
  store: Assistant;
  scope: string;
  // Something in the conversation is still going; 重试 waits until it's over.
  running: boolean;
  autoApply: boolean;
}) {
  const m = p.message;
  const streaming = m.status === 'streaming';
  const [copied, setCopied] = useState(false);
  const renderCite = ({ n, doc, quote }: { n: number; doc: string; quote: string }) => {
    const found = m.cites?.[citeKey(doc, quote)];
    return (
      <CiteChip
        n={n}
        quote={quote}
        found={found}
        label={
          doc && m.docs && m.docs.length > 1 ? `第 ${doc} 篇` : doc && !m.docs ? fileName(doc) : ''
        }
        onJump={() => void p.store.flash(m, doc, quote)}
        onHighlight={() => void p.store.highlightQuote(m, doc, quote)}
      />
    );
  };
  const onLink = (url: string) => void invoke('external', { url });
  const text = m.parts
    ? m.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n\n')
    : m.text;
  const empty = !text.trim() && !m.parts?.length;
  const index = p.thread.messages.indexOf(m);
  const question = p.thread.messages[index - 1];
  const resume = p.store.canResume(m.id);
  return (
    <div className={`chat-answer ${m.status || ''}`}>
      {m.reasoning ? (
        <details className="chat-reasoning">
          <summary>
            <Brain size={12} />
            {streaming && empty ? '正在思考…' : '思考过程'}
          </summary>
          <div>{m.reasoning}</div>
        </details>
      ) : null}
      {m.parts ? (
        m.parts.map((part, i) =>
          part.type === 'text' ? (
            <Markdown
              key={i}
              text={part.text}
              streaming={streaming && i === m.parts!.length - 1}
              renderCite={renderCite}
              onLink={onLink}
            />
          ) : (
            <StepCard
              key={part.step.id}
              step={part.step}
              autoApply={p.autoApply}
              onApprove={(ok) => p.store.approve(part.step.id, ok)}
              onAutoApply={(v) => p.store.setAutoApply(p.thread.id, v)}
              onShowNote={(path, find) => void p.store.showNote(path, find)}
            />
          ),
        )
      ) : (
        <>
          {m.searches?.map((step) => (
            <StepCard
              key={step.id}
              step={step}
              autoApply={p.autoApply}
              onApprove={() => {}}
              onAutoApply={() => {}}
              onShowNote={() => {}}
            />
          ))}
          <Markdown text={m.text} streaming={streaming} renderCite={renderCite} onLink={onLink} />
        </>
      )}
      {m.draft ? <LiveDraft draft={m.draft} /> : null}
      {streaming && empty && !m.reasoning ? (
        <div className="chat-waiting">
          <LoaderCircle className="spin" size={14} />
          正在组织回答…
        </div>
      ) : null}
      {m.status === 'error' || m.error ? (
        <div className="chat-error" role="alert">
          <CircleX size={14} />
          <span>{m.error || '出错了'}</span>
          {m.status === 'error' && question?.role === 'user' && !m.parts && !p.running ? (
            <button
              onClick={() => {
                const reading = m.docs?.length ? { scope: p.scope, docs: m.docs } : null;
                if (!reading) return;
                if (resume) return void p.store.resumeCompanion(reading, p.thread.id, m.id);
                const task = (Object.keys(taskLabels) as Task[]).find(
                  (t) => taskLabels[t] === question.label,
                );
                if (task) void p.store.runTask(reading, task);
                else void p.store.ask(reading, question.text, question.selection, question.images);
              }}
            >
              <RotateCcw size={12} />
              {resume ? '接着写' : '重试'}
            </button>
          ) : null}
        </div>
      ) : null}
      {m.status === 'stopped' ? (
        <div className="chat-note">
          已停止
          {resume && m.docs?.length && !p.running ? (
            <button
              onClick={() =>
                void p.store.resumeCompanion({ scope: p.scope, docs: m.docs! }, p.thread.id, m.id)
              }
            >
              <RotateCcw size={12} />
              接着写
            </button>
          ) : null}
        </div>
      ) : null}
      {!streaming && !empty ? (
        <div className="chat-actions">
          <button
            title="复制回答"
            onClick={() => {
              void navigator.clipboard.writeText(plainCites(text).trim());
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
          {m.docs?.length && m.status === 'done' ? (
            m.savedNote ? (
              <button
                title={`打开「${fileName(m.savedNote)}」的笔记，定位到这条回答`}
                onClick={() => void p.store.showNote(m.savedNote!, plainCites(m.text).trim())}
              >
                <Check size={12} />
                已存入 · 查看笔记
              </button>
            ) : (
              <button
                title="追加到这篇文档的笔记"
                onClick={() =>
                  void p.store.saveToNote(
                    p.scope,
                    p.thread.id,
                    m,
                    question?.role === 'user' ? question : undefined,
                  )
                }
              >
                <NotebookPen size={12} />
                存入笔记
              </button>
            )
          ) : null}
          {m.model ? <UsageMeta message={m} /> : null}
        </div>
      ) : null}
    </div>
  );
}
// The model under a reply. Hovering it, or clicking to keep it open, shows what the reply
// used; the browser's own title tip came late and went at the slightest move.
function UsageMeta({ message }: { message: ChatMessage }) {
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tip, setTip] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [pinned, setPinned] = useState(false);
  const place = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 110 > innerHeight;
    setTip({
      // Half the tip's widest, and a little: it stays inside the window.
      left: Math.max(170, Math.min(innerWidth - 170, rect.left + rect.width / 2)),
      top: above ? rect.top - 6 : rect.bottom + 6,
      above,
    });
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPinned(false);
    setTip(null);
  };
  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => {
      if (!button.current?.contains(e.target as Node)) hide();
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', hide);
    };
  }, [pinned]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const [model, ...lines] = usageText(message).split('\n');
  return (
    <>
      <button
        ref={button}
        type="button"
        className="chat-meta"
        aria-expanded={!!tip}
        onMouseEnter={() => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(place, 200);
        }}
        onMouseLeave={() => {
          if (timer.current) clearTimeout(timer.current);
          if (!pinned) setTip(null);
        }}
        onClick={() => {
          if (pinned) return hide();
          setPinned(true);
          place();
        }}
      >
        {message.model}
      </button>
      {tip
        ? createPortal(
            <div
              role="tooltip"
              className={`tool-tooltip usage-tooltip${tip.above ? ' above' : ''}`}
              style={{ left: tip.left, top: tip.top }}
            >
              <strong>{model}</strong>
              {lines.length ? (
                lines.map((line) => <span key={line}>{line}</span>)
              ) : (
                <span>这个服务没有返回用量</span>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
function usageText(m: ChatMessage) {
  const lines = [m.model || ''];
  if (m.usage) {
    const { input, output, cached } = m.usage;
    // How much of the input the service had cached, as a share of it.
    const share = input ? Math.round((cached / input) * 100) : 0;
    lines.push(
      `输入 ${input.toLocaleString()} tokens${cached ? `（缓存命中 ${share || '<1'}%）` : ''}`,
      `输出 ${output.toLocaleString()} tokens`,
    );
  }
  if (m.quota) {
    const hours =
      m.quota.windowMins >= 60 ? `${Math.round(m.quota.windowMins / 60)} 小时` : '当前周期';
    lines.push(`ChatGPT 套餐的 Codex 额度：近 ${hours}已用 ${m.quota.usedPercent}%`);
  }
  return lines.join('\n');
}

function CiteChip(p: {
  n: number;
  quote: string;
  found?: boolean;
  label: string;
  onJump: () => void;
  onHighlight: () => void;
}) {
  // The popover is placed in the window, so the sidebar's scrolling can't clip it.
  const [open, setOpen] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const host = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!host.current?.contains(target) && !pop.current?.contains(target)) setOpen(null);
    };
    const close = () => setOpen(null);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  function toggle() {
    if (open) return setOpen(null);
    const r = host.current!.getBoundingClientRect();
    const above = r.top > 190;
    setOpen({
      left: Math.max(8, Math.min(innerWidth - 268, r.left + r.width / 2 - 130)),
      top: above ? r.top - 8 : r.bottom + 8,
      above,
    });
  }
  const missing = p.found === false;
  return (
    <span className="cite" ref={host}>
      <button
        className={`cite-chip ${missing ? 'missing' : ''}`}
        aria-label={`引用 ${p.n}${missing ? '（未在原文中找到）' : ''}：${p.quote}`}
        title={missing ? '没有在原文中找到这段引用' : p.quote}
        onClick={() => {
          toggle();
          if (!missing) p.onJump();
        }}
      >
        {p.n}
      </button>
      {open
        ? createPortal(
            <span
              ref={pop}
              className="cite-pop"
              role="dialog"
              aria-label="引用的原文"
              style={{
                left: open.left,
                top: open.top,
                transform: open.above ? 'translateY(-100%)' : undefined,
              }}
            >
              <span className="cite-quote">
                {p.label ? <em>{p.label}</em> : null}
                {p.quote}
              </span>
              {missing ? (
                <span className="cite-missing">
                  没有在原文中找到这段文字，可能是模型改写了原句。
                </span>
              ) : (
                <span className="cite-actions">
                  <button onClick={p.onJump}>定位原文</button>
                  <button
                    onClick={() => {
                      p.onHighlight();
                      setOpen(null);
                    }}
                  >
                    <Highlighter size={12} />
                    高亮这句
                  </button>
                </span>
              )}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

const stepIcons = {
  running: LoaderCircle,
  waiting: CircleDashed,
  done: CircleCheck,
  error: CircleX,
  skipped: MinusCircle,
};
// What the agent added to the end of a note; nothing when it rewrote the whole note.
function addedToNote({ before, after }: { before: string; after: string }) {
  const kept = before.trimEnd();
  return after.startsWith(kept) ? after.slice(kept.length).trim() : '';
}
function StepCard(p: {
  step: AgentStep;
  autoApply: boolean;
  onApprove: (ok: boolean) => void;
  onAutoApply: (value: boolean) => void;
  onShowNote: (path: string, find: string) => void;
}) {
  const s = p.step;
  const Icon = stepIcons[s.status];
  const notePreview = s.preview?.kind === 'note' ? s.preview : null;
  const waiting = s.status === 'waiting';
  return (
    <div className={`agent-step ${s.status}`}>
      <div className="agent-step-head">
        <Icon size={14} className={s.status === 'running' ? 'spin' : ''} />
        <span className="agent-step-title">{s.title}</span>
      </div>
      {s.detail ? (
        <div className="agent-step-detail">
          {s.detail}
          {notePreview && s.status === 'done' ? (
            <button onClick={() => p.onShowNote(notePreview.path, addedToNote(notePreview))}>
              查看笔记
            </button>
          ) : null}
        </div>
      ) : null}
      {s.preview && waiting ? <StepPreview step={s} /> : null}
      {s.preview && !waiting && s.status !== 'running' ? (
        <details className="agent-step-more">
          <summary>查看{s.status === 'done' ? '已应用的' : ''}改动</summary>
          <StepPreview step={s} />
        </details>
      ) : null}
      {waiting ? (
        <div className="agent-approve">
          <button className="primary-button" onClick={() => p.onApprove(true)}>
            应用
          </button>
          <button className="secondary-button" onClick={() => p.onApprove(false)}>
            跳过
          </button>
          <label>
            <input
              type="checkbox"
              checked={p.autoApply}
              onChange={(e) => {
                p.onAutoApply(e.target.checked);
                if (e.target.checked) p.onApprove(true);
              }}
            />
            本次任务自动应用后面的修改
          </label>
        </div>
      ) : null}
    </div>
  );
}
function StepPreview({ step }: { step: AgentStep }) {
  const v = step.preview!;
  if (v.kind === 'highlights')
    return (
      <ul className="agent-highlights">
        {v.items.map((item, i) => (
          <li key={i} className={item.found ? '' : 'missing'}>
            <i style={{ background: item.color }} />
            <div>
              <q>{item.quote}</q>
              {item.note ? <span>{item.note}</span> : null}
              {item.found ? null : <em>未在原文中找到，不会添加</em>}
            </div>
          </li>
        ))}
      </ul>
    );
  if (v.kind === 'download')
    return (
      <div className="agent-create">
        {v.title ? <div>{v.title}</div> : null}
        <pre>{v.url}</pre>
      </div>
    );
  if (v.kind === 'create')
    return (
      <div className="agent-create">
        <div>
          {v.path} · {v.content.length.toLocaleString()} 字符
        </div>
        <pre>{v.content.slice(0, 4000)}</pre>
      </div>
    );
  return <DiffView before={v.before} after={v.after} maxHeight={260} />;
}
