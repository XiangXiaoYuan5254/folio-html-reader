import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// The file tree on the left and the annotation/assistant panel on the right both have a
// drag handle on their inner edge. Each remembers its width; double-click resets it.
const sides = {
  left: {
    storageKey: 'folio.sidebar-width',
    min: 180,
    max: 560,
    widthVar: '--sidebar-user-width',
    defaultVar: '--sidebar',
    fallback: 236,
    compact: 950,
    label: '调整文件树宽度',
    title: '左右拖动调整目录宽度；双击恢复默认',
    controls: 'project-file-sidebar',
  },
  right: {
    storageKey: 'folio.inspector-width',
    min: 260,
    max: 760,
    widthVar: '--inspector-user-width',
    defaultVar: '--inspector',
    fallback: 292,
    compact: 700,
    label: '调整右侧栏宽度',
    title: '左右拖动调整右侧栏宽度；双击恢复默认',
    controls: 'inspector-panel',
  },
};
function stored(key: string, min: number, max: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= min ? Math.min(max, value) : null;
  } catch {
    return null;
  }
}

export function SidebarResizer({ side = 'left' }: { side?: 'left' | 'right' }) {
  const config = sides[side];
  const { storageKey } = config;
  const { min: minWidth, max: maxWidth } = config;
  const clamp = (width: number, max: number) => Math.max(minWidth, Math.min(max, width));
  const [initialWidth] = useState(() => stored(storageKey, minWidth, maxWidth));
  const preferred = useRef(initialWidth);
  const handle = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const drag = useRef<{
    pointer: number;
    x: number;
    width: number;
    previous: number | null;
    moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState({ width: initialWidth || 236, max: maxWidth });
  const latest = useRef(metrics);

  const layout = useCallback(() => {
    const sidebar = handle.current?.parentElement;
    const workspace = sidebar?.parentElement;
    if (!sidebar || !workspace) return;
    const other = workspace.querySelector<HTMLElement>(
      side === 'left' ? '.inspector' : '.file-sidebar',
    );
    // A hidden panel is pulled out of the row by a negative margin rather than removed.
    const otherStyle = other && getComputedStyle(other);
    const otherWidth =
      other && otherStyle
        ? Math.max(
            0,
            other.getBoundingClientRect().width +
              parseFloat(otherStyle.marginLeft) +
              parseFloat(otherStyle.marginRight),
          )
        : 0;
    // On compact windows the panel is a drawer, so it doesn't share the row.
    const available =
      innerWidth <= config.compact ? innerWidth - 48 : workspace.clientWidth - otherWidth - 520;
    const max = Math.max(minWidth, Math.min(maxWidth, available));
    const fallback =
      parseFloat(getComputedStyle(sidebar).getPropertyValue(config.defaultVar)) || config.fallback;
    const width = Math.round(clamp(preferred.current ?? fallback, max));
    sidebar.style.setProperty(config.widthVar, `${width}px`);
    latest.current = { width, max };
    setMetrics((old) => (old.width === width && old.max === max ? old : { width, max }));
  }, [side, storageKey]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      layout();
    });
  }, [layout]);

  const persist = useCallback(() => {
    try {
      if (preferred.current === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred.current));
    } catch {}
  }, [storageKey]);
  const finish = useCallback(
    (cancel = false) => {
      const gesture = drag.current;
      if (!gesture) return;
      drag.current = null;
      if (cancel) preferred.current = gesture.previous;
      else if (gesture.moved) persist();
      setDragging(false);
      if (handle.current?.hasPointerCapture(gesture.pointer))
        handle.current.releasePointerCapture(gesture.pointer);
      layout();
    },
    [layout, persist],
  );

  useLayoutEffect(() => {
    layout();
    const sidebar = handle.current!.parentElement!;
    const workspace = sidebar.parentElement!;
    const observer = new ResizeObserver(schedule);
    observer.observe(workspace);
    observer.observe(sidebar);
    const other = workspace.querySelector(side === 'left' ? '.inspector' : '.file-sidebar');
    if (other) observer.observe(other);
    // The other panel sliding in or out only shows as the reading area changing size.
    const main = workspace.querySelector('.main-panel');
    if (main) observer.observe(main);
    const blur = () => finish();
    window.addEventListener('resize', schedule);
    window.addEventListener('blur', blur);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('blur', blur);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [layout, schedule, finish]);

  const reset = () => {
    preferred.current = null;
    persist();
    layout();
  };
  return (
    <>
      <div
        ref={handle}
        className={`sidebar-resizer ${side}${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-label={config.label}
        aria-orientation="vertical"
        aria-controls={config.controls}
        aria-valuemin={minWidth}
        aria-valuemax={metrics.max}
        aria-valuenow={metrics.width}
        aria-valuetext={`${metrics.width} 像素`}
        title={config.title}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0 || drag.current) return;
          e.preventDefault();
          e.currentTarget.focus({ preventScroll: true });
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            pointer: e.pointerId,
            x: e.clientX,
            width: latest.current.width,
            previous: preferred.current,
            moved: false,
          };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const gesture = drag.current;
          if (!gesture || gesture.pointer !== e.pointerId) return;
          // The right panel grows as its left edge moves left.
          const delta = (e.clientX - gesture.x) * (side === 'left' ? 1 : -1);
          if (!gesture.moved && Math.abs(delta) < 1) return;
          gesture.moved = true;
          preferred.current = Math.round(clamp(gesture.width + delta, latest.current.max));
          schedule();
        }}
        onPointerUp={() => finish()}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish()}
        onDoubleClick={reset}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && drag.current) {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
            return;
          }
          if (drag.current) return;
          const step = (e.shiftKey ? 40 : 10) * (side === 'left' ? 1 : -1);
          const next =
            e.key === 'ArrowLeft'
              ? latest.current.width - step
              : e.key === 'ArrowRight'
                ? latest.current.width + step
                : e.key === 'Home'
                  ? minWidth
                  : e.key === 'End'
                    ? latest.current.max
                    : null;
          if (next === null) return;
          e.preventDefault();
          preferred.current = clamp(next, latest.current.max);
          persist();
          layout();
        }}
      />
      {dragging ? <div className="sidebar-resize-shield" aria-hidden="true" /> : null}
    </>
  );
}
