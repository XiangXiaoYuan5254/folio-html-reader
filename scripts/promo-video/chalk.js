// 页间 · 白板讲解 · 黑板粉笔版，竖屏 1080×1440（3:4）。整块画面是一块黑板：彩色粉笔一笔一笔写，
// 换场时板擦擦掉；页老师自己配音（narrate.mjs 录好放在 out/voice-chalk/），画面和字幕按录好的
// 每句长度和每个字的时间排。按 seek(t) 逐帧算出画面。
//   chalk.html?preview   拖动进度条看效果
//   chalk.html?t=12.5    打开时停在这一秒
import { clamp, lerp, seg, E, spring, startPreview } from './kit.js';
import {
  rng,
  s,
  g,
  T,
  span,
  letters,
  popLetters,
  stroke,
  wiper,
  place,
  rectD,
  ellipseD,
  lineD,
  polyD,
  starD,
  heartD,
  headD,
  Mascot,
  blinkAt,
  hop,
  popIn,
} from './sketch.js';
import { LINES } from './chalk-lines.js';

const W = 1080;
const H = 1440;
const ERASE = 0.8; // 板擦擦一遍
const CK = {
  board: '#2c4a3f',
  white: '#f4f1e6',
  dim: 'rgba(244,241,230,.42)',
  yellow: '#f7dd78',
  pink: '#f6a6b8',
  blue: '#92c8f2',
  green: '#a8e3b3',
  orange: '#f7b679',
  violet: '#cbb6f8',
  red: '#f28b8b',
  teal: '#7cc8b0',
};
const FONT = {
  title: "'Yuppy SC', 'Hannotate SC', cursive",
  hand: "'Hannotate SC', 'HanziPen SC', cursive",
  latin: "'Chalkduster', 'Chalkboard SE', cursive",
  mono: 'Menlo, monospace',
};
const scenesEl = document.getElementById('scenes');
const boardSvg = document.getElementById('board');
const smudgeEl = document.getElementById('smudge');
const top = document.getElementById('subs');
const EVENTS = {
  style: 'chalk',
  melodic: [],
  voice: [],
  chalk: [],
  tap: [],
  erase: [],
  pluck: [],
  poof: [],
  ding: [],
  click: [],
  sparkle: [],
  scenes: [],
};
const scenes = [];
let clock = 0;

// ---------- 旁白 ----------
// A line's length as said, from the recording, or a guess until it is recorded.
const recorded = await fetch('out/voice-chalk/lines.json')
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
const weight = (c) => (/[，、；：]/.test(c) ? 1.8 : /[。？！～]/.test(c) ? 2.4 : /\s/.test(c) ? 0.3 : /[A-Za-z]/.test(c) ? 0.7 : 1);
const LINE = Object.fromEntries(
  LINES.map((l) => {
    const r = recorded[l.id];
    const total = [...l.text].reduce((a, c) => a + weight(c), 0);
    return [l.id, { ...l, dur: r?.dur ?? total * 0.16, file: r ? `out/voice-chalk/${r.file}` : null, total, times: r?.times }];
  }),
);
// When the character at `k` is said, as a fraction of the line: from the recording's own
// timing where it has one, else as if speech were even.
function fracAt(line, k) {
  if (line.times) {
    const t = line.times.slice(k).find((x) => x != null);
    return t == null ? 1 : t / line.dur;
  }
  return [...line.text].slice(0, k).reduce((a, c) => a + weight(c), 0) / line.total;
}
// Where `sub` starts (or ends) in the line.
function frac(line, sub, end = false) {
  const i = line.text.indexOf(sub);
  if (i < 0) throw Error(`「${sub}」不在台词里：${line.text}`);
  return fracAt(line, [...line.text.slice(0, i)].length + (end ? [...sub].length : 0));
}
// Subtitles: the line split at its pauses into pieces short enough for one row.
const SUBS = [];
function subtitle(line, at) {
  const text = line.sub || line.text;
  const parts = text.match(/[^，。？！；～]+[，。？！；～]*/g) || [text];
  const rows = [];
  for (const p of parts) {
    const last = rows.at(-1);
    if (last && [...last + p].length <= 14) rows[rows.length - 1] = last + p;
    else rows.push(p);
  }
  // Each row from when its first character is said (the subtitle's text can differ a little
  // from what is said, so by position).
  const total = rows.reduce((a, r) => a + [...r].length, 0);
  const spoken = [...line.text].length;
  let n = 0;
  const starts = rows.map((r, i) => {
    const t = i ? at + fracAt(line, Math.round((n / total) * spoken)) * line.dur : at;
    n += [...r].length;
    return t;
  });
  rows.forEach((r, i) => SUBS.push({ t0: starts[i], t1: starts[i + 1] ?? at + line.dur, text: r.replace(/[，；、]$/, '') }));
}

// ---------- 场景 ----------
// plan: the lines it says, lead before the first, gaps between, tail after the last, a minimum.
function scene(id, plan, build, { last = false } = {}) {
  const t0 = clock;
  const L = {};
  let t = plan.lead ?? 0.4;
  plan.lines.forEach((lid, i) => {
    const line = LINE[lid];
    L[lid] = { t0: t, t1: t + line.dur, dur: line.dur, at: (sub, end) => t + line.dur * frac(line, sub, end) };
    L[lid].at = ((t0l) => (sub, end) => t0l + line.dur * frac(line, sub, end))(t);
    if (line.file) EVENTS.voice.push([t0 + t, line.file]);
    subtitle(line, t0 + t);
    t += line.dur + (i < plan.lines.length - 1 ? [].concat(plan.gap ?? 0.4)[i] ?? 0.4 : 0);
  });
  const dur = Math.max(plan.min ?? 0, t + (plan.tail ?? 1)) + (last ? 0 : ERASE);
  clock += dur;
  const root = document.createElement('div');
  root.className = 'scene';
  root.id = id;
  scenesEl.append(root);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  root.append(svg);
  const defs = s('defs', {}, svg);
  const world = g(svg, { filter: 'url(#chalk)' });
  const S = { id, t0, t1: t0 + dur, dur, last, L, root, svg, defs, world };
  const sfx = (kind, x, d) => EVENTS[kind].push(d != null ? [t0 + x, d] : t0 + x);
  S.sfx = sfx;
  // Speaking now? (for the mouth)
  S.talking = (u) => plan.lines.some((lid) => u > L[lid].t0 + 0.05 && u < L[lid].t1 - 0.1);
  if (!last) {
    S.wipe = eraserWipe(S);
    sfx('erase', dur - ERASE + 0.05, ERASE * 0.85);
  }
  S.chalk = new Chalk(S);
  Object.assign(S, build(S, sfx));
  scenes.push(S);
  return S;
}

