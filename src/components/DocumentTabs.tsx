import { useEffect, useRef } from 'react';
import { FileCode2, X, Plus } from 'lucide-react';
import type { OpenDocument } from '../types';
import { IconButton } from './IconButton';
export function DocumentTabs({
  docs,
  active,
  onSelect,
  onClose,
  onNew,
}: {
  docs: OpenDocument[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
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
    <div ref={strip} className="document-tabs" role="tablist" aria-label="打开的文档">
      {docs.map((d) => (
        <div className={`document-tab ${d.id === active ? 'selected' : ''}`} key={d.id}>
          <button
            role="tab"
            aria-selected={d.id === active}
            title={d.path}
            onClick={() => onSelect(d.id)}
          >
            <FileCode2 size={14} />
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
  );
}
