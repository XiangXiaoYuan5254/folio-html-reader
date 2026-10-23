import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Where a menu opens: under the ⋯ button that opened it (above it when there's no room
// below), or at the pointer for a right-click.
export type MenuAnchor = { x: number; top: number; bottom: number; from?: Element };
export const belowButton = (el: Element): MenuAnchor => {
  const r = el.getBoundingClientRect();
  return { x: r.left, top: r.bottom + 4, bottom: r.top - 4, from: el };
};
export const atPointer = (e: { clientX: number; clientY: number }): MenuAnchor => ({
  x: e.clientX,
  top: e.clientY,
  bottom: e.clientY,
});

export type MenuItem = {
  label: ReactNode;
  onSelect: () => void;
  onDoubleClick?: () => void;
  help?: string;
  // A keyboard shortcut shown at the right.
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  // Leaves the menu open, e.g. for a delete that asks for a second click.
  keep?: boolean;
};

// A menu floating over the window like an app's context menu, instead of opening in the
// list and pushing the rows below it down. A press anywhere else, Escape, leaving the
// window (which is also how a click inside the reader's iframe shows up) or scrolling
// closes it; the ⋯ button that opened it toggles it in its own click handler.
export function PopupMenu({
  at,
  items,
  label,
  onClose,
}: {
  at: MenuAnchor;
  items: MenuItem[];
  label: string;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null);
  useLayoutEffect(() => {
    const { width, height } = menu.current!.getBoundingClientRect();
    const above = at.top + height > innerHeight - 8;
    setPlace({
      left: Math.max(8, Math.min(at.x, innerWidth - width - 8)),
      top: above ? Math.max(8, at.bottom - height) : at.top,
      above,
    });
  }, [at]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && !!menu.current?.contains(t);
    const press = (e: PointerEvent) => {
      if (inside(e.target) || (e.target instanceof Node && at.from?.contains(e.target))) return;
      close.current();
    };
    const scroll = (e: Event) => inside(e.target) || close.current();
    const leave = () => close.current();
    // The arrow keys move through the items, as in any menu.
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return close.current();
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = [
        ...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
      ];
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const step = e.key === 'ArrowDown' ? 1 : list.length - 1;
      list[i === -1 ? (step === 1 ? 0 : list.length - 1) : (i + step) % list.length].focus();
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', leave);
    window.addEventListener('resize', leave);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', leave);
      window.removeEventListener('resize', leave);
    };
  }, [at]);
  return createPortal(
    <div
      ref={menu}
      className="popup-menu"
      role="menu"
      aria-label={label}
      style={
        place
          ? {
              left: place.left,
              top: place.top,
              // It grows out of the button, from whichever side it opened on.
              ['--menu-origin' as string]: `${Math.max(0, at.x - place.left)}px ${place.above ? '100%' : '0'}`,
            }
          : { left: at.x, top: at.top, visibility: 'hidden' }
      }
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          data-danger={item.danger || undefined}
          disabled={item.disabled}
          title={item.help}
          onDoubleClick={item.onDoubleClick}
          onClick={() => {
            if (!item.keep) onClose();
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
          {item.hint ? <kbd>{item.hint}</kbd> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
