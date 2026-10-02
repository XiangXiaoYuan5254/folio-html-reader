// 手绘可爱版的画笔：抖动的手绘线条、小涂鸦、吉祥物「小页」、AI 小星、纸张、便签、气泡、
// 简笔画的页间窗口。全部是 SVG，随机数都有种子，每次渲染画出来一样。
import { clamp, lerp, E, spring } from './kit.js';

export const C = {
  paper: '#fff7e8',
  ink: '#3d3a4b',
  ink2: '#7a7588',
  line: '#d9cfbd',
  teal: '#5bb5a2',
  tealD: '#2f8a78',
  tealL: '#d4f0e8',
  pink: '#ff9fb6',
  pinkL: '#ffe1e8',
  yellow: '#ffd25e',
  yellowL: '#fff1bf',
  sky: '#7fbcff',
  skyL: '#dcecff',
  violet: '#a58bff',
  violetL: '#ebe4ff',
  coral: '#ff7f6e',
  mint: '#a6e7c9',
  gold: '#f2c14e',
  blush: '#ff9fb0',
  red: '#e8505b',
  blue: '#4b8fe8',
};
export const FONT = {
  title: "'Wawati SC', 'HanziPen SC', cursive",
  hand: "'HanziPen SC', 'Hannotate SC', cursive",
  latin: "'Chalkboard SE', 'Comic Sans MS', cursive",
  serif: "'Times New Roman', Times, serif",
};
const NS = 'http://www.w3.org/2000/svg';

