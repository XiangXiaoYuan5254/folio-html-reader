// 页间宣传片（纸页版）：1080×1440 竖屏。像一本杂志：暖纸、宋体大字、真实的页间界面像照片一样
// 印在纸上，场景之间翻页。所有画面都由 seek(t) 按时间算出来，render.mjs 逐帧调用 seek 再截图。
// 时间按 90 BPM 的小节排：每次切换都落在小节线上，配乐（music-film.mjs）按同一张时间表写。
//   ?preview       显示进度条，可以拖动、播放
//   ?t=12.5        打开时停在这一秒

import { clamp, lerp, seg, E, monotone, el, css, chars, startPreview } from './kit.js';

const W = 1080;
const H = 1440;
const BPM = 90;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
// Bar and beat (both from 1) → seconds.
const T = (bar, beat = 1) => (bar - 1) * BAR + (beat - 1) * BEAT;
const END = T(17) + 1.5;
const media = 'media/';

// ---------- 录屏片段 ----------
class Clip {
  constructor(m) {
    this.name = m.name;
    this.slow = m.slow || 1;
    this.frames = m.frames;
    this.cur = m.cursor;
    this.marks = m.marks;
    this.t0 = this.frames[0].t;
    this.t1 = this.frames.at(-1).t;
    // When the pointer last moved, as of each entry; an idle pointer fades away.
    let moved = this.cur[0].t;
    this.cur.forEach((c, i) => {
      const p = this.cur[i - 1];
      if (p && (Math.abs(c.x - p.x) > 0.5 || Math.abs(c.y - p.y) > 0.5)) moved = c.t;
      c.moved = moved;
    });
  }
  url(i) {
    return `${media}clips/${this.name}/${this.frames[i].file}`;
  }
  frame(ms) {
    const f = this.frames;
    ms = clamp(ms, this.t0, this.t1);
    let lo = 0;
    let hi = f.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid].t <= ms) lo = mid;
      else hi = mid;
    }
    const k = f[hi].t > f[lo].t ? clamp((ms - f[lo].t) / (f[hi].t - f[lo].t)) : 0;
    return { a: this.url(lo), b: this.url(hi), k };
  }
  pointer(ms) {
    const c = this.cur;
    let lo = 0;
    let hi = c.length - 1;
    if (ms <= c[0].t) hi = 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid].t <= ms) lo = mid;
      else hi = mid;
    }
    const p = c[lo];
    const q = c[lo + 1];
    let { x, y } = p;
    if (q && q.t > p.t && ms > p.t) {
      const k = clamp((ms - p.t) / (q.t - p.t));
      x = lerp(p.x, q.x, k);
      y = lerp(p.y, q.y, k);
    }
    let press = -1e9;
    for (let i = lo; i > 0; i--)
      if (c[i].down && !c[i - 1].down) {
        press = c[i].t;
        break;
      }
    const s = this.slow;
    let shown = 1 - clamp((ms - p.moved - 1600 * s) / (350 * s));
    if (q && q.moved === q.t) shown = Math.max(shown, 1 - clamp((q.t - ms) / (250 * s)));
    if (p.down) shown = 1;
    return { x, y, kind: p.kind, down: p.down, since: ms - press, at: press, shown };
  }
}

// Scene time → clip time. `segments` are [clip seconds, speed] pairs (1 = the speed the action
// really had); `fit` stretches the whole to a given length. Joins are smoothed.
function playback(clip, from, segments, fit) {
  const knots = [[0, from * 1000]];
  let tau = 0;
  let ms = from * 1000;
  for (const [to, speed] of segments) {
    const end = Math.min(to * 1000, clip.t1);
    tau += (end - ms) / (speed * clip.slow * 1000);
    knots.push([tau, end]);
    ms = end;
  }
  if (fit) {
    console.log(
      `${clip.name}: 实际 ${tau.toFixed(2)} 秒，压到 ${fit.toFixed(2)} 秒（×${(tau / fit).toFixed(2)}）`,
    );
    for (const k of knots) k[0] *= fit / tau;
    tau = fit;
  }
  const f = monotone(knots);
  const map = (t) => f(clamp(t, 0, tau));
  map.duration = tau;
  map.at = (s) => {
    let a = 0;
    let b = tau;
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2;
      if (f(m) < s * 1000) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  return map;
}

// ---------- 光标 ----------
const CURSORS = {
  arrow: `<g transform="scale(1.3)"><path d="M1 1 L1 18.5 L5.4 14.4 L8.3 21.2 L11.4 19.9 L8.6 13.3 L14.6 13.3 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></g>`,
  ibeam: `<g transform="scale(1.25)" fill="none" stroke-linecap="round"><path d="M-4 -10 Q0 -10 0 -7 L0 7 Q0 10 -4 10 M4 -10 Q0 -10 0 -7 M0 7 Q0 10 4 10 M-2.5 0 H2.5" stroke="#fff" stroke-width="4"/><path d="M-4 -10 Q0 -10 0 -7 L0 7 Q0 10 -4 10 M4 -10 Q0 -10 0 -7 M0 7 Q0 10 4 10 M-2.5 0 H2.5" stroke="#111" stroke-width="1.6"/></g>`,
  cross: `<g fill="none" stroke-linecap="round"><path d="M0 -11 V11 M-11 0 H11" stroke="#fff" stroke-width="4"/><path d="M0 -11 V11 M-11 0 H11" stroke="#111" stroke-width="1.6"/></g>`,
  pen: (ink) =>
    `<g transform="translate(-16 -16)" fill="none" stroke-linecap="round"><circle cx="16" cy="16" r="10" stroke="white" stroke-width="3.5" stroke-dasharray="12 3.708" stroke-dashoffset="-1.854"/><circle cx="16" cy="16" r="10" stroke="${ink}" stroke-width="1.8" stroke-dasharray="12 3.708" stroke-dashoffset="-1.854"/><path d="M16 2.5v5M16 24.5v5M2.5 16h5M24.5 16h5" stroke="white" stroke-width="3.8"/><path d="M16 2.5v5M16 24.5v5M2.5 16h5M24.5 16h5" stroke="#20262e" stroke-width="2"/><circle cx="16" cy="16" r="2.5" fill="${ink}" stroke="white" stroke-width=".7"/></g>`,
};

// ---------- 镜头：关键帧之间缓动，z 按对数插值 ----------
function mix(a, b, k) {
  const o = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const p = a[key] ?? b[key];
    const q = b[key] ?? a[key];
    o[key] = key === 'z' ? Math.exp(lerp(Math.log(p), Math.log(q), k)) : lerp(p, q, k);
  }
  return o;
}
function track(keys) {
  return (t) => {
    if (t <= keys[0][0]) return { ...keys[0][1] };
    for (let i = 1; i < keys.length; i++) {
      const [t1, s1, ease = E.inOut] = keys[i];
      const [t0, s0] = keys[i - 1];
      if (t <= t1) return mix(s0, s1, ease(seg(t, t0, t1)));
    }
    return { ...keys.at(-1)[1] };
  };
}

