// 页间宣传视频：1920×1080 的时间轴动画。所有画面都由 seek(t) 按时间算出来，
// render.mjs 逐帧调用 seek 再截图，所以每一帧都确定、可复现。
// 录屏素材来自 capture.mjs（系统临时目录/folio-promo），官网素材来自 website/assets。
//   ?preview       显示进度条，可以拖动、播放
//   ?t=12.5        打开时停在这一秒

import { clamp, lerp, seg, E, spring, monotone, el, css, chars, revealChars, fadeIn, fadeOut, startPreview } from './kit.js';

const W = 1920;
const H = 1080;
const BEAT = 0.6; // 100 BPM，场景长度按拍子算，配乐的重音落在转场上
const media = 'media/';
const site = 'site/';

const ICONS = {
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  code: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  pen: '<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.9a.5.5 0 0 1-.6-.6l.9-2.9a2 2 0 0 1 .5-.9z"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  sparkles:
    '<path d="M9.94 14.06A2 2 0 0 0 8.5 12.6l-5.14-1.33a.5.5 0 0 1 0-.96L8.5 8.98a2 2 0 0 0 1.44-1.44l1.33-5.14a.5.5 0 0 1 .96 0l1.33 5.14a2 2 0 0 0 1.44 1.44l5.14 1.33a.5.5 0 0 1 0 .96l-5.14 1.33a2 2 0 0 0-1.44 1.44l-1.33 5.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;

// ---------- 录屏片段 ----------
class Clip {
  constructor(m) {
    this.name = m.name;
    this.slow = m.slow || 1;
    this.frames = m.frames;
    this.cur = m.cursor;
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
  // The two frames around `ms` and how far between them.
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
    // Fade out after 1.6 s without moving, back in just before the next move.
    const s = this.slow;
    let shown = 1 - clamp((ms - p.moved - 1600 * s) / (350 * s));
    if (q && q.moved === q.t) shown = Math.max(shown, 1 - clamp((q.t - ms) / (250 * s)));
    if (p.down) shown = 1;
    return { x, y, kind: p.kind, down: p.down, since: ms - press, at: press, shown };
  }
}

// Scene time → clip time. `segments` are [clip seconds, speed] pairs: play up to that
// point at that speed (1 = the speed the action really had). The curve through the
// joins is smoothed so speed changes ramp instead of jumping. `fit` stretches the whole
// thing to a given length.
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
    console.log(`${clip.name}: 实际 ${tau.toFixed(2)} 秒，压到 ${fit.toFixed(2)} 秒（×${(tau / fit).toFixed(2)}）`);
    for (const k of knots) k[0] *= fit / tau;
    tau = fit;
  }
  const f = monotone(knots);
  const map = (t) => f(clamp(t, 0, tau));
  map.duration = tau;
  // Scene time at which the clip reaches `s` seconds.
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

// ---------- 光标（画在窗口坐标里，跟着镜头缩放） ----------
const CURSORS = {
  arrow: `<g transform="scale(1.3)"><path d="M1 1 L1 18.5 L5.4 14.4 L8.3 21.2 L11.4 19.9 L8.6 13.3 L14.6 13.3 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></g>`,
  ibeam: `<g transform="scale(1.25)" fill="none" stroke-linecap="round"><path d="M-4 -10 Q0 -10 0 -7 L0 7 Q0 10 -4 10 M4 -10 Q0 -10 0 -7 M0 7 Q0 10 4 10 M-2.5 0 H2.5" stroke="#fff" stroke-width="4"/><path d="M-4 -10 Q0 -10 0 -7 L0 7 Q0 10 -4 10 M4 -10 Q0 -10 0 -7 M0 7 Q0 10 4 10 M-2.5 0 H2.5" stroke="#111" stroke-width="1.6"/></g>`,
  cross: `<g fill="none" stroke-linecap="round"><path d="M0 -11 V11 M-11 0 H11" stroke="#fff" stroke-width="4"/><path d="M0 -11 V11 M-11 0 H11" stroke="#111" stroke-width="1.6"/></g>`,
  pen: (ink) =>
    `<g transform="translate(-16 -16)" fill="none" stroke-linecap="round"><circle cx="16" cy="16" r="10" stroke="white" stroke-width="3.5" stroke-dasharray="12 3.708" stroke-dashoffset="-1.854"/><circle cx="16" cy="16" r="10" stroke="${ink}" stroke-width="1.8" stroke-dasharray="12 3.708" stroke-dashoffset="-1.854"/><path d="M16 2.5v5M16 24.5v5M2.5 16h5M24.5 16h5" stroke="white" stroke-width="3.8"/><path d="M16 2.5v5M16 24.5v5M2.5 16h5M24.5 16h5" stroke="#20262e" stroke-width="2"/><circle cx="16" cy="16" r="2.5" fill="${ink}" stroke="white" stroke-width=".7"/></g>`,
};

// What follows the pointer while a file is dragged out of the tree.
const DRAG = `<g transform="translate(16 22)" opacity=".92"><rect width="236" height="34" rx="8" fill="#fff" stroke="rgba(22,44,38,.18)"/><path transform="translate(9 7) scale(.85)" d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z M14 2v4a2 2 0 0 0 2 2h4" fill="none" stroke="#d93b4b" stroke-width="1.8"/><text x="34" y="22" font-size="13" font-family="-apple-system, PingFang SC" fill="#1b211e">Attention Is All You Need.pdf</text></g>`;

