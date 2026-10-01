import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { TutorState } from '../ai/board';

// The teacher's pencil. It goes along whatever is being written or drawn, keeping time with
// the writing's own animation (a character at a time, a stroke along its length), then
// rests by the last thing it touched, so the student knows where to look. It follows the
// board: what it moves over is found on the page by the keys the board gives each drawing.

type Key = { t: number; x: number; y: number };
const boardWidth = 960;

// The ease strokes are drawn with (cubic-bezier(0.45, 0.05, 0.35, 1) in whiteboard.css),
// as how far along the stroke is at a moment.
function eased(x: number) {
  const [x1, y1, x2, y2] = [0.45, 0.05, 0.35, 1];
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, (lo + hi) / 2);
}
const ms = (el: Element, name: string) =>
  parseFloat(getComputedStyle(el).getPropertyValue(name)) || 0;

// Where things are, in board coordinates.
function placer(canvas: HTMLElement) {
  const base = canvas.getBoundingClientRect();
  const s = base.width / boardWidth || 1;
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - base.left) / s,
      y: (r.top - base.top) / s,
      w: r.width / s,
      h: r.height / s,
    };
  };
  // A point of an SVG element: the board's own layers are drawn in board coordinates, a
  // figure in its view box.
  const point = (el: SVGGraphicsElement, x: number, y: number): [number, number] => {
    const svg = el.ownerSVGElement;
    if (!svg || svg.classList.contains('wb-layer')) return [x, y];
    const vb = svg.viewBox.baseVal;
    const r = box(svg);
    if (!vb || !vb.width) return [r.x + x, r.y + y];
    return [r.x + ((x - vb.x) * r.w) / vb.width, r.y + ((y - vb.y) * r.h) / vb.height];
  };
  return { box, point };
}

// The pencil's way along a stroke drawn from `delay` for `dur`.
function along(
  el: SVGGeometryElement,
  delay: number,
  dur: number,
  place: ReturnType<typeof placer>,
) {
  let length = 0;
  try {
    length = el.getTotalLength();
  } catch {
    return [];
  }
  if (!length) return [];
  const steps = Math.max(6, Math.min(60, Math.round(length / 10)));
  const keys: Key[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = el.getPointAtLength(eased(i / steps) * length);
    const [x, y] = place.point(el, p.x, p.y);
    keys.push({ t: delay + (dur * i) / steps, x, y });
  }
  return keys;
}
// Over writing that appears a character at a time.
function writing(el: Element, start: number, place: ReturnType<typeof placer>) {
  const keys: Key[] = [];
  for (const atom of el.querySelectorAll('.wb-atom')) {
    const b = place.box(atom);
    if (!b.w) continue;
    const t = start + ms(atom, '--d');
    if (!keys.length) keys.push({ t, x: b.x, y: b.y + b.h * 0.8 });
    keys.push({ t: t + 120, x: b.x + b.w, y: b.y + b.h * 0.8 });
  }
  return keys;
}
// What the pencil does for a drawing the board just made.
function plan(pen: NonNullable<TutorState['pen']>, canvas: HTMLElement): Key[] {
  const place = placer(canvas);
  const keys: Key[] = [];
  const found = [
    ...canvas.querySelectorAll(
      pen.kind === 'shapes'
        ? `[data-pen^="${CSS.escape(pen.key)}."]`
        : `[data-pen="${CSS.escape(pen.key)}"]`,
    ),
  ];
  if (pen.kind === 'block') {
    const el = canvas.querySelector(`.wb-main > [data-ref="${CSS.escape(pen.key)}"]`);
    if (!el) return [];
    if (el.querySelector('.wb-atom')) return writing(el, 0, place);
    // A formula is wiped on from left to right.
    const b = place.box(el);
    const y = b.y + Math.min(b.h * 0.6, 40);
    const dur = ms(el, '--dur') || 600;
    return [
      { t: 0, x: b.x + 22, y },
      { t: dur, x: b.x + b.w, y },
    ];
  }
  for (const el of found) {
    const delay = ms(el, '--delay');
    const dur = ms(el, '--dur') || 400;
    if (el instanceof SVGGeometryElement && !el.matches('.wb-fig-fade')) {
      // An arrowhead is drawn once the shaft nearly is.
      const head = el.matches('.wb-arrow-head');
      keys.push(...along(el, head ? dur * 0.85 : delay, head ? 180 : dur, place));
    } else if (el instanceof SVGGraphicsElement) {
      const b = place.box(el);
      keys.push({ t: delay, x: b.x + b.w / 2, y: b.y + b.h / 2 });
      keys.push({ t: delay + dur, x: b.x + b.w / 2, y: b.y + b.h / 2 });
    } else keys.push(...writing(el, 0, place));
  }
  return keys.sort((a, b) => a.t - b.t);
}

