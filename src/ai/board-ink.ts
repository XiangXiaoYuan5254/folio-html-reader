// Hand-drawn strokes for the whiteboard: circles that run past where they started, lines
// that wobble a little. Each stroke is seeded, so it keeps its shape when the board is laid
// out again after a resize.

export type Box = { x: number; y: number; w: number; h: number };
type P = [number, number];

function random(seed: string) {
  let a = 2166136261;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const n = (v: number) => Math.round(v * 10) / 10;
const pt = ([x, y]: P) => `${n(x)} ${n(y)}`;

export function pairs(flat: number[]): P[] {
  const out: P[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}
// A smooth line through the points: each point bends the curve towards it.
export function smooth(points: P[]): string {
  if (!points.length) return '';
  if (points.length < 3) return points.map((p, i) => `${i ? 'L' : 'M'}${pt(p)}`).join(' ');
  let d = `M${pt(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q${pt([x, y])} ${pt([(x + nx) / 2, (y + ny) / 2])}`;
  }
  return d + ` L${pt(points[points.length - 1])}`;
}

export function circlePath(b: Box, seed: string) {
  const r = random(seed);
  const cx = b.x + b.w / 2 + (r() - 0.5) * 4;
  const cy = b.y + b.h / 2 + (r() - 0.5) * 3;
  // Close around the words, so circles on neighbouring lines don't run into each other.
  const rx = b.w / 2 + 9 + Math.min(28, b.w * 0.04);
  const ry = b.h / 2 + 5 + Math.min(8, b.h * 0.1);
  // Starts at the upper left and goes once round and a bit more, drifting outwards.
  const start = -Math.PI * (0.55 + r() * 0.25);
  const sweep = Math.PI * 2 + 0.3 + r() * 0.35;
  const tilt = (r() - 0.5) * Math.min(0.08, 12 / Math.max(rx, 1));
  const phase = r() * Math.PI * 2;
  const points: P[] = [];
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const t = start + sweep * f;
    const grow = 1 + 0.06 * f + 0.02 * Math.sin(t * 2 + phase);
    const c = Math.cos(t);
    const s = Math.sin(t);
    // Squarer than an ellipse, so a long line fits without a huge loop.
    const x = rx * grow * Math.sign(c) * Math.abs(c) ** 0.8;
    const y = ry * grow * Math.sign(s) * Math.abs(s) ** 0.8;
    points.push([
      cx + x * Math.cos(tilt) - y * Math.sin(tilt),
      cy + x * Math.sin(tilt) + y * Math.cos(tilt),
    ]);
  }
  return smooth(points);
}

export function underlinePath(b: Box, seed: string) {
  const r = random(seed);
  const x0 = b.x - 3 - r() * 4;
  const x1 = b.x + b.w + 2 + r() * 6;
  const y0 = b.y + b.h + 4 + (r() - 0.5) * 2;
  const y1 = y0 + (r() - 0.5) * 5;
  const bow = (r() - 0.5) * 4;
  const points: P[] = [];
  for (let i = 0; i <= 10; i++) {
    const f = i / 10;
    points.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f + Math.sin(f * Math.PI) * bow]);
  }
  return smooth(points);
}

export function boxPath(b: Box, seed: string) {
  const r = random(seed);
  const pad = 7;
  const j = () => (r() - 0.5) * 4;
  const corners: P[] = [
    [b.x - pad + j(), b.y - pad + j()],
    [b.x + b.w + pad + j(), b.y - pad + j()],
    [b.x + b.w + pad + j(), b.y + b.h + pad + j()],
    [b.x - pad + j(), b.y + b.h + pad + j()],
  ];
  // Four strokes that each run a little past the corner.
  return corners
    .map(([ax, ay], i) => {
      const [bx, by] = corners[(i + 1) % 4];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const over = 4 + r() * 4;
      const s: P = [ax - ux * over * 0.4, ay - uy * over * 0.4];
      const e: P = [bx + ux * over, by + uy * over];
      const bend = (r() - 0.5) * 5;
      const m: P = [(s[0] + e[0]) / 2 - uy * bend, (s[1] + e[1]) / 2 + ux * bend];
      return `M${pt(s)} Q${pt(m)} ${pt(e)}`;
    })
    .join(' ');
}

// A highlighter swipe through the middle of the text.
export function markPath(b: Box, seed: string) {
  const r = random(seed);
  const width = Math.max(10, Math.min(36, b.h * 0.72));
  const y0 = b.y + b.h * 0.56;
  const y1 = y0 + (r() - 0.5) * 3;
  const m: P = [b.x + b.w / 2, (y0 + y1) / 2 + (r() - 0.5) * 2];
  return { d: `M${pt([b.x - 4, y0])} Q${pt(m)} ${pt([b.x + b.w + 4, y1])}`, width };
}

