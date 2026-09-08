import type { Annotation, EraserMode, Point } from '../types';

export function inkBounds(paths: Point[][]) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const path of paths)
    for (const p of path) {
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
  return Number.isFinite(left) ? { left, top, width: right - left, height: bottom - top } : null;
}

export function inkPaths(a: Annotation): Point[][] {
  if (a.paths) return a.paths;
  const p = a.points || [];
  if (!p.length || !['pen', 'arrow', 'rectangle'].includes(a.type)) return [];
  const first = p[0],
    last = p[p.length - 1];
  if (a.type === 'rectangle')
    return [[first, { x: last.x, y: first.y }, last, { x: first.x, y: last.y }, first]];
  if (a.type === 'arrow') {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    return [
      [first, last],
      [
        { x: last.x - 14 * Math.cos(angle - 0.5), y: last.y - 14 * Math.sin(angle - 0.5) },
        last,
        { x: last.x - 14 * Math.cos(angle + 0.5), y: last.y - 14 * Math.sin(angle + 0.5) },
      ],
    ];
  }
  return [p];
}

type Interval = [number, number];
const mix = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

function circle(a: Point, b: Point, c: Point, r: number): Interval | null {
  const d = sub(b, a),
    f = sub(a, c),
    aa = dot(d, d),
    cc = dot(f, f) - r * r;
  if (aa < 1e-12) return cc <= 0 ? [0, 1] : null;
  const bb = 2 * dot(f, d),
    discriminant = bb * bb - 4 * aa * cc;
  if (discriminant <= 0) return null;
  const root = Math.sqrt(discriminant);
  const lo = Math.max(0, (-bb - root) / (2 * aa)),
    hi = Math.min(1, (-bb + root) / (2 * aa));
  return hi > lo ? [lo, hi] : null;
}

// Exact intersection with the swept circular eraser: a rectangle and two round caps.
// Testing every swept segment prevents fast pointer moves from leaving gaps.
function sweptIntervals(a: Point, b: Point, from: Point, to: Point, r: number) {
  const intervals = [circle(a, b, from, r), circle(a, b, to, r)].filter((v): v is Interval => !!v);
  const axis = sub(to, from),
    length = Math.hypot(axis.x, axis.y);
  if (length > 1e-8) {
    const u = { x: axis.x / length, y: axis.y / length },
      v = { x: -u.y, y: u.x };
    const start = sub(a, from),
      direction = sub(b, a);
    let lo = 0,
      hi = 1;
    for (const [origin, delta, min, max] of [
      [dot(start, u), dot(direction, u), 0, length],
      [dot(start, v), dot(direction, v), -r, r],
    ]) {
      if (Math.abs(delta) < 1e-12) {
        if (origin < min || origin > max) hi = -1;
      } else {
        const t1 = (min - origin) / delta,
          t2 = (max - origin) / delta;
        lo = Math.max(lo, Math.min(t1, t2));
        hi = Math.min(hi, Math.max(t1, t2));
      }
    }
    if (hi > lo) intervals.push([lo, hi]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const tail = merged.at(-1);
    if (tail && interval[0] <= tail[1] + 1e-8) tail[1] = Math.max(tail[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export function erasePaths(
  paths: Point[][],
  from: Point,
  to: Point,
  radius: number,
  mode: EraserMode = 'partial',
): Point[][] {
  let changed = false;
  const result: Point[][] = [];
  for (const path of paths) {
    if (!path.length) continue;
    if (path.length === 1) {
      if (sweptIntervals(path[0], path[0], from, to, radius).length) {
        if (mode === 'stroke') return [];
        changed = true;
      } else result.push(path);
      continue;
    }
    let fragment: Point[] = [];
    const flush = () => {
      if (fragment.length) result.push(fragment);
      fragment = [];
    };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        b = path[i];
      const removed = sweptIntervals(a, b, from, to, radius);
      // All fragments and arrowheads still belong to one original annotation.
      if (mode === 'stroke' && removed.length) return [];
      if (removed.length) changed = true;
      const kept: Interval[] = [];
      let cursor = 0;
      for (const [lo, hi] of removed) {
        if (lo > cursor) kept.push([cursor, lo]);
        cursor = hi;
      }
      if (cursor < 1) kept.push([cursor, 1]);
      if (!kept.length) flush();
      for (const [lo, hi] of kept) {
        const start = mix(a, b, lo),
          end = mix(a, b, hi);
        if (fragment.length && !same(fragment.at(-1)!, start)) flush();
        if (!fragment.length) fragment.push(start);
        fragment.push(end);
        if (hi < 1) flush();
      }
    }
    flush();
  }
  return changed ? result : paths;
}

export function inkPathData(paths: Point[][], offset: Point) {
  return paths
    .map(
      (path) =>
        path.map((p, i) => `${i ? 'L' : 'M'}${p.x + offset.x} ${p.y + offset.y}`).join(' ') +
        (path.length === 1 ? ' l.01 0' : ''),
    )
    .join(' ');
}

/** Round freehand jitter using midpoint quadratics, sampled into editable ink. */
export function smoothPoints(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const result: Point[] = [points[0]];
  let start = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const control = points[i];
    const end = i === points.length - 2 ? points[i + 1] : mix(control, points[i + 1], 0.5);
    const steps = Math.max(
      1,
      Math.ceil(
        (Math.hypot(control.x - start.x, control.y - start.y) +
          Math.hypot(end.x - control.x, end.y - control.y)) /
          3,
      ),
    );
    for (let step = 1; step <= steps; step++) {
      const t = step / steps,
        u = 1 - t;
      result.push({
        x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
      });
    }
    start = end;
  }
  return result;
}