// A window-shaped card that plays a clip or shows a still, with a camera inside it.
class Screen {
  constructor(parent) {
    this.el = el('div', 'screen', parent);
    this.world = el('div', 'world', this.el);
    this.a = el('img', '', this.world);
    this.b = el('img', '', this.world);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 1600 1000');
    this.svg.setAttribute('width', 1600);
    this.svg.setAttribute('height', 1000);
    this.world.append(this.svg);
    this.svg.innerHTML = `
      <g class="lights"><circle cx="25" cy="24" r="6" fill="#ff5f57" stroke="#e2463f" stroke-width=".6"/><circle cx="45" cy="24" r="6" fill="#febc2e" stroke="#e1a116" stroke-width=".6"/><circle cx="65" cy="24" r="6" fill="#28c840" stroke="#1aab29" stroke-width=".6"/></g>
      <g class="extra"></g>
      <circle class="ripple" r="0" fill="rgba(46,125,111,.22)" stroke="rgba(46,125,111,.65)" stroke-width="2"/>
      <g class="cursor"></g>`;
    this.extra = this.svg.querySelector('.extra');
    this.ripple = this.svg.querySelector('.ripple');
    this.cursor = this.svg.querySelector('.cursor');
    this.kind = null;
  }
  // Card position on the stage: top-left (x, y), width w (height follows 16:10).
  place(x, y, w, transform = '') {
    const h = w / 1.6;
    this.w = w;
    css(this.el, {
      width: w + 'px',
      height: h + 'px',
      transform: `translate(${x}px, ${y}px) ${transform}`,
      borderRadius: Math.max(6, (17 * w) / 1600) + 'px',
    });
  }
  // Camera: world point (cx, cy) at the card's center, zoomed z times.
  look({ cx = 800, cy = 500, z = 1 } = {}) {
    if (z >= 1) {
      cx = clamp(cx, 800 / z, 1600 - 800 / z);
      cy = clamp(cy, 500 / z, 1000 - 500 / z);
    }
    const s = (this.w / 1600) * z;
    const tx = this.w / 2 - cx * s;
    const ty = this.w / 1.6 / 2 - cy * s;
    this.world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
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
    // Blend only around the middle of the gap: moving text ghosts less.
    this.b.style.opacity = E.inOut(clamp((k - 0.15) / 0.7));
    this.b.style.display = b === a ? 'none' : '';
    await Promise.all(jobs);
  }
  async play(clip, ms) {
    const f = clip.frame(ms);
    await this.show(f.a, f.b, f.k);
    this.point(clip.pointer(ms), clip);
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
      this.cursor.innerHTML =
        name === 'pen' ? CURSORS.pen(ink) : name === 'grab' ? CURSORS.arrow + DRAG : CURSORS[name] || CURSORS.arrow;
    }
    // A pressed cursor dips a little, like a real click.
    const press = clip ? clamp(1 - Math.abs(p.since) / (220 * clip.slow)) : 0;
    this.cursor.setAttribute(
      'transform',
      `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${1 - 0.12 * press})`,
    );
    const age = clip ? p.since / (520 * clip.slow) : 2;
    if (age >= 0 && age < 1 && !p.kind.startsWith('pen')) {
      const k = E.out(age);
      this.ripple.setAttribute('cx', clip.pointer(p.at).x);
      this.ripple.setAttribute('cy', clip.pointer(p.at).y);
      this.ripple.setAttribute('r', 6 + 26 * k);
      this.ripple.style.opacity = 1 - age;
    } else this.ripple.setAttribute('r', 0);
  }
}

// Camera moves given in clip seconds, eased in scene time.
function camera(map, init, moves) {
  const ms = moves.map(([a, b, to, ease = E.inOut]) => [map.at(a), map.at(b), to, ease]);
  return (t) => {
    let c = { cx: 800, cy: 500, z: 1, ...init };
    for (const [a, b, to, ease] of ms) {
      if (t <= a) break;
      const k = ease(seg(t, a, b));
      c = {
        cx: lerp(c.cx, to.cx ?? c.cx, k),
        cy: lerp(c.cy, to.cy ?? c.cy, k),
        z: Math.exp(lerp(Math.log(c.z), Math.log(to.z ?? c.z), k)),
      };
    }
    return c;
  };
}

// ---------- 舞台 ----------
const stage = document.getElementById('stage');
const scenesEl = document.getElementById('scenes');
const bg = {
  dark: stage.querySelector('.bg-dark'),
  b1: stage.querySelector('.b1'),
  b2: stage.querySelector('.b2'),
  b3: stage.querySelector('.b3'),
  grain: stage.querySelector('.grain'),
};
const scenes = [];
let darkTrack = () => 0;
// Moments the soundtrack lines up with: clicks in the recordings, transitions, theme switches.
const EVENTS = { clicks: [], whooshes: [], impacts: [], swells: [], themes: [] };

function scene(id, t0, dur, build, { pre = 0, post = 0, dark = false } = {}) {
  const root = el('section', 'scene' + (dark ? ' dark' : ''), scenesEl);
  root.id = id;
  const s = { id, t0, t1: t0 + dur, dur, pre, post, root };
  Object.assign(s, build(root, s));
  scenes.push(s);
  return s;
}

// Demo layout: the card nearly fills the frame.
const CARD = { x: 160, y: 40, w: 1600 };

// Caption block over the card. `pos`: tl / bl / tr / br.
function caption(parent, { eyebrow, headline, sub, pos = 'bl', width }) {
  const c = el('div', 'caption', parent);
  const left = pos.endsWith('l');
  const top = pos.startsWith('t');
  css(c, {
    [left ? 'left' : 'right']: '96px',
    [top ? 'top' : 'bottom']: top ? '96px' : '84px',
    textAlign: left ? 'left' : 'right',
  });
  if (width) c.style.width = width + 'px';
  const e = eyebrow ? el('div', 'eyebrow', c, eyebrow) : null;
  const h = chars(c, 'headline', headline);
  const s = sub ? el('div', 'sub', c, sub) : null;
  return {
    el: c,
    render(t, t0, t1) {
      const kIn = E.outQuint(seg(t, t0, t0 + 0.7));
      c.style.opacity = kIn;
      c.style.transform = `translateY(${(1 - kIn) * 40}px) scale(${lerp(0.96, 1, kIn)})`;
      c.style.filter = kIn < 0.999 ? `blur(${(1 - kIn) * 10}px)` : 'none';
      if (e) fadeIn(e, E.out(seg(t, t0 + 0.15, t0 + 0.7)), { dy: 10, blur: 4 });
      revealChars(h, t, t0 + 0.2, { stagger: 0.03, dur: 0.8 });
      if (s) fadeIn(s, E.out(seg(t, t0 + 0.55, t0 + 1.2)), { dy: 12, blur: 6 });
      if (t1 != null && t > t1) {
        const k = E.inOut(seg(t, t1, t1 + 0.45));
        c.style.opacity = 1 - k;
        c.style.transform = `translateY(${k * 30}px) scale(${lerp(1, 0.97, k)})`;
        c.style.filter = `blur(${k * 8}px)`;
      }
    },
  };
}

