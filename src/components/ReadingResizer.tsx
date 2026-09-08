import { useEffect, useRef, useState } from 'react';

export function ReadingResizer({
  ratio,
  onChange,
}: {
  ratio: number;
  onChange: (ratio: number) => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; before: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  function change(value: number) {
    const width = handle.current?.parentElement?.clientWidth || 800;
    const min = Math.min(0.45, Math.max(0.2, 200 / width));
    onChange(Math.max(min, Math.min(1 - min, value)));
  }
  function finish(cancel = false) {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null;
    if (cancel) onChange(gesture.before);
    setDragging(false);
    if (handle.current?.hasPointerCapture(gesture.pointer))
      handle.current.releasePointerCapture(gesture.pointer);
  }
  useEffect(() => {
    const blur = () => finish();
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, []);
  return (
    <>
      <div
        ref={handle}
        className={`reading-resizer${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-label="调整双栏宽度"
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`左栏 ${Math.round(ratio * 100)}%`}
        title="左右拖动调整双栏宽度；双击恢复均分"
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { pointer: e.pointerId, before: ratio };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (drag.current?.pointer !== e.pointerId) return;
          const rect = e.currentTarget.parentElement!.getBoundingClientRect();
          change((e.clientX - rect.left) / rect.width);
        }}
        onPointerUp={() => finish()}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish()}
        onDoubleClick={() => onChange(0.5)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && drag.current) {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
            return;
          }
          const next =
            e.key === 'ArrowLeft'
              ? ratio - 0.025
              : e.key === 'ArrowRight'
                ? ratio + 0.025
                : e.key === 'Home'
                  ? 0.2
                  : e.key === 'End'
                    ? 0.8
                    : null;
          if (next === null) return;
          e.preventDefault();
          change(next);
        }}
      />
      {dragging ? <div className="sidebar-resize-shield" aria-hidden="true" /> : null}
    </>
  );
}
