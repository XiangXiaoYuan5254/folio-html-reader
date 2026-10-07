import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  History,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Presentation,
  Trash2,
  X,
} from 'lucide-react';
import { invoke } from '../api';
import { Closing } from '../motion';
import type { BoardEntry } from '../ai/board';
import { fileName } from '../ai/context';
import { backupLabel } from './HistoryPanel';
import { IconButton } from './IconButton';
import { atPointer, belowButton, PopupMenu, type MenuAnchor } from './PopupMenu';

// The whiteboard lessons saved in this project, newest first. `version` changes whenever a
// board is saved or deleted, to read the list again.
function useBoards(version = 0) {
  const [items, setItems] = useState<BoardEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    invoke<BoardEntry[]>('boards')
      .then((list) => live && (setItems(list), setError('')))
      .catch((e) => {
        if (!live) return;
        setItems([]);
        setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [version]);
  async function remove(id: string) {
    try {
      await invoke('delete-board', { id });
      setItems((list) => list?.filter((b) => b.id !== id) || null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return { items, error, remove };
}
const where = (b: BoardEntry) =>
  b.source ? `${fileName(b.source)}${b.page ? ` 第 ${b.page} 页` : ''}` : '空白白板';

// The boards in the file sidebar, under the project's files: open one, start a blank one,
// or keep one in its document's note.
export function BoardShelf(p: {
  version: number;
  current?: string;
  // The open document, whose boards come first.
  active?: string;
  onOpen: (entry: BoardEntry) => void;
  onBlank: () => void;
  onNote: (entry: BoardEntry) => void;
  onDeleted: (id: string) => void;
}) {
  const { items, error, remove } = useBoards(p.version);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('folio.board-shelf') !== 'closed';
    } catch {
      return true;
    }
  });
  // The height the shelf is dragged to, from the handle on its top edge; null keeps the
  // default (as tall as its boards, up to 42% of the sidebar).
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem('folio.board-shelf-height')) || null;
    } catch {
      return null;
    }
  });
  const shelf = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function resize(next: number | null) {
    const sidebar = shelf.current?.parentElement;
    if (next !== null && sidebar)
      next = Math.round(Math.max(72, Math.min(sidebar.clientHeight * 0.75, next)));
    setHeight(next);
    try {
      if (next === null) localStorage.removeItem('folio.board-shelf-height');
      else localStorage.setItem('folio.board-shelf-height', String(next));
    } catch {}
  }
  const [menu, setMenu] = useState<{ board: BoardEntry; at: MenuAnchor } | null>(null);
  // Deleting takes a second click on the same item.
  const [confirm, setConfirm] = useState(false);
  function showMenu(board: BoardEntry, at: MenuAnchor) {
    setConfirm(false);
    setMenu({ board, at });
  }
  function toggle() {
    setOpen(!open);
    try {
      localStorage.setItem('folio.board-shelf', open ? 'closed' : 'open');
    } catch {}
  }
  const list = items
    ? [
        ...items.filter((b) => p.active && b.source === p.active),
        ...items.filter((b) => !p.active || b.source !== p.active),
      ]
    : null;
  return (
    <section
      ref={shelf}
      className={`board-shelf${open ? ' open' : ''}`}
      style={open && height ? { maxHeight: `min(${height}px, 75%)` } : undefined}
      aria-label="白板"
    >
      {open ? (
        <div
          className={`board-shelf-resizer${dragging ? ' dragging' : ''}`}
          role="separator"
          aria-label="调整白板列表高度"
          aria-orientation="horizontal"
          title="上下拖动调整白板列表高度；双击恢复默认"
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0 || !shelf.current) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {
              pointer: e.pointerId,
              y: e.clientY,
              height: shelf.current.getBoundingClientRect().height,
            };
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const gesture = drag.current;
            if (!gesture || gesture.pointer !== e.pointerId) return;
            // The shelf grows as its top edge moves up.
            resize(gesture.height - (e.clientY - gesture.y));
          }}
          onPointerUp={() => {
            drag.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onDoubleClick={() => resize(null)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const step = (e.shiftKey ? 60 : 20) * (e.key === 'ArrowUp' ? 1 : -1);
            resize(shelf.current!.getBoundingClientRect().height + step);
          }}
        />
      ) : null}
      {dragging ? <div className="sidebar-resize-shield rows" aria-hidden="true" /> : null}
      <div className="board-shelf-head">
        <button className="board-shelf-toggle" aria-expanded={open} onClick={toggle}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Presentation className="board-shelf-icon" size={15} />
          <span>白板</span>
          {items?.length ? <em>{items.length}</em> : null}
        </button>
        <IconButton label="新建空白白板" help="直接提问，或贴一道题的图片" onClick={p.onBlank}>
          <Plus size={15} />
        </IconButton>
      </div>
      {open ? (
        <div className="board-shelf-items">
          {list === null ? (
            <p className="board-shelf-empty">
              <LoaderCircle className="spin" size={12} />
              正在读取…
            </p>
          ) : list.length ? (
            list.map((b) => (
              <div key={b.id}>
                <div
                  className="board-row"
                  data-current={b.id === p.current || undefined}
                  data-here={(!!p.active && b.source === p.active) || undefined}
                  data-menu-open={menu?.board.id === b.id || undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showMenu(b, atPointer(e));
                  }}
                >
                  <button className="board-row-open" title={b.title} onClick={() => p.onOpen(b)}>
                    <strong>{b.title}</strong>
                    <span>
                      {where(b)} · {b.questions ? `${b.questions} 问 · ` : ''}
                      {backupLabel(b.updatedAt)}
                    </span>
                  </button>
                  <IconButton
                    label={`${b.title} 的操作`}
                    aria-haspopup="menu"
                    aria-expanded={menu?.board.id === b.id}
                    onClick={(e) =>
                      menu?.board.id === b.id
                        ? setMenu(null)
                        : showMenu(b, belowButton(e.currentTarget))
                    }
                  >
                    <MoreHorizontal size={15} />
                  </IconButton>
                </div>
              </div>
            ))
          ) : (
            <p className="board-shelf-empty">
              选中文字或框选公式、图表，点工具栏的白板按钮开讲；讲过的白板存在这里。
            </p>
          )}
          {error ? <p className="board-shelf-empty error">{error}</p> : null}
        </div>
      ) : null}
      {menu ? (
        <PopupMenu
          at={menu.at}
          label={menu.board.title}
          onClose={() => setMenu(null)}
          items={[
            {
              label: `存入${menu.board.source ? `「${fileName(menu.board.source)}」的` : '当前文档的'}笔记`,
              onSelect: () => p.onNote(menu.board),
            },
            {
              label: confirm ? '再点一次删除' : '删除',
              danger: true,
              keep: !confirm,
              onSelect: () => {
                if (!confirm) return setConfirm(true);
                const { id } = menu.board;
                void remove(id).then(() => p.onDeleted(id));
              },
            },
          ]}
        />
      ) : null}
    </section>
  );
}

