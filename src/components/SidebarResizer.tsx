import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const storageKey = 'folio.sidebar-width';
const minWidth = 180;
const maxWidth = 560;
const clamp = (width: number, max: number) => Math.max(minWidth, Math.min(max, width));

export function SidebarResizer() {
  const [initialWidth] = useState(() => {
    try {
      const value = Number(localStorage.getItem(storageKey));
      return Number.isFinite(value) && value >= minWidth ? clamp(value, maxWidth) : null;
    } catch {
      return null;
    }
  });
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
    const inspector = workspace.querySelector<HTMLElement>('.inspector');
    const inspectorWidth = inspector?.getBoundingClientRect().width || 0;
    // On compact windows the file tree is a drawer, so it doesn't share the row.
    const available =
      innerWidth <= 950 ? innerWidth - 48 : workspace.clientWidth - inspectorWidth - 520;
    const max = Math.max(minWidth, Math.min(maxWidth, available));
    const fallback = parseFloat(getComputedStyle(sidebar).getPropertyValue('--sidebar')) || 236;
    const width = Math.round(clamp(preferred.current ?? fallback, max));
    sidebar.style.setProperty('--sidebar-user-width', `${width}px`);
    latest.current = { width, max };
    setMetrics((old) => (old.width === width && old.max === max ? old : { width, max }));
  }, []);

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
  }, []);

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
    const inspector = workspace.querySelector('.inspector');
    if (inspector) observer.observe(inspector);
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
        className={`sidebar-resizer${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-label="调整文件树宽度"
        aria-orientation="vertical"
        aria-controls="project-file-sidebar"
        aria-valuemin={minWidth}
        aria-valuemax={metrics.max}
        aria-valuenow={metrics.width}
        aria-valuetext={`${metrics.width} 像素`}
        title="左右拖动调整目录宽度；双击恢复默认"
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
          const delta = e.clientX - gesture.x;
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
          const step = e.shiftKey ? 40 : 10;
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