// Transitions of the card between demo scenes.
const swap = {
  // Card slides in from the right with a slight turn; out to the left.
  in(t, d = 0.9) {
    const k = E.inOutQuint(seg(t, -d / 2, d / 2));
    return {
      x: lerp(1500, 0, k),
      ry: lerp(-14, 0, k),
      s: lerp(0.86, 1, Math.min(1, k * 1.15)),
      o: clamp(k * 3),
    };
  },
  out(t, d = 0.9) {
    const k = E.inOutQuint(seg(t, -d / 2, d / 2));
    return { x: lerp(0, -1500, k), ry: lerp(0, 14, k), s: lerp(1, 0.86, k), o: clamp((1 - k) * 3) };
  },
};
function rig(s) {
  return `translateX(${s.x}px) rotateY(${s.ry}deg) scale(${s.s})`;
}

// A demo scene: card + clip + camera + caption.
function demo(id, t0, dur, clip, opts) {
  return scene(
    id,
    t0,
    dur,
    (root) => {
      const holder = el('div', 'abs', root);
      css(holder, { inset: 0, transformStyle: 'preserve-3d' });
      const screen = new Screen(holder);
      const lead = opts.lead ?? 0;
      const map = playback(clip, opts.from ?? 0.3, opts.play, dur - lead - (opts.tail ?? 0));
      const shift = (t) => t - lead;
      const cam = camera(
        { at: (s) => map.at(s) + lead },
        opts.cam0 || {},
        opts.cam || [],
      );
      const cap = opts.caption ? caption(holder, opts.caption) : null;
      clip.cur.forEach((c, i) => {
        if (i && c.down && !clip.cur[i - 1].down && !c.kind.startsWith('pen')) {
          const at = map.at(c.t / 1000) + lead;
          if (at > 0.05 && at < dur - 0.05) EVENTS.clicks.push(t0 + at);
        }
      });
      if (opts.enter === 'swap') EVENTS.whooshes.push(t0);
      if (opts.enter === 'rise') EVENTS.swells.push(t0);
      return {
        async render(t) {
          let tr = { x: 0, ry: 0, s: 1, o: 1 };
          if (opts.enter === 'swap') tr = swap.in(t);
          if (opts.exit === 'swap' && t > dur - 0.6) tr = swap.out(t - dur);
          holder.style.transform = rig(tr);
          holder.style.opacity = tr.o;
          if (opts.enter === 'rise') {
            const k = E.outQuint(seg(t, -0.4, 0.8));
            holder.style.transform = `translateY(${(1 - k) * 700}px) rotateX(${(1 - k) * 18}deg) scale(${lerp(0.9, 1, k)})`;
            holder.style.opacity = clamp(k * 2);
          }
          if (opts.exit === 'fade' && t > dur - 0.5) {
            const k = E.inOut(seg(t, dur - 0.5, dur + 0.3));
            holder.style.opacity = 1 - k;
            holder.style.transform += ` scale(${lerp(1, 0.94, k)})`;
          }
          screen.place(CARD.x, CARD.y, CARD.w);
          screen.look(cam(t));
          await screen.play(clip, map(shift(t)));
          const capOut = opts.capOut?.clip != null ? map.at(opts.capOut.clip) + lead : opts.capOut;
          cap?.render(t, opts.capAt ?? 0.15, capOut ?? dur - 0.5);
          opts.extra?.(t, screen, map(shift(t)));
        },
      };
    },
    { pre: opts.enter ? 0.6 : 0, post: opts.exit ? 0.6 : 0, dark: opts.dark },
  );
}

