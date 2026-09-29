import { useLayoutEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';

export type ScreenBox = { left: number; top: number; right: number; bottom: number };

// The toolbar for selected text sits just above the selection, or below it when there is
// no room, and stays inside the reading area while the page scrolls. Without a box it
// falls back to the bottom of the pane.
export function SelectionToolbar({
  box,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { box: ScreenBox | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.offsetParent;
    if (!el) return;
    if (!box || !(pane instanceof HTMLElement)) {
      el.style.transform = '';
      return;
    }
    const place = () => {
      const p = pane.getBoundingClientRect();
      // The document itself, below a two-column header or the source preview caption.
      const area = pane.querySelector('.reader-surface')?.getBoundingClientRect() || p;
      const width = el.offsetWidth,
        height = el.offsetHeight,
        gap = 10,
        edge = 6;
      let top = box.top - height - gap;
      if (top < area.top + edge) top = box.bottom + gap;
      top = Math.max(area.top + edge, Math.min(top, area.bottom - height - edge));
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
  }, [box]);
  return (
    <div
      ref={ref}
      {...props}
      className={`selection-toolbar${box ? ' beside-selection' : ''}${className ? ' ' + className : ''}`}
    />
  );
}