// ---------- 印在纸上的窗口：一个框，里面可以叠几层画面（交叉淡化时用） ----------
class Layer {
  constructor(plate, ww, wh) {
    this.ww = ww;
    this.wh = wh;
    this.el = el('div', 'world', plate.el);
    this.a = el('img', '', this.el);
    this.b = el('img', '', this.el);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${ww} ${wh}`);
    this.el.append(this.svg);
    this.svg.innerHTML = `
      <g class="lights"><circle cx="24" cy="23" r="6" fill="#ff5f57" stroke="#e2463f" stroke-width=".6"/><circle cx="44" cy="23" r="6" fill="#febc2e" stroke="#e1a116" stroke-width=".6"/><circle cx="64" cy="23" r="6" fill="#28c840" stroke="#1aab29" stroke-width=".6"/></g>
      <g class="extra"></g>
      <circle class="ripple" r="0" fill="rgba(46,125,111,.18)" stroke="rgba(46,125,111,.7)" stroke-width="2"/>
      <g class="cursor"></g>`;
    this.extra = this.svg.querySelector('.extra');
    this.ripple = this.svg.querySelector('.ripple');
    this.cursor = this.svg.querySelector('.cursor');
    this.kind = null;
    this.plate = plate;
  }
  // Camera: window point (cx, cy) at the middle of the plate, z stage px per window px.
  set({ cx, cy, z }, o = 1) {
    const { w, h } = this.plate.box;
    const hw = w / 2 / z;
    const hh = h / 2 / z;
    cx = hw < this.ww / 2 ? clamp(cx, hw, this.ww - hw) : this.ww / 2;
    cy = hh < this.wh / 2 ? clamp(cy, hh, this.wh - hh) : this.wh / 2;
    css(this.el, {
      width: this.ww * z + 'px',
      height: this.wh * z + 'px',
      transform: `translate(${(w / 2 - cx * z).toFixed(2)}px, ${(h / 2 - cy * z).toFixed(2)}px)`,
      opacity: o,
      display: o > 0.002 ? '' : 'none',
    });
  }
  async show(a, b = a, k = 0) {
    const jobs = [];
    for (const [img, src] of [
      [this.a, a],
      [this.b, b],
    ])
      if (img.getAttribute('src') !== src) {
        img.setAttribute('src', src);
        jobs.push(img.decode().catch(() => {}));
      }
    this.b.style.opacity = E.inOut(clamp((k - 0.15) / 0.7));
    this.b.style.display = b === a ? 'none' : '';
    await Promise.all(jobs);
  }
  async still(src) {
    this.point(null);
    await this.show(src);
  }
  async play(clip, ms, cursor = true) {
    const f = clip.frame(ms);
    await this.show(f.a, f.b, f.k);
    this.point(cursor ? clip.pointer(ms) : null, clip);
  }
  point(p, clip) {
    if (!p || !p.kind) {
      this.cursor.style.display = 'none';
      this.ripple.setAttribute('r', 0);
      return;
    }
    this.cursor.style.display = '';
    this.cursor.style.opacity = p.shown ?? 1;
    if (p.kind !== this.kind) {
      this.kind = p.kind;
      const [name, ink] = p.kind.split(':');
      this.cursor.innerHTML = name === 'pen' ? CURSORS.pen(ink) : CURSORS[name] || CURSORS.arrow;
    }
    const press = clip ? clamp(1 - Math.abs(p.since) / (220 * clip.slow)) : 0;
    this.cursor.setAttribute(
      'transform',
      `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${1 - 0.12 * press})`,
    );
    const age = clip ? p.since / (520 * clip.slow) : 2;
    if (age >= 0 && age < 1 && !p.kind.startsWith('pen')) {
      const k = E.out(age);
      const at = clip.pointer(p.at);
      this.ripple.setAttribute('cx', at.x);
      this.ripple.setAttribute('cy', at.y);
      this.ripple.setAttribute('r', 6 + 24 * k);
      this.ripple.style.opacity = 1 - age;
    } else this.ripple.setAttribute('r', 0);
  }
}
class Plate {
  constructor(parent) {
    this.el = el('div', 'plate', parent);
    this.box = { w: 960, h: 900 };
  }
  layer(ww, wh) {
    return new Layer(this, ww, wh);
  }
  // Where the plate sits: x, y, w, h, corner radius r; rx/ry tilt; o, blur, dy.
  set(b) {
    this.box = b;
    css(this.el, {
      left: b.x + 'px',
      top: b.y + (b.dy || 0) + 'px',
      width: b.w + 'px',
      height: b.h + 'px',
      borderRadius: (b.r ?? 14) + 'px',
      opacity: b.o ?? 1,
      transform: `rotateX(${b.rx || 0}deg) rotateY(${b.ry || 0}deg) scale(${b.s ?? 1})`,
      filter: (b.blur || 0) > 0.05 ? `blur(${b.blur.toFixed(2)}px)` : 'none',
      display: (b.o ?? 1) > 0.002 ? '' : 'none',
    });
  }
}
const PLATE = { x: 60, y: 468, w: 960, h: 896, r: 14 };
const PLATE_LOW = { x: 60, y: 530, w: 960, h: 834, r: 14 };
const WIDE = { x: 60, y: 548, w: 960, h: 600, r: 12 };

// ---------- 版式：页眉、标题、页码 ----------
function runningHead(page) {
  const rh = el('div', 'rh', page, '<span>页间 · FOLIO</span><span>读得进，也读得懂</span>');
  const line = el('div', 'rh-line', page);
  return { rh, line };
}
function lines(parent, cls, text) {
  const box = el('div', cls, parent);
  box.rows = text.split('\n').map((row) => el('span', '', el('span', 'line', box), row));
  return box;
}
// A heading: a teal label with a short rule and a Latin word at the right, then the title.
function heading(page, { label, latin, title, sub }) {
  const box = el('div', 'head', page);
  const lab = el('div', 'label', box);
  const bar = el('span', 'bar', lab);
  const text = el('span', '', lab, label);
  const no = latin ? el('span', 'no', lab, latin) : null;
  const head = lines(box, 'title', title);
  const subEl = sub ? el('div', 'sub', box, sub) : null;
  return {
    box,
    // In at a, out at b (scene time); the sub line comes in at `subAt` when given.
    render(t, a, b = 1e9, subAt) {
      const out = E.in(seg(t, b - 0.3, b));
      bar.style.transform = `scaleX(${E.outExpo(seg(t, a, a + 0.8))})`;
      bar.style.opacity = 1 - out;
      const k = E.outExpo(seg(t, a + 0.05, a + 0.85));
      text.style.opacity = k * (1 - out);
      text.style.transform = `translateX(${(1 - k) * -14}px)`;
      if (no) {
        const n = E.outExpo(seg(t, a + 0.25, a + 1.1));
        no.style.opacity = n * (1 - out);
        no.style.transform = `translateX(${(1 - n) * 14}px)`;
      }
      head.rows.forEach((s, i) => {
        const r = E.outExpo(seg(t, a + 0.1 + i * 0.1, a + 1.0 + i * 0.1));
        const o = E.in(seg(t, b - 0.32 + i * 0.05, b - 0.02 + i * 0.05));
        s.style.transform = `translateY(${((1 - r) * 108 - o * 108).toFixed(2)}%)`;
      });
      if (subEl) {
        const s0 = subAt ?? a + 0.45;
        const r = E.outExpo(seg(t, s0, s0 + 0.9));
        subEl.style.opacity = r * (1 - out);
        subEl.style.transform = `translateY(${(1 - r) * 16}px)`;
      }
      box.style.visibility = t > a - 0.01 && t < b + 0.02 ? 'visible' : 'hidden';
    },
  };
}
function folio(page, n) {
  return el('div', 'folio', page, `— ${String(n).padStart(2, '0')} —`);
}

// The app icon, in parts, so it can put itself together.
const ICON = (id) => `<svg viewBox="0 0 1024 1024" width="100%" height="100%">
  <defs><linearGradient id="ig${id}" x2="1" y2="1"><stop stop-color="#438e7f"/><stop offset="1" stop-color="#24695f"/></linearGradient>
  <linearGradient id="ip${id}" x2="0" y2="1"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#dfebe1"/></linearGradient></defs>
  <rect class="sq" x="72" y="72" width="880" height="880" rx="205" fill="url(#ig${id})"/>
  <g class="book"><path d="M260 295c94-17 167 5 252 55 85-50 158-72 252-55v420c-91-22-173-7-252 37-79-44-161-59-252-37z" fill="url(#ip${id})"/>
  <path d="M512 355v391" fill="none" stroke="#98b5a7" stroke-width="11"/></g>
  <path class="ln" d="M323 414c42-1 87 11 131 32m-131 55c42-1 87 11 131 32m-131 55c42-1 87 11 108 21" fill="none" stroke="#8eb1a3" stroke-width="13" stroke-linecap="round"/>
  <path class="mark" d="M607 366v187l40-25 40 25V342" fill="#e2bb63"/></svg>`;
let icons = 0;
function icon(parent, size) {
  const box = el('div', 'abs', parent, ICON(++icons));
  css(box, { width: size + 'px', height: size + 'px' });
  const sq = box.querySelector('.sq');
  const book = box.querySelector('.book');
  const ln = box.querySelector('.ln');
  const mark = box.querySelector('.mark');
  for (const e of [sq, book, mark]) e.style.transformBox = 'view-box';
  sq.style.transformOrigin = '512px 512px';
  book.style.transformOrigin = '512px 520px';
  const len = ln.getTotalLength();
  return {
    box,
    // k from 0 (nothing) to 1 (the whole icon), over about 1.4 s of local time.
    render(t) {
      const a = E.outBack(clamp(seg(t, 0, 0.7)));
      sq.style.transform = `scale(${lerp(0.82, 1, a)})`;
      sq.style.opacity = E.out(seg(t, 0, 0.35));
      const b = E.outExpo(seg(t, 0.25, 0.95));
      book.style.transform = `scaleX(${lerp(0.04, 1, b)}) scaleY(${lerp(0.7, 1, b)})`;
      book.style.opacity = clamp(b * 3);
      ln.style.strokeDasharray = `${len}`;
      ln.style.strokeDashoffset = `${len * (1 - E.inOut(seg(t, 0.6, 1.2)))}`;
      const m = seg(t, 0.75, 1.3);
      mark.style.transform = `translateY(${(1 - E.outBack(m)) * -90}px)`;
      mark.style.opacity = clamp(m * 4);
    },
  };
}

// ---------- 舞台 ----------
const stage = document.getElementById('stage');
const scenesEl = document.getElementById('scenes');
const grainEl = document.getElementById('grain');
const scenes = [];
const EVENTS = { clicks: [], keys: [], turns: [], flips: [], swishes: [], ink: [], seal: null };

// A scene is a page of its own. `turn`: it turns away like a page at its end.
function scene(id, t0, dur, build, { pre = 0, post = 0, turn = false } = {}) {
  const root = el('div', 'scene', scenesEl);
  root.style.display = 'none';
  const page = el('div', 'paper', root);
  const s = { id, t0, t1: t0 + dur, pre, post, root, page, turn };
  const content = el('div', 'abs', root);
  css(content, { inset: 0, perspective: '2600px' });
  s.content = content;
  s.shade = el('div', 'shade', root);
  s.render = build(content, s).render;
  scenes.push(s);
  if (turn) EVENTS.turns.push(t0 + dur - TURN_LEAD);
  return s;
}
// A page turn: lifts from the right edge, swings over the spine on the left.
const TURN_LEAD = 0.62;
const TURN_TAIL = 0.16;
function turning(s, t) {
  if (!s.turn) return 0;
  const dur = s.t1 - s.t0;
  return E.inOut(seg(t, dur - TURN_LEAD, dur + TURN_TAIL));
}

// Cursor presses inside a scene, for click sounds; typing, for key taps.
function sounds(clip, map, t0, lead, dur) {
  clip.cur.forEach((c, i) => {
    if (i && c.down && !clip.cur[i - 1].down && !c.kind.startsWith('pen')) {
      const at = map.at(c.t / 1000) + lead;
      if (at > 0.05 && at < dur - 0.05 && c.t <= map(map.duration)) EVENTS.clicks.push(t0 + at);
    }
  });
  const marks = clip.marks;
  marks.forEach((m, i) => {
    if (m.name !== 'type') return;
    const until = (marks[i + 1]?.t ?? m.t + 4000) / 1000;
    let s = m.t / 1000 + 0.3;
    let n = 0;
    while (s < until - 0.2) {
      const at = map.at(s) + lead;
      if (at > 0 && at < dur && s * 1000 <= map(map.duration)) EVENTS.keys.push(t0 + at);
      s += 0.15 + ((n++ * 7919) % 13) / 100;
    }
  });
}

// Paper tooth: soft noise, the same every frame (paper doesn't flicker).
function makePaper() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const img = g.createImageData(512, 512);
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 236 + rnd() * 19;
    img.data[i] = v;
    img.data[i + 1] = v - 2;
    img.data[i + 2] = v - 6;
    img.data[i + 3] = 26;
  }
  g.putImageData(img, 0, 0);
  // A few long fibers.
  g.globalAlpha = 0.05;
  g.strokeStyle = '#8a7350';
  for (let i = 0; i < 70; i++) {
    g.lineWidth = 0.6 + rnd();
    g.beginPath();
    const x = rnd() * 512;
    const y = rnd() * 512;
    g.moveTo(x, y);
    g.quadraticCurveTo(
      x + rnd() * 40 - 20,
      y + rnd() * 40 - 20,
      x + rnd() * 70 - 35,
      y + rnd() * 70 - 35,
    );
    g.stroke();
  }
  stage.style.setProperty('--tooth', `url(${c.toDataURL()})`);
  const n = document.createElement('canvas');
  n.width = n.height = 256;
  const h = n.getContext('2d');
  const d = h.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = rnd() * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  h.putImageData(d, 0, 0);
  grainEl.style.backgroundImage = `url(${n.toDataURL()})`;
}

// ---------- 搭场景 ----------
async function build() {
  makePaper();
  const names = ['translate', 'annotate', 'ask', 'board'];
  const clips = {};
  await Promise.all(
    names.map(async (n) => {
      clips[n] = new Clip(await (await fetch(`${media}clips/${n}/meta.json`)).json());
    }),
  );

  // ===== 1. 一篇英文论文，十五页。读到第二段，就走神了。 =====
  scene(
    'hook',
    T(1),
    T(3) - T(1),
    (root, s) => {
      const dur = s.t1 - s.t0;
      const wrap = el('div', 'abs', root);
      css(wrap, {
        inset: 0,
        overflow: 'hidden',
        maskImage:
          'linear-gradient(to bottom, transparent 0, transparent 470px, #000 660px, #000 1260px, transparent 1440px)',
        webkitMaskImage:
          'linear-gradient(to bottom, transparent 0, transparent 470px, #000 660px, #000 1260px, transparent 1440px)',
      });
      const img = el('img', 'macro', wrap);
      img.src = `${media}pages/hi-01.png`;
      const head = el('div', 'head', root);
      css(head, { top: '170px' });
      const a = lines(head, 'title', '一篇英文论文，\n十五页。');
      const b = lines(head, 'title', '读到第二段，\n就走神了。');
      css(b, { position: 'absolute', left: 0, top: 0, marginTop: '22px' });
      // A red wavy line under 走神, drawn in by hand.
      const ink = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ink.setAttribute('viewBox', '0 0 180 30');
      css(ink, {
        position: 'absolute',
        left: '84px',
        top: '214px',
        width: '180px',
        height: '30px',
        overflow: 'visible',
      });
      ink.innerHTML = `<path d="M3 16 C 18 6, 30 26, 46 15 S 74 6, 90 16 S 118 26, 134 14 S 164 8, 178 17" fill="none" stroke="#b8382c" stroke-width="5" stroke-linecap="round"/>`;
      head.append(ink);
      const path = ink.querySelector('path');
      const plen = path.getTotalLength();
      const inkAt = T(2, 3.4);
      EVENTS.ink.push(s.t0 + inkAt);
      const row = (rows, t, a0, b0) =>
        rows.forEach((r, i) => {
          const k = E.outExpo(seg(t, a0 + i * 0.12, a0 + 1 + i * 0.12));
          const o = E.in(seg(t, b0 + i * 0.05, b0 + 0.3 + i * 0.05));
          r.style.transform = `translateY(${((1 - k) * 108 - o * 108).toFixed(2)}%)`;
        });
      return {
        render(t) {
          // The page drifts like eyes reading along, then slips out of focus.
          const sc = 0.85;
          const x = 40 - 600 * sc - t * 18;
          const y = 600 - 1716 * sc - t * 9;
          const blur = E.inOut(seg(t, T(2, 1.6), T(2, 4.2))) * 7;
          const swim = E.inOut(seg(t, T(2, 1.6), dur));
          img.style.transform = `translate(${x}px, ${y}px) scale(${sc * (1 + swim * 0.05)})`;
          img.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
          img.style.opacity = (1 - 0.35 * swim) * E.out(seg(t, 0, 0.5));
          row(a.rows, t, 0.08, T(2) - 0.42);
          row(b.rows, t, T(2), 1e9);
          path.style.strokeDasharray = `${plen}`;
          path.style.strokeDashoffset = `${plen * (1 - E.inOut(seg(t, inkAt, inkAt + 0.42)))}`;
        },
      };
    },
    { turn: true },
  );

  // ===== 2. 换一种读法。 =====
  scene(
    'turn',
    T(3),
    T(4) - T(3),
    (root, s) => {
      const dur = s.t1 - s.t0;
      const word = chars(root, 'word', '换一种读法。', {
        top: '612px',
        fontFamily: 'var(--song)',
        fontWeight: 700,
        fontSize: '80px',
        letterSpacing: '0.08em',
      });
      const rule = el('div', 'abs', root);
      css(rule, {
        left: '470px',
        top: '760px',
        width: '140px',
        height: '2px',
        background: 'var(--teal)',
        transformOrigin: '50% 50%',
      });
      return {
        render(t) {
          word.chars.forEach((c, i) => {
            const k = E.outExpo(seg(t, 0.1 + i * 0.07, 1.1 + i * 0.07));
            const o = E.in(seg(t, dur - 0.45, dur + 0.05));
            c.style.opacity = k * (1 - o);
            c.style.transform = `translateY(${(1 - k) * 22 - o * 30}px)`;
            c.style.filter = k < 0.995 ? `blur(${(1 - k) * 8}px)` : 'none';
          });
          const r = E.outExpo(seg(t, 0.5, 1.4));
          rule.style.transform = `scaleX(${r * (1 - E.in(seg(t, dur - 0.5, dur)))})`;
        },
      };
    },
    { pre: TURN_LEAD, post: 0.2 },
  );

  // ===== 3. 图标拼起来：页间 Folio，读得进，也读得懂。 =====
  scene(
    'logo',
    T(4),
    T(5) - T(4),
    (root, s) => {
      const dur = s.t1 - s.t0;
      const ic = icon(root, 230);
      css(ic.box, { left: W / 2 - 115 + 'px', top: '330px' });
      const name = chars(root, 'word', '页间', {
        top: '600px',
        fontFamily: 'var(--song)',
        fontWeight: 700,
        fontSize: '150px',
        letterSpacing: '0.14em',
        paddingLeft: '0.14em',
      });
      const latin = el('div', 'word', root, 'Folio');
      css(latin, {
        top: '806px',
        fontFamily: 'var(--bodoni)',
        fontStyle: 'italic',
        fontSize: '64px',
        color: 'var(--teal)',
      });
      const tag = chars(root, 'word', '读得进，也读得懂。', {
        top: '930px',
        fontFamily: 'var(--song)',
        fontSize: '38px',
        letterSpacing: '0.16em',
        paddingLeft: '0.16em',
        color: 'var(--ink-2)',
      });
      return {
        render(t) {
          const out = E.in(seg(t, dur - 0.1, dur + 0.45));
          root.style.opacity = 1 - out;
          root.style.transform = `translateY(${-out * 40}px)`;
          ic.render(t - 0.05);
          name.chars.forEach((c, i) => {
            const k = E.outExpo(seg(t, 0.4 + i * 0.12, 1.4 + i * 0.12));
            c.style.opacity = k;
            c.style.transform = `translateY(${(1 - k) * 26}px)`;
            c.style.filter = k < 0.995 ? `blur(${(1 - k) * 10}px)` : 'none';
          });
          const l = E.outExpo(seg(t, 0.75, 1.6));
          latin.style.opacity = l;
          latin.style.transform = `translateY(${(1 - l) * 16}px)`;
          latin.style.letterSpacing = `${lerp(0.3, 0.04, l)}em`;
          tag.chars.forEach((c, i) => {
            const k = E.outExpo(seg(t, 1.05 + i * 0.04, 1.85 + i * 0.04));
            c.style.opacity = k;
            c.style.transform = `translateY(${(1 - k) * 12}px)`;
          });
        },
      };
    },
    { post: 0.45 },
  );

  // ===== 4. 窗口落在纸上：把论文，放进页间。镜头推进去：全文翻译 =====
  scene(
    'translate',
    T(5),
    T(8) - T(5),
    (root, s) => {
      const dur = s.t1 - s.t0;
      const rh = runningHead(root);
      const h1 = heading(root, {
        label: 'PDF · HTML',
        latin: 'Folio',
        title: '把论文，\n放进页间。',
      });
      const h2 = heading(root, {
        label: '全文翻译',
        latin: 'Translate',
        title: '英文论文，\n读成中文。',
      });
      const fol = folio(root, 1);
      const plate = new Plate(root);
      const wide = plate.layer(1600, 1000);
      const clip = clips.translate;
      const tr = plate.layer(960, 1120);
      const swap = T(6) - T(5);
      const lead = swap + 0.1;
      const map = playback(
        clip,
        0.5,
        [
          [2.0, 1.1],
          [6.3, 3.5],
          [29.6, 16],
          [30.4, 2],
          [38.3, 10],
          [46, 1.5],
        ],
        dur - lead - 0.55,
      );
      const at = (sec) => lead + map.at(sec);
      sounds(clip, map, s.t0, lead, dur);
      EVENTS.swishes.push(s.t0 + swap - 0.25);
      const box = track([
        [0, { ...WIDE, dy: 90, o: 0, rx: 14 }],
        [0.95, { ...WIDE, dy: 0, o: 1, rx: 0 }, E.outQuint],
        [swap - 0.5, { ...WIDE, dy: 0, o: 1, rx: 0 }],
        [swap + 0.35, { ...PLATE, dy: 0, o: 1, rx: 0 }, E.inOutQuint],
      ]);
      const camWide = track([
        [0, { cx: 800, cy: 500, z: 0.6 }],
        [swap - 0.5, { cx: 800, cy: 500, z: 0.615 }],
        [swap + 0.35, { cx: 980, cy: 470, z: 1.05 }, E.inOutQuint],
      ]);
      const camTr = track([
        [swap - 0.5, { cx: 560, cy: 420, z: 0.62 }],
        [swap + 0.35, { cx: 480, cy: 448, z: 1 }, E.inOutQuint],
        [at(2.0), { cx: 560, cy: 400, z: 1.08 }],
        [at(6.5), { cx: 480, cy: 450, z: 1 }],
        [at(31), { cx: 480, cy: 480, z: 1 }],
        [at(38.4), { cx: 480, cy: 560, z: 1.02 }],
        [dur, { cx: 560, cy: 610, z: 1.14 }, E.inOut],
      ]);
      return {
        async render(t) {
          const r = E.outExpo(seg(t, 0.2, 1.1));
          rh.rh.style.opacity = r;
          rh.line.style.transform = `scaleX(${r})`;
          fol.style.opacity = E.out(seg(t, 0.6, 1.2));
          fol.textContent = t < swap ? '— 01 —' : '— 02 —';
          h1.render(t, 0.25, swap - 0.05);
          h2.render(t, swap + 0.12);
          const b = box(t);
          plate.set(b);
          const x = E.inOut(seg(t, swap - 0.35, swap + 0.2));
          wide.set(camWide(t), 1 - x);
          tr.set(camTr(t), x);
          await Promise.all([
            x < 0.999 ? wide.still(`${media}wide-notes.png`) : null,
            x > 0.001 ? tr.play(clip, map(t - lead), t > lead + 0.05) : null,
          ]);
        },
      };
    },
    { pre: 0.2, turn: true },
  );

  // ===== 5. 批注：划下来，写在页边。 =====
  scene(
    'annotate',
    T(8),
    T(10) - T(8),
    (root, s) => {
      const dur = s.t1 - s.t0;
      const rh = runningHead(root);
      const h = heading(root, { label: '批注', latin: 'Annotate', title: '划下来，\n写在页边。' });
      folio(root, 3);
      const plate = new Plate(root);
      plate.set(PLATE);
      const clip = clips.annotate;
      const layer = plate.layer(960, 1120);
      const lead = 0.15;
      const map = playback(
        clip,
        0.9,
        [
          [3.5, 1.5],
          [6.2, 9],
          [8.0, 2.2],
          [13.2, 12],
          [15.6, 2.1],
          [21.4, 12],
          [28.6, 3.4],
          [31.5, 2],
        ],
        dur - lead - 0.65,
      );
      const at = (sec) => lead + map.at(sec);
      sounds(clip, map, s.t0, lead, dur);
      const cam = track([
        [0, { cx: 470, cy: 520, z: 1.5 }],
        [at(3.4), { cx: 470, cy: 500, z: 1.58 }],
        [at(13.3), { cx: 490, cy: 520, z: 1.62 }],
        [at(15.8), { cx: 505, cy: 530, z: 1.66 }],
        [at(21.5), { cx: 600, cy: 380, z: 1.32 }, E.inOutQuint],
        [dur, { cx: 610, cy: 370, z: 1.38 }],
      ]);
      return {
        render(t) {
          rh.rh.style.opacity = 1;
          h.render(t, 0.05);
          layer.set(cam(t));
          return layer.play(clip, map(t - lead));
        },
      };
    },
    { pre: TURN_LEAD, turn: true },
  );

  // ===== 6. 问：哪里不懂，问它。每一句回答，都指回原文。 =====
  scene(
    'ask',
    T(10),
    T(12) - T(10),
    (root, s) => {
      const dur = s.t1 - s.t0;
      runningHead(root);
      const h = heading(root, {
        label: 'AI 助手',
        latin: 'Ask',
        title: '哪里不懂，\n问它。',
        sub: '每一句回答，都指回原文。',
      });
      folio(root, 4);
      const plate = new Plate(root);
      plate.set(PLATE_LOW);
      const clip = clips.ask;
      const layer = plate.layer(960, 1120);
      layer.extra.innerHTML = `<path class="link" d="M846 507 C 760 600, 640 720, 470 812" fill="none" stroke="#6a5ae0" stroke-width="3" stroke-linecap="round"/><circle class="spark" r="6" fill="#6a5ae0"/>`;
      const link = layer.extra.querySelector('.link');
      const spark = layer.extra.querySelector('.spark');
      const len = link.getTotalLength();
      const lead = 0.15;
      const map = playback(
        clip,
        0.6,
        [
          [2.5, 1.3],
          [6.3, 8],
          [11.7, 3.4],
          [17.2, 3.8],
          [18.9, 2.6],
          [23.8, 1.6],
        ],
        dur - lead - 0.55,
      );
      const at = (sec) => lead + map.at(sec);
      sounds(clip, map, s.t0, lead, dur);
      const linkAt = at(21.4);
      EVENTS.swishes.push(s.t0 + linkAt + 0.1);
      const cam = track([
        [0, { cx: 480, cy: 450, z: 1 }],
        [at(2.6), { cx: 520, cy: 470, z: 1.04 }],
        [at(6.6), { cx: 640, cy: 760, z: 1.32 }, E.inOutQuint],
        [at(11.8), { cx: 640, cy: 700, z: 1.32 }],
        [at(13), { cx: 640, cy: 420, z: 1.3 }, E.inOutQuint],
        [at(19.0), { cx: 640, cy: 440, z: 1.3 }],
        [at(21.2), { cx: 480, cy: 640, z: 1.0 }, E.inOutQuint],
        [dur, { cx: 470, cy: 650, z: 1.02 }],
      ]);
      return {
        render(t) {
          h.render(t, 0.05, 1e9, linkAt + 0.2);
          layer.set(cam(t));
          const k = E.inOut(seg(t, linkAt, linkAt + 0.7));
          link.setAttribute('stroke-dasharray', `${(k * len).toFixed(1)} ${len}`);
          link.style.opacity = k > 0 ? 0.85 : 0;
          const p = link.getPointAtLength(k * len);
          spark.setAttribute('cx', p.x);
          spark.setAttribute('cy', p.y);
          spark.style.opacity = k > 0 && k < 1 ? 1 : 0;
          return layer.play(clip, map(t - lead));
        },
      };
    },
    { pre: TURN_LEAD, turn: true },
  );

  // ===== 7. 白板：还是不懂？它拿起笔，讲给你听。 =====
  scene(
    'board',
    T(12),
    T(14) - T(12),
    (root, s) => {
      const dur = s.t1 - s.t0;
      runningHead(root);
      const h = heading(root, {
        label: '白板讲解',
        latin: 'Explain',
        title: '还是不懂？\n它拿起笔，讲给你听。',
      });
      folio(root, 5);
      const plate = new Plate(root);
      plate.set(PLATE);
      const clip = clips.board;
      const layer = plate.layer(960, 1120);
      const lead = 0.15;
      const map = playback(
        clip,
        4.5,
        [
          [5.9, 1.4],
          [8.0, 6],
          [9.0, 1.5],
          [59.8, 12],
          [61.6, 3],
          [65.6, 2.2],
          [68.8, 5],
        ],
        dur - lead - 0.6,
      );
      const at = (sec) => lead + map.at(sec);
      sounds(clip, map, s.t0, lead, dur);
      const cam = track([
        [0, { cx: 480, cy: 470, z: 1.04 }],
        [at(8.4), { cx: 440, cy: 446, z: 1.2 }, E.inOutQuint],
        [at(35), { cx: 430, cy: 452, z: 1.22 }],
        [at(59.8), { cx: 430, cy: 456, z: 1.2 }],
        [dur, { cx: 450, cy: 470, z: 1.26 }],
      ]);
      return {
        render(t) {
          h.render(t, 0.05);
          layer.set(cam(t));
          return layer.play(clip, map(t - lead));
        },
      };
    },
    { pre: TURN_LEAD, turn: true },
  );

  // ===== 8. 十套主题，跟着十六分音符换 =====
  const THEMES = [
    ['青岚', '#2e7d6f'],
    ['晴空', '#3b82c4'],
    ['桃夭', '#d0708a'],
    ['新粗野', '#e0b400'],
    ['报刊', '#b23a2a'],
    ['终端', '#2fbf63'],
    ['极光', '#8a6cf0'],
    ['夜读', '#5d7fd0'],
    ['墨金', '#c9a24a'],
    ['宣纸', '#a8823f'],
  ];
  scene(
    'themes',
    T(14),
    T(15) - T(14),
    (root, s) => {
      const dur = s.t1 - s.t0;
      runningHead(root);
      const h = heading(root, {
        label: '界面主题',
        latin: 'Themes',
        title: '换个心情，\n接着读。',
      });
      folio(root, 6);
      const plate = new Plate(root);
      const layer = plate.layer(1600, 1000);
      const name = el('div', 'word', root);
      css(name, {
        top: '1196px',
        fontFamily: 'var(--song)',
        fontSize: '34px',
        letterSpacing: '0.3em',
        paddingLeft: '0.3em',
      });
      const dot = el('span', 'abs', root);
      css(dot, { width: '12px', height: '12px', borderRadius: '50%', top: '1214px' });
      const step = BEAT / 4;
      const first = 0;
      THEMES.forEach((_, i) => i && EVENTS.flips.push(s.t0 + first + i * step));
      const box = track([
        [-TURN_LEAD, { ...WIDE }],
        [dur, { ...WIDE, s: 1.015 }],
        [dur + 0.5, { ...WIDE, dy: 60, o: 0, s: 0.97 }, E.inOut],
      ]);
      return {
        render(t) {
          h.render(t, 0.05, dur + 0.15);
          const i = clamp(Math.floor((t - first) / step + 1e-6), 0, THEMES.length - 1);
          const b = box(t);
          plate.set(b);
          layer.set({ cx: 800, cy: 500, z: 0.6 });
          const [label, color] = THEMES[i];
          name.textContent = label;
          const nw = label.length * 34 * 1.3;
          dot.style.left = `${W / 2 - nw / 2 - 30}px`;
          dot.style.background = color;
          const o = (b.o ?? 1) * E.out(seg(t, 0.1, 0.6));
          name.style.opacity = o;
          dot.style.opacity = o;
          return layer.still(`${media}theme-${label}.png`);
        },
      };
    },
    { pre: TURN_LEAD, post: 0.5 },
  );

  // ===== 9. 落款：页间 Folio，读得进，也读得懂。盖章。 =====
  scene(
    'outro',
    T(15),
    END - T(15),
    (root, s) => {
      const ic = icon(root, 190);
      css(ic.box, { left: W / 2 - 95 + 'px', top: '300px' });
      const name = chars(root, 'word', '页间', {
        top: '540px',
        fontFamily: 'var(--song)',
        fontWeight: 700,
        fontSize: '140px',
        letterSpacing: '0.14em',
        paddingLeft: '0.14em',
      });
      const latin = el('div', 'word', root, 'Folio');
      css(latin, {
        top: '736px',
        fontFamily: 'var(--bodoni)',
        fontStyle: 'italic',
        fontSize: '58px',
        color: 'var(--teal)',
      });
      const tag = chars(root, 'word', '读得进，也读得懂。', {
        top: '856px',
        fontFamily: 'var(--song)',
        fontSize: '38px',
        letterSpacing: '0.16em',
        paddingLeft: '0.16em',
        color: 'var(--ink-2)',
      });
      const rule = el('div', 'abs', root);
      css(rule, {
        left: '490px',
        top: '968px',
        width: '100px',
        height: '1px',
        background: 'var(--rule)',
      });
      const recap = el('div', 'word', root, '全文翻译 · 批注 · AI 助手 · 白板讲解 · 十套主题');
      css(recap, {
        top: '1000px',
        fontSize: '21px',
        letterSpacing: '0.2em',
        paddingLeft: '0.2em',
        color: 'var(--ink-2)',
      });
      const os = el('div', 'word', root, 'macOS · Windows');
      css(os, {
        top: '1052px',
        fontSize: '22px',
        letterSpacing: '0.34em',
        paddingLeft: '0.34em',
        color: 'var(--ink-3)',
      });
      const url = el('div', 'word', root, 'helloxxy.com/works/folio');
      css(url, {
        top: '1094px',
        fontFamily: 'var(--didot)',
        fontStyle: 'italic',
        fontSize: '26px',
        letterSpacing: '0.06em',
        color: 'var(--ink-3)',
      });
      // A red seal, pressed on at the last chord.
      const seal = el(
        'div',
        'seal',
        root,
        `<svg viewBox="0 0 104 104" width="104" height="104"><defs><filter id="rough" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="2" seed="5" result="n"/><feColorMatrix in="n" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -9 7.4" result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/></filter></defs><g filter="url(#rough)"><rect x="4" y="4" width="96" height="96" rx="10" fill="#b8382c"/><text x="52" y="47" text-anchor="middle" font-family="Weibei SC, Kaiti SC, serif" font-size="38" fill="#f7efe4">页</text><text x="52" y="88" text-anchor="middle" font-family="Weibei SC, Kaiti SC, serif" font-size="38" fill="#f7efe4">间</text></g></svg>`,
      );
      css(seal, { left: '808px', top: '548px' });
      const sealAt = T(16) - T(15);
      EVENTS.seal = s.t0 + sealAt;
      return {
        render(t) {
          ic.render(t - 0.1);
          name.chars.forEach((c, i) => {
            const k = E.outExpo(seg(t, 0.35 + i * 0.12, 1.35 + i * 0.12));
            c.style.opacity = k;
            c.style.transform = `translateY(${(1 - k) * 26}px)`;
            c.style.filter = k < 0.995 ? `blur(${(1 - k) * 10}px)` : 'none';
          });
          const l = E.outExpo(seg(t, 0.7, 1.5));
          latin.style.opacity = l;
          latin.style.letterSpacing = `${lerp(0.3, 0.04, l)}em`;
          tag.chars.forEach((c, i) => {
            const k = E.outExpo(seg(t, 0.95 + i * 0.04, 1.75 + i * 0.04));
            c.style.opacity = k;
            c.style.transform = `translateY(${(1 - k) * 12}px)`;
          });
          const m = E.outExpo(seg(t, 1.4, 2.2));
          rule.style.transform = `scaleX(${m})`;
          const rc = E.outExpo(seg(t, 1.6, 2.5));
          recap.style.opacity = rc;
          recap.style.transform = `translateY(${(1 - rc) * 10}px)`;
          os.style.opacity = E.outExpo(seg(t, 2.0, 2.8));
          url.style.opacity = E.outExpo(seg(t, 2.2, 3.0));
          const p = seg(t, sealAt - 0.08, sealAt + 0.12);
          const settle = E.outBack(seg(t, sealAt, sealAt + 0.35));
          seal.style.opacity = clamp(p * 3);
          seal.style.transform = `rotate(-4deg) scale(${t < sealAt ? lerp(1.5, 1, E.in(p)) : lerp(0.96, 1, settle)})`;
          // A slow push on the whole page.
          root.style.transform = `scale(${1 + 0.02 * seg(t, 0, END - s.t0)})`;
          root.style.transformOrigin = '50% 45%';
        },
      };
    },
    { pre: 0.2 },
  );

  EVENTS.scenes = scenes.map(({ id, t0, t1 }) => ({ id, t0, t1 }));
  EVENTS.duration = END;
  EVENTS.bpm = BPM;
  window.EVENTS = EVENTS;
  return END;
}