// ---------- 随机与曲线 ----------
export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
// Catmull–Rom through the points, as cubic Béziers.
export function smoothD(pts, closed = false) {
  const n = pts.length;
  const p = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const [a, b, c, e] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const c1 = [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6];
    const c2 = [c[0] - (e[0] - b[0]) / 6, c[1] - (e[1] - b[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${c[0].toFixed(1)} ${c[1].toFixed(1)}`;
  }
  return d + (closed ? 'Z' : '');
}
// Nudges each point by a smooth random amount, like an unsteady hand.
function wobble(pts, amp, seed) {
  const r = rng(seed);
  return pts.map(([x, y]) => [x + (r() - 0.5) * 2 * amp, y + (r() - 0.5) * 2 * amp]);
}
export function lineD(x1, y1, x2, y2, seed = 1, amp = 2.5) {
  const n = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 60));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([lerp(x1, x2, i / n), lerp(y1, y2, i / n)]);
  const w = wobble(pts, amp, seed);
  w[0] = [x1, y1];
  return smoothD(w);
}
export function polyD(pts, seed = 1, amp = 2, closed = false) {
  return smoothD(wobble(pts, amp, seed), closed);
}
// Straight-edged polygon drawn by hand: edges stay straight-ish, corners stay tight.
export function sharpD(pts, seed = 1, amp = 1.5, closed = true, step = 44) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const near = Math.min(0.3, 5 / len);
    const k = Math.max(1, Math.round(len / step));
    out.push(a, [lerp(a[0], b[0], near), lerp(a[1], b[1], near)]);
    for (let j = 1; j < k; j++) out.push([lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)]);
    out.push([lerp(a[0], b[0], 1 - near), lerp(a[1], b[1], 1 - near)]);
  }
  if (!closed) out.push(pts[n - 1]);
  return smoothD(wobble(out, amp, seed), closed);
}
// Rounded rectangle traced by hand: starts a bit before the corner and overshoots it.
export function rectD(x, y, w, h, r = 18, seed = 1, amp = 2.2) {
  r = Math.min(r, w / 2, h / 2);
  const pts = [];
  const step = 46;
  const edge = (x1, y1, x2, y2) => {
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let i = 0; i < n; i++) pts.push([lerp(x1, x2, i / n), lerp(y1, y2, i / n)]);
  };
  const corner = (cx, cy, a0) => {
    for (let i = 0; i < 3; i++) {
      const a = a0 + (i / 3) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  edge(x + r, y, x + w - r, y);
  corner(x + w - r, y + r, -Math.PI / 2);
  edge(x + w, y + r, x + w, y + h - r);
  corner(x + w - r, y + h - r, 0);
  edge(x + w - r, y + h, x + r, y + h);
  corner(x + r, y + h - r, Math.PI / 2);
  edge(x, y + h - r, x, y + r);
  corner(x + r, y + r, Math.PI);
  return smoothD(wobble(pts, amp, seed), true);
}
// A loop drawn in one go, ending a little past where it began.
export function ellipseD(cx, cy, rx, ry, seed = 1, amp = 2, over = 0.12, a0 = -2.2) {
  const r = rng(seed);
  const n = 26;
  const pts = [];
  for (let i = 0; i <= n * (1 + over); i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    const k = 1 + (r() - 0.5) * 0.06 + (i / n) * 0.04;
    pts.push([cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
  }
  return smoothD(wobble(pts, amp, seed + 7));
}
export function starD(cx, cy, R, seed = 1) {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? R * 0.45 : R;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const w = wobble(pts, R * 0.05, seed);
  return 'M' + w.map((p) => p.map((v) => v.toFixed(1)).join(' ')).join('L');
}
export function sparkleD(cx, cy, R, inner = 0.18) {
  let d = '';
  for (let k = 0; k < 4; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 2;
    const tip = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    const c = [cx + R * inner * Math.cos(a + Math.PI / 4), cy + R * inner * Math.sin(a + Math.PI / 4)];
    const next = [cx + R * Math.cos(a + Math.PI / 2), cy + R * Math.sin(a + Math.PI / 2)];
    d += (k ? '' : `M${tip[0]} ${tip[1]}`) + `Q${c[0]} ${c[1]} ${next[0]} ${next[1]}`;
  }
  return d + 'Z';
}
export function heartD(cx, cy, R) {
  return `M${cx} ${cy + R * 0.9}C${cx - R * 1.4} ${cy - R * 0.1} ${cx - R * 0.7} ${cy - R * 1.2} ${cx} ${cy - R * 0.45}C${cx + R * 0.7} ${cy - R * 1.2} ${cx + R * 1.4} ${cy - R * 0.1} ${cx} ${cy + R * 0.9}Z`;
}
export function squiggleD(x, y, w, amp = 8, waves = 5, seed = 1) {
  const pts = [];
  const n = waves * 4;
  for (let i = 0; i <= n; i++) pts.push([x + (w * i) / n, y + Math.sin((i / 4) * Math.PI * 2) * amp]);
  return smoothD(wobble(pts, 1.2, seed));
}
// Arrow head at the end of a path whose last direction is `ang` (radians).
export function headD(x, y, ang, size = 22) {
  const a1 = ang + Math.PI - 0.5;
  const a2 = ang + Math.PI + 0.5;
  return `M${x + size * Math.cos(a1)} ${y + size * Math.sin(a1)}L${x} ${y}L${x + size * Math.cos(a2)} ${y + size * Math.sin(a2)}`;
}

// ---------- SVG ----------
export function s(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  parent?.append(e);
  return e;
}
export const g = (parent, attrs) => s('g', attrs, parent);
export function T(parent, str, x, y, { font = FONT.hand, size = 40, fill = C.ink, anchor = 'start', weight = 400, ...rest } = {}) {
  const e = s('text', { x, y, 'font-family': font, 'font-size': size, fill, 'text-anchor': anchor, 'font-weight': weight, ...rest }, parent);
  e.textContent = str;
  return e;
}
// Horizontal extent of `sub` inside a text element, in its own units.
export function span(textEl, sub, from = 0) {
  const i = textEl.textContent.indexOf(sub, from);
  if (i < 0) throw Error('not in text: ' + sub);
  const a = textEl.getStartPositionOfChar(i).x;
  const b = textEl.getEndPositionOfChar(i + [...sub].length - 1).x;
  return { x0: a, x1: b, w: b - a };
}
// Each character as its own group, so they can bounce one by one.
export function letters(parent, str, x, y, opts = {}) {
  const probe = T(parent, str, x, y, { ...opts, anchor: 'start' });
  const chars = [...str];
  const ext = chars.map((_, i) => probe.getExtentOfChar(i));
  const width = probe.getComputedTextLength();
  probe.remove();
  const shift = opts.anchor === 'middle' ? -width / 2 : opts.anchor === 'end' ? -width : 0;
  const box = g(parent);
  const items = chars.map((c, i) => {
    const cx = ext[i].x + ext[i].width / 2 + shift;
    const cy = ext[i].y + ext[i].height / 2;
    const holder = g(box);
    const inner = g(holder);
    T(inner, c, cx, y, { ...opts, anchor: 'middle' });
    return { g: inner, cx, cy, c };
  });
  return { g: box, items, width, x0: x + shift };
}
// Pop each letter in with a little spring and tilt.
export function popLetters(L, t, t0, { stagger = 0.06, freq = 2.4, damp = 0.45, out } = {}) {
  L.items.forEach((it, i) => {
    const k = spring(t - t0 - i * stagger, freq, damp);
    let o = clamp(k * 3);
    let dy = (1 - k) * 40;
    let rot = (1 - k) * (i % 2 ? 16 : -16);
    if (out != null && t > out) {
      const q = E.in(clamp((t - out - i * 0.025) / 0.35));
      o *= 1 - q;
      dy += q * 90;
      rot += q * (i % 2 ? 30 : -30);
    }
    it.g.setAttribute('transform', `translate(${it.cx} ${it.cy + dy}) rotate(${rot}) scale(${Math.max(0, k)}) translate(${-it.cx} ${-it.cy})`);
    it.g.setAttribute('opacity', o);
  });
}
// Fill a little off the outline, like a slightly misregistered print.
export function shape(parent, d, { fill, stroke = C.ink, sw = 5, off = [5, 6], fillOpacity = 1, dash } = {}) {
  const box = g(parent);
  const f = fill ? s('path', { d, fill, 'fill-opacity': fillOpacity, transform: `translate(${off[0]} ${off[1]})` }, box) : null;
  const l = stroke
    ? s('path', { d, fill: 'none', stroke, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': dash }, box)
    : null;
  return { g: box, f, l };
}
// A stroke that can be drawn on: k from 0 (nothing) to 1 (all).
export function stroke(parent, d, { color = C.ink, sw = 5, opacity = 1 } = {}) {
  const p = s('path', { d, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': '1 1', 'stroke-dashoffset': 1, opacity }, parent);
  p.draw = (k) => p.setAttribute('stroke-dashoffset', 1 - clamp(k));
  return p;
}
// Clip rectangle that reveals its content left to right, for writing and highlighting.
let clipN = 0;
export function wiper(defsParent, target, x, y, w, h) {
  const id = 'w' + ++clipN;
  const cp = s('clipPath', { id }, defsParent);
  const r = s('rect', { x, y, width: 0, height: h }, cp);
  target.setAttribute('clip-path', `url(#${id})`);
  return { set: (k) => r.setAttribute('width', Math.max(0, w * clamp(k))), x, y, w, h };
}
export function place(e, x, y, sc = 1, rot = 0) {
  e.setAttribute('transform', `translate(${x} ${y}) rotate(${rot}) scale(${sc})`);
}

// ---------- 小页：页间图标变成的吉祥物 ----------
const PAGE = 'M260 295c94-17 167 5 252 55 85-50 158-72 252-55v420c-91-22-173-7-252 37-79-44-161-59-252-37z';
export class Mascot {
  constructor(parent, { color = C.teal, seed = 3 } = {}) {
    this.root = g(parent);
    this.shadow = s('ellipse', { cx: 0, cy: 0, rx: 96, ry: 15, fill: 'rgba(61,58,75,.14)' }, this.root);
    this.lift = g(this.root);
    this.body = g(this.lift);
    this.armL = this.arm(-1);
    this.armR = this.arm(1);
    this.feet = [-42, 42].map((x) =>
      s('ellipse', { cx: x, cy: -19, rx: 30, ry: 16, fill: C.tealD, stroke: C.ink, 'stroke-width': 4.5 }, this.body),
    );
    this.ribbon = g(this.body);
    s('path', { d: 'M28 -222 L28 -272 L40 -261 L52 -272 L52 -222 Z', fill: C.gold, stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, this.ribbon);
    const torso = rectD(-96, -234, 192, 206, 74, seed, 1.6);
    this.fill = s('path', { d: torso, fill: color, transform: 'translate(4 5)' }, this.body);
    s('path', { d: torso, fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linejoin': 'round' }, this.body);
    s('path', { d: PAGE, transform: 'translate(-153.6 -286) scale(.3)', fill: '#fffdf6', stroke: C.ink, 'stroke-width': 15 }, this.body);
    s('path', { d: 'M0 -178 L0 -156', stroke: '#b6cfc4', 'stroke-width': 4, 'stroke-linecap': 'round' }, this.body);
    this.face = g(this.body);
    this.blushes = [-50, 50].map((x) => s('ellipse', { cx: x, cy: -103, rx: 13, ry: 7.5, fill: C.blush, opacity: 0.75 }, this.face));
    this.eyes = [-35, 35].map((x) => {
      const e = g(this.face, { transform: `translate(${x} -132)` });
      const ball = s('ellipse', { cx: 0, cy: 0, rx: 10, ry: 13, fill: C.ink }, e);
      const shine = s('circle', { cx: 3.5, cy: -5, r: 3.6, fill: '#fff' }, e);
      return { e, ball, shine, x };
    });
    this.happyEyes = g(this.face);
    for (const x of [-35, 35])
      s('path', { d: `M${x - 11} -128 Q${x} -144 ${x + 11} -128`, fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, this.happyEyes);
    this.dizzyEyes = g(this.face);
    for (const x of [-35, 35])
      s('path', { d: `M${x} -132 m-2 0 a2 2 0 1 1 4 0 a5 5 0 1 1 -9 0 a8 8 0 1 1 15 1 a11 11 0 1 1 -20 -2`, fill: 'none', stroke: C.ink, 'stroke-width': 3.2, 'stroke-linecap': 'round' }, this.dizzyEyes);
    this.winkEye = s('path', { d: 'M24 -130 Q35 -140 46 -130', fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, this.face);
    this.mouths = {
      smile: s('path', { d: 'M-10 -110 Q0 -100 10 -110', fill: 'none', stroke: C.ink, 'stroke-width': 4.5, 'stroke-linecap': 'round' }, this.face),
      open: s('path', { d: 'M-12 -112 Q0 -93 12 -112 Z', fill: '#d9536b', stroke: C.ink, 'stroke-width': 4, 'stroke-linejoin': 'round' }, this.face),
      o: s('ellipse', { cx: 0, cy: -106, rx: 7, ry: 9, fill: '#d9536b', stroke: C.ink, 'stroke-width': 4 }, this.face),
      wavy: s('path', { d: 'M-14 -106 q5 -6 9 0 t9 0 t9 0', fill: 'none', stroke: C.ink, 'stroke-width': 4, 'stroke-linecap': 'round' }, this.face),
    };
    this.glasses = g(this.face);
    for (const x of [-35, 35])
      s('circle', { cx: x, cy: -132, r: 21, fill: 'rgba(255,255,255,.25)', stroke: C.ink, 'stroke-width': 4.5 }, this.glasses);
    s('path', { d: 'M-14 -134 Q0 -142 14 -134', fill: 'none', stroke: C.ink, 'stroke-width': 4.5 }, this.glasses);
    this.sweat = s('path', { d: 'M78 -200 q10 16 0 22 q-10 -6 0 -22z', fill: '#9fd3ff', stroke: C.ink, 'stroke-width': 3.5 }, this.body);
    this.mood = null;
    this.set({});
  }
  arm(side) {
    const a = g(this.body, { transform: `translate(${side * 90} -118)` });
    const inner = g(a);
    const d = side > 0 ? 'M0 0 Q22 10 30 38' : 'M0 0 Q-22 10 -30 38';
    s('path', { d, fill: 'none', stroke: C.ink, 'stroke-width': 25, 'stroke-linecap': 'round' }, inner);
    const f = s('path', { d, fill: 'none', stroke: C.teal, 'stroke-width': 15, 'stroke-linecap': 'round' }, inner);
    const hand = g(inner, { transform: `translate(${side * 30} 38)` });
    (this.armFills ||= []).push(f);
    inner.hand = hand;
    inner.side = side;
    return inner;
  }
  // x, y: feet position; lift: jump height; sq: squash (+) or stretch (−); raiseL/R in degrees.
  set({ x = 0, y = 0, scale = 1, lift = 0, sq = 0, rot = 0, raiseL = 0, raiseR = 0, blink = 0, look = [0, 0], mood = 'smile', sweat = false, glasses = false, color, sway = 0, opacity = 1 }) {
    place(this.root, x, y, scale);
    this.root.setAttribute('opacity', opacity);
    this.lift.setAttribute('transform', `translate(0 ${-lift})`);
    const sh = clamp(1 - lift / 700, 0.4, 1);
    this.shadow.setAttribute('transform', `scale(${sh} ${sh})`);
    this.body.setAttribute('transform', `rotate(${rot}) scale(${1 + 0.22 * sq} ${1 - 0.22 * sq})`);
    this.armL.setAttribute('transform', `rotate(${raiseL})`);
    this.armR.setAttribute('transform', `rotate(${-raiseR})`);
    this.ribbon.setAttribute('transform', `rotate(${sway} 40 -222)`);
    if (color && color !== this.color) {
      this.color = color;
      this.fill.setAttribute('fill', color);
      for (const f of this.armFills) f.setAttribute('stroke', color);
    }
    for (const { e, ball, shine, x } of this.eyes) {
      e.setAttribute('transform', `translate(${x + look[0]} ${-132 + look[1]}) scale(1 ${Math.max(0.08, 1 - blink)})`);
      shine.setAttribute('opacity', blink > 0.5 ? 0 : 1);
      ball.setAttribute('rx', mood === 'wow' ? 12 : 10);
      ball.setAttribute('ry', mood === 'wow' ? 15 : 13);
    }
    const eyesOn = !['happy', 'dizzy'].includes(mood);
    this.eyes[0].e.style.display = eyesOn ? '' : 'none';
    this.eyes[1].e.style.display = eyesOn && mood !== 'wink' ? '' : 'none';
    this.happyEyes.style.display = mood === 'happy' ? '' : 'none';
    this.dizzyEyes.style.display = mood === 'dizzy' ? '' : 'none';
    this.winkEye.style.display = mood === 'wink' ? '' : 'none';
    const mouth = { smile: 'smile', happy: 'open', wink: 'open', wow: 'o', dizzy: 'wavy', talk: 'open' }[mood] || 'smile';
    for (const k in this.mouths) this.mouths[k].style.display = k === mouth ? '' : 'none';
    this.glasses.style.display = glasses ? '' : 'none';
    this.sweat.style.display = sweat ? '' : 'none';
  }
}
// Blinks now and then: returns 0 (open) … 1 (closed).
export function blinkAt(t, every = 2.9, phase = 0.4) {
  const u = (t + phase) % every;
  return u < 0.16 ? Math.sin((u / 0.16) * Math.PI) : 0;
}
// Bounce landing: a fall from `h` that lands at t = 0, then settles with a squash.
export function landing(t, h = 900, fall = 0.55) {
  if (t < 0) {
    const k = clamp(1 + t / fall);
    return { lift: h * (1 - k * k), sq: -0.25 * k };
  }
  return { lift: 0, sq: 0.7 * Math.exp(-7 * t) * Math.cos(15 * t) };
}
// A hop starting at t = 0 lasting `dur`.
export function hop(t, height = 120, dur = 0.5) {
  if (t < 0 || t > dur + 0.4) return { lift: 0, sq: 0 };
  if (t < 0.08) return { lift: 0, sq: 0.35 * Math.sin((t / 0.08) * Math.PI) };
  if (t < dur) {
    const k = (t - 0.08) / (dur - 0.08);
    return { lift: height * 4 * k * (1 - k), sq: -0.18 * Math.sin(k * Math.PI) };
  }
  const u = t - dur;
  return { lift: 0, sq: 0.5 * Math.exp(-9 * u) * Math.cos(16 * u) };
}

// ---------- AI 小星 ----------
export class Buddy {
  constructor(parent, color = C.violet) {
    this.root = g(parent);
    this.glow = s('circle', { cx: 0, cy: 0, r: 110, fill: color, opacity: 0.18 }, this.root);
    this.body = g(this.root);
    const d = sparkleD(0, 0, 92, 0.42);
    s('path', { d, fill: color, transform: 'translate(5 6)' }, this.body);
    s('path', { d, fill: '#c4b3ff', stroke: C.ink, 'stroke-width': 5, 'stroke-linejoin': 'round' }, this.body);
    this.eyes = [-13, 13].map((x) => s('ellipse', { cx: x, cy: -6, rx: 5.5, ry: 7.5, fill: C.ink }, this.body));
    s('path', { d: 'M-8 8 Q0 15 8 8', fill: 'none', stroke: C.ink, 'stroke-width': 4, 'stroke-linecap': 'round' }, this.body);
    for (const x of [-24, 24]) s('ellipse', { cx: x, cy: 7, rx: 7, ry: 4.5, fill: C.blush, opacity: 0.8 }, this.body);
    this.twinkles = [0, 1, 2].map((i) => s('path', { d: sparkleD(0, 0, 14), fill: C.yellow, stroke: C.ink, 'stroke-width': 2.5 }, this.root));
  }
  set({ x = 0, y = 0, scale = 1, rot = 0, blink = 0, t = 0, opacity = 1 }) {
    place(this.root, x, y, scale);
    this.root.setAttribute('opacity', opacity);
    this.body.setAttribute('transform', `rotate(${rot + Math.sin(t * 2.2) * 6}) scale(${1 + Math.sin(t * 4) * 0.03})`);
    for (const e of this.eyes) e.setAttribute('ry', 7.5 * Math.max(0.1, 1 - blink));
    this.glow.setAttribute('r', 105 + Math.sin(t * 3) * 10);
    this.twinkles.forEach((tw, i) => {
      const a = t * 1.6 + (i * Math.PI * 2) / 3;
      const k = 0.6 + 0.4 * Math.sin(t * 5 + i * 2);
      place(tw, Math.cos(a) * 120, Math.sin(a) * 90, k, t * 90);
    });
  }
}

// ---------- 纸张、便签、气泡 ----------
// A sheet of paper with a folded corner and a file-type tag.
export function sheet(parent, { x, y, w, h, tag, seed = 1, fill = '#fffdf8' }) {
  const box = g(parent, { transform: `translate(${x} ${y})` });
  const d = `M0 14 Q0 0 14 0 L${w - 46} 0 L${w} 46 L${w} ${h - 14} Q${w} ${h} ${w - 14} ${h} L14 ${h} Q0 ${h} 0 ${h - 14} Z`;
  s('path', { d, fill: 'rgba(61,58,75,.10)', transform: 'translate(10 12)' }, box);
  s('path', { d: sharpD([[0, 0], [w - 46, 0], [w, 46], [w, h], [0, h]], seed, 1.4), fill, stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, box);
  s('path', { d: `M${w - 46} 0 L${w - 46} 46 L${w} 46`, fill: '#f1e6d1', stroke: C.ink, 'stroke-width': 4, 'stroke-linejoin': 'round' }, box);
  if (tag) {
    const col = tag === 'PDF' ? C.red : C.blue;
    const tg = g(box, { transform: 'translate(22 -18) rotate(-4)' });
    shape(tg, rectD(0, 0, tag === 'PDF' ? 78 : 92, 40, 12, seed + 3, 1.2), { fill: col, sw: 3.5, off: [3, 3] });
    T(tg, tag, tag === 'PDF' ? 39 : 46, 30, { font: FONT.latin, size: 24, fill: '#fff', anchor: 'middle', weight: 700 });
  }
  return box;
}
// Gray scribbles standing in for lines of text.
export function scribbles(parent, x, y, w, n, { gap = 30, seed = 1, color = C.line, sw = 7 } = {}) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? w * (0.4 + r() * 0.3) : w * (0.82 + r() * 0.18);
    out.push(s('path', { d: lineD(x, y + i * gap, x + len, y + i * gap + (r() - 0.5) * 3, seed * 10 + i, 1.6), stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', fill: 'none' }, parent));
  }
  return out;
}
export function sticky(parent, { x, y, w = 300, h = 170, color = C.yellowL, rot = 0, seed = 1, lines = [], size = 40, sub }) {
  const box = g(parent);
  const inner = g(box);
  shape(inner, rectD(-w / 2, -h / 2, w, h, 10, seed, 1.8), { fill: color, sw: 4.5 });
  s('path', { d: rectD(-46, -h / 2 - 16, 92, 32, 4, seed + 5, 1), fill: 'rgba(255,255,255,.55)', stroke: 'rgba(61,58,75,.25)', 'stroke-width': 2, transform: 'rotate(-6)' }, inner);
  const texts = lines.map((l, i) => T(inner, l, 0, -((lines.length - 1) * size * 1.25) / 2 + i * size * 1.25 + size * 0.35 - (sub ? 14 : 0), { size, anchor: 'middle' }));
  if (sub) texts.push(T(inner, sub, 0, h / 2 - 26, { size: 26, anchor: 'middle', fill: C.ink2 }));
  box.base = { x, y, rot };
  box.inner = inner;
  box.texts = texts;
  place(box, x, y, 1, rot);
  return box;
}
// Slap a sticky note in: drops with a wobble at t0.
export function slap(note, t, t0, out) {
  const k = spring(t - t0, 2.2, 0.42);
  const { x, y, rot } = note.base;
  let o = clamp((t - t0) * 8);
  let sc = lerp(1.6, 1, clamp(k));
  let dy = 0;
  if (out != null && t > out) {
    const q = E.in(clamp((t - out) / 0.4));
    o *= 1 - q;
    dy = -q * 60;
    sc *= 1 - q * 0.3;
  }
  place(note, x, y + dy, t < t0 ? 0 : sc, rot + (1 - clamp(k)) * 12);
  note.setAttribute('opacity', o);
}
// Speech bubble with a tail; text can be typed out a character at a time.
export class Bubble {
  constructor(parent, { x, y, w, h, tail = [0, 0], fill = '#fff', stroke = C.ink, lines = [], size = 38, align = 'middle', seed = 2, font = FONT.hand, pad = 30 }) {
    this.root = g(parent);
    this.inner = g(this.root);
    const tx = tail[0] - x;
    const ty = tail[1] - y;
    const bodyD = rectD(-w / 2, -h / 2, w, h, Math.min(34, h / 2), seed, 1.8);
    const base = clamp(tx, -w / 2 + 40, w / 2 - 40);
    const edge = ty > 0 ? h / 2 - 2 : -h / 2 + 2;
    const tailD = `M${base - 18} ${edge} Q${(base + tx) / 2} ${(edge + ty) / 2} ${tx} ${ty} Q${(base + tx) / 2 + 6} ${(edge + ty) / 2} ${base + 18} ${edge}`;
    s('path', { d: bodyD, fill: 'rgba(61,58,75,.10)', transform: 'translate(7 9)' }, this.inner);
    s('path', { d: tailD, fill, stroke, 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, this.inner);
    s('path', { d: bodyD, fill, stroke, 'stroke-width': 4.5 }, this.inner);
    s('path', { d: tailD.replace(/^M[^Q]+/, (m) => m) , fill, stroke: 'none', transform: 'translate(0 -3)' }, this.inner);
    const lx = align === 'middle' ? 0 : -w / 2 + pad;
    this.texts = lines.map((l, i) =>
      T(this.inner, l, lx, -((lines.length - 1) * size * 1.3) / 2 + i * size * 1.3 + size * 0.35, { size, anchor: align, font }),
    );
    this.full = lines;
    this.x = x;
    this.y = y;
    this.tail = [tx, ty];
  }
  // Pop in at t0 (scale from the tail), out at t1.
  show(t, t0, t1) {
    const k = spring(t - t0, 2.3, 0.45);
    let o = clamp((t - t0) * 6);
    let sc = Math.max(0, k);
    if (t1 != null && t > t1) {
      const q = E.in(clamp((t - t1) / 0.25));
      o *= 1 - q;
      sc *= 1 - q * 0.6;
    }
    this.root.setAttribute('transform', `translate(${this.x} ${this.y})`);
    this.inner.setAttribute('transform', `translate(${this.tail[0]} ${this.tail[1]}) scale(${sc}) translate(${-this.tail[0]} ${-this.tail[1]})`);
    this.root.setAttribute('opacity', t < t0 ? 0 : o);
  }
  // Type the text out between t0 and t1.
  type(t, t0, t1) {
    const total = this.full.reduce((a, l) => a + [...l].length, 0);
    let n = Math.floor(total * clamp((t - t0) / (t1 - t0)));
    this.full.forEach((l, i) => {
      const cs = [...l];
      this.texts[i].textContent = cs.slice(0, n).join('');
      n = Math.max(0, n - cs.length);
    });
  }
}

// ---------- 工具：荧光笔、红笔、魔法棒、手指 ----------
export function tool(parent, kind) {
  const box = g(parent);
  const inner = g(box);
  if (kind === 'highlighter') {
    shape(inner, polyD([[-8, -6], [8, -6], [26, -64], [10, -70], [-6, -12]], 2, 0.6, true), { fill: C.yellow, sw: 4, off: [2, 2] });
    shape(inner, rectD(4, -150, 44, 90, 12, 3, 1.2), { fill: '#fff2b0', sw: 4.5, off: [3, 3] });
    inner.setAttribute('transform', 'rotate(28)');
  } else if (kind === 'wand') {
    s('path', { d: 'M0 0 L0 -150', stroke: C.ink, 'stroke-width': 14, 'stroke-linecap': 'round' }, inner);
    s('path', { d: 'M0 0 L0 -150', stroke: '#8a6cff', 'stroke-width': 7, 'stroke-linecap': 'round' }, inner);
    s('path', { d: starD(0, -168, 30, 4), fill: C.yellow, stroke: C.ink, 'stroke-width': 4, 'stroke-linejoin': 'round' }, inner);
  } else if (kind === 'pointer') {
    s('path', { d: 'M0 0 L0 46 L12 35 L21 55 L31 50 L22 31 L38 31 Z', fill: '#fff', stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, inner);
  } else {
    // pens: red, marker colors…
    const col = { red: C.red, purple: '#8a6cff', marker: C.ink, orange: '#ff9a3c', green: '#3bb273', blue: C.blue }[kind] || C.red;
    shape(inner, polyD([[0, 0], [-7, -22], [7, -22]], 5, 0.4, true), { fill: col, sw: 3.5, off: [1, 1] });
    shape(inner, rectD(-12, -150, 24, 128, 10, 6, 1), { fill: '#fff', sw: 4.5, off: [3, 3] });
    s('rect', { x: -12, y: -150, width: 24, height: 34, rx: 10, fill: col, stroke: C.ink, 'stroke-width': 4.5 }, inner);
    inner.setAttribute('transform', 'rotate(24)');
  }
  return box;
}
// Ripple rings where something was clicked.
export function ripple(parent, color = C.violet) {
  const c = s('circle', { r: 0, fill: 'none', stroke: color, 'stroke-width': 5 }, parent);
  c.at = (t, t0, x, y) => {
    const k = (t - t0) / 0.45;
    if (k < 0 || k > 1) return c.setAttribute('r', 0);
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', 8 + 40 * E.out(k));
    c.setAttribute('opacity', 1 - k);
  };
  return c;
}

// ---------- 撒花 ----------
export function confetti(parent, { x, y, n = 46, seed = 9 }) {
  const r = rng(seed);
  const cols = [C.yellow, C.pink, C.teal, C.sky, C.violet, C.coral, C.mint];
  const bits = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 4;
    const col = cols[i % cols.length];
    const e =
      kind === 0
        ? s('path', { d: starD(0, 0, 16, i), fill: col, stroke: C.ink, 'stroke-width': 3 }, parent)
        : kind === 1
          ? s('path', { d: heartD(0, 0, 13), fill: col, stroke: C.ink, 'stroke-width': 3 }, parent)
          : kind === 2
            ? s('circle', { r: 9, fill: col, stroke: C.ink, 'stroke-width': 3 }, parent)
            : s('path', { d: squiggleD(-18, 0, 36, 5, 2, i), fill: 'none', stroke: col, 'stroke-width': 6, 'stroke-linecap': 'round' }, parent);
    const a = -Math.PI / 2 + (r() - 0.5) * 2.4;
    const v = 700 + r() * 900;
    bits.push({ e, vx: Math.cos(a) * v, vy: Math.sin(a) * v, spin: (r() - 0.5) * 900, drift: (r() - 0.5) * 2 });
  }
  return (t, t0) => {
    const u = t - t0;
    for (const b of bits) {
      if (u < 0) {
        b.e.setAttribute('opacity', 0);
        continue;
      }
      const drag = (1 - Math.exp(-2.2 * u)) / 2.2;
      const px = x + b.vx * drag + Math.sin(u * 3 + b.drift) * 30;
      const py = y + b.vy * drag + 420 * u * u;
      place(b.e, px, py, 1, b.spin * u);
      b.e.setAttribute('opacity', clamp(2.6 - u));
    }
  };
}

// ---------- 简笔画的页间窗口 ----------
export const PALETTES = [
  { name: '青岚', bg: '#f6fbf9', bar: '#eef7f3', side: '#e8f4ef', paper: '#ffffff', ink: '#2b3a36', ink2: '#bcd3cb', accent: '#2f8a78', line: C.ink, mascot: C.teal },
  { name: '宣纸', bg: '#f7efe0', bar: '#f1e6d1', side: '#ede0c8', paper: '#fffaf0', ink: '#3b2f25', ink2: '#d6c6a6', accent: '#c0392b', line: '#5a4632', mascot: '#e2735f', font: "'Songti SC', serif" },
  { name: '晴空', bg: '#f3f8ff', bar: '#e7f1ff', side: '#ddeaff', paper: '#ffffff', ink: '#1f2d4a', ink2: '#c4d6f2', accent: '#4b7bec', line: C.ink, mascot: '#7fb0ff' },
  { name: '桃夭', bg: '#fff5f7', bar: '#ffe9ef', side: '#ffe0e8', paper: '#ffffff', ink: '#4a2b35', ink2: '#f2c8d3', accent: '#e86a8b', line: C.ink, mascot: '#ff9fb6' },
  { name: '夜读', bg: '#1e2535', bar: '#252e42', side: '#222a3c', paper: '#2a3348', ink: '#e6e9ef', ink2: '#46526b', accent: '#5ec2b1', line: '#0e1320', mascot: '#3f6f8f' },
  { name: '墨金', bg: '#17191d', bar: '#1f2227', side: '#1c1f24', paper: '#23262c', ink: '#efe6cf', ink2: '#3d3a33', accent: '#d4af37', line: '#0a0b0d', mascot: '#d4af37' },
  { name: '新粗野', bg: '#fff7d6', bar: '#ffe066', side: '#ffd23f', paper: '#ffffff', ink: '#111111', ink2: '#cfc6a0', accent: '#ff5c8a', line: '#111111', mascot: '#ff5c8a', sw: 8 },
  { name: '报刊', bg: '#f3eee1', bar: '#ebe3d0', side: '#e8dfca', paper: '#faf6ec', ink: '#1a1a1a', ink2: '#cfc4ad', accent: '#b4372b', line: '#1a1a1a', mascot: '#8c8c8c', font: "'Songti SC', serif" },
  { name: '终端', bg: '#0b0f0b', bar: '#0f160f', side: '#0d130d', paper: '#0b100b', ink: '#39ff6a', ink2: '#1f5a2d', accent: '#39ff6a', line: '#000000', mascot: '#2bd45a', font: "Menlo, monospace" },
  { name: '极光', bg: 'url(#aurora)', bar: 'rgba(255,255,255,.12)', side: 'rgba(255,255,255,.10)', paper: 'rgba(255,255,255,.16)', ink: '#ffffff', ink2: 'rgba(255,255,255,.35)', accent: '#7cf2d0', line: '#120c2a', mascot: '#9b7bff' },
];
export class AppWin {
  constructor(parent, { w, h, seed = 11 }) {
    this.root = g(parent);
    this.w = w;
    this.h = h;
    const sb = Math.round(w * 0.23);
    this.sb = sb;
    const R = (d, attrs) => s('path', { d, ...attrs }, this.root);
    this.shadowEl = R(rectD(0, 0, w, h, 28, seed, 1.5), { fill: 'rgba(61,58,75,.14)', transform: 'translate(14 18)' });
    this.frame = R(rectD(0, 0, w, h, 28, seed, 1.5), {});
    this.side = R(sharpD([[4, 60], [sb, 60], [sb, h - 20], [4, h - 20]], seed + 1, 1)  , {});
    this.bar = R(`M3 60 L3 28 Q3 3 28 3 L${w - 28} 3 Q${w - 3} 3 ${w - 3} 28 L${w - 3} 60 Z`, {});
    this.dots = [C.coral, C.yellow, C.mint].map((c, i) => s('circle', { cx: 32 + i * 28, cy: 31, r: 9, fill: c, stroke: C.ink, 'stroke-width': 3 }, this.root));
    this.title = T(this.root, '页间 Folio', w / 2, 41, { size: 28, anchor: 'middle' });
    this.palette = g(this.root, { transform: `translate(${w - 40} 31)` });
    s('circle', { r: 14, fill: '#fff', stroke: C.ink, 'stroke-width': 3 }, this.palette);
    [C.coral, C.teal, C.sky].forEach((c, i) => s('circle', { cx: -5 + i * 5, cy: i === 1 ? -5 : 2, r: 3.4, fill: c }, this.palette));
    // sidebar items
    this.sideText = [T(this.root, '工作空间', 26, 104, { size: 26 })];
    const items = [
      ['folder', '论文精读', 0],
      ['folder', 'Transformer', 1],
      ['html', '伴读笔记.html', 2],
      ['pdf', '论文.pdf', 2],
      ['html', '阅读清单.html', 1],
    ];
    this.sel = R(rectD(14, 136 + 2 * 50, sb - 28, 40, 10, seed + 3, 1), {});
    this.icons = [];
    items.forEach(([kind, label, ind], i) => {
      const y = 150 + i * 50;
      const x = 28 + ind * 22;
      const col = kind === 'folder' ? C.gold : kind === 'pdf' ? C.red : C.blue;
      const ic =
        kind === 'folder'
          ? s('path', { d: `M${x} ${y - 6} l0 22 l30 0 l0 -18 l-14 0 l-4 -6 z`, fill: col, stroke: C.ink, 'stroke-width': 3, 'stroke-linejoin': 'round' }, this.root)
          : s('path', { d: `M${x + 4} ${y - 8} l16 0 l7 7 l0 24 l-23 0 z`, fill: '#fff', stroke: col, 'stroke-width': 3.2, 'stroke-linejoin': 'round' }, this.root);
      this.icons.push(ic);
      this.sideText.push(T(this.root, label, x + 40, y + 13, { size: 23 }));
    });
    // toolbar
    const tb = 76;
    this.tools = [0, 1, 2, 3, 4].map((i) => s('path', { d: rectD(sb + 26 + i * 40, tb - 13, 26, 26, 6, seed + 20 + i, 0.8), fill: 'none', 'stroke-width': 3 }, this.root));
    this.swatches = [C.yellow, C.coral, C.teal, C.sky].map((c, i) => s('circle', { cx: sb + 250 + i * 30, cy: tb, r: 10, fill: c, stroke: C.ink, 'stroke-width': 2.5 }, this.root));
    this.aiPill = R(rectD(w - 170, tb - 18, 96, 36, 18, seed + 9, 0.8), {});
    this.aiText = T(this.root, '✦ AI', w - 122, tb + 9, { font: FONT.latin, size: 20, anchor: 'middle', fill: '#fff' });
    // document
    const dx = sb + 60;
    const dw = w - sb - 150;
    this.doc = R(rectD(dx, 108, dw, h - 130, 16, seed + 4, 1.4), {});
    this.kicker = R(lineD(dx + 50, 160, dx + 140, 160, seed + 5, 1), { 'stroke-width': 7, 'stroke-linecap': 'round', fill: 'none' });
    this.docTitle = T(this.root, 'Attention Is All You Need', dx + 50, 214, { font: FONT.latin, size: Math.round(w / 34) });
    this.lines = [];
    const box = Math.min(dw - 100, 620);
    this.summary = R(rectD(dx + 50, 250, box, 150, 14, seed + 6, 1.2), {});
    this.hl = R(rectD(dx + 70, 286, box * 0.62, 26, 8, seed + 7, 1), { fill: C.yellow, 'fill-opacity': 0.55 });
    for (let i = 0; i < 3; i++)
      this.lines.push(R(lineD(dx + 74, 300 + i * 34, dx + 74 + (box - 60) * (i === 2 ? 0.55 : 0.92), 300 + i * 34, seed + 30 + i, 1.2), { 'stroke-width': 8, 'stroke-linecap': 'round', fill: 'none' }));
    for (let i = 0; i < Math.floor((h - 470) / 38); i++)
      this.lines.push(R(lineD(dx + 50, 450 + i * 38, dx + 50 + (dw - 100) * (i % 4 === 3 ? 0.5 : 0.95), 450 + i * 38, seed + 40 + i, 1.2), { 'stroke-width': 8, 'stroke-linecap': 'round', fill: 'none' }));
    // assistant rail
    this.rail = R(sharpD([[w - 70, 104], [w - 5, 104], [w - 5, h - 20], [w - 70, h - 20]], seed + 8, 1), {});
    this.railStar = s('path', { d: sparkleD(w - 37, 150, 16) }, this.root);
    this.setTheme(PALETTES[0]);
  }
  setTheme(P) {
    if (P === this.P) return;
    this.P = P;
    const ln = P.line;
    const sw = P.sw || 4.5;
    const set = (e, a) => {
      for (const k in a) e.setAttribute(k, a[k]);
    };
    set(this.frame, { fill: P.bg, stroke: ln, 'stroke-width': sw + 1 });
    set(this.side, { fill: P.side, stroke: ln, 'stroke-width': sw - 1 });
    set(this.bar, { fill: P.bar, stroke: ln, 'stroke-width': sw - 1 });
    this.title.setAttribute('fill', P.ink);
    this.title.setAttribute('font-family', P.font || FONT.hand);
    for (const t of this.sideText) {
      t.setAttribute('fill', P.ink);
      t.setAttribute('font-family', P.font || FONT.hand);
    }
    set(this.sel, { fill: P.accent, 'fill-opacity': 0.22, stroke: P.accent, 'stroke-width': 2.5 });
    for (const t of this.tools) set(t, { stroke: P.ink });
    set(this.aiPill, { fill: P.accent, stroke: ln, 'stroke-width': sw - 1.5 });
    this.aiText.setAttribute('fill', P.name === '终端' || P.name === '极光' ? '#08130b' : '#fff');
    set(this.doc, { fill: P.paper, stroke: ln, 'stroke-width': sw - 1 });
    set(this.kicker, { stroke: P.accent });
    this.docTitle.setAttribute('fill', P.ink);
    this.docTitle.setAttribute('font-family', P.font || FONT.latin);
    set(this.summary, { fill: P.paper, stroke: P.accent, 'stroke-width': 3 });
    for (const l of this.lines) set(l, { stroke: P.ink2 });
    set(this.rail, { fill: P.side, stroke: ln, 'stroke-width': sw - 1.5 });
    set(this.railStar, { fill: P.accent, stroke: ln, 'stroke-width': 2.5 });
  }
}
