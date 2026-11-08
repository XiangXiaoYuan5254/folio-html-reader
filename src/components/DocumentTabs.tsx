import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FileCode2,
  FileImage,
  FileText,
  FileType,
  X,
  Plus,
} from 'lucide-react';
import type { OpenDocument } from '../types';
import { IconButton } from './IconButton';
import { belowButton, PopupMenu, type MenuAnchor } from './PopupMenu';
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
  onNew: (kind: 'html' | 'markdown') => void;
  // Auto-saved edits are written at once, so only a failed save leaves a tab marked unsaved.
  autosave: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // A tab opens up in the strip once, when its document is opened.
  const arrived = useRef(new Set<string>());
  // Whether tabs are hidden past either end of the strip, and the list of every tab.
  const [hidden, setHidden] = useState({ before: false, after: false });
  const [list, setList] = useState<MenuAnchor | null>(null);
  const [newMenu, setNewMenu] = useState<MenuAnchor | null>(null);
  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setHidden((h) => (h.before === before && h.after === after ? h : { before, after }));
  };
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
  useLayoutEffect(measure);
  useEffect(() => {
    const el = strip.current!;
    // A mouse wheel scrolls the tabs sideways, as a trackpad already does.
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', wheel);
    };
  }, []);
  // A tab picked from the list comes into view, even the one already showing.
  const reveal = (id: string) =>
    requestAnimationFrame(() =>
      [...(strip.current?.querySelectorAll<HTMLElement>('.document-tab') || [])]
        .find((tab) => tab.dataset.id === id)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    );
  const name = (d: OpenDocument) => d.path.split('/').at(-1);
  const icon = (d: OpenDocument) =>
    d.kind === 'pdf' ? (
      <FileText className="tree-icon-pdf" size={14} />
    ) : d.kind === 'markdown' ? (
      <FileType size={14} />
    ) : d.kind === 'image' ? (
      <FileImage size={14} />
    ) : (
      <FileCode2 size={14} />
    );
  return (
    <div className="document-tab-row">
      <div
        ref={strip}
        className={`document-tabs${hidden.before ? ' hides-before' : ''}${hidden.after ? ' hides-after' : ''}`}
        role="tablist"
        aria-label="打开的文档"
      >
        {docs.map((d) => (
          <div
            className={`document-tab${d.id === active ? ' selected' : ''}${arrived.current.has(d.id) ? '' : ' fresh'}`}
            key={d.id}
            data-id={d.id}
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
              {icon(d)}
              <span>{name(d)}</span>
              {d.draft !== d.source && (!autosave || d.autosavePaused) ? (
                <span className="dirty-dot" aria-label="有未保存的修改" />
              ) : null}
            </button>
            <IconButton label={`关闭 ${name(d)}`} onClick={() => onClose(d.id)}>
              <X size={13} />
            </IconButton>
          </div>
        ))}
        <IconButton
          label="新建文档"
          aria-haspopup="menu"
          aria-expanded={!!newMenu}
          onClick={(e) => setNewMenu(newMenu ? null : belowButton(e.currentTarget))}
        >
          <Plus size={17} />
        </IconButton>
      </div>
      {hidden.before || hidden.after ? (
        // Tabs past the ends of the strip are a click away here.
        <IconButton
          className="document-tabs-all"
          label={`全部 ${docs.length} 个标签`}
          active={!!list}
          onClick={(e) => setList(list ? null : belowButton(e.currentTarget))}
        >
          <ChevronDown size={15} />
        </IconButton>
      ) : null}
      {list ? (
        <PopupMenu
          at={list}
          label="全部标签"
          className="document-tab-list"
          onClose={() => setList(null)}
          items={docs.map((d) => ({
            label: (
              <span className={`document-tab-list-item${d.id === active ? ' active' : ''}`}>
                {icon(d)}
                <span>{name(d)}</span>
                {d.id === active ? <Check size={13} /> : null}
              </span>
            ),
            help: d.path,
            onSelect: () => {
              onSelect(d.id);
              reveal(d.id);
            },
          }))}
        />
      ) : null}
      {newMenu ? (
        <PopupMenu
          at={newMenu}
          label="新建文档"
          onClose={() => setNewMenu(null)}
          items={[
            { label: '新建 HTML', onSelect: () => onNew('html') },
            { label: '新建 Markdown', onSelect: () => onNew('markdown') },
          ]}
        />
      ) : null}
    </div>
  );
}