// ---------- 每帧 ----------
async function seek(t) {
  const frame = Math.round(t * 60);
  grainEl.style.backgroundPosition = `${(frame * 97) % 256}px ${(frame * 173) % 256}px`;
  const jobs = [];
  for (const [i, s] of scenes.entries()) {
    const on = t >= s.t0 - s.pre && t < s.t1 + s.post + (s.turn ? TURN_TAIL : 0);
    s.root.style.display = on ? '' : 'none';
    if (!on) continue;
    // The page turning away sits above the one coming in.
    const k = turning(s, t - s.t0);
    s.root.style.zIndex = k > 0 ? 3 : 1 + (i % 2);
    s.root.style.transform =
      k > 0 ? `translateZ(${Math.sin(k * Math.PI) * 30}px) rotateY(${-108 * k}deg)` : '';
    s.shade.style.opacity =
      k > 0 ? (0.42 * Math.sin(Math.min(k * 108, 90) * (Math.PI / 180))).toFixed(3) : 0;
    s.shade.style.background = 'linear-gradient(to left, rgba(40,30,15,.55), rgba(40,30,15,.15))';
    // The page beneath gets the shadow of the one turning over it.
    const prev = scenes[i - 1];
    if (prev?.turn && t < prev.t1 + TURN_TAIL) {
      const kp = turning(prev, t - prev.t0);
      const reach = Math.max(0, Math.cos(kp * 108 * (Math.PI / 180))) * W;
      s.shade.style.opacity = (0.5 * Math.sin(kp * Math.PI)).toFixed(3);
      s.shade.style.background = `linear-gradient(to right, rgba(40,30,15,.0) 0, rgba(40,30,15,.28) ${Math.max(0, reach - 160)}px, rgba(40,30,15,.0) ${reach + 40}px)`;
    }
    jobs.push(s.render(t - s.t0, t));
  }
  await Promise.all(jobs);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

const total = await build();
window.DURATION = total;
window.FPS = 60;
window.seek = seek;
const params = new URLSearchParams(location.search);
await seek(Number(params.get('t') || 0));
window.READY = true;

if (params.has('preview')) startPreview(stage, seek, total, Number(params.get('t') || 0));
