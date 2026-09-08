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
} from 'lucide-react';
import { useState } from 'react';
import type { Annotation, OutlineItem, OpenDocument } from '../types';
import { IconButton } from './IconButton';
import { PenIcon } from './PenIcon';
import { InkThumbnail } from './InkThumbnail';
export type InspectorTab = 'annotations' | 'note' | 'outline';
const labels: Record<string, string> = {
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
  outline: OutlineItem[];
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
}) {
  const [filter, setFilter] = useState('');
  const list =
    p.doc?.data.annotations.filter((a) =>
      (a.note + ' ' + (a.quote?.exact || '') + ' ' + labels[a.type])
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) || [];
  return (
    <aside className="inspector">
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
        <div className="document-note">
          <div className="note-caption">
            <span>文档笔记</span>
            <span>
              <Check size={12} />
              {p.saving ? '保存中…' : '自动保存'}
            </span>
          </div>
          <textarea
            aria-label="文档笔记"
            placeholder={
              '读到这里，你想到了什么？\n\n记下总结、疑问，或下次要继续探索的线索。\n支持 Markdown 文本。'
            }
            value={p.doc?.data.note || ''}
            disabled={!p.doc}
            onChange={(e) => p.onNote(e.target.value)}
          />
          <div className="note-count">{p.doc?.data.note.length || 0} 字</div>
        </div>
      ) : null}
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
  return (
    <article
      className={`annotation-card ${selected ? 'selected' : ''}`}
      style={{ '--annotation-color': a.color } as React.CSSProperties}
      data-annotation={a.id}
      aria-label={`${labels[a.type]}批注${selected ? '，已选中' : ''}`}
      onClick={(e) => {
        if (!(e.target as Element).closest('button,textarea,input,select')) onSelect();
      }}
    >
      <div className="annotation-meta">
        <button onClick={onSelect}>
          <Icon size={13} />
          {labels[a.type]}
        </button>
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
          aria-label={`定位${labels[a.type]}批注`}
          onClick={onSelect}
        >
          <InkThumbnail annotation={a} />
          <span>
            查看页面中的{labels[a.type]}
            <ArrowUpRight size={13} />
          </span>
        </button>
      ) : (
        <button className="drawing-link" onClick={onSelect}>
          查看页面中的{labels[a.type]}
          <ArrowUpRight size={13} />
        </button>
      )}
      {orphan ? (
        <div className="orphan-warning">
          <AlertCircle size={13} />
          原文已变化<button onClick={onRebind}>重新关联</button>
        </div>
      ) : null}
      <textarea
        aria-label="批注内容"
        placeholder="添加你的想法…"
        value={a.note}
        onChange={(e) => onUpdate(e.target.value)}
        onFocus={onSelect}
        rows={Math.max(2, Math.min(8, a.note.split('\n').length + 1))}
      />
    </article>
  );
}