// ---------- 粉笔 ----------
// A stick of chalk.
function chalkStick(parent) {
  const e = g(parent);
  const inner = g(e, { transform: 'rotate(32)' });
  const body = s('rect', { x: -9, y: -86, width: 18, height: 86, rx: 6, fill: CK.white }, inner);
  s('rect', { x: -9, y: -86, width: 18, height: 86, rx: 6, fill: 'rgba(0,0,0,.12)', transform: 'translate(5 0) scale(.45 1)' }, inner);
  s('path', { d: 'M-9 -8 Q0 4 9 -8 L9 -2 Q0 8 -9 -2 Z', fill: 'rgba(255,255,255,.6)' }, inner);
  e.paint = (c) => body.setAttribute('fill', c);
  return e;
}
// Chalk dust falling from where the stick has just been.
function dustPool(parent, n = 26) {
  const dots = Array.from({ length: n }, () => s('circle', { r: 2, fill: CK.white, opacity: 0 }, parent));
  return (u, spots) => {
    let k = 0;
    for (const [s0, x, y, col] of spots) {
      if (k >= n) break;
      const dt = u - s0;
      const r = rng(Math.round(s0 * 1000) + 7);
      const d = dots[k++];
      d.setAttribute('cx', x + (r() - 0.5) * 50 * dt + (r() - 0.5) * 8);
      d.setAttribute('cy', y + 10 + 40 * dt + 260 * dt * dt);
      d.setAttribute('r', 1.4 + r() * 2.6);
      d.setAttribute('fill', col);
      d.setAttribute('opacity', 0.85 * (1 - dt / 0.7));
    }
    for (; k < n; k++) dots[k].setAttribute('opacity', 0);
  };
}
// The scene's chalk: everything written or drawn, in order, with the stick following along.
class Chalk {
  constructor(S) {
    this.S = S;
    this.steps = [];
    this.layer = g(S.world);
  }
  // Writes a text element left to right between a and b.
  text(el, a, b, { color = CK.white, dy = 0 } = {}) {
    const bb = el.getBBox();
    const w = wiper(this.S.defs, el, bb.x - 6, bb.y - 10, bb.width + 14, bb.height + 24);
    const y = bb.y + bb.height * 0.6 + dy;
    this.add(a, b, w.set, (k) => [w.x + w.w * k, y], color, true);
    return w;
  }
  // Draws a stroke (from `stroke`) between a and b.
  line(p, a, b, { color = p.getAttribute('stroke') } = {}) {
    this.add(a, b, p.draw, (k) => {
      const len = (p.len ||= p.getTotalLength());
      const q = p.getPointAtLength(len * clamp(k));
      return [q.x, q.y];
    }, color, false);
    return p;
  }
  add(a, b, set, pos, color, jiggle) {
    this.steps.push({ a, b, set, pos, color, jiggle });
    this.S.sfx('chalk', a, b - a);
  }
  // Puts the stick and its dust on top of everything else in the scene.
  finish() {
    this.dust = dustPool(this.S.world);
    this.stick = chalkStick(this.S.world);
  }
  render(u) {
    let on = null;
    for (const st of this.steps) {
      st.set(seg(u, st.a, st.b));
      if (u >= st.a - 0.04 && u <= st.b + 0.06) on = st;
    }
    this.stick.setAttribute('opacity', on ? 1 : 0);
    if (on) {
      const [x, y] = on.pos(seg(u, on.a, on.b));
      place(this.stick, x, y + (on.jiggle ? Math.sin(u * 46) * 7 : 0));
      this.stick.paint(on.color);
    }
    const spots = [];
    for (let s0 = Math.floor((u - 0.7) * 20) / 20; s0 <= u; s0 += 0.05) {
      const st = this.steps.find((x) => s0 >= x.a && s0 <= x.b);
      if (!st || s0 < 0) continue;
      const [x, y] = st.pos(seg(s0, st.a, st.b));
      spots.push([s0, x, y, st.color]);
    }
    this.dust(u, spots);
  }
}
const chalkStroke = (parent, d, color = CK.white, sw = 6) => stroke(parent, d, { color, sw });
const chalkText = (parent, str, x, y, { font = FONT.hand, size = 44, fill = CK.white, ...rest } = {}) =>
  T(parent, str, x, y, { font, size, fill, ...rest });
// Diagonal chalk hatching inside a shape, like colouring in.
let hatchN = 0;
function hatch(parent, defs, d, { color = CK.white, gap = 12, sw = 4, angle = -0.8, seed = 1, opacity = 0.75 } = {}) {
  const id = 'h' + ++hatchN;
  s('path', { d }, s('clipPath', { id }, defs));
  const box = g(parent, { 'clip-path': `url(#${id})` });
  const probe = s('path', { d }, parent);
  const bb = probe.getBBox();
  probe.remove();
  const r = rng(seed);
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  const R = Math.hypot(bb.width, bb.height) / 2 + 10;
  const dir = [Math.cos(angle), Math.sin(angle)];
  const nrm = [-dir[1], dir[0]];
  for (let o = -R; o <= R; o += gap) {
    const mx = cx + nrm[0] * o + (r() - 0.5) * 3;
    const my = cy + nrm[1] * o + (r() - 0.5) * 3;
    s('path', { d: lineD(mx - dir[0] * R, my - dir[1] * R, mx + dir[0] * R, my + dir[1] * R, seed * 100 + Math.round(o), 1.2), stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', fill: 'none', opacity }, box);
  }
  return box;
}
// A speech bubble outlined in chalk.
class ChalkBubble {
  constructor(parent, { x, y, w, h, tail, lines, size = 42, color = CK.white, font = FONT.hand, seed = 2, icon }) {
    this.root = g(parent);
    this.inner = g(this.root);
    const tx = tail[0] - x;
    const ty = tail[1] - y;
    const base = clamp(tx, -w / 2 + 40, w / 2 - 40);
    const edge = ty > 0 ? h / 2 - 2 : -h / 2 + 2;
    s('path', { d: rectD(-w / 2, -h / 2, w, h, Math.min(34, h / 2), seed, 1.6), fill: 'rgba(255,255,255,.07)', stroke: color, 'stroke-width': 5 }, this.inner);
    s('path', { d: `M${base - 18} ${edge} Q${(base + tx) / 2} ${(edge + ty) / 2} ${tx} ${ty} Q${(base + tx) / 2 + 6} ${(edge + ty) / 2} ${base + 18} ${edge}`, fill: 'none', stroke: color, 'stroke-width': 5, 'stroke-linejoin': 'round' }, this.inner);
    const lx = icon ? 28 : 0;
    lines.forEach((l, i) => T(this.inner, l, lx, -((lines.length - 1) * size * 1.3) / 2 + i * size * 1.3 + size * 0.36, { size, fill: color, anchor: 'middle', font }));
    if (icon) icon(this.inner, -w / 2 + 52, 0, color);
    this.x = x;
    this.y = y;
    this.tail = [tx, ty];
  }
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
}

// ---------- 小图标（粉笔线） ----------
const pathOf = (parent, d, col, sw = 4.5, fill = 'none') =>
  s('path', { d, fill, stroke: col, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, parent);
function micIcon(parent, x, y, col) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  s('rect', { x: -9, y: -24, width: 18, height: 30, rx: 9, fill: 'none', stroke: col, 'stroke-width': 4.5 }, e);
  pathOf(e, 'M-15 -2 Q-15 14 0 14 Q15 14 15 -2 M0 14 L0 22 M-8 22 L8 22', col);
  return e;
}
function speakerIcon(parent, x, y, col) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  pathOf(e, 'M-18 -7 L-10 -7 L0 -17 L0 17 L-10 7 L-18 7 Z', col, 4);
  e.waves = [9, 18].map((r) => pathOf(e, `M${6 + r * 0.3} ${-r} Q${10 + r} 0 ${6 + r * 0.3} ${r}`, col, 4));
  return e;
}
function easelIcon(parent, x, y, col) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  pathOf(e, 'M-17 -14 L17 -14 L17 9 L-17 9 Z M0 9 L0 15 M-8 19 L0 13 L8 19', col, 4);
  return e;
}
function handPointer(parent) {
  const e = g(parent);
  s('path', { d: 'M0 0 L0 50 L13 38 L23 60 L34 55 L24 34 L42 34 Z', fill: CK.board, stroke: CK.white, 'stroke-width': 5, 'stroke-linejoin': 'round' }, e);
  return e;
}
function chalkRipple(parent, col = CK.yellow) {
  const c = s('circle', { r: 0, fill: 'none', stroke: col, 'stroke-width': 6 }, parent);
  c.at = (t, t0, x, y) => {
    const k = (t - t0) / 0.45;
    if (k < 0 || k > 1) return c.setAttribute('r', 0);
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', 10 + 46 * E.out(k));
    c.setAttribute('opacity', 1 - k);
  };
  return c;
}
// Chalk stars and hearts that pop in and twinkle.
function doodles(parent, list) {
  const cols = [CK.yellow, CK.pink, CK.blue, CK.green, CK.violet];
  return list.map(([x, y, r, kind = 'star'], i) => {
    const e = g(parent);
    const d = kind === 'heart' ? heartD(0, 0, r) : starD(0, 0, r, i + 3);
    s('path', { d, fill: 'none', stroke: cols[i % cols.length], 'stroke-width': 5, 'stroke-linejoin': 'round' }, e);
    return { e, x, y, i };
  });
}
function twinkle(list, u, t0, out) {
  for (const { e, x, y, i } of list) {
    const a = t0 + i * 0.1;
    const k = spring(u - a, 2.6, 0.4);
    let o = u < a ? 0 : 1;
    if (out != null && u > out) o *= 1 - clamp((u - out) / 0.3);
    place(e, x, y, Math.max(0, k) * (1 + 0.12 * Math.sin(u * 6 + i)), Math.sin(u * 2 + i) * 16);
    e.setAttribute('opacity', o);
  }
}
const teacher = (parent) =>
  new Mascot(parent, { color: CK.teal, ink: CK.white, eye: '#20352b', page: '#e6eee8', feet: '#4f9d86', shadow: 'rgba(0,0,0,.22)' });
