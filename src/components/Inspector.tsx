import {
  MessageSquare,
  NotebookPen,
  List,
  Plus,
  Trash2,
  Download,
  Search,
  ArrowUpRight,
  Highlighter,
  MoveUpRight,
  Square,
  Underline,
  Check,
  AlertCircle,
  X,
  StickyNote,
  Type,
  Sparkle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Annotation, OutlineItem, OpenDocument } from '../types';
import { IconButton } from './IconButton';
import { PenIcon } from './PenIcon';
import { InkThumbnail } from './InkThumbnail';
import { SidebarResizer } from './SidebarResizer';
import { Markdown } from '../ai/Markdown';
import { invoke, isDesktop } from '../api';
export type InspectorTab = 'annotations' | 'note' | 'outline' | 'assistant';
export const annotationLabels: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  text: '文本注释',
  sticky: '便签',
  pen: '画笔',
  arrow: '箭头',
  rectangle: '矩形',
};
const icons: Record<string, typeof Highlighter> = {
  highlight: Highlighter,
  underline: Underline,
  text: Type,
  sticky: StickyNote,
  pen: PenIcon,
  arrow: MoveUpRight,
  rectangle: Square,
};
export function Inspector(p: {
  doc?: OpenDocument;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  noteReveal: boolean;
  onNoteRevealed: () => void;
  outline: OutlineItem[];
  // Annotation ids in reading order; ones not in it yet go last, oldest first.
  order: string[];
  selected: string | null;
  onSelect: (id: string) => void;
  onUpdate: (id: string, note: string) => void;
  onDelete: (id: string) => void;
  onNote: (s: string) => void;
  onHeading: (id: string) => void;
  onExport: () => void;
  orphans: string[];
  saving: boolean;
  onRebind: (id: string) => void;
  onClose: () => void;
  assistant: ReactNode;
}) {
  const [filter, setFilter] = useState('');
  const rank = new Map(p.order.map((id, i) => [id, i]));
  const list = (
    p.doc?.data.annotations.filter((a) =>
      (a.note + ' ' + (a.quote?.exact || '') + ' ' + annotationLabels[a.type])
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) || []
  ).sort(
    (a, b) =>
      (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size) || a.createdAt - b.createdAt,
  );
  return (
    <aside id="inspector-panel" className={`inspector${p.tab === 'assistant' ? ' wide' : ''}`}>
      <SidebarResizer
        side="right"
        storageKey={p.tab === 'assistant' ? 'folio.assistant-width' : 'folio.inspector-width'}
      />
      <div className="inspector-heading">
        <span>批注与笔记</span>
        <IconButton className="inspector-drawer-close" label="收起批注栏" onClick={p.onClose}>
          <X size={16} />
        </IconButton>
        <IconButton label="导出 Markdown 笔记" onClick={p.onExport} disabled={!p.doc}>
          <Download size={16} />
        </IconButton>
      </div>
      <div className="inspector-tabs">
        {(
          [
            { id: 'annotations', label: '批注', icon: MessageSquare },
            { id: 'note', label: '笔记', icon: NotebookPen },
            { id: 'outline', label: '目录', icon: List },
            { id: 'assistant', label: '助手', icon: Sparkle },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            className={p.tab === t.id ? 'active' : ''}
            onClick={() => p.onTab(t.id)}
          >
            <t.icon size={14} />
            {t.label}
            {t.id === 'annotations' && p.doc?.data.annotations.length ? (
              <span>{p.doc.data.annotations.length}</span>
            ) : null}
          </button>
        ))}
      </div>
      {p.tab === 'annotations' ? (
        <>
          <label className="annotation-search">
            <Search size={14} />
            <input
              placeholder="搜索批注…"
              aria-label="搜索批注"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <div className="annotations-list">
            {list.length ? (
              list.map((a) => (
                <AnnotationCard
                  key={a.id}
                  annotation={a}
                  selected={a.id === p.selected}
                  orphan={p.orphans.includes(a.id)}
                  onSelect={() => p.onSelect(a.id)}
                  onUpdate={(s) => p.onUpdate(a.id, s)}
                  onDelete={() => p.onDelete(a.id)}
                  onRebind={() => p.onRebind(a.id)}
                />
              ))
            ) : (
              <div className="inspector-empty">
                <div className="empty-icon">
                  <Highlighter size={25} />
                </div>
                <h3>{filter ? '没有匹配的批注' : '留下你的思考'}</h3>
                <p>
                  {filter
                    ? '试试其他关键词'
                    : '选中文字添加高亮，点击高亮写笔记。也可以用画笔，把重点圈出来。'}
                </p>
                <div className="empty-shortcut">
                  <span>选中文字</span>
                  <span>→</span>
                  <Highlighter size={14} />
                </div>
              </div>
            )}
          </div>
          <button className="inspector-note-button" onClick={() => p.onTab('note')}>
            <Plus size={15} />
            写一篇文档笔记
          </button>
        </>
      ) : null}
      {p.tab === 'note' ? (
        <DocumentNote
          key={p.doc?.id || ''}
          note={p.doc?.data.note || ''}
          disabled={!p.doc}
          saving={p.saving}
          onChange={p.onNote}
          reveal={p.noteReveal}
          onRevealed={p.onNoteRevealed}
        />
      ) : null}
      {p.tab === 'assistant' ? p.assistant : null}
      {p.tab === 'outline' ? (
        <div className="outline-list">
          {p.outline.length ? (
            p.outline.map((h) => (
              <button
                key={h.id}
                className={`outline-level-${h.level}`}
                onClick={() => p.onHeading(h.id)}
                title={h.text}
              >
                <span className="outline-marker" />
                {h.text}
              </button>
            ))
          ) : (
            <div className="inspector-empty">
              <List size={25} />
              <h3>这里会显示文档目录</h3>
              <p>根据 HTML 中的标题自动生成。</p>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
const noteViewKey = 'folio.note-view';
// The document note, shown as rendered Markdown or as its source for editing.
function DocumentNote(p: {
  note: string;
  disabled: boolean;
  saving: boolean;
  onChange: (note: string) => void;
  reveal: boolean;
  onRevealed: () => void;
}) {
  // An empty note opens ready to write; otherwise the last chosen view.
  const [editing, setEditing] = useState(() => {
    if (!p.note.trim()) return true;
    try {
      return localStorage.getItem(noteViewKey) === 'edit';
    } catch {
      return false;
    }
  });
  const chosen = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.reveal) return;
    const box = input.current || view.current;
    if (box) box.scrollTop = box.scrollHeight;
    p.onRevealed();
  }, [p.reveal]);
  function show(edit: boolean) {
    chosen.current = true;
    setEditing(edit);
    try {
      localStorage.setItem(noteViewKey, edit ? 'edit' : 'preview');
    } catch {}
  }
  const openLink = (url: string) =>
    isDesktop ? void invoke('external', { url }) : window.open(url, '_blank', 'noopener');
  return (
    <div className="document-note">
      <div className="note-caption">
        <span>文档笔记</span>
        <div className="note-view" role="group" aria-label="笔记显示方式">
          <button aria-pressed={!editing} onClick={() => show(false)}>
            预览
          </button>
          <button aria-pressed={editing} onClick={() => show(true)}>
            编辑
          </button>
        </div>
        <span>
          <Check size={12} />
          {p.saving ? '保存中…' : '自动保存'}
        </span>
      </div>
      {editing ? (
        <textarea
          ref={input}
          aria-label="文档笔记"
          autoFocus={chosen.current}
          placeholder={
            '读到这里，你想到了什么？\n\n记下总结、疑问，或下次要继续探索的线索。\n支持 Markdown 文本。'
          }
          value={p.note}
          disabled={p.disabled}
          onChange={(e) => p.onChange(e.target.value)}
        />
      ) : (
        <div className="note-preview" ref={view} aria-label="文档笔记预览">
          {p.note.trim() ? (
            <Markdown text={p.note} onLink={openLink} />
          ) : (
            <p className="note-preview-empty">还没有笔记，点「编辑」开始写。</p>
          )}
        </div>
      )}
      <div className="note-count">{p.note.length} 字</div>
    </div>
  );
}
function AnnotationCard({
  annotation: a,
  selected,
  orphan,
  onSelect,
  onUpdate,
  onDelete,
  onRebind,
}: {
  annotation: Annotation;
  selected: boolean;
  orphan: boolean;
  onSelect: () => void;
  onUpdate: (v: string) => void;
  onDelete: () => void;
  onRebind: () => void;
}) {
  const Icon = icons[a.type] || MessageSquare;
  // Without a note the card shows a one-line button; the box opens when you write.
  const [writing, setWriting] = useState(false);
  return (
    <article
      className={`annotation-card ${selected ? 'selected' : ''}`}
      style={{ '--annotation-color': a.color } as React.CSSProperties}
      data-annotation={a.id}
      aria-label={`${annotationLabels[a.type]}批注${selected ? '，已选中' : ''}`}
      onClick={(e) => {
        if (!(e.target as Element).closest('button,textarea,input,select')) onSelect();
      }}
    >
      <div className="annotation-meta">
        <button onClick={onSelect}>
          <Icon size={13} />
          {annotationLabels[a.type]}
        </button>
        {a.by === 'ai' ? (
          <span className="annotation-ai-badge" title="由 AI 添加">
            AI
          </span>
        ) : null}
        {selected ? <span className="annotation-selected-label">已选中</span> : null}
        <time>
          {new Date(a.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}{' '}
          {new Date(a.createdAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
        <IconButton label="删除批注" onClick={onDelete}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      {a.quote ? (
        <button className="annotation-quote" onClick={onSelect}>
          {a.quote.exact}
        </button>
      ) : ['pen', 'arrow', 'rectangle'].includes(a.type) ? (
        <button
          className="drawing-preview"
          aria-label={`定位${annotationLabels[a.type]}批注`}
          onClick={onSelect}
        >
          <InkThumbnail annotation={a} />
          <span>
            查看页面中的{annotationLabels[a.type]}
            <ArrowUpRight size={13} />
          </span>
        </button>
      ) : (
        <button className="drawing-link" onClick={onSelect}>
          查看页面中的{annotationLabels[a.type]}
          <ArrowUpRight size={13} />
        </button>
      )}
      {orphan ? (
        <div className="orphan-warning">
          <AlertCircle size={13} />
          原文已变化<button onClick={onRebind}>重新关联</button>
        </div>
      ) : null}
      {a.note || writing ? (
        <textarea
          aria-label="批注内容"
          placeholder="添加你的想法…"
          value={a.note}
          autoFocus={writing}
          onChange={(e) => onUpdate(e.target.value)}
          onFocus={onSelect}
          onBlur={() => setWriting(false)}
          rows={Math.max(2, Math.min(8, a.note.split('\n').length + 1))}
        />
      ) : (
        <button className="annotation-add-note" onClick={() => setWriting(true)}>
          <Plus size={13} />
          写想法
        </button>
      )}
    </article>
  );
}