// The same list over the whiteboard, to switch to another board.
export function BoardList(p: {
  current?: string;
  onOpen: (entry: BoardEntry) => void;
  onBlank: () => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const { items, error, remove } = useBoards();
  // Deleting takes a second click on the same row.
  const [confirm, setConfirm] = useState('');
  // Rendered into the page body, outside the Exit wrapper that marks it leaving.
  const closing = useContext(Closing);
  return createPortal(
    <div
      className="modal-backdrop board-list-backdrop"
      data-closing={closing || undefined}
      inert={closing}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <section
        className="board-list"
        role="dialog"
        aria-label="白板记录"
        onKeyDown={(e) => {
          if (e.key === 'Escape') p.onClose();
          e.stopPropagation();
        }}
      >
        <header className="board-list-head">
          <h2>
            <History size={16} />
            白板记录
          </h2>
          <button className="board-list-new" onClick={p.onBlank}>
            <Plus size={14} />
            新建空白白板
          </button>
          <IconButton label="关闭白板记录" onClick={p.onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="board-list-items">
          {items === null ? (
            <p className="board-list-empty">
              <LoaderCircle className="spin" size={14} />
              正在读取…
            </p>
          ) : items.length ? (
            items.map((b) => (
              <div className="board-item" key={b.id} data-current={b.id === p.current || undefined}>
                <button className="board-item-open" onClick={() => p.onOpen(b)}>
                  <strong>{b.title}</strong>
                  <span>
                    {where(b)} · {b.questions} 个问题 · {backupLabel(b.updatedAt)}
                    {b.id === p.current ? ' · 正在看' : ''}
                  </span>
                </button>
                <button
                  className={`board-item-delete${confirm === b.id ? ' confirm' : ''}`}
                  aria-label={confirm === b.id ? '确认删除这块白板' : '删除这块白板'}
                  title={confirm === b.id ? '再点一次删除' : '删除'}
                  onClick={() => {
                    if (confirm !== b.id) return setConfirm(b.id);
                    setConfirm('');
                    void remove(b.id).then(() => p.onDeleted(b.id));
                  }}
                  onBlur={() => setConfirm((c) => (c === b.id ? '' : c))}
                >
                  {confirm === b.id ? '确认删除' : <Trash2 size={14} />}
                </button>
              </div>
            ))
          ) : (
            <p className="board-list-empty">还没有保存的白板。讲过的白板会自动保存在这个项目里。</p>
          )}
          {error ? <p className="board-list-error">{error}</p> : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
