import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CircleStop,
  CircleX,
  History,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import type { OpenDocument } from '../types';
import type { Assistant } from '../ai/assistant';
import { chat, errorText, isAbort, providerFor, useAiConfig } from '../ai/client';
import { documentBudget, estimateTokens } from '../ai/context';
import { diffText } from '../ai/diff';
import { applyReply } from '../ai/edits';
import { loadEditHistory, saveEditHistory } from '../ai/edit-history';
import type { EditHistory, EditThread, EditTurnRecord } from '../ai/edit-history';
import { imageTokens, isImageFile, maxImages, prepareImage, refusesImages } from '../ai/images';
import { loadedModelOptions } from '../ai/levels';
import { sourceEditPrompt, sourceEditSystem } from '../ai/prompts';
import { Markdown } from '../ai/Markdown';
import { DiffView } from './DiffView';
import { IconButton } from './IconButton';
import { ImageViewer } from './ImageViewer';
import { ModelMenu } from './ModelMenu';
import { kindName } from '../doc-kind';

// Changes waiting for review: every round's reply so far, applied in order on top of `base`.
type Proposal = {
  base: string;
  replies: string[];
  source: string;
  failed: string[];
};
const newId = (): string => crypto.randomUUID();
const titleOf = (turn: EditTurnRecord) =>
  (turn.request || '按图片修改').replace(/\s+/g, ' ').slice(0, 28);
const when = (time: number) => {
  const d = new Date(time);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};
const examples = {
  html: [
    '改成深色配色',
    '给表格加上斑马纹和表头底色',
    '把正文字号调大一些，行距更宽松',
    '在开头加一个目录',
  ],
  markdown: ['在开头加一个目录', '把要点整理成表格', '修正错别字和标点', '把这篇改写得更简洁'],
};

// The source with each reply's edits applied in turn, or null once one no longer fits.
function replay(source: string, replies: string[], kind: 'html' | 'markdown') {
  let next = source;
  for (const reply of replies) {
    const edit = applyReply(next, reply, kind);
    if (!edit.applied || edit.failed.length) return null;
    next = edit.source;
  }
  return next;
}

