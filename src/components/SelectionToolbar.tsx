import { useEffect, useLayoutEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { prefersReducedMotion } from '../motion';

export type ScreenBox = { left: number; top: number; right: number; bottom: number };
export type ToolbarSide = 'below' | 'above';

// The toolbar for selected text sits just below the selection, or above it when the reader
// prefers that, on the other side when there is no room, and stays inside the reading area
// while the page scrolls. Without a box it falls back to the bottom of the pane. When the
// reader moves it to the other side it slides there; otherwise it keeps up with the page at once.
export function SelectionToolbar({
  box,
  side = 'below',
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { box: ScreenBox | null; side?: ToolbarSide }) {
  const ref = useRef<HTMLDivElement>(null);
  const shownSide = useRef(side);
  const sliding = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(sliding.current), []);
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.offsetParent;
    if (!el) return;
    if (!box || !(pane instanceof HTMLElement)) {
      el.style.transform = '';
      return;
    }
    if (side !== shownSide.current) {
      shownSide.current = side;
      if (!prefersReducedMotion()) {
        el.dataset.sliding = '';
        clearTimeout(sliding.current);
        sliding.current = setTimeout(() => delete el.dataset.sliding, 400);
      }
    }
    const place = () => {
      const p = pane.getBoundingClientRect();
      // The document itself, below a two-column header or the source preview caption.
      const area = pane.querySelector('.reader-surface')?.getBoundingClientRect() || p;
      const width = el.offsetWidth,
        height = el.offsetHeight,
        gap = 10,
        edge = 6;
      const below = box.bottom + gap,
        above = box.top - height - gap;
      let top = side === 'above' ? above : below;
      if (side === 'above' && top < area.top + edge) top = below;
      else if (side === 'below' && top + height > area.bottom - edge) top = above;
      top = Math.max(area.top + edge, Math.min(top, area.bottom - height - edge));
      // Which edge it grows from when it appears.
      el.dataset.side = top < box.top ? 'above' : 'below';
      const left = Math.max(
        p.left + edge,
        Math.min((box.left + box.right) / 2 - width / 2, p.right - width - edge),
      );
      el.style.transform = `translate(${Math.round(left - p.left)}px, ${Math.round(top - p.top)}px)`;
    };
    place();
    // Its width changes when a button such as “关联此批注” appears.
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box, side]);
  return (
    <div
      ref={ref}
      {...props}
      className={`selection-toolbar${box ? ' beside-selection' : ''}${className ? ' ' + className : ''}`}
    />
  );
}