export function BoardPen({
  pen,
  paused,
  teaching,
  canvas,
}: {
  pen: TutorState['pen'];
  paused: boolean;
  // Out of sight when the teacher isn't at the board.
  teaching: boolean;
  canvas: RefObject<HTMLDivElement | null>;
}) {
  const el = useRef<HTMLDivElement>(null);
  // The pencil's way (times from when the drawing appeared), when that was, and how long
  // the board has been paused since, on the clock the drawing's animation keeps.
  const state = useRef({
    keys: [] as Key[],
    start: 0,
    pausedFor: 0,
    pausedAt: 0,
    x: -100,
    y: -100,
  });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // A new drawing: the pencil goes there and along it, getting to where it starts quickly
  // from wherever it was.
  useLayoutEffect(() => {
    if (!pen || !canvas.current) return;
    const keys = plan(pen, canvas.current);
    if (!keys.length) return;
    const s = state.current;
    if (s.x > -100) {
      keys[0] = { ...keys[0], t: Math.max(keys[0].t, 120) };
      keys.unshift({ t: 0, x: s.x, y: s.y });
    }
    const now = performance.now();
    s.keys = keys;
    s.start = now;
    s.pausedFor = 0;
    s.pausedAt = pausedRef.current ? now : 0;
  }, [pen?.n]);

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const s = state.current;
      const node = el.current;
      if (!node) return;
      if (pausedRef.current && !s.pausedAt) s.pausedAt = now;
      if (!pausedRef.current && s.pausedAt) {
        s.pausedFor += now - s.pausedAt;
        s.pausedAt = 0;
      }
      const keys = s.keys;
      let idle = 0;
      if (keys.length) {
        const t = (s.pausedAt || now) - s.start - s.pausedFor;
        const i = keys.findIndex((k) => k.t > t);
        const a = keys[i < 0 ? keys.length - 1 : Math.max(0, i - 1)];
        const b = keys[i < 0 ? keys.length - 1 : i];
        const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
        s.x = a.x + (b.x - a.x) * f;
        s.y = a.y + (b.y - a.y) * f;
        idle = t - keys[keys.length - 1].t;
      }
      // Resting, it steps aside from what it wrote and bobs a little; long resting, it fades.
      const aside = Math.min(1, Math.max(0, idle / 400));
      const bob = idle > 0 ? Math.sin(now / 600) * 1.5 : 0;
      node.style.transform = `translate(${s.x + 12 * aside}px, ${s.y + 16 * aside + bob}px)`;
      node.dataset.state = !keys.length
        ? 'hidden'
        : idle > 6000
          ? 'away'
          : idle > 0
            ? 'rest'
            : 'drawing';
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={el}
      className="wb-pen"
      data-state="hidden"
      data-off={!teaching || undefined}
      aria-hidden="true"
    >
      <svg viewBox="0 0 44 44" width="44" height="44">
        <g transform="rotate(-45 22 22)">
          <path d="M22 1.5 L18.6 9.5 H25.4 Z" fill="#3a3a3a" />
          <path d="M18.6 9.5 L22 1.5 L25.4 9.5 L27 14 H17 Z" fill="#efd3a8" />
          <path d="M22 1.5 L20.6 4.8 H23.4 Z" fill="#2b2b2b" />
          <rect x="17" y="14" width="10" height="20" fill="#f3b93a" />
          <rect x="21" y="14" width="2" height="20" fill="#e2a52b" />
          <rect x="16.6" y="34" width="10.8" height="4" fill="#c9cdd2" />
          <path d="M16.6 38 H27.4 V40.5 Q22 44 16.6 40.5 Z" fill="#ec8d93" />
        </g>
      </svg>
    </div>
  );
}