// Source mode: describe a change, review the diff, then apply it to the editor. Not happy
// with it? Keep talking: the next round edits on top of it, and remembers the earlier ones.
export function AiSourceEdit(p: {
  doc: OpenDocument;
  store: Assistant;
  editorSelection: () => string;
  onPreview: (source: string | null) => void;
  onApply: (source: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const kind = p.doc.kind === 'markdown' ? 'markdown' : 'html';
  const [request, setRequest] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // Conversations about this file, newest first, and the one being shown.
  const [threads, setThreads] = useState<EditThread[]>([]);
  const [activeId, setActiveId] = useState(newId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [place, setPlace] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>();
  const [showOriginal, setShowOriginal] = useState(false);
  // Screenshots of the page, or how it should look, sent with the request.
  const [images, setImages] = useState<string[]>([]);
  const [viewing, setViewing] = useState('');
  const [dropping, setDropping] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const threadBox = useRef<HTMLDivElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyMenu = useRef<HTMLDivElement>(null);
  // Saving: conversations change as turns are added and settled; saves are delayed, and the
  // last one before the panel closes is written on the way out.
  const latest = useRef({ threads, activeId });
  latest.current = { threads, activeId };
  const dirty = useRef(false);
  const started = useRef(false);
  const activeThread = threads.find((t) => t.id === activeId);
  const turns = activeThread?.turns || [];
  const savedThreads = [...threads]
    .filter((t) => t.turns.length)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const provider = providerFor(useAiConfig(), 'edit');
  const blocked = images.length > 0 && refusesImages(provider, loadedModelOptions(provider?.id));
  // Pictures are scaled down as they arrive; the latest list is used when each one is ready.
  async function addImages(sources: Blob[]) {
    if (!sources.length) return;
    const room = maxImages - images.length;
    if (room <= 0) return p.store.notify(`每次最多附 ${maxImages} 张图片`, true);
    try {
      const ready = await Promise.all(sources.slice(0, room).map((s) => prepareImage(s)));
      setImages((now) => [...now, ...ready].slice(0, maxImages));
      if (sources.length > room) p.store.notify(`每次最多附 ${maxImages} 张图片`, true);
    } catch {
      p.store.notify('这张图片读取不了，换成 PNG 或 JPG 再试', true);
    }
    input.current?.focus();
  }
  // Earlier conversations about this file, loaded when the panel opens; those started while
  // loading stay ahead of them.
  useEffect(() => {
    let live = true;
    void loadEditHistory(p.doc.id).then((h) => {
      if (!live) return;
      const saved = (h?.threads || [])
        .filter((t) => Array.isArray(t?.turns) && t.turns.length)
        // A change still waiting for review when the panel closed was never applied.
        .map((t) => ({
          ...t,
          turns: t.turns.map((turn) =>
            turn.outcome === 'pending' ? { ...turn, outcome: 'discarded' as const } : turn,
          ),
        }));
      setThreads((local) => [...local, ...saved.filter((s) => !local.some((t) => t.id === s.id))]);
      if (!started.current && h?.active) {
        const active = saved.find((t) => t.id === h.active);
        // A new conversation started before closing comes back empty, not as the one before.
        setActiveId(active?.id || newId());
      } else if (!started.current && saved.length) {
        const newest = [...saved].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        setActiveId(newest.id);
      }
    });
    return () => {
      live = false;
    };
  }, [p.doc.id]);
  function persist() {
    if (!dirty.current) return Promise.resolve();
    dirty.current = false;
    const now = latest.current;
    const data: EditHistory = {
      version: 1,
      active: now.activeId,
      threads: now.threads
        .filter((t) => t.turns.length)
        .slice(0, 40)
        .map((t) => ({
          ...t,
          turns: t.turns.map((turn) =>
            turn.outcome === 'pending' ? { ...turn, outcome: 'discarded' as const } : turn,
          ),
        })),
    };
    return saveEditHistory(p.doc.id, data).catch((e) =>
      p.store.notify('修改记录保存失败：' + errorText(e), true),
    );
  }
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void persist(), 500);
    return () => clearTimeout(timer);
  }, [threads, activeId]);
  useEffect(() => {
    input.current?.focus();
    return () => {
      controller.current?.abort();
      p.onPreview(null);
      void persist();
    };
  }, []);
  useEffect(() => {
    p.onPreview(proposal && !showOriginal ? proposal.source : null);
  }, [proposal, showOriginal]);
  useLayoutEffect(() => {
    if (threadBox.current) threadBox.current.scrollTop = threadBox.current.scrollHeight;
  }, [turns.length, activeId]);
  function addTurn(turn: EditTurnRecord) {
    const at = Date.now();
    dirty.current = true;
    started.current = true;
    setThreads((all) =>
      all.some((t) => t.id === activeId)
        ? all.map((t) =>
            t.id === activeId ? { ...t, updatedAt: at, turns: [...t.turns, turn] } : t,
          )
        : [
            { id: activeId, title: titleOf(turn), createdAt: at, updatedAt: at, turns: [turn] },
            ...all,
          ],
    );
  }
  function settle(outcome: 'applied' | 'discarded') {
    dirty.current = true;
    setThreads((all) =>
      all.map((t) =>
        t.id === activeId
          ? {
              ...t,
              updatedAt: Date.now(),
              turns: t.turns.map((x) => (x.outcome === 'pending' ? { ...x, outcome } : x)),
            }
          : t,
      ),
    );
  }
  function discard() {
    setProposal(null);
    settle('discarded');
  }
  // Starts a fresh conversation; the one shown stays in the history list.
  function restart() {
    if (proposal) {
      setProposal(null);
      settle('discarded');
    }
    dirty.current = true;
    started.current = true;
    setActiveId(newId());
    setStatus('idle');
    setError('');
    setShowOriginal(false);
    setImages([]);
    input.current?.focus();
  }
  function selectThread(id: string) {
    if (id === activeId) return setHistoryOpen(false);
    controller.current?.abort();
    if (proposal) {
      setProposal(null);
      settle('discarded');
    }
    dirty.current = true;
    started.current = true;
    setActiveId(id);
    setStatus('idle');
    setError('');
    setShowOriginal(false);
    setImages([]);
    setHistoryOpen(false);
    input.current?.focus();
  }
  function removeThread(id: string) {
    dirty.current = true;
    started.current = true;
    const left = threads.filter((t) => t.id !== id);
    if (id === activeId) {
      controller.current?.abort();
      setProposal(null);
      setStatus('idle');
      setError('');
      setShowOriginal(false);
      setImages([]);
      setActiveId(left[0]?.id || newId());
    }
    if (!left.length) setHistoryOpen(false);
    setThreads(left);
  }
  useLayoutEffect(() => {
    if (!historyOpen || !historyButton.current) return;
    const r = historyButton.current.getBoundingClientRect();
    const width = 286;
    const room = 320;
    const left = Math.max(8, Math.min(r.right - width, innerWidth - width - 8));
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    setPlace(
      below >= Math.min(room, above)
        ? { left, top: r.bottom + 6, maxHeight: Math.min(room, below) }
        : { left, bottom: innerHeight - r.top + 6, maxHeight: Math.min(room, above) },
    );
  }, [historyOpen]);
  useEffect(() => {
    if (!historyOpen) return;
    const dismiss = (e: PointerEvent) => {
      const t = e.target as Node;
      if (historyMenu.current?.contains(t) || historyButton.current?.contains(t)) return;
      setHistoryOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setHistoryOpen(false);
    };
    const close = () => setHistoryOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [historyOpen]);
  async function run() {
    const text = request.trim();
    if ((!text && !images.length) || blocked || status === 'running') return;
    const base = p.doc.draft;
    // Feedback on changes still waiting: the next round works on top of them.
    let pending = proposal;
    if (pending && pending.base !== base) {
      const source = replay(base, pending.replies, kind);
      if (source === null) {
        discard();
        p.store.notify('源码在这期间改动过，刚才的修改已对不上，这次按现在的源码来改', true);
        pending = null;
      } else pending = { ...pending, base, source };
    }
    const working = pending ? pending.source : base;
    setStatus('running');
    setError('');
    setProgress(0);
    const c = new AbortController();
    controller.current = c;
    try {
      const { provider } = await p.store.provider('edit');
      const selected = p.editorSelection();
      const content = sourceEditPrompt(
        p.doc.path,
        working,
        text,
        selected || undefined,
        images.length,
        turns.map(({ request, explanation, outcome }) => ({
          request,
          explanation,
          outcome: pending ? outcome : outcome === 'pending' ? 'discarded' : outcome,
        })),
        pending ? diffText(pending.base, pending.source) : undefined,
      );
      const tokens = estimateTokens(content) + images.length * imageTokens;
      if (tokens > documentBudget(provider, 0.6))
        throw Error(
          `这个文件约 ${tokens.toLocaleString()} tokens，超出了当前模型一次能处理的长度。可以换用上下文更长的模型，或只选中一部分${kind === 'markdown' ? '内容' : '代码'}后再试。`,
        );
      let length = 0;
      const result = await chat(
        {
          system: sourceEditSystem(kind),
          use: 'edit',
          messages: [{ role: 'user', content, ...(images.length ? { images } : {}) }],
        },
        {
          signal: c.signal,
          onText: (d) => {
            length += d.length;
            setProgress(length);
          },
        },
      );
      const edit = applyReply(working, result.text, kind);
      if (!edit.applied || edit.source === working) {
        setStatus('error');
        setError(
          edit.failed.length
            ? `生成的修改没能对上源码，请换个说法再试：\n${edit.failed.join('\n')}`
            : `没有生成修改。${edit.explanation.slice(0, 300)}`,
        );
        return;
      }
      setProposal({
        base,
        replies: [...(pending?.replies || []), result.text],
        source: edit.source,
        failed: edit.failed,
      });
      addTurn({
        request: text,
        images: images.length,
        explanation: edit.explanation,
        outcome: 'pending',
      });
      setRequest('');
      setImages([]);
      setShowOriginal(false);
      setStatus('idle');
    } catch (e) {
      if (isAbort(e)) setStatus('idle');
      else {
        setStatus('error');
        setError(errorText(e));
      }
    } finally {
      controller.current = null;
    }
  }
  function apply() {
    if (!proposal) return;
    // Edited meanwhile: re-apply the same edits to the current source.
    const next =
      p.doc.draft === proposal.base ? proposal.source : replay(p.doc.draft, proposal.replies, kind);
    if (next === null) {
      setStatus('error');
      setError('生成修改之后源码又被改动过，修改已对不上。请重新生成。');
      discard();
      return;
    }
    p.onApply(next);
    setProposal(null);
    settle('applied');
    input.current?.focus();
  }
  return (
    <div
      className={`ai-source${dropping ? ' dropping' : ''}`}
      role="region"
      aria-label={`AI 修改 ${kindName[kind]}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
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
      <div className="ai-source-head">
        <WandSparkles size={14} />
        <strong>AI 修改</strong>
        <span>
          {turns.length
            ? '不满意就接着说，AI 记得刚才改了什么'
            : '描述想怎么改，确认改动后再写入源码'}
        </span>
        <ModelMenu use="edit" className="model-pick-mini" onOpenSettings={p.onOpenSettings} />
        {savedThreads.length ? (
          <IconButton
            ref={historyButton}
            label="历史对话"
            help="这篇文档以前的 AI 修改，点一段接着改"
            tooltipDelay={0}
            active={historyOpen}
            disabled={status === 'running'}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <History size={15} />
          </IconButton>
        ) : null}
        {turns.length ? (
          <IconButton
            label="新对话"
            help="开始一段新的修改对话，这段保留在历史里"
            tooltipDelay={0}
            disabled={status === 'running'}
            onClick={restart}
          >
            <MessageSquarePlus size={15} />
          </IconButton>
        ) : null}
        <button className="icon-button" aria-label="关闭 AI 修改" onClick={p.onClose}>
          <X size={15} />
        </button>
      </div>
      {historyOpen && place
        ? createPortal(
            <div
              ref={historyMenu}
              className="ai-edit-history"
              role="menu"
              aria-label="AI 修改的历史对话"
              style={place}
            >
              {!savedThreads.length ? <p>还没有历史对话</p> : null}
              {savedThreads.map((t) => (
                <div
                  key={t.id}
                  className={`ai-edit-history-item${t.id === activeId ? ' active' : ''}`}
                >
                  <button type="button" role="menuitem" onClick={() => selectThread(t.id)}>
                    <span>{t.title}</span>
                    <time>{when(t.updatedAt)}</time>
                  </button>
                  <IconButton
                    label="删除这段对话"
                    tooltipDelay={0}
                    onClick={() => removeThread(t.id)}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
      {turns.length ? (
        <div className="ai-source-thread" ref={threadBox} aria-label="修改对话">
          {turns.map((t, i) => (
            <div key={i} className={`ai-source-turn ${t.outcome}`}>
              <div className="ai-source-ask">
                {t.request || '按图片修改'}
                {t.images ? <span>（附 {t.images} 张图）</span> : null}
              </div>
              <div className="ai-source-reply">
                {t.explanation ? <Markdown text={t.explanation} /> : <p>已生成修改。</p>}
                {t.outcome !== 'pending' ? (
                  <span className="ai-source-outcome">
                    {t.outcome === 'applied' ? '已应用' : '已放弃'}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
          {proposal ? (
            <div className="ai-source-proposal">
              {proposal.failed.length ? (
                <div className="chat-error">
                  <CircleX size={14} />
                  <span>有 {proposal.failed.length} 处修改没能对上源码，已跳过。</span>
                </div>
              ) : null}
              <DiffView before={proposal.base} after={proposal.source} maxHeight={260} />
              <div className="ai-source-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={showOriginal}
                    onChange={(e) => setShowOriginal(e.target.checked)}
                  />
                  预览修改前
                </label>
                <span className="toolbar-flex" />
                <button
                  className="secondary-button"
                  disabled={status === 'running'}
                  onClick={discard}
                >
                  放弃
                </button>
                <button className="primary-button" disabled={status === 'running'} onClick={apply}>
                  应用修改
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {images.length ? (
        <div className="assistant-images ai-source-images" aria-label="要发送的图片">
          {images.map((src, i) => (
            <figure key={i}>
              <img src={src} alt={`图片 ${i + 1}`} onClick={() => setViewing(src)} />
              <button
                type="button"
                aria-label={`移除图片 ${i + 1}`}
                onClick={() => setImages(images.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </figure>
          ))}
        </div>
      ) : null}
      {blocked ? (
        <p className="assistant-vision-note ai-source-vision" role="alert">
          {provider?.model} 不能看图。在右上角换一个标有
          <ImagePlus size={11} aria-label="能看图" />
          的模型，或移除图片。
        </p>
      ) : null}
      <div className="ai-source-input">
        <textarea
          ref={input}
          rows={2}
          aria-label={proposal ? '对这次修改的意见' : '修改要求'}
          placeholder={
            proposal
              ? '哪里不满意？接着说，例如：颜色再深一点；按钮别加阴影；把表格那处改回去'
              : turns.length
                ? '接着说下一处要改的地方，AI 记得刚才改过什么'
                : kind === 'markdown'
                  ? '例如：在开头加一个目录；把要点整理成表格。选中一段可以只改那一部分。'
                  : '例如：把配色改成深色；给所有图片加圆角和阴影。选中一段代码可以只改那一部分，也可以粘贴截图。'
          }
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter(isImageFile);
            if (!files.length) return;
            if (!e.clipboardData.getData('text/plain')) e.preventDefault();
            void addImages(files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button
          type="button"
          className="icon-button ai-source-attach"
          aria-label="添加图片"
          title="添加图片：页面截图或想要的样子。也可以直接粘贴截图，或把图片拖到这里"
          disabled={status === 'running'}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={15} />
        </button>
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
        {status === 'running' ? (
          <button className="secondary-button" onClick={() => controller.current?.abort()}>
            <CircleStop size={14} />
            停止
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={(!request.trim() && !images.length) || blocked}
            onClick={() => void run()}
          >
            {proposal ? '继续修改' : '生成修改'}
          </button>
        )}
      </div>
      {status === 'running' ? (
        <div className="ai-source-status">
          <LoaderCircle className="spin" size={13} />
          {proposal ? '正在按你的意见调整' : '正在生成修改'}
          {progress ? `（已写 ${progress.toLocaleString()} 字）` : '…'}
        </div>
      ) : status === 'error' ? (
        <div className="chat-error" role="alert">
          <CircleX size={14} />
          <span>{error}</span>
        </div>
      ) : !turns.length && !request && !images.length ? (
        <div className="ai-source-examples">
          {examples[kind].map((e) => (
            <button key={e} onClick={() => setRequest(e)}>
              {e}
            </button>
          ))}
        </div>
      ) : null}
      {viewing ? <ImageViewer src={viewing} onClose={() => setViewing('')} /> : null}
    </div>
  );
}