export type Label = { x: number; y: number; anchor: 'start' | 'middle' | 'end' };
function head(tip: P, from: P) {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const size = 13;
  const spread = 0.45;
  const a: P = [tip[0] - size * Math.cos(angle - spread), tip[1] - size * Math.sin(angle - spread)];
  const b: P = [tip[0] - size * Math.cos(angle + spread), tip[1] - size * Math.sin(angle + spread)];
  return `M${pt(a)} L${pt(tip)} L${pt(b)}`;
}
// An arrow from one thing on the board to another that crosses as little writing as it
// can: it tries leaving and arriving by each side, bent either way, and keeps the route
// that runs over the fewest letters. `writing` is the boxes of the letters and formula
// glyphs; the arrow's words go in the first clear spot beside it.
export function arrowPath(a: Box, b: Box, seed: string, label = '', writing: Box[] = []) {
  const r = random(seed);
  const sides = (box: Box, gap: number) => [
    { p: [box.x + box.w / 2, box.y + box.h + gap] as P, n: [0, 1] as P },
    { p: [box.x + box.w / 2, box.y - gap] as P, n: [0, -1] as P },
    { p: [box.x - gap, box.y + box.h / 2] as P, n: [-1, 0] as P },
    { p: [box.x + box.w + gap, box.y + box.h / 2] as P, n: [1, 0] as P },
  ];
  let best: { p0: P; c: P; p1: P; cost: number } | null = null;
  for (const s of sides(a, 5))
    for (const e of sides(b, 8))
      for (const bend of [0, 0.18, -0.18]) {
        const [p0, p1] = [s.p, e.p];
        const dx = p1[0] - p0[0];
        const dy = p1[1] - p0[1];
        const dist = Math.hypot(dx, dy);
        if (dist < 24) continue;
        // Pulled out the way both ends face, then bent sideways.
        const pull = Math.min(dist * 0.25, 70);
        const c: P = [
          (p0[0] + p1[0]) / 2 + (s.n[0] + e.n[0]) * pull - (dy / dist) * bend * dist,
          (p0[1] + p1[1]) / 2 + (s.n[1] + e.n[1]) * pull + (dx / dist) * bend * dist,
        ];
        // Ends that face each other read best.
        let cost =
          (1 - (s.n[0] * dx + s.n[1] * dy) / dist) * 0.6 +
          (1 + (e.n[0] * dx + e.n[1] * dy) / dist) * 0.6 +
          dist / 500 +
          Math.abs(bend);
        // Every 6px along the curve, so it can't slip between letters unnoticed; each
        // step over writing costs about as much as 60px of extra length.
        const steps = Math.ceil(
          (dist + Math.hypot(c[0] - p0[0], c[1] - p0[1]) + Math.hypot(p1[0] - c[0], p1[1] - c[1])) /
            12,
        );
        for (let i = 1; i < steps && (!best || cost < best.cost); i++) {
          const q = bezier(p0, c, p1, i / steps);
          if (q[0] < 4 || q[0] > 956) cost += 0.1;
          else if (writing.some((w) => inBox(q, w, 3))) cost += 0.1;
        }
        if (!best || cost < best.cost) best = { p0, c, p1, cost };
      }
  const { p0, c, p1 } = best || { p0: [a.x, a.y] as P, c: [a.x, b.y] as P, p1: [b.x, b.y] as P };
  const jitter: P = [c[0] + (r() - 0.5) * 8, c[1] + (r() - 0.5) * 8];
  return {
    shaft: `M${pt(p0)} Q${pt(jitter)} ${pt(p1)}`,
    head: head(p1, jitter),
    label: label ? placeLabel(label, p0, jitter, p1, writing) : null,
  };
}
const bezier = (p0: P, c: P, p1: P, t: number): P => [
  (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
  (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1],
];
const inBox = ([x, y]: P, b: Box, pad = 0) =>
  x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;

// Tries spots along the curve, on either side and a little further out, for words that
// cover nothing; failing that, the spot that covers least.
function placeLabel(text: string, p0: P, c: P, p1: P, writing: Box[]): Label {
  const width = [...text].length * 17 + 4;
  const height = 22;
  let best: { label: Label; covered: number } | null = null;
  for (const t of [0.5, 0.35, 0.65, 0.2, 0.8])
    for (const away of [14, 32])
      for (const side of [1, -1]) {
        const [x, y] = bezier(p0, c, p1, t);
        const [x2, y2] = bezier(p0, c, p1, t + 0.01);
        const len = Math.hypot(x2 - x, y2 - y) || 1;
        // Unit normal to the curve.
        const nx = (-(y2 - y) / len) * side;
        const ny = ((x2 - x) / len) * side;
        const ox = x + nx * away;
        const oy = y + ny * away;
        const anchor: Label['anchor'] = Math.abs(nx) < 0.35 ? 'middle' : nx > 0 ? 'start' : 'end';
        const left = anchor === 'start' ? ox : anchor === 'end' ? ox - width : ox - width / 2;
        const top = Math.abs(ny) < 0.35 ? oy - height / 2 : ny > 0 ? oy : oy - height;
        const box = { x: left, y: top, w: width, h: height };
        let covered = left < 0 || left + width > 960 ? 1e6 : 0;
        for (const w of writing) covered += overlap(box, w);
        const label: Label = { x: ox, y: top + height * 0.78, anchor };
        if (!covered) return label;
        if (!best || covered < best.covered) best = { label, covered };
      }
  return best!.label;
}
function overlap(a: Box, b: Box) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// The line from a margin note back to what it is about.
export function notePath(target: Box, note: Box) {
  const x1 = note.x - 8;
  const x0 = Math.min(target.x + target.w + 6, x1 - 24);
  const y0 = target.y + Math.min(target.h / 2, 18);
  const y1 = note.y + 14;
  const c: P = [(x0 + x1) / 2, y0];
  return `M${pt([x0, y0])} Q${pt(c)} ${pt([x1, y1])}`;
}
