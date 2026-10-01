import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../api';
import { errorText } from '../ai/client';

type Rect = { x: number; y: number; width: number; height: number };
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(n);
  });

// Drag a rectangle anywhere in the window to take a picture of it: a figure, a formula,
// a scanned page. The overlay hides itself before the shot, so it isn't in the picture.
export function RegionCapture(p: {
  hint?: string;
  // The picture, and the box it was taken of in window coordinates.
  onCapture: (png: string, box: { left: number; top: number; right: number; bottom: number }) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [shooting, setShooting] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        p.onCancel();
      }
    };
    const blur = () => !done.current && p.onCancel();
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, []);
  async function shoot(r: Rect) {
    done.current = true;
    setShooting(true);
    // Let the window repaint without the overlay first.
    await frames(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      p.onCapture(await invoke<string>('capture-region', r), {
        left: r.x,
        top: r.y,
        right: r.x + r.width,
        bottom: r.y + r.height,
      });
    } catch (e) {
      p.onError(errorText(e));
    }
  }
  return createPortal(
    <div
      className={`region-capture${rect ? ' selecting' : ''}`}
      role="application"
      aria-label="框选截图区域"
      hidden={shooting}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setStart({ x: e.clientX, y: e.clientY });
        setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
      }}
      onPointerMove={(e) => {
        if (!start) return;
        setRect({
          x: Math.min(start.x, e.clientX),
          y: Math.min(start.y, e.clientY),
          width: Math.abs(e.clientX - start.x),
          height: Math.abs(e.clientY - start.y),
        });
      }}
      onPointerUp={() => {
        setStart(null);
        if (rect && rect.width >= 8 && rect.height >= 8) void shoot(rect);
        else setRect(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onCancel();
      }}
    >
      {rect && rect.width + rect.height > 0 ? (
        <div
          className="region-capture-box"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          <span>
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      ) : null}
      {!start ? (
        <div className="region-capture-hint">{p.hint || '拖动框选要问 AI 的区域 · Esc 取消'}</div>
      ) : null}
    </div>,
    document.body,
  );
}