// ---------- 载入素材，搭场景 ----------
async function build() {
  const names = [
    'split',
    'pdf',
    'ask',
    'highlights',
    'translate',
    'board',
    'source',
    'annotate',
    'companion',
  ];
  const clips = {};
  await Promise.all(
    names.map(async (n) => {
      clips[n] = new Clip(await (await fetch(`${media}clips/${n}/meta.json`)).json());
    }),
  );

  let t = 0;
  const next = (beats) => {
    const at = t;
    t += beats * BEAT;
    return [at, beats * BEAT];
  };

  // ===== 1. 片头：图标展开，页间 Folio =====
  scene('intro', ...next(8), (root) => {
    const box = el('div', 'abs', root);
    css(box, { left: 0, top: 0, width: W + 'px', height: H + 'px' });
    const logo = el(
      'div',
      'abs',
      box,
      `<svg viewBox="0 0 1024 1024" width="260" height="260">
        <defs><linearGradient id="ig" x2="1" y2="1"><stop stop-color="#438e7f"/><stop offset="1" stop-color="#24695f"/></linearGradient>
        <linearGradient id="ip" x2="0" y2="1"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#dfebe1"/></linearGradient></defs>
        <g class="sq"><rect x="72" y="72" width="880" height="880" rx="205" fill="url(#ig)"/></g>
        <g class="pg"><path d="M260 295c94-17 167 5 252 55 85-50 158-72 252-55v420c-91-22-173-7-252 37-79-44-161-59-252-37z" fill="url(#ip)"/></g>
        <path class="sp" d="M512 355v391" fill="none" stroke="#98b5a7" stroke-width="11" pathLength="1" stroke-dasharray="1 1"/>
        <path class="ln" d="M323 414c42-1 87 11 131 32m-131 55c42-1 87 11 131 32m-131 55c42-1 87 11 108 21" fill="none" stroke="#8eb1a3" stroke-width="13" stroke-linecap="round" pathLength="1" stroke-dasharray="1 1"/>
        <g class="bm"><path d="M607 366v187l40-25 40 25V342" fill="#e2bb63"/></g>
      </svg>`,
    );
    css(logo, { left: W / 2 - 130 + 'px', top: '250px', width: '260px', height: '260px' });
    const svg = logo.querySelector('svg');
    const sq = svg.querySelector('.sq');
    const pg = svg.querySelector('.pg');
    const sp = svg.querySelector('.sp');
    const ln = svg.querySelector('.ln');
    const bm = svg.querySelector('.bm');
    const glow = el('div', 'abs', box);
    css(glow, {
      left: W / 2 - 260 + 'px',
      top: '120px',
      width: '520px',
      height: '520px',
      borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(67,142,127,.28), transparent 65%)',
    });
    const title = el('div', 'abs', box);
    css(title, {
      left: 0,
      right: 0,
      top: '560px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'baseline',
      gap: '28px',
    });
    const zh = chars(title, 'headline', '页间', { fontSize: '120px', letterSpacing: '.12em' });
    const en = chars(title, '', 'Folio', {
      font: 'italic 400 76px var(--latin)',
      color: 'var(--teal-deep)',
    });
    const tag = chars(box, 'abs sub', '读得进，也读得懂。', {
      left: 0,
      right: 0,
      top: '742px',
      textAlign: 'center',
      fontSize: '40px',
      letterSpacing: '.3em',
      color: 'var(--ink-2)',
    });
    return {
      render(t) {
        const k = spring(t - 0.25, 1.4, 0.55);
        css(sq, {
          transformOrigin: '512px 512px',
          transform: `scale(${0.3 + 0.7 * k}) rotate(${(1 - k) * -14}deg)`,
          opacity: clamp(k * 3),
        });
        const p = E.outQuint(seg(t, 0.55, 1.35));
        css(pg, {
          transformOrigin: '512px 520px',
          transform: `scale(${lerp(0.2, 1, p)}, ${lerp(0.6, 1, p)})`,
          opacity: p,
        });
        sp.style.strokeDashoffset = 1 - E.out(seg(t, 0.8, 1.3));
        ln.style.strokeDashoffset = 1 - E.inOut(seg(t, 1.0, 1.75));
        const b = spring(t - 1.35, 2.2, 0.42);
        css(bm, { transform: `translateY(${(1 - b) * -150}px)`, opacity: clamp(b * 4) });
        glow.style.opacity = E.out(seg(t, 0.4, 1.6)) * 0.9;
        glow.style.transform = `scale(${lerp(0.6, 1.1, E.out(seg(t, 0.3, 2.5)))})`;
        revealChars(zh, t, 1.5, { stagger: 0.12, dur: 1.0, dy: 0.35, blur: 18 });
        revealChars(en, t, 1.8, { stagger: 0.05, dur: 0.9, dy: 0.3 });
        revealChars(tag, t, 2.5, { stagger: 0.06, dur: 0.9, dy: 0.4 });
        // Push back and out of focus as the next scene comes in.
        const out = E.inOut(seg(t, 4.0, 4.9));
        box.style.opacity = 1 - out;
        box.style.transform = `scale(${lerp(1, 1.12, E.in(seg(t, 3.6, 4.9)))}) translateY(${-out * 40}px)`;
        box.style.filter = out > 0 ? `blur(${out * 14}px)` : 'none';
        const drift = E.inOut(seg(t, 0, 4.8));
        logo.style.transform = `translateY(${lerp(10, -6, drift)}px)`;
      },
    };
  }, { post: 0.6 });

  // ===== 2. 打开文件夹，就能读 =====
  scene('folder', ...next(8), (root) => {
    const box = el('div', 'abs', root);
    css(box, { inset: 0 });
    const head = chars(box, 'abs headline', '打开文件夹，就能读。', {
      left: 0,
      right: 0,
      top: '640px',
      textAlign: 'center',
      fontSize: '92px',
    });
    const sub = el('div', 'abs sub', box, 'HTML 与 PDF · 都在你自己的电脑里');
    css(sub, { left: 0, right: 0, top: '790px', textAlign: 'center', fontSize: '34px' });
    const tile = (label, color, ic, x) => {
      const e = el(
        'div',
        'abs',
        box,
        `<div class="ti"><svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[ic]}</svg></div><div class="tl">${label}</div>`,
      );
      css(e, {
        left: x - 120 + 'px',
        top: '250px',
        width: '240px',
        textAlign: 'center',
      });
      css(e.querySelector('.ti'), {
        width: '200px',
        height: '200px',
        margin: '0 auto',
        borderRadius: '44px',
        background: '#fffdf8',
        display: 'grid',
        placeItems: 'center',
        boxShadow: '0 0 0 1px rgba(22,44,38,.08), 0 24px 50px -20px rgba(22,52,44,.4)',
      });
      css(e.querySelector('svg'), { width: '108px', height: '108px' });
      css(e.querySelector('.tl'), {
        marginTop: '22px',
        font: '500 28px var(--sans)',
        color: 'var(--ink-2)',
        whiteSpace: 'nowrap',
      });
      return e;
    };
    const folder = tile('论文精读', '#c9962f', 'folder', W / 2);
    const pdf = tile('Attention.pdf', '#d93b4b', 'file', W / 2);
    const html = tile('伴读笔记.html', '#2864d7', 'code', W / 2);
    folder.querySelector('svg').setAttribute('fill', 'rgba(226,187,99,.35)');
    return {
      render(t) {
        // Folder drops in, then the two files spring out of it to either side.
        const f = spring(t - 0.05, 1.6, 0.55);
        css(folder, {
          opacity: clamp(f * 3),
          transform: `translateY(${(1 - f) * 120}px) scale(${lerp(0.6, 1, f)})`,
          zIndex: 2,
        });
        for (const [e, dir, d] of [
          [pdf, -1, 0.55],
          [html, 1, 0.7],
        ]) {
          const k = spring(t - d, 1.5, 0.6);
          const out = E.outBack(seg(t, d, d + 0.6));
          css(e, {
            opacity: clamp(k * 4),
            transform: `translate(${dir * 330 * k}px, ${-30 * Math.sin(Math.PI * clamp(out))}px) rotate(${dir * (1 - k) * -18 + dir * 4 * k}deg) scale(${lerp(0.5, 1, k)})`,
          });
        }
        revealChars(head, t, 1.1, { stagger: 0.05, dur: 0.9 });
        fadeIn(sub, E.out(seg(t, 1.8, 2.6)), { dy: 16, blur: 8 });
        // Hand over to the window: everything lifts away.
        const out = E.inOut(seg(t, 4.0, 4.8));
        box.style.opacity = 1 - out;
        box.style.transform = `translateY(${-out * 160}px) scale(${lerp(1, 0.92, out)})`;
        box.style.filter = out > 0 ? `blur(${out * 10}px)` : 'none';
      },
    };
  }, { pre: 0.6, post: 0.8 });

  // ===== 3. 窗口升起 + 卖点 =====
  // 和下一段批注录屏的第一帧一样，升起之后无缝接上
  const cleanNote = clips.annotate.url(0);
  scene('reveal', ...next(8), (root) => {
    const holder = el('div', 'abs', root);
    css(holder, { inset: 0, transformStyle: 'preserve-3d' });
    const screen = new Screen(holder);
    screen.point(null);
    const pills = [
      ['shield', '文件留在本地', '不上传，不同步', 70, 300],
      ['file', '原文一字不动', '批注另存在旁边', 1390, 210],
      ['user', '无需注册', '打开就能用', 1480, 720],
      ['key', 'AI 由你来选', '自带 Key，也能本机跑', 40, 760],
    ].map(([ic, a, b, x, y]) => {
      const p = el('div', 'pill', holder, `<i>${icon(ic)}</i><span>${a}</span><small>${b}</small>`);
      css(p, { left: x + 'px', top: y + 'px' });
      return p;
    });
    return {
      async render(t) {
        const k = E.outQuint(seg(t, -0.8, 1.2));
        const tilt = (1 - E.inOut(seg(t, -0.8, 1.6))) * 28;
        holder.style.transform = `translateY(${(1 - k) * 760}px) rotateX(${tilt}deg) scale(${lerp(0.84, 1, k)})`;
        holder.style.opacity = clamp(k * 2.5);
        // Window floats a little smaller while the selling points are shown.
        const shrink = E.inOut(seg(t, 0.6, 1.6)) - E.inOut(seg(t, 3.7, 4.7));
        const w = lerp(1600, 1360, shrink);
        screen.place((W - w) / 2, (H - w / 1.6) / 2 + lerp(0, 10, shrink), w);
        screen.look({ z: 1 });
        await screen.show(cleanNote);
        pills.forEach((p, i) => {
          const a = 1.3 + i * 0.28;
          const s = spring(t - a, 1.8, 0.55);
          const o = E.inOut(seg(t, 3.5 + i * 0.06, 4.0 + i * 0.06));
          const fx = Math.sin(t * 1.3 + i * 2) * 6;
          const fy = Math.cos(t * 1.1 + i) * 8;
          p.style.opacity = clamp(s * 3) * (1 - o);
          p.style.transform = `translate(${fx}px, ${fy + (1 - s) * 40}px) scale(${lerp(0.7, 1, s) - o * 0.1})`;
          p.style.filter = o > 0 ? `blur(${o * 8}px)` : 'none';
        });
      },
    };
  }, { pre: 1.0 });

  // ===== 4. 批注 =====
  demo('annotate', ...next(16), clips.annotate, {
    play: [
      [6.0, 3],
      [8.4, 1.4],
      [12.8, 3.5],
      [15.2, 1.4],
      [21.6, 4],
      [23.5, 1.4],
      [25.7, 3],
      [27.3, 1.4],
      [33.9, 4.5],
      [40.3, 2.5],
      [44.4, 4.5],
      [46.0, 1.4],
      [51.0, 3],
    ],
    cam: [
      [0.4, 3.6, { cx: 880, cy: 500, z: 1.2 }],
      [33.0, 34.4, { cx: 1300, cy: 760, z: 1.8 }],
      [40.2, 41.6, { cx: 880, cy: 500, z: 1.2 }],
      [46.5, 50.5, { cx: 800, cy: 500, z: 1 }],
    ],
    caption: {
      eyebrow: '阅读 · 批注',
      headline: '随手标，想法就写在原文旁。',
      sub: '高亮 · 划线 · 手绘 · 便签，原文一字不动',
      pos: 'tr',
    },
    capAt: 0.4,
    capOut: { clip: 46.5 },
    exit: 'swap',
  });

  // ===== 5. PDF =====
  demo('pdf', ...next(8), clips.pdf, {
    play: [
      [2.4, 3],
      [4.8, 1.5],
      [8.6, 2.5],
      [9.6, 1.5],
      [15.1, 4],
      [17.0, 1.4],
      [22.9, 3],
    ],
    cam0: { cx: 800, cy: 500, z: 1 },
    cam: [
      [0.4, 2.6, { cx: 900, cy: 760, z: 1.55 }],
      [17.2, 22, { cx: 860, cy: 700, z: 1.3 }],
    ],
    caption: { eyebrow: 'PDF', headline: 'PDF 也一样能批注。', pos: 'tl' },
    enter: 'swap',
    exit: 'swap',
  });

  // ===== 6. 双栏 =====
  demo('split', ...next(8), clips.split, {
    play: [
      [2.8, 3],
      [6.35, 1.3],
      [6.55, 0.4],
      [10.0, 1.6],
      [29.0, 4.5],
    ],
    cam0: { cx: 800, cy: 500, z: 1 },
    cam: [[6.6, 12, { cx: 800, cy: 520, z: 1.06 }]],
    caption: { eyebrow: '双栏阅读', headline: '拖进来，左右对照读。', pos: 'bl' },
    capAt: 0.5,
    enter: 'swap',
    exit: 'fade',
  });

  // ===== 7. AI 章节页 =====
  const aiAt = t;
  scene('ai', ...next(8), (root) => {
    const box = el('div', 'abs', root);
    css(box, { inset: 0 });
    const eb = el('div', 'abs eyebrow', box, 'AI 陪读');
    css(eb, { left: 0, right: 0, top: '330px', justifyContent: 'center', fontSize: '28px' });
    const head = chars(box, 'abs headline', '有 AI 陪你读，', {
      left: 0,
      right: 0,
      top: '390px',
      textAlign: 'center',
      fontSize: '104px',
    });
    const head2 = chars(box, 'abs headline', '它会指给你看原文。', {
      left: 0,
      right: 0,
      top: '525px',
      textAlign: 'center',
      fontSize: '104px',
    });
    const row = el('div', 'abs', box);
    css(row, { left: 0, top: '740px', display: 'flex', gap: '18px', whiteSpace: 'nowrap' });
    const names = [
      'DeepSeek',
      '通义千问',
      'Kimi',
      '智谱 GLM',
      '豆包',
      'Claude',
      'OpenAI',
      'Gemini',
      'OpenRouter',
      'Ollama',
      'LM Studio',
      'Codex',
    ];
    const chipsEls = [...names, ...names].map((n) => {
      const c = el('div', '', row, n);
      css(c, {
        padding: '14px 26px',
        borderRadius: '999px',
        font: '500 28px var(--sans)',
        color: 'rgba(243,239,228,.86)',
        background: 'rgba(255,255,255,.06)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.14)',
      });
      return c;
    });
    const spark = el('div', 'abs', box, icon('sparkles'));
    css(spark, { left: W / 2 - 34 + 'px', top: '220px', width: '68px', height: '68px', color: '#b9adff' });
    css(spark.querySelector('svg'), {
      width: '68px',
      height: '68px',
      fill: 'rgba(185,173,255,.25)',
      stroke: 'currentColor',
      strokeWidth: '1.4',
    });
    return {
      render(t) {
        const s = spring(t - 0.3, 1.6, 0.5);
        spark.style.opacity = clamp(s * 2);
        spark.style.transform = `scale(${lerp(0.3, 1, s)}) rotate(${(1 - s) * 90 + Math.sin(t * 2) * 6}deg)`;
        fadeIn(eb, E.out(seg(t, 0.5, 1.1)), { dy: 12, blur: 6 });
        revealChars(head, t, 0.6, { stagger: 0.05 });
        revealChars(head2, t, 1.1, { stagger: 0.05 });
        const r = E.out(seg(t, 1.6, 2.4));
        row.style.opacity = r;
        row.style.transform = `translateX(${-((t * 90) % 2000) - 120}px)`;
        chipsEls.forEach((c, i) => (c.style.opacity = clamp(r * 1.4 - (i % 12) * 0.03)));
        const out = E.inOut(seg(t, 4.1, 4.8));
        box.style.opacity = 1 - out;
        box.style.transform = `translateY(${-out * 120}px) scale(${lerp(1, 0.94, out)})`;
        box.style.filter = out > 0 ? `blur(${out * 10}px)` : 'none';
      },
    };
  }, { dark: true, post: 0.6 });

  // ===== 8. 问答 =====
  demo('ask', ...next(12), clips.ask, {
    lead: 0.3,
    play: [
      [3.4, 3.5],
      [3.6, 0.4],
      [7.2, 2.2],
      [12.8, 1.8],
      [18.2, 1.6],
      [22.4, 3.5],
      [27.9, 1.4],
    ],
    cam0: { cx: 800, cy: 500, z: 1 },
    cam: [
      [5.0, 7.2, { cx: 1180, cy: 640, z: 1.5 }],
      [12.6, 14.0, { cx: 1180, cy: 400, z: 1.5 }],
      [21.6, 23.2, { cx: 860, cy: 480, z: 1.12 }],
    ],
    caption: { eyebrow: '问这篇文档', headline: '回答带编号，点一下回到原文。', pos: 'tl' },
    capAt: 0.9,
    enter: 'rise',
    exit: 'swap',
    dark: true,
  });

  // ===== 9. AI 划重点 =====
  demo('highlights', ...next(7), clips.highlights, {
    play: [
      [5.9, 3.5],
      [17.0, 3],
      [22.6, 1.5],
    ],
    cam0: { cx: 800, cy: 500, z: 1 },
    cam: [[15.5, 18.0, { cx: 660, cy: 540, z: 1.25 }]],
    caption: { eyebrow: 'AI 划重点', headline: '核心观点、定义、数据，一键标出。', pos: 'tl' },
    enter: 'swap',
    dark: true,
  });

  // ===== 10. 划词翻译（接着同一页） =====
  demo('translate', ...next(7), clips.translate, {
    play: [
      [4.0, 4],
      [6.5, 1.5],
      [12.9, 3],
      [15.0, 1.4],
      [20.9, 2.5],
    ],
    cam0: { cx: 660, cy: 540, z: 1.25 },
    caption: { eyebrow: '划词翻译', headline: '选中一句，直接译成中文。', pos: 'tr' },
    exit: 'fade',
    dark: true,
  });

  // ===== 11. 白板 =====
  scene('boardTitle', ...next(6), (root) => {
    const box = el('div', 'abs', root);
    css(box, { inset: 0 });
    const eb = el('div', 'abs eyebrow', box, '白板讲解');
    css(eb, { left: 0, right: 0, top: '390px', justifyContent: 'center', fontSize: '28px' });
    const head = chars(box, 'abs headline', '没读懂？请页老师上白板。', {
      left: 0,
      right: 0,
      top: '450px',
      textAlign: 'center',
      fontSize: '96px',
    });
    const sub = el('div', 'abs sub', box, '边说边写边画，圈出没懂的地方，他换个说法重讲');
    css(sub, { left: 0, right: 0, top: '600px', textAlign: 'center', fontSize: '34px' });
    return {
      render(t) {
        fadeIn(eb, E.out(seg(t, 0.1, 0.7)), { dy: 12, blur: 6 });
        revealChars(head, t, 0.2, { stagger: 0.045 });
        fadeIn(sub, E.out(seg(t, 0.9, 1.6)), { dy: 14, blur: 8 });
        const out = E.inOut(seg(t, 2.9, 3.6));
        box.style.opacity = 1 - out;
        box.style.transform = `translateY(${-out * 140}px) scale(${lerp(1, 0.94, out)})`;
        box.style.filter = out > 0 ? `blur(${out * 10}px)` : 'none';
      },
    };
  }, { dark: true, post: 0.6 });
  demo('board', ...next(16), clips.board, {
    lead: 0.2,
    play: [
      [2.4, 3],
      [4.8, 1.5],
      [8.6, 4],
      [8.75, 0.35],
      [12.1, 4],
      [52.0, 4.0],
      [57.5, 4],
      [59.5, 1.3],
      [63.3, 4],
      [67.5, 2],
      [71.0, 3],
    ],
    cam0: { cx: 800, cy: 500, z: 1 },
    cam: [
      [10.5, 13.0, { cx: 800, cy: 470, z: 1.14 }],
      [53.0, 56.0, { cx: 760, cy: 560, z: 1.3 }],
      [62.5, 64.5, { cx: 800, cy: 560, z: 1.1 }],
    ],
    caption: { eyebrow: '白板讲解', headline: '一笔一笔，边写边讲。', pos: 'tr', width: 560 },
    capAt: 3.5,
    capOut: 8.2,
    enter: 'rise',
    exit: 'swap',
    dark: true,
  });

  // ===== 12. 源码 + AI 修改 =====
  demo('source', ...next(12), clips.source, {
    play: [
      [3.5, 3.5],
      [6.0, 2],
      [14.0, 4.5],
      [17.8, 2.4],
      [21.0, 3.5],
      [30.8, 6.5],
      [33.0, 1.6],
      [40.8, 6],
      [43.5, 1.6],
      [45.8, 3],
      [48.5, 1.6],
      [51.8, 3],
    ],
    cam0: { cx: 800, cy: 500, z: 1 },
    cam: [
      [8.0, 12.5, { cx: 700, cy: 330, z: 1.45 }],
      [30.0, 33.5, { cx: 900, cy: 480, z: 1.22 }],
    ],
    caption: { eyebrow: '源码 · AI 修改', headline: '说一句，改源码。', sub: '先看对比和预览，确认了才写入', pos: 'bl' },
    enter: 'swap',
    exit: 'swap',
    dark: true,
  });

  // ===== 13. 精读笔记 =====
  demo('companion', ...next(8), clips.companion, {
    play: [
      [4.4, 3.5],
      [8.6, 2.6],
      [14.65, 4],
      [14.82, 0.35],
      [15.5, 1.6],
      [18.8, 3],
      [22.5, 2],
      [30.6, 5],
    ],
    cam0: { cx: 800, cy: 500, z: 1 },
    cam: [[18.0, 21.0, { cx: 1180, cy: 520, z: 1.3 }]],
    caption: { eyebrow: '精读笔记', headline: '一键写一份精读笔记。', sub: '保存在原文旁边，并排打开', pos: 'bl' },
    enter: 'swap',
    exit: 'fade',
    dark: true,
  });
  const aiEnd = t;

  // ===== 14. 十套主题 =====
  const THEMES = [
    ['default', '青岚'],
    ['paper', '宣纸'],
    ['sky', '晴空'],
    ['blossom', '桃夭'],
    ['night', '夜读'],
    ['ink', '墨金'],
    ['brutal', '新粗野'],
    ['editorial', '报刊'],
    ['terminal', '终端'],
    ['aurora', '极光'],
  ];
  scene('themes', ...next(14), (root) => {
    const holder = el('div', 'abs', root);
    css(holder, { inset: 0 });
    const cards = THEMES.map(([id, name]) => {
      const c = el('div', 'screen', holder);
      const img = el('img', '', c);
      img.src = `${site}themes/${id}.webp`;
      css(img, { width: '100%', height: '100%', display: 'block' });
      const label = el('div', '', c, name);
      css(label, {
        position: 'absolute',
        left: '50%',
        bottom: '-62px',
        transform: 'translateX(-50%)',
        font: '600 26px var(--sans)',
        color: 'var(--ink-2)',
        whiteSpace: 'nowrap',
      });
      c.style.overflow = 'visible';
      img.style.borderRadius = 'inherit';
      return { c, img, label };
    });
    const cap = caption(holder, { eyebrow: '界面主题', headline: '十套主题，换一种心情读。', pos: 'tl' });
    // The palette button in the title bar, where each new theme spreads from.
    const origin = { x: 1561 / 1600, y: 23 / 1000 };
    const STEP = BEAT;
    const first = 1.2;
    const gridAt = first + STEP * 9 + 0.3;
    for (let i = 0; i < 9; i++) EVENTS.themes.push(t + first + i * STEP);
    EVENTS.whooshes.push(t + gridAt + 0.1);
    return {
      async render(t) {
        const enter = E.outQuint(seg(t, -0.6, 0.6));
        const toGrid = E.inOutQuint(seg(t, gridAt, gridAt + 1.1));
        const big = { x: CARD.x, y: CARD.y, w: CARD.w };
        cards.forEach(({ c, img, label }, i) => {
          // Grid cell: 5 × 2.
          const gw = 300;
          const gx = (W - (gw * 5 + 44 * 4)) / 2 + (i % 5) * (gw + 44);
          const gy = 300 + Math.floor(i / 5) * (gw / 1.6 + 110);
          const reveal = i === 0 ? 1 : E.outExpo(seg(t, first + (i - 1) * STEP, first + (i - 1) * STEP + 0.55));
          const stagger = E.inOutQuint(seg(t, gridAt + i * 0.03, gridAt + 1.0 + i * 0.03));
          const x = lerp(big.x, gx, stagger);
          const y = lerp(big.y, gy, stagger);
          const w = lerp(big.w, gw, stagger);
          css(c, {
            width: w + 'px',
            height: w / 1.6 + 'px',
            transform: `translate(${x}px, ${y + (1 - enter) * 600}px)`,
            borderRadius: Math.max(6, (17 * w) / 1600) + 'px',
            zIndex: i,
            opacity: clamp(enter * 2),
          });
          // Before the grid, each theme spreads as a circle from the palette button.
          const r = reveal * 2000;
          const clip = toGrid > 0.001 ? 'none' : `circle(${r}px at ${origin.x * w}px ${origin.y * (w / 1.6)}px)`;
          c.style.clipPath = clip;
          c.style.visibility = reveal > 0 || toGrid > 0 ? 'visible' : 'hidden';
          c.style.boxShadow = toGrid > 0.5 || i === 0 ? '' : 'none';
          label.style.opacity = E.out(seg(t, gridAt + 0.8 + i * 0.04, gridAt + 1.3 + i * 0.04));
        });
        cap.render(t, 0.3, gridAt - 0.2);
        const out = E.inOut(seg(t, 8.0, 8.8));
        holder.style.opacity = 1 - out;
        holder.style.transform = `scale(${lerp(1, 0.9, out)})`;
        holder.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
        await Promise.all(cards.map(({ img }) => img.decode().catch(() => {})));
      },
    };
  }, { pre: 0.6, post: 0.8 });

  // ===== 15. 片尾 =====
  scene('outro', ...next(12), (root) => {
    const box = el('div', 'abs', root);
    css(box, { inset: 0 });
    const logo = el('img', 'abs', box);
    logo.src = `${site}icon.svg`;
    css(logo, { left: W / 2 - 90 + 'px', top: '210px', width: '180px', height: '180px' });
    const title = el('div', 'abs', box);
    css(title, {
      left: 0,
      right: 0,
      top: '420px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'baseline',
      gap: '24px',
    });
    const zh = chars(title, 'headline', '页间', { fontSize: '108px', letterSpacing: '.12em' });
    const en = chars(title, '', 'Folio', {
      font: 'italic 400 68px var(--latin)',
      color: 'var(--teal-deep)',
    });
    const tag = chars(box, 'abs sub', '读得进，也读得懂。', {
      left: 0,
      right: 0,
      top: '585px',
      textAlign: 'center',
      fontSize: '38px',
      letterSpacing: '.3em',
    });
    const btn = el('div', 'abs', box, `${icon('download')}<span>免费下载</span><small>macOS · Windows</small>`);
    css(btn, {
      left: '50%',
      top: '700px',
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      padding: '22px 40px',
      borderRadius: '999px',
      background: 'linear-gradient(180deg, #2f8576, #24695f)',
      color: '#fff',
      font: '600 32px var(--sans)',
      boxShadow: '0 20px 44px -16px rgba(36,105,95,.7), inset 0 1px 0 rgba(255,255,255,.25)',
      whiteSpace: 'nowrap',
    });
    css(btn.querySelector('svg'), {
      width: '30px',
      height: '30px',
      fill: 'none',
      stroke: '#fff',
      strokeWidth: '2',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    });
    css(btn.querySelector('small'), { font: '400 26px var(--sans)', opacity: 0.8 });
    const url = el('div', 'abs', box, 'helloxxy.com/works/folio');
    css(url, {
      left: 0,
      right: 0,
      top: '832px',
      textAlign: 'center',
      font: '500 30px var(--sans)',
      letterSpacing: '.06em',
      color: 'var(--ink-3)',
    });
    return {
      render(t) {
        const s = spring(t - 0.1, 1.5, 0.5);
        logo.style.opacity = clamp(s * 2);
        logo.style.transform = `scale(${lerp(0.4, 1, s)}) rotate(${(1 - s) * -12}deg)`;
        revealChars(zh, t, 0.4, { stagger: 0.1 });
        revealChars(en, t, 0.65, { stagger: 0.05 });
        revealChars(tag, t, 1.1, { stagger: 0.06 });
        const b = spring(t - 1.8, 1.6, 0.55);
        btn.style.opacity = clamp(b * 2);
        btn.style.transform = `translateX(-50%) translateY(${(1 - b) * 30}px) scale(${lerp(0.85, 1, b)})`;
        fadeIn(url, E.out(seg(t, 2.3, 3.0)), { dy: 10, blur: 6 });
        const out = E.inOut(seg(t, 6.5, 7.2));
        box.style.opacity = 1 - out;
        box.style.filter = out > 0 ? `blur(${out * 8}px)` : 'none';
      },
    };
  });

  const total = t;
  const at = (id) => scenes.find((s) => s.id === id).t0;
  EVENTS.impacts.push(at('reveal'), at('ai'), at('outro'));
  EVENTS.swells.push(at('ai'), at('boardTitle'), at('themes'));
  EVENTS.scenes = scenes.map(({ id, t0, t1 }) => ({ id, t0, t1 }));
  EVENTS.duration = total;
  window.EVENTS = EVENTS;
  darkTrack = (x) =>
    E.inOut(seg(x, aiAt - 0.6, aiAt + 0.6)) * (1 - E.inOut(seg(x, aiEnd - 0.5, aiEnd + 0.5)));
  return total;
}