const idle = (u, more = {}) => ({ blink: blinkAt(u), sway: Math.sin(u * 3) * 5, sq: Math.sin(u * 4.2) * 0.025, glasses: true, ...more });
const headline = (parent, str, { y = 165, size = 92, fill = CK.yellow } = {}) =>
  letters(parent, str, W / 2, y, { font: FONT.title, size, fill, anchor: 'middle' });

// ---------- 板擦 ----------
const props = g(top);
const eraser = g(props);
{
  const inner = g(eraser, { transform: 'rotate(-12)' });
  s('rect', { x: -86, y: -2, width: 172, height: 30, rx: 6, fill: '#3d3f47' }, inner);
  s('path', { d: 'M-86 6 L86 6', stroke: 'rgba(255,255,255,.18)', 'stroke-width': 3 }, inner);
  s('rect', { x: -92, y: -44, width: 184, height: 44, rx: 10, fill: 'url(#wood)', stroke: '#6e4425', 'stroke-width': 3 }, inner);
  T(inner, '页间', 0, -12, { font: FONT.title, size: 26, fill: '#6e4425', anchor: 'middle' });
}
const REST = [880, 1418];
// Sweeps the whole board in zigzags at the end of a scene; what it passed over is gone.
function eraserWipe(S, { pts, sw = 380, a = S.dur - ERASE, b = S.dur - ERASE * 0.12, target = S.world, smudge = true } = {}) {
  pts ||= Array.from({ length: 10 }, (_, i) => [i % 2 ? -90 : 1170, -40 + i * 170]);
  const d = 'M' + pts.map((p) => p.join(' ')).join('L');
  const id = `erase-${S.id}-${a.toFixed(2)}`;
  const mask = s('mask', { id, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, S.defs);
  s('rect', { width: W, height: H, fill: '#fff' }, mask);
  const p = s('path', { d, fill: 'none', stroke: '#000', 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': '1 1', 'stroke-dashoffset': 1 }, mask);
  target.setAttribute('mask', `url(#${id})`);
  const smear = smudge ? s('path', { d, fill: 'none', stroke: '#e8ece4', 'stroke-width': sw * 0.8, 'stroke-linecap': 'round', opacity: 0, filter: 'url(#smear)' }, smudgeEl) : null;
  const len = p.getTotalLength();
  return {
    a,
    b,
    // Local time of the scene.
    render(u) {
      const k = seg(u, a, b);
      p.setAttribute('stroke-dashoffset', 1 - k);
      if (smear) smear.setAttribute('opacity', u < a ? 0 : 0.07 * clamp((u - a) * 3) * (1 - clamp((u - b - 0.3) / 3)));
    },
    // Where the eraser is, if it is out.
    eraser(u) {
      if (u < a - 0.15 || u > b + 0.15) return null;
      const k = seg(u, a, b);
      const q = p.getPointAtLength(len * k);
      const lift = 1 - clamp(Math.min(u - (a - 0.15), b + 0.15 - u) / 0.15);
      return [lerp(q.x, REST[0], lift), lerp(q.y, REST[1], lift), Math.sin(u * 30) * 6];
    },
  };
}
// Smudges of a scene that is long gone still fade on the board.
function smearsAfter(t) {
  for (const S of scenes) {
    if (S.wipe) S.wipe.render(t - S.t0);
    for (const w of S.local || []) w.render(t - S.t0);
  }
}

// ---------- 木框和粉笔槽 ----------
{
  const f = g(top);
  s('path', { d: `M0 0H${W}V${H}H0Z M24 24V1386H1056V24Z`, 'fill-rule': 'evenodd', fill: 'url(#wood)' }, f);
  s('path', { d: 'M24 24H1056V1386H24Z', fill: 'none', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 6 }, f);
  s('rect', { x: 0, y: 1386, width: W, height: 14, fill: '#d29c66' }, f);
  s('rect', { x: 0, y: 1398, width: W, height: 4, fill: 'rgba(0,0,0,.18)' }, f);
  const r = rng(77);
  for (let i = 0; i < 14; i++) {
    const y = 1404 + r() * 30;
    s('path', { d: lineD(r() * 400, y, 300 + r() * 780, y + (r() - 0.5) * 4, i, 1), stroke: 'rgba(90,55,28,.25)', 'stroke-width': 2, fill: 'none' }, f);
  }
  [
    [150, CK.white, -4],
    [212, CK.yellow, 3],
    [262, CK.pink, -2],
  ].forEach(([x, col, rot]) => {
    const c = g(f, { transform: `translate(${x} 1418) rotate(${rot})` });
    s('rect', { x: -36, y: -8, width: 72, height: 16, rx: 7, fill: col }, c);
    s('rect', { x: -36, y: 1, width: 72, height: 7, rx: 3, fill: 'rgba(0,0,0,.12)' }, c);
  });
}
// subtitles above the frame, crisp
const subRow = T(top, '', W / 2, 1338, {
  font: FONT.hand,
  size: 46,
  fill: '#fffbea',
  anchor: 'middle',
  weight: 700,
  stroke: 'rgba(16,30,24,.88)',
  'stroke-width': 10,
  'paint-order': 'stroke',
  'stroke-linejoin': 'round',
});
// the eraser rests in the tray, in front of the frame
top.insertBefore(props, subRow);

// ====================================================================
async function build() {
  await Promise.all(
    [FONT.title, FONT.hand, FONT.latin, FONT.mono].map((f) => document.fonts.load(`40px ${f}`, '页间读得进AaBb12√')),
  );

  // ===== 1. 又卡在一行公式上？ =====
  scene('stuck', { lines: ['stuck'], lead: 0.4, tail: 0.7, min: 4.2 }, (S, sfx) => {
    const w = S.world;
    const L = S.L.stuck;
    const head = headline(w, '又卡在一行公式上？', { size: 96 });
    const ck = S.chalk;
    const card = chalkStroke(w, `M180 380 L840 380 L900 440 L900 1060 L180 1060 Z`, CK.white, 5);
    const fold = chalkStroke(w, 'M840 380 L840 440 L900 440', CK.white, 4);
    const tag = chalkText(w, 'PDF', 220, 438, { font: FONT.latin, size: 30, fill: CK.red });
    const title = chalkText(w, 'Attention Is All You Need', 540, 520, { font: FONT.latin, size: 36, anchor: 'middle' });
    const rows = [600, 650, 870, 920, 970].map((y, i) => chalkStroke(w, lineD(230, y, i % 3 === 2 ? 640 : 850, y, 30 + i, 1.5), CK.dim, 7));
    const f = chalkText(w, '', 540, 775, { font: FONT.latin, size: 50, anchor: 'middle' });
    for (const [txt, dy, size] of [['softmax( QK', 0, 50], ['T', -22, 30], [' / √dₖ ) V', 22, 50]])
      s('tspan', { dy, 'font-size': size }, f).textContent = txt;
    const dk = span(f, '√dₖ');
    const tangle = (() => {
      const r = rng(41);
      const pts = [];
      const cx = dk.x0 + dk.w / 2;
      for (let i = 0; i < 46; i++) {
        const a = i * 0.9 + r() * 0.6;
        const rad = 34 + r() * 60;
        pts.push([cx + Math.cos(a) * rad * 1.5, 765 + Math.sin(a) * rad * 0.8]);
      }
      return chalkStroke(w, polyD(pts, 42, 3), CK.pink, 5);
    })();
    const qs = [
      [250, 1170, -14, 130, CK.yellow],
      [800, 1150, 12, 150, CK.blue],
      [140, 760, 8, 96, CK.pink],
      [960, 720, -10, 110, CK.green],
    ].map(([x, y, rot, size, fill], i) => {
      const e = g(w);
      chalkText(e, '?', 0, size * 0.36, { font: FONT.title, size, fill, anchor: 'middle' });
      return { e, x, y, rot, i };
    });
    const a = 0.25;
    ck.line(card, a, a + 0.5);
    ck.line(fold, a + 0.5, a + 0.6);
    ck.text(tag, a + 0.6, a + 0.75, { color: CK.red });
    ck.text(title, a + 0.75, a + 1.35);
    rows.forEach((p, i) => ck.line(p, a + 1.35 + i * 0.09, a + 1.42 + i * 0.09, { color: CK.white }));
    const tf = Math.max(a + 1.9, L.at('一行') - 0.9);
    ck.text(f, tf, tf + 0.9);
    const tq = L.at('公式');
    ck.line(tangle, tq - 0.1, tq + 0.7);
    qs.forEach(({ i }) => sfx('pluck', tq + 0.3 + i * 0.16));
    ck.finish();
    return {
      render(u) {
        popLetters(head, u, 0.1, { stagger: 0.06 });
        ck.render(u);
        for (const { e, x, y, rot, i } of qs) popIn(e, u, tq + 0.3 + i * 0.16, { x, y: y + Math.sin(u * 3 + i) * 10, rot: rot + Math.sin(u * 2.5 + i) * 8 });
      },
    };
  });

  // ===== 2. 嗨～我是页老师！ =====
  scene('hello', { lines: ['hello'], lead: 0.55, tail: 1.0, min: 3.0 }, (S, sfx) => {
    const w = S.world;
    const ck = S.chalk;
    const puffs = Array.from({ length: 9 }, (_, i) => {
      const a = (i / 9) * Math.PI * 2;
      return { c: s('circle', { r: 0, fill: CK.white, opacity: 0 }, w), a, r: 60 + (i % 3) * 30 };
    });
    const m = teacher(w);
    const title = chalkText(w, '页老师来上课啦～', 540, 330, { font: FONT.title, size: 104, fill: CK.yellow, anchor: 'middle' });
    const hi = new ChalkBubble(w, { x: 800, y: 600, w: 260, h: 120, tail: [690, 720], lines: ['嗨～'], size: 66, font: FONT.title, color: CK.white });
    const under = chalkStroke(w, lineD(170, 372, 910, 372, 51, 2), CK.pink, 7);
    const dood = doodles(w, [
      [160, 560, 34],
      [930, 900, 28, 'heart'],
      [150, 980, 26],
      [930, 1120, 30],
      [300, 470, 22, 'heart'],
    ]);
    ck.text(title, 1.0, 1.9, { color: CK.yellow });
    ck.line(under, 1.95, 2.3, { color: CK.pink });
    sfx('poof', 0.2);
    sfx('pluck', 0.35);
    sfx('pluck', 0.6);
    sfx('sparkle', 2.4);
    ck.finish();
    return {
      render(u) {
        for (const p of puffs) {
          const k = seg(u, 0.2, 0.9);
          const rr = p.r * E.out(k);
          p.c.setAttribute('cx', 540 + Math.cos(p.a) * rr);
          p.c.setAttribute('cy', 960 + Math.sin(p.a) * rr * 0.7);
          p.c.setAttribute('r', 30 + 50 * k);
          p.c.setAttribute('opacity', u < 0.2 ? 0 : 0.5 * (1 - k));
        }
        const k = spring(u - 0.3, 2, 0.45);
        const waving = clamp(seg(u, 0.6, 0.85)) * (1 - seg(u, 2.6, 2.9));
        const h = hop(u - 2.4, 90, 0.42);
        m.set({
          x: 540,
          y: 1210,
          scale: 1.45 * Math.max(0, k),
          ...idle(u),
          lift: h.lift,
          sq: h.sq + Math.sin(u * 4.2) * 0.02,
          mood: S.talking(u) && Math.sin(u * 14) > 0 ? 'talk' : 'happy',
          raiseR: waving * (140 + Math.sin(u * 14) * 18),
          raiseL: h.lift * 1.2,
          opacity: u > 0.3 ? 1 : 0,
        });
        hi.show(u, 0.7, 2.6);
        ck.render(u);
        twinkle(dood, u, 2.4);
      },
    };
  });

  // ===== 3. 选中它，点一下「白板」 =====
  scene('pick', { lines: ['pick'], lead: 0.35, tail: 0.9, min: 3.8 }, (S, sfx) => {
    const w = S.world;
    const L = S.L.pick;
    const ck = S.chalk;
    const head = headline(w, '选中它，点「白板」', { size: 96, fill: CK.white });
    const card = chalkStroke(w, 'M110 300 L920 300 L970 350 L970 1100 L110 1100 Z', CK.white, 5);
    chalkStroke(w, 'M920 300 L920 350 L970 350', CK.white, 4).draw(1);
    card.draw(1);
    chalkText(w, 'HTML', 146, 358, { font: FONT.latin, size: 28, fill: CK.blue });
    chalkText(w, 'Attention 伴读笔记', 150, 420, { size: 46 });
    chalkText(w, '缩放点积注意力：', 150, 510, { size: 40, fill: CK.dim });
    chalkText(w, '分数先除以 √dₖ，再做 softmax，', 150, 572, { size: 40, fill: CK.dim });
    const sel = g(w);
    const band = s('path', { d: rectD(140, 660, 800, 150, 18, 61, 1.5), fill: CK.yellow, 'fill-opacity': 0.22, stroke: CK.yellow, 'stroke-width': 4 }, sel);
    const bw = wiper(S.defs, band, 130, 650, 820, 170);
    const f = chalkText(w, '', 540, 755, { font: FONT.latin, size: 50, anchor: 'middle' });
    for (const [txt, dy, size] of [['softmax( QK', 0, 50], ['T', -22, 30], [' / √dₖ ) V', 22, 50]])
      s('tspan', { dy, 'font-size': size }, f).textContent = txt;
    [880, 940, 1000].forEach((y, i) => chalkStroke(w, lineD(160, y, i === 2 ? 600 : 900, y, 62 + i, 1.5), CK.dim, 7).draw(1));
    // the selection toolbar
    const bar = g(w);
    s('path', { d: rectD(-345, -42, 690, 84, 30, 64, 1.4), fill: CK.board, stroke: CK.white, 'stroke-width': 5 }, bar);
    const BTN = ['高亮', '划线', '解释', '翻译', '提问', '白板'];
    BTN.forEach((b, i) => chalkText(bar, b, -280 + i * 112, 13, { size: 36, anchor: 'middle', fill: b === '白板' ? CK.green : CK.white }));
    const hot = g(bar, { transform: 'translate(280 0)' });
    s('path', { d: rectD(-52, -30, 104, 60, 16, 65, 1), fill: 'none', stroke: CK.green, 'stroke-width': 5 }, hot);
    const ptr = handPointer(w);
    const rip = chalkRipple(w, CK.green);
    const ts = L.at('选中');
    const tb = L.at('点一下');
    const tc = L.at('白板') + 0.15;
    sfx('chalk', ts, 0.5);
    sfx('pluck', tb);
    sfx('click', tc);
    sfx('ding', tc + 0.1);
    const btn = [560 + 280, 600];
    ck.finish();
    return {
      render(u) {
        popLetters(head, u, 0.1, { stagger: 0.05 });
        bw.set(seg(u, ts, ts + 0.5));
        popIn(bar, u, tb, { x: 560, y: 600 });
        hot.setAttribute('transform', `translate(280 0) scale(${u > tc && u < tc + 0.14 ? 0.86 : 1})`);
        let px;
        let py;
        if (u < tb) {
          const k = seg(u, ts, ts + 0.5);
          px = lerp(150, 940, k);
          py = 800;
        } else {
          const k = E.inOut(seg(u, tb + 0.1, tc - 0.05));
          px = lerp(940, btn[0], k);
          py = lerp(800, btn[1], k);
        }
        place(ptr, px, py, u > tc && u < tc + 0.14 ? 0.85 : 1);
        ptr.setAttribute('opacity', clamp((u - ts + 0.2) * 5) * (1 - clamp((u - tc - 1.2) * 4)));
        rip.at(u, tc, btn[0], btn[1]);
        ck.render(u);
      },
    };
  });

  // ===== 4. 上课：边写边讲 → 圈出来问 → 换个说法 =====
  scene(
    'lesson',
    { lines: ['teach', 'why', 'ask', 'again'], lead: 0.4, gap: [0.3, 0.5, 0.4], tail: 3.8 },
    (S, sfx) => {
      const w = S.world;
      const { teach, why, ask, again } = S.L;
      const ck = S.chalk;
      // header: like the window's, in chalk
      easelIcon(w, 74, 92, CK.dim);
      chalkText(w, '白板讲解', 104, 104, { size: 34, fill: CK.dim });
      const spk = speakerIcon(w, 780, 92, CK.dim);
      chalkText(w, '页老师出声', 812, 104, { size: 34, fill: CK.dim });
      chalkStroke(w, lineD(50, 140, 1030, 140, 70, 1.5), CK.dim, 3).draw(1);
      // the lesson
      const t1 = chalkText(w, '为什么要除以 √dₖ ？', 80, 238, { size: 66, fill: CK.yellow });
      const f = chalkText(w, '', 110, 345, { font: FONT.latin, size: 52 });
      for (const [txt, dy, size] of [['softmax( QK', 0, 52], ['T', -22, 30], [' / √dₖ ) · V', 22, 52]])
        s('tspan', { dy, 'font-size': size }, f).textContent = txt;
      const dk = span(f, '√dₖ');
      const ringDk = chalkStroke(w, ellipseD(dk.x0 + dk.w / 2, 352, dk.w / 2 + 24, 44, 71, 2), CK.orange, 6);
      const charts = g(w);
      const l1 = chalkText(charts, '不缩放', 265, 470, { size: 42, anchor: 'middle' });
      const ax1 = chalkStroke(charts, lineD(85, 700, 450, 700, 72, 1.5), CK.white, 6);
      const bars1 = [200, 16, 12, 9].map((h, i) => {
        const e = g(charts);
        const d = rectD(115 + i * 80, 700 - h, 52, h, 5, 73 + i, 1);
        hatch(e, S.defs, d, { color: CK.pink, gap: 11, seed: 73 + i });
        s('path', { d, fill: 'none', stroke: CK.pink, 'stroke-width': 5 }, e);
        return e;
      });
      const ringBar = chalkStroke(charts, ellipseD(141, 600, 54, 126, 78, 2), CK.red, 6);
      const n1 = chalkText(charts, '全挤在', 212, 560, { size: 34, fill: CK.red });
      const n2 = chalkText(charts, '一个词上！', 212, 604, { size: 34, fill: CK.red });
      const arrow = chalkStroke(charts, lineD(470, 610, 590, 610, 79, 1.5), CK.orange, 6);
      const ah = pathOf(charts, headD(590, 610, 0, 22), CK.orange, 6);
      const aT = chalkText(charts, '÷√dₖ', 530, 585, { font: FONT.latin, size: 30, fill: CK.orange, anchor: 'middle' });
      const l2 = chalkText(charts, '除以 √dₖ', 810, 470, { size: 42, anchor: 'middle' });
      const ax2 = chalkStroke(charts, lineD(625, 700, 1000, 700, 80, 1.5), CK.white, 6);
      const bars2 = [134, 106, 82, 62].map((h, i) => {
        const e = g(charts);
        const d = rectD(650 + i * 84, 700 - h, 52, h, 5, 81 + i, 1);
        hatch(e, S.defs, d, { color: CK.blue, gap: 11, seed: 81 + i });
        s('path', { d, fill: 'none', stroke: CK.blue, 'stroke-width': 5 }, e);
        return e;
      });
      const concl = chalkText(w, 'softmax 不饱和，梯度不消失！', 80, 830, { size: 52 });
      const cl = concl.getComputedTextLength();
      const box = chalkStroke(w, rectD(62, 768, cl + 40, 90, 16, 85, 2.2), CK.green, 6);
      const sm = span(concl, 'softmax');
      // the student's violet circle, and their question
      const ring = chalkStroke(w, ellipseD(sm.x0 + sm.w / 2, 815, sm.w / 2 + 26, 46, 86, 2.5), CK.violet, 7);
      const q = new ChalkBubble(w, { x: 690, y: 1010, w: 600, h: 112, tail: [960, 1110], lines: ['“饱和”是什么意思？'], size: 42, color: CK.violet, icon: micIcon });
      const bars = [0, 1, 2].map((i) => s('rect', { x: 0, y: 0, width: 7, height: 10, rx: 3, fill: CK.violet }, q.inner));
      const pause = g(w);
      s('circle', { r: 30, fill: CK.board, stroke: CK.white, 'stroke-width': 5 }, pause);
      pathOf(pause, 'M-7 -11 L-7 11 M7 -11 L7 11', CK.white, 6);
      // a new way to say it: one word takes the whole cake
      const pie = g(w);
      const cx = 240;
      const cy = 580;
      const R = 112;
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI * 2 * 0.92;
      const at = (a, r = R) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const slice = g(pie);
      hatch(slice, S.defs, `M${cx} ${cy} L${at(a0).join(' ')} A${R} ${R} 0 1 1 ${at(a1).join(' ')} Z`, { color: CK.yellow, gap: 12, seed: 90 });
      const rim = chalkStroke(pie, ellipseD(cx, cy, R, R, 91, 1.5, 0.05, a0), CK.white, 6);
      const cuts = [a0, a1, a1 + 0.2, a1 + 0.38].map((a, i) => chalkStroke(pie, lineD(cx, cy, ...at(a), 92 + i, 0.8), CK.white, 5));
      const k1 = chalkText(pie, 'k₁', cx + 6, cy + 46, { font: FONT.latin, size: 44, anchor: 'middle', fill: CK.white });
      const crown = g(w);
      pathOf(crown, 'M-36 16 L-36 -10 L-18 4 L0 -22 L18 4 L36 -10 L36 16 Z', CK.yellow, 5);
      const s1 = chalkText(w, '一个词全拿走！', 400, 520, { size: 48, fill: CK.yellow });
      const s2 = chalkText(w, '别的词 ≈ 0', 400, 590, { size: 40, fill: CK.dim });
      const arr = chalkStroke(w, polyD([[420, 625], [432, 665], [462, 682]], 96, 1), CK.white, 5);
      const arrH = pathOf(w, headD(462, 682, 0.35, 18), CK.white, 5);
      const s3 = chalkText(w, '梯度 ≈ 0，学不动啦', 478, 700, { size: 44, fill: CK.pink });
      const sleepy = g(w);
      s('circle', { r: 44, fill: 'none', stroke: CK.pink, 'stroke-width': 5 }, sleepy);
      pathOf(sleepy, 'M-25 -4 Q-15 5 -6 -4 M6 -4 Q15 5 25 -4 M-7 19 Q0 14 7 19', CK.pink, 4.5);
      const zz = [0, 1].map((i) => chalkText(w, 'z', 0, 0, { font: FONT.latin, size: 36 - i * 9, fill: CK.dim, anchor: 'middle' }));
      const got = new ChalkBubble(w, { x: 730, y: 1010, w: 340, h: 112, tail: [960, 1110], lines: ['懂了！'], size: 58, font: FONT.title, color: CK.violet });
      const m = teacher(w);
      const dood = doodles(w, [
        [560, 1000, 26],
        [470, 1110, 22, 'heart'],
        [990, 900, 24],
      ]);

      // when each thing is written: the title as it starts to talk, then in step with the words
      ck.text(t1, teach.t0 + 0.2, teach.t0 + 1.5, { color: CK.yellow });
      const tf = why.at('为什么');
      ck.text(f, tf, Math.max(tf + 0.8, why.at('根号') + 0.1));
      ck.line(ringDk, why.at('根号') + 0.15, why.at('根号') + 0.6);
      const tA = why.at('不缩放');
      ck.text(l1, tA, tA + 0.35);
      ck.line(ax1, tA + 0.35, tA + 0.6);
      const tR = why.at('权重');
      ck.line(ringBar, tR, tR + 0.45, { color: CK.red });
      ck.text(n1, tR + 0.5, tR + 0.75, { color: CK.red });
      ck.text(n2, tR + 0.75, tR + 1.1, { color: CK.red });
      const tB = why.at('除一下');
      ck.line(arrow, tB, tB + 0.3);
      ck.text(l2, tB + 0.35, tB + 0.7);
      ck.line(ax2, tB + 0.7, tB + 0.9);
      const tC = why.t1 + 0.1;
      ck.text(concl, tC, tC + 1.0);
      ck.line(box, tC + 1.0, tC + 1.4, { color: CK.green });
      const tQ = ask.at('圈出来');
      ck.line(ring, tQ - 0.1, tQ + 0.45, { color: CK.violet });
      const tAsk = ask.at('开口');
      const tP = again.at('停下来');
      // the eraser takes the charts off, then the pie goes up
      const tE = again.at('换个说法');
      const local = eraserWipe(S, { pts: [[1100, 430], [40, 470], [1100, 560], [40, 620], [1100, 700], [40, 740]], sw: 150, a: tE, b: tE + 0.8, target: charts, smudge: true });
      S.local = [local];
      sfx('erase', tE, 0.8);
      const tPie = Math.max(tE + 0.9, again.at('再讲'));
      ck.line(rim, tPie, tPie + 0.7);
      cuts.forEach((c, i) => ck.line(c, tPie + 0.7 + i * 0.1, tPie + 0.8 + i * 0.1));
      ck.text(s1, tPie + 1.3, tPie + 1.9, { color: CK.yellow });
      ck.text(s2, tPie + 1.9, tPie + 2.3, { color: CK.white });
      ck.line(arr, tPie + 2.3, tPie + 2.5);
      ck.text(s3, tPie + 2.5, tPie + 3.2, { color: CK.pink });
      const tGot = tPie + 3.5;
      sfx('pluck', tA + 0.6);
      bars1.forEach((_, i) => sfx('pluck', tA + 0.6 + i * 0.1));
      bars2.forEach((_, i) => sfx('pluck', tB + 0.9 + i * 0.14));
      sfx('pluck', tAsk);
      sfx('pluck', tP);
      sfx('pluck', tPie + 1.15);
      sfx('pluck', tPie + 3.2);
      sfx('ding', tGot);
      sfx('sparkle', tGot + 0.05);
      ck.finish();
      const grow = (list, a, gap) =>
        list.forEach((b, i) => {
          const k = E.outBack(seg(S.u, a + i * gap, a + i * gap + 0.3));
          b.setAttribute('transform', `translate(0 700) scale(1 ${Math.max(0, k)}) translate(0 -700)`);
          b.setAttribute('opacity', S.u > a + i * gap ? 1 : 0);
        });
      return {
        render(u) {
          S.u = u;
          ck.render(u);
          grow(bars1, tA + 0.6, 0.1);
          grow(bars2, tB + 0.9, 0.14);
          ah.setAttribute('opacity', u > tB + 0.3 ? 1 : 0);
          aT.setAttribute('opacity', clamp((u - tB - 0.1) * 4));
          local.render(u);
          // the mic picks the question up
          q.show(u, tAsk, tGot - 0.1);
          bars.forEach((b, i) => {
            const v = 8 + 16 * Math.abs(Math.sin(u * 11 + i * 1.7)) * (u > tAsk && u < tAsk + 1.6 ? 1 : 0.2);
            b.setAttribute('x', -300 + 92 + i * 12);
            b.setAttribute('y', -v / 2);
            b.setAttribute('height', v);
          });
          popIn(pause, u, tP, { x: 310, y: 1035, out: tE + 0.6 });
          popIn(crown, u, tPie + 1.15, { x: cx, y: cy - R - 26, rot: -8 });
          slice.setAttribute('opacity', E.out(seg(u, tPie + 0.9, tPie + 1.3)));
          k1.setAttribute('opacity', clamp((u - tPie - 1.0) * 5));
          arrH.setAttribute('opacity', u > tPie + 2.5 ? 1 : 0);
          popIn(sleepy, u, tPie + 3.2, { x: 940, y: 684 });
          zz.forEach((z, i) => {
            const k = (((u - tPie - 3.4 - i * 0.4) % 1.2) + 1.2) % 1.2;
            place(z, 975 + k * 25 + i * 6, 640 - k * 45 - i * 6, 1, -10);
            z.setAttribute('opacity', u > tPie + 3.4 + i * 0.4 ? Math.sin((k / 1.2) * Math.PI) : 0);
          });
          got.show(u, tGot);
          twinkle(dood, u, tGot + 0.05);
          // the teacher talks while the voice does
          const voiced = S.talking(u);
          spk.waves.forEach((e, i) => e.setAttribute('opacity', voiced ? 0.35 + 0.65 * Math.max(0, Math.sin(u * 9 - i * 1.2)) : 0.3));
          const listening = u > tAsk - 0.2 && u < tE;
          const h = hop(u - tGot, 90, 0.42);
          m.set({
            x: 165,
            y: 1290,
            scale: 0.8,
            ...idle(u),
            lift: h.lift,
            sq: h.sq + Math.sin(u * 4.2) * 0.02,
            mood: u > tGot ? 'happy' : voiced && Math.sin(u * 14) > 0 ? 'talk' : listening ? 'wow' : 'smile',
            raiseR: u > tGot ? 150 : listening ? 30 : 70 + Math.sin(u * 3) * 12,
            raiseL: u > tGot ? 150 : 20,
            look: [5, -4],
          });
        },
      };
    },
  );

  // ===== 5. 公式、代码、函数图像、二叉树 =====
  scene('more', { lines: ['more'], lead: 0.35, tail: 1.1, min: 4.6 }, (S, sfx) => {
    const w = S.world;
    const L = S.L.more;
    const ck = S.chalk;
    const head = headline(w, '不止论文，题目也能讲', { size: 88 });
    const SPOTS = [
      [70, 235, '公式', L.at('公式')],
      [560, 235, '代码', L.at('代码')],
      [70, 690, '函数图像', L.at('函数图像')],
      [560, 690, '二叉树', L.at('二叉树')],
    ];
    const frames = SPOTS.map(([x, y, name, t], i) => {
      const fr = chalkStroke(w, rectD(x, y, 450, 430, 26, 100 + i, 1.8), CK.white, 5);
      const lab = chalkText(w, name, x + 30, y + 56, { size: 36, fill: [CK.yellow, CK.pink, CK.blue, CK.green][i] });
      ck.line(fr, t, t + 0.35);
      ck.text(lab, t + 0.35, t + 0.55, { color: CK.white });
      return { t };
    });
    // 1 · an integral
    const [ta, tb, tc, td] = frames.map((f) => f.t + 0.55);
    const i1 = chalkText(w, '∫ x² dx', 120, 400, { font: FONT.latin, size: 52 });
    const i2 = chalkText(w, '= x³/3 + C', 150, 490, { font: FONT.latin, size: 52, fill: CK.yellow });
    const ib = chalkStroke(w, rectD(130, 440, 330, 72, 14, 104, 1.5), CK.orange, 5);
    ck.text(i1, ta, ta + 0.35);
    ck.text(i2, ta + 0.35, ta + 0.7, { color: CK.yellow });
    ck.line(ib, ta + 0.7, ta + 0.9, { color: CK.orange });
    // 2 · code
    const CODE = ['def fib(n):', '  if n < 2:', '    return n', '  return fib(n-1)+fib(n-2)'];
    const code = CODE.map((l, i) => chalkText(w, l, 585, 360 + i * 46, { font: FONT.mono, size: 24, fill: i === 0 ? CK.violet : CK.white }));
    code.forEach((c, i) => ck.text(c, tb + i * 0.16, tb + 0.16 + i * 0.16));
    const cbox = chalkStroke(w, rectD(575, 360 + 3 * 46 - 32, 400, 46, 10, 105, 1.4), CK.pink, 5);
    ck.line(cbox, tb + 0.7, tb + 0.95, { color: CK.pink });
    const cn = chalkText(w, '递归在这里！', 785, 610, { size: 32, fill: CK.pink, anchor: 'middle' });
    ck.text(cn, tb + 0.95, tb + 1.25, { color: CK.pink });
    // 3 · y = sin x
    const axX = chalkStroke(w, lineD(100, 910, 490, 910, 106, 1), CK.white, 5);
    const axY = chalkStroke(w, lineD(140, 1080, 140, 760, 107, 1), CK.white, 5);
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push([150 + (i / 40) * 330, 910 - 100 * Math.sin((i / 40) * Math.PI * 2)]);
    const sine = chalkStroke(w, polyD(pts, 108, 0.6), CK.blue, 6);
    const sl = chalkText(w, 'y = sin x', 400, 790, { font: FONT.latin, size: 30, fill: CK.blue, anchor: 'middle' });
    ck.line(axX, tc, tc + 0.15);
    ck.line(axY, tc + 0.15, tc + 0.3);
    ck.line(sine, tc + 0.3, tc + 0.9, { color: CK.blue });
    ck.text(sl, tc + 0.9, tc + 1.1, { color: CK.blue });
    // 4 · a tree
    const N = [
      [785, 800],
      [680, 900],
      [890, 900],
      [630, 1010],
      [730, 1010],
      [840, 1010],
      [940, 1010],
    ];
    const edges = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 6]].map(([a, b], i) => {
      const [x1, y1] = N[a];
      const [x2, y2] = N[b];
      const d = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / d;
      const uy = (y2 - y1) / d;
      return chalkStroke(w, lineD(x1 + ux * 30, y1 + uy * 30, x2 - ux * 30, y2 - uy * 30, 110 + i, 1), CK.white, 5);
    });
    const nodes = N.map(([x, y], i) => {
      const e = g(w);
      s('circle', { r: 28, fill: 'none', stroke: [CK.yellow, CK.green, CK.green, CK.pink, CK.pink, CK.pink, CK.pink][i], 'stroke-width': 5 }, e);
      chalkText(e, String(i + 1), 0, 11, { font: FONT.latin, size: 30, anchor: 'middle' });
      return { e, x, y };
    });
    const lv = [0, 1, 1, 2, 2, 2, 2];
    edges.forEach((e, i) => ck.line(e, td + 0.15 + (i < 2 ? 0 : 0.25), td + 0.3 + (i < 2 ? 0 : 0.25)));
    const m = teacher(w);
    sfx('pluck', ta + 0.7);
    nodes.forEach((_, i) => sfx('pluck', td + lv[i] * 0.25 + (i % 2) * 0.04));
    ck.finish();
    return {
      render(u) {
        popLetters(head, u, 0.1, { stagger: 0.045 });
        ck.render(u);
        nodes.forEach(({ e, x, y }, i) => popIn(e, u, td + lv[i] * 0.25 + (i % 2) * 0.04, { x, y }));
        const enter = spring(u - 0.4, 2, 0.5);
        m.set({ x: 540, y: 1300 + (1 - clamp(enter)) * 300, scale: 0.55, ...idle(u), mood: S.talking(u) && Math.sin(u * 14) > 0 ? 'talk' : 'happy', raiseL: 60 + Math.sin(u * 5) * 20, raiseR: 60 + Math.sin(u * 5 + 1) * 20 });
      },
    };
  });

  // ===== 6. 自动保存，存进笔记 =====
  scene('keep', { lines: ['keep'], lead: 0.35, tail: 1.0, min: 4.2 }, (S, sfx) => {
    const w = S.world;
    const L = S.L.keep;
    const ck = S.chalk;
    const head = headline(w, '自动保存，随时接着问', { size: 88 });
    const panel = chalkStroke(w, rectD(80, 235, 920, 470, 28, 120, 1.6), CK.white, 5);
    chalkText(w, '白板记录', 130, 305, { size: 42 });
    const save = g(w);
    s('path', { d: rectD(-110, -32, 220, 64, 32, 121, 1.2), fill: 'none', stroke: CK.violet, 'stroke-width': 5 }, save);
    chalkText(save, '存入笔记', 0, 13, { size: 36, fill: CK.violet, anchor: 'middle' });
    const ROWS = [
      ['为什么要除以 √dₖ', '论文.pdf 第 3 页 · 问了 2 次 · 刚刚'],
      ['二叉树的层序遍历', '直接提问 · 昨天'],
      ['梯度消失是怎么回事', '讲义.pdf 第 12 页 · 3 天前'],
    ];
    const rows = ROWS.map(([a, b], i) => {
      const e = g(w);
      const inner = g(e, { transform: 'translate(-420 -55)' });
      s('path', { d: rectD(0, 0, 840, 110, 18, 122 + i, 1.2), fill: i ? 'none' : 'rgba(168,227,179,.12)', stroke: i ? CK.dim : CK.green, 'stroke-width': 4 }, inner);
      s('path', { d: rectD(18, 16, 78, 78, 10, 125 + i, 1), fill: 'none', stroke: CK.white, 'stroke-width': 3.5 }, inner);
      s('path', { d: 'M32 80 L32 60 M46 80 L46 72 M66 80 L66 52 M80 80 L80 64', stroke: [CK.pink, CK.yellow, CK.blue][i], 'stroke-width': 6, 'stroke-linecap': 'round' }, inner);
      chalkText(inner, a, 120, 50, { size: 38 });
      chalkText(inner, b, 120, 90, { size: 27, fill: CK.dim });
      return { e, y: 400 + i * 128 };
    });
    const note = g(w);
    s('path', { d: rectD(120, 770, 840, 500, 26, 130, 1.6), fill: 'rgba(255,255,255,.05)', stroke: CK.white, 'stroke-width': 5 }, note);
    chalkText(note, '伴读笔记.md', 160, 830, { font: FONT.latin, size: 30, fill: CK.dim });
    chalkText(note, '## 白板：为什么要除以 √dₖ', 160, 890, { size: 40, fill: CK.yellow });
    const shot = g(note);
    s('path', { d: rectD(160, 920, 500, 270, 14, 131, 1.2), fill: 'none', stroke: CK.white, 'stroke-width': 4 }, shot);
    chalkText(shot, '为什么要除以 √dₖ ？', 190, 970, { size: 28, fill: CK.yellow });
    [86, 7, 5, 4].forEach((h, i) => s('path', { d: `M${205 + i * 36} 1130 L${205 + i * 36} ${1130 - h}`, stroke: CK.pink, 'stroke-width': 16, 'stroke-linecap': 'butt' }, shot));
    [60, 48, 37, 28].forEach((h, i) => s('path', { d: `M${470 + i * 40} 1130 L${470 + i * 40} ${1130 - h}`, stroke: CK.blue, 'stroke-width': 16, 'stroke-linecap': 'butt' }, shot));
    pathOf(shot, 'M185 1132 L350 1132 M450 1132 L630 1132', CK.white, 3);
    chalkText(shot, 'softmax 不饱和，梯度不消失！', 190, 1172, { size: 24 });
    const from = chalkText(note, '来自 论文.pdf 第 3 页 · ', 160, 1240, { size: 28, fill: CK.dim });
    const fl = from.getComputedTextLength();
    chalkText(note, '在白板中打开', 160 + fl, 1240, { size: 28, fill: CK.green });
    pathOf(note, `M${162 + fl} 1250 L${160 + fl + 168} 1250`, CK.green, 3);
    const ptr = handPointer(w);
    const rip = chalkRipple(w, CK.violet);
    const dood = doodles(w, [
      [720, 980, 28],
      [880, 1100, 22, 'heart'],
      [760, 1200, 20],
    ]);
    ck.line(panel, 0.15, 0.55);
    const tr = L.at('自动保存');
    const ts = L.at('一键') + 0.1;
    rows.forEach((_, i) => sfx('pluck', tr - 0.4 + i * 0.15));
    sfx('pluck', ts - 0.6);
    sfx('click', ts);
    sfx('ding', ts + 0.75);
    sfx('sparkle', ts + 0.8);
    ck.finish();
    return {
      render(u) {
        popLetters(head, u, 0.1, { stagger: 0.045 });
        ck.render(u);
        rows.forEach((r, i) => popIn(r.e, u, tr - 0.4 + i * 0.15, { x: 540, y: r.y }));
        popIn(save, u, ts - 0.6, { x: 850, y: 292 });
        const pk = E.inOut(seg(u, ts - 0.55, ts - 0.05));
        place(ptr, lerp(980, 860, pk), lerp(1150, 300, pk), u > ts && u < ts + 0.14 ? 0.85 : 1);
        ptr.setAttribute('opacity', clamp((u - ts + 0.6) * 5) * (1 - clamp((u - ts - 0.7) * 4)));
        rip.at(u, ts, 850, 292);
        const d = spring(u - ts - 0.1, 1.8, 0.6);
        note.setAttribute('transform', `translate(0 ${lerp(700, 0, clamp(d, 0, 1.08))})`);
        note.setAttribute('opacity', u > ts + 0.05 ? 1 : 0);
        const k = E.inOut(seg(u, ts + 0.25, ts + 0.75));
        shot.setAttribute('transform', `translate(${lerp(-80, 0, k)} ${lerp(-580, 0, k)}) translate(410 1055) scale(${lerp(0.25, 1, k)}) translate(-410 -1055)`);
        shot.setAttribute('opacity', u > ts + 0.25 ? 1 : 0);
        twinkle(dood, u, ts + 0.8);
      },
    };
  });

  // ===== 7. 片尾 =====
  scene(
    'bye',
    { lines: ['bye'], lead: 0.45, tail: 2.0, min: 6 },
    (S, sfx) => {
      const w = S.world;
      const L = S.L.bye;
      const ck = S.chalk;
      const m = teacher(w);
      const burst = Array.from({ length: 16 }, (_, i) => {
        const e = g(w);
        const cols = [CK.yellow, CK.pink, CK.blue, CK.green, CK.violet];
        const d = i % 3 === 1 ? heartD(0, 0, 14) : starD(0, 0, 18, i);
        s('path', { d, fill: 'none', stroke: cols[i % 5], 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, e);
        const r = rng(200 + i);
        const a = -Math.PI / 2 + (r() - 0.5) * 2.6;
        return { e, a, v: 380 + r() * 360, spin: (r() - 0.5) * 500 };
      });
      const zh = letters(w, '页间', 420, 1035, { font: FONT.title, size: 150, fill: CK.white, anchor: 'middle' });
      const en = chalkText(w, 'Folio', 738, 1030, { font: FONT.latin, size: 84, fill: CK.teal, anchor: 'middle' });
      const tag = chalkText(w, '没读懂？请页老师上白板～', 540, 1130, { size: 52, fill: CK.yellow, anchor: 'middle' });
      const pillG = g(w);
      s('path', { d: rectD(-270, -42, 540, 84, 42, 140, 1.4), fill: 'rgba(124,200,176,.14)', stroke: CK.teal, 'stroke-width': 5 }, pillG);
      chalkText(pillG, 'macOS · Windows', 0, 14, { font: FONT.latin, size: 38, anchor: 'middle' });
      const url = chalkText(w, 'helloxxy.com/works/folio', 540, 1290, { font: FONT.latin, size: 32, fill: CK.dim, anchor: 'middle' });
      const bye = new ChalkBubble(w, { x: 810, y: 520, w: 300, h: 112, tail: [650, 610], lines: ['下次见～'], size: 54, font: FONT.title });
      const tWave = L.at('我们下次见');
      ck.text(en, 1.3, 1.75, { color: CK.teal });
      ck.text(tag, 1.8, 2.7, { color: CK.yellow });
      ck.text(url, 3.0, 3.6, { color: CK.white });
      sfx('poof', 0.2);
      sfx('sparkle', 0.35);
      sfx('pluck', 0.9);
      sfx('pluck', 1.05);
      sfx('pluck', 2.8);
      sfx('pluck', tWave);
      ck.finish();
      return {
        render(u) {
          const h = hop(u - 0.2, 150, 0.55);
          const waving = clamp(seg(u, tWave - 0.2, tWave)) * (1 - seg(u, S.dur - 0.9, S.dur - 0.6));
          m.set({
            x: 540,
            y: 880,
            scale: 1.15,
            ...idle(u),
            lift: h.lift,
            sq: h.sq + Math.sin(u * 4.2) * 0.02,
            raiseL: h.lift > 10 ? 160 : 20,
            raiseR: h.lift > 10 ? 160 : waving * (140 + Math.sin(u * 14) * 18) + 20 * (1 - waving),
            mood: S.talking(u) && Math.sin(u * 14) > 0 ? 'talk' : 'happy',
            sway: Math.sin(u * 3) * 6 - h.sq * 20,
          });
          for (const b of burst) {
            const dt = u - 0.35;
            if (dt < 0) {
              b.e.setAttribute('opacity', 0);
              continue;
            }
            const drag = (1 - Math.exp(-2.4 * dt)) / 2.4;
            place(b.e, 540 + Math.cos(b.a) * b.v * drag, 560 + Math.sin(b.a) * b.v * drag + 90 * dt * dt, 1, b.spin * dt);
            b.e.setAttribute('opacity', clamp(3.2 - dt));
          }
          popLetters(zh, u, 0.9, { stagger: 0.15 });
          popIn(pillG, u, 2.8, { x: 540, y: 1215 });
          bye.show(u, tWave);
          ck.render(u);
          S.world.setAttribute('opacity', 1 - E.inOut(seg(u, S.dur - 0.7, S.dur)));
        },
      };
    },
    { last: true },
  );

  EVENTS.melodic = ['hello', 'more', 'bye'];
  EVENTS.scenes = scenes.map(({ id, t0, t1 }) => ({ id, t0, t1 }));
  EVENTS.duration = clock;
  window.EVENTS = EVENTS;
  return clock;
}

async function seek(t) {
  for (const S of scenes) {
    const vis = t >= S.t0 && t < S.t1;
    S.root.style.visibility = vis ? 'visible' : 'hidden';
    if (vis) S.render(t - S.t0);
  }
  smearsAfter(t);
  // the eraser: out while some scene is being wiped, else in the tray
  let at = null;
  for (const S of scenes) for (const w of [S.wipe, ...(S.local || [])]) if (w && !at) at = w.eraser(t - S.t0);
  place(eraser, ...(at ? [at[0], at[1], 1, at[2]] : [REST[0], REST[1], 0.55, 4]));
  const sub = SUBS.find((x) => t >= x.t0 && t < x.t1 + 0.15);
  subRow.textContent = sub ? sub.text : '';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

const total = await build();
window.DURATION = total;
window.FPS = 60;
window.seek = seek;
const params = new URLSearchParams(location.search);
await seek(Number(params.get('t') || 0));
window.READY = true;
if (params.has('preview')) startPreview(document.getElementById('stage'), seek, total, Number(params.get('t') || 0));
