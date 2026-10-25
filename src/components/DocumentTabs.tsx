import { useEffect, useRef } from 'react';
import { FileCode2, FileText, X, Plus } from 'lucide-react';
import type { OpenDocument } from '../types';
import { IconButton } from './IconButton';
export function DocumentTabs({
  docs,
  active,
  onSelect,
  onClose,
  onNew,
  autosave,
}: {
  docs: OpenDocument[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  // Auto-saved edits are written at once, so only a failed save leaves a tab marked unsaved.
  autosave: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // A tab opens up in the strip once, when its document is opened.
  const arrived = useRef(new Set<string>());
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
          <div
            className={`document-tab${d.id === active ? ' selected' : ''}${arrived.current.has(d.id) ? '' : ' fresh'}`}
            key={d.id}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget) arrived.current.add(d.id);
            }}
          >
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
              {d.draft !== d.source && (!autosave || d.autosavePaused) ? (
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
    </div>
  );
}