// ---------- 每帧 ----------
async function seek(t) {
  const d = darkTrack(t);
  bg.dark.style.opacity = d;
  bg.grain.style.mixBlendMode = d > 0.5 ? 'screen' : 'multiply';
  bg.grain.style.opacity = lerp(0.05, 0.035, d);
  css(bg.b1, {
    transform: `translate(${-120 + Math.sin(t * 0.21) * 120}px, ${-160 + Math.cos(t * 0.17) * 90}px)`,
    opacity: lerp(0.55, 0.22, d),
    background: d > 0.5 ? '#1f6f60' : '#b8d9cd',
  });
  css(bg.b2, {
    transform: `translate(${1380 + Math.cos(t * 0.19) * 110}px, ${560 + Math.sin(t * 0.23) * 80}px)`,
    opacity: lerp(0.5, 0.0, d),
  });
  css(bg.b3, {
    transform: `translate(${1300 + Math.sin(t * 0.15) * 140}px, ${-120 + Math.cos(t * 0.2) * 100}px)`,
    opacity: lerp(0.3, 0.45, d),
    background: d > 0.5 ? '#3d2f9c' : '#cfc7ff',
  });
  const jobs = [];
  for (const s of scenes) {
    const on = t >= s.t0 - s.pre && t < s.t1 + s.post;
    s.root.style.visibility = on ? 'visible' : 'hidden';
    if (on) jobs.push(s.render(t - s.t0, t));
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
