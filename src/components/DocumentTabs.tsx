import { useEffect, useRef } from 'react';
import { FileCode2, FileText, X, Plus, Columns2 } from 'lucide-react';
import type { OpenDocument } from '../types';
import { IconButton } from './IconButton';
export function DocumentTabs({
  docs,
  active,
  onSelect,
  onClose,
  onNew,
  split,
  onSplit,
}: {
  docs: OpenDocument[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  split: boolean;
  onSplit: () => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const showActive = () =>
      strip.current
        ?.querySelector('.document-tab.selected')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showActive();
    const observer = new ResizeObserver(showActive);
    if (strip.current) observer.observe(strip.current);
    return () => observer.disconnect();
  }, [active, docs.length]);
  return (
    <div className="document-tab-row">
      <div ref={strip} className="document-tabs" role="tablist" aria-label="打开的文档">
        {docs.map((d) => (
          <div className={`document-tab ${d.id === active ? 'selected' : ''}`} key={d.id}>
            <button
              role="tab"
              aria-selected={d.id === active}
              title={d.path}
              onClick={() => onSelect(d.id)}
            >
              {d.kind === 'pdf' ? (
                <FileText className="tree-icon-pdf" size={14} />
              ) : (
                <FileCode2 size={14} />
              )}
              <span>{d.path.split('/').at(-1)}</span>
              {d.draft !== d.source ? (
                <span className="dirty-dot" aria-label="有未保存的修改" />
              ) : null}
            </button>
            <IconButton label={`关闭 ${d.path.split('/').at(-1)}`} onClick={() => onClose(d.id)}>
              <X size={13} />
            </IconButton>
          </div>
        ))}
        <IconButton label="新建文档" onClick={onNew}>
          <Plus size={17} />
        </IconButton>
      </div>
      <button
        className={`split-reading-toggle${split ? ' active' : ''}`}
        disabled={!docs.length}
        aria-pressed={split}
        onClick={onSplit}
        title={split ? '退出双栏，保留当前文档' : '左右同时阅读两篇文档；点击任一栏切换操作对象'}
      >
        <Columns2 size={16} />
        {split ? '退出双栏' : '双栏阅读'}
      </button>
    </div>
  );
}
