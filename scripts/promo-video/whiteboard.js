// 页间 · 白板讲解 · 手绘可爱版，竖屏 1080×1440（3:4），发小红书用。画风和 cute.js 一样，
// 全是 sketch.js 里的手绘 SVG：小页戴上眼镜当「页老师」，在白板上边写边讲。按 seek(t) 逐帧算出画面。
//   whiteboard.html?preview   拖动进度条看效果
//   whiteboard.html?t=12.5    打开时停在这一秒
import { clamp, lerp, seg, E, spring, startPreview } from './kit.js';
import {
  C,
  FONT,
  s,
  g,
  T,
  span,
  letters,
  popLetters,
  shape,
  stroke,
  wiper,
  place,
  rectD,
  ellipseD,
  lineD,
  polyD,
  starD,
  sparkleD,
  headD,
  Mascot,
  blinkAt,
  landing,
  hop,
  sheet,
  scribbles,
  sticky,
  slap,
  Bubble,
  tool,
  ripple,
  confetti,
  idle,
  popIn,
  follow,
  showTool,
  sparkles,
  twinkle,
} from './sketch.js';

const W = 1080;
const H = 1440;
const BAR = 2; // 120 BPM，一小节 2 秒
const TR = 0.8; // 转场长度
const scenesEl = document.getElementById('scenes');
const over = document.getElementById('over');
const turb = document.querySelector('#boil feTurbulence');
const EVENTS = {
  style: 'cute',
  quiet: [],
  melodic: [],
  boing: [],
  pop: [],
  slap: [],
  scribble: [],
  swish: [],
  sparkle: [],
  click: [],
  type: [],
  ding: [],
  themes: [],
};
const scenes = [];
let clock = 0;

function scene(id, bars, build, { enter = 'cut', at = [W / 2, H / 2], tint = C.paper } = {}) {
  const t0 = clock;
  const dur = bars * BAR;
  clock += dur;
  const root = document.createElement('div');
  root.className = 'scene';
  root.id = id;
  scenesEl.append(root);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  root.append(svg);
  const defs = s('defs', {}, svg);
  s('rect', { width: W, height: H, fill: tint }, svg);
  s('rect', { width: W, height: H, fill: 'url(#dots)' }, svg);
  const world = g(svg, { filter: 'url(#boil)' });
  const S = { id, t0, t1: t0 + dur, dur, enter, at, root, svg, defs, world };
  const sfx = (kind, x, d) => EVENTS[kind].push(d != null ? [t0 + x, d] : t0 + x);
  if (enter !== 'cut') sfx('swish', 0);
  Object.assign(S, build(S, sfx));
  scenes.push(S);
  return S;
}

// Big hand-lettered headline across the top.
const headline = (parent, str, { y = 175, size = 96, fill = C.ink } = {}) =>
  letters(parent, str, W / 2, y, { font: FONT.title, size, fill, anchor: 'middle' });
// Caption typed out as it is spoken; returns true while still typing.
function captions(el, list, u, rate = 0.045) {
  const c = list.filter(([a]) => u >= a).at(-1);
  if (!c) {
    el.textContent = '';
    return false;
  }
  const chars = [...c[1]];
  const n = Math.ceil(chars.length * clamp((u - c[0]) / Math.max(0.4, chars.length * rate)));
  el.textContent = chars.slice(0, n).join('');
  return n < chars.length;
}
// A small rounded pill with a label.
function pill(parent, str, { x = 0, y = 0, size = 26, fill = '#fff', color = C.ink, pad = 22, h = size * 1.7, seed = 1, font = FONT.hand, sw = 3.5 } = {}) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  const t = T(e, str, 0, size * 0.36, { size, fill: color, anchor: 'middle', font });
  const w = t.getComputedTextLength() + pad * 2;
  const sh = shape(e, rectD(-w / 2, -h / 2, w, h, h / 2, seed, 1), { fill, sw, off: [2, 3] });
  e.insertBefore(sh.g, t);
  e.w = w;
  return e;
}

// ---------- 小图标 ----------
const line = (parent, d, col = C.ink, sw = 4) =>
  s('path', { d, fill: 'none', stroke: col, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, parent);
function easelIcon(parent, x, y) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  s('rect', { x: -17, y: -14, width: 34, height: 23, rx: 4, fill: C.tealL, stroke: C.ink, 'stroke-width': 3.5 }, e);
  line(e, 'M0 9 L0 15 M-8 19 L0 13 L8 19', C.ink, 3.5);
  return e;
}
function speakerIcon(parent, x, y, { waves = 2, slash = false, col = C.ink } = {}) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  s('path', { d: 'M-20 -8 L-11 -8 L1 -19 L1 19 L-11 8 L-20 8 Z', fill: col, stroke: col, 'stroke-width': 3, 'stroke-linejoin': 'round' }, e);
  e.waves = [10, 20].slice(0, waves).map((r) => line(e, `M${6 + r * 0.3} ${-r} Q${10 + r} 0 ${6 + r * 0.3} ${r}`, col, 4));
  if (slash) line(e, 'M10 -12 L26 12 M26 -12 L10 12', C.red, 4.5);
  return e;
}
function micIcon(parent, x, y, col = C.ink) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  s('rect', { x: -9, y: -22, width: 18, height: 30, rx: 9, fill: col }, e);
  line(e, 'M-15 0 Q-15 16 0 16 Q15 16 15 0 M0 16 L0 24 M-8 24 L8 24', col, 3.5);
  return e;
}
function phoneIcon(parent, x, y, col = C.ink) {
  const e = g(parent, { transform: `translate(${x} ${y}) rotate(-20)` });
  s('path', { d: 'M-20 -14 Q-22 -22 -14 -24 L-6 -24 L-2 -12 L-8 -6 Q-4 6 6 10 L12 4 L24 8 L24 16 Q22 24 14 22 Q-16 14 -20 -14 Z', fill: col, stroke: col, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, e);
  return e;
}
function capIcon(parent, x, y) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  s('circle', { r: 27, fill: C.tealL, stroke: C.ink, 'stroke-width': 3.5 }, e);
  s('path', { d: 'M-11 -1 L-11 8 Q0 14 11 8 L11 -1', fill: C.ink }, e);
  s('path', { d: 'M-21 -6 L0 -15 L21 -6 L0 3 Z', fill: C.ink, stroke: C.ink, 'stroke-width': 2, 'stroke-linejoin': 'round' }, e);
  line(e, 'M15 -4 L15 9', C.gold, 3);
  return e;
}
function noteIcon(parent, x, y, col = C.violet) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  s('rect', { x: -10, y: -12, width: 20, height: 24, rx: 3, fill: 'none', stroke: col, 'stroke-width': 3 }, e);
  line(e, 'M-5 -4 L5 -4 M-5 3 L3 3', col, 2.5);
  return e;
}
function historyIcon(parent, x, y, col = C.ink) {
  const e = g(parent, { transform: `translate(${x} ${y})` });
  line(e, 'M-11 -7 A13 13 0 1 1 -12 4 M-14 -14 L-11 -7 L-4 -9 M0 -6 L0 1 L5 4', col, 3);
  return e;
}
// Little lamp that lights up over a head.
function bulb(parent) {
  const e = g(parent);
  s('path', { d: 'M0 -40 a32 32 0 1 1 1 0 q10 20 6 34 l-14 0 q-4 -14 7 -34z', fill: C.yellow, stroke: C.ink, 'stroke-width': 4.5, transform: 'translate(-1 0)' }, e);
  s('rect', { x: -12, y: -4, width: 24, height: 14, rx: 4, fill: '#ccc', stroke: C.ink, 'stroke-width': 4 }, e);
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.5;
    s('path', { d: lineD(Math.cos(a) * 52, -70 + Math.sin(a) * 52, Math.cos(a) * 72, -70 + Math.sin(a) * 72, i, 0.5), stroke: C.yellow, 'stroke-width': 6, 'stroke-linecap': 'round' }, e);
  }
  return e;
}

// ---------- 白板窗口 ----------
// The 「白板讲解」 window as drawn by hand: header, dotted board, caption bar at the bottom.
const BX = 50;
const BY = 250;
const BW = 980;
const BH = 940;
function boardWin(parent, seed = 300) {
  const box = g(parent);
  shape(box, rectD(BX, BY, BW, BH, 30, seed, 1.6), { fill: '#fffefa', sw: 5.5, off: [8, 10] });
  s('rect', { x: BX + 16, y: BY + 84, width: BW - 32, height: BH - 184, fill: 'url(#grid)' }, box);
  s('path', { d: lineD(BX + 4, BY + 76, BX + BW - 4, BY + 76, seed + 1, 1), stroke: C.ink, 'stroke-width': 4, fill: 'none' }, box);
  easelIcon(box, BX + 42, BY + 38);
  T(box, '白板讲解', BX + 72, BY + 50, { size: 32 });
  pill(box, '跟随聊天 ▾', { x: BX + 330, y: BY + 38, size: 24, fill: '#f4f1ea', seed: seed + 2, sw: 2.5 });
  const save = g(box, { transform: `translate(${BX + 660} ${BY + 38})` });
  const sp = pill(save, '    存入笔记', { size: 24, fill: C.violetL, color: '#6b52d6', seed: seed + 3, sw: 2.5 });
  noteIcon(sp, -sp.w / 2 + 30, 0, '#6b52d6');
  historyIcon(box, BX + 830, BY + 38);
  line(box, `M${BX + 876} ${BY + 38} L${BX + 896} ${BY + 38}`, C.ink, 3.5);
  line(box, `M${BX + 928} ${BY + 28} L${BX + 946} ${BY + 48} M${BX + 946} ${BY + 28} L${BX + 928} ${BY + 48}`, C.ink, 3.5);
  // caption bar
  s('path', { d: lineD(BX + 4, BY + BH - 92, BX + BW - 4, BY + BH - 92, seed + 4, 1), stroke: C.line, 'stroke-width': 4, fill: 'none' }, box);
  capIcon(box, BX + 52, BY + BH - 46);
  const cap = T(box, '', BX + 96, BY + BH - 34, { size: 34, fill: C.ink });
  const ctl = g(box, { transform: `translate(${BX + BW - 112} ${BY + BH - 46})` });
  s('circle', { r: 24, fill: '#fff', stroke: C.ink, 'stroke-width': 3.5 }, ctl);
  const pause = g(ctl);
  line(pause, 'M-6 -9 L-6 9 M6 -9 L6 9', C.ink, 5);
  const play = s('path', { d: 'M-6 -10 L10 0 L-6 10 Z', fill: C.ink, stroke: C.ink, 'stroke-width': 3, 'stroke-linejoin': 'round' }, ctl);
  T(ctl, '1×', 58, 10, { font: FONT.latin, size: 28, anchor: 'middle' });
  return {
    g: box,
    cap,
    save,
    paused(on) {
      pause.style.display = on ? 'none' : '';
      play.style.display = on ? '' : 'none';
    },
  };
}

// The lesson on the board: why attention divides by √dₖ, written and drawn one step at a time.
function lesson(parent, defs, seed = 320) {
  const ink = g(parent);
  const t1 = T(ink, '为什么要除以 √dₖ ？', 100, 420, { size: 58 });
  const t1w = wiper(defs, t1, 90, 350, t1.getComputedTextLength() + 30, 100);
  const f = T(ink, '', 130, 520, { font: FONT.latin, size: 50 });
  for (const [txt, dy, size] of [['softmax( QK', 0, 50], ['T', -22, 30], [' / √dₖ ) · V', 22, 50]])
    s('tspan', { dy, 'font-size': size }, f).textContent = txt;
  const fw = wiper(defs, f, 120, 450, f.getComputedTextLength() + 40, 100);
  const dk = span(f, '√dₖ');
  const ringDk = stroke(ink, ellipseD(dk.x0 + dk.w / 2, 528, dk.w / 2 + 22, 42, seed + 1, 2), { color: '#ff9a3c', sw: 7 });
  // the two charts can be wiped off later
  const charts = g(ink);
  const l1 = T(charts, '不缩放', 275, 630, { size: 40, anchor: 'middle' });
  const ax1 = stroke(charts, lineD(105, 830, 450, 830, seed + 2, 1.5), { sw: 6 });
  const redBars = [170, 14, 10, 8].map((h, i) =>
    s('path', { d: rectD(135 + i * 78, 830 - h, 50, h, 6, seed + 3 + i, 1), fill: '#ffb3b8', stroke: C.red, 'stroke-width': 5 }, charts),
  );
  const ringBar = stroke(charts, ellipseD(160, 745, 54, 112, seed + 8, 2), { color: C.red, sw: 6 });
  const note = g(charts);
  T(note, '全挤在', 232, 712, { size: 32, fill: C.red });
  T(note, '一个词上！', 232, 752, { size: 32, fill: C.red });
  const nw = wiper(defs, note, 225, 675, 180, 95);
  const arrow = stroke(charts, lineD(472, 740, 588, 740, seed + 9, 1.5), { color: '#ff9a3c', sw: 6 });
  const ah = s('path', { d: headD(588, 740, 0, 22), fill: 'none', stroke: '#ff9a3c', 'stroke-width': 6, 'stroke-linecap': 'round' }, charts);
  const aT = T(charts, '÷√dₖ', 530, 712, { font: FONT.latin, size: 30, fill: '#ff9a3c', anchor: 'middle' });
  const l2 = T(charts, '除以 √dₖ', 805, 630, { size: 40, anchor: 'middle' });
  const ax2 = stroke(charts, lineD(625, 830, 990, 830, seed + 10, 1.5), { sw: 6 });
  const blueBars = [120, 96, 74, 56].map((h, i) =>
    s('path', { d: rectD(650 + i * 80, 830 - h, 50, h, 6, seed + 11 + i, 1), fill: '#c9defc', stroke: C.blue, 'stroke-width': 5 }, charts),
  );
  // conclusion, boxed in green, part of it highlighted
  const band = g(ink);
  const concl = T(ink, 'softmax 不饱和，梯度不消失！', 100, 965, { size: 48 });
  const cl = concl.getComputedTextLength();
  const cw = wiper(defs, concl, 90, 900, cl + 30, 100);
  const box = stroke(ink, rectD(80, 905, cl + 44, 86, 14, seed + 16, 2.2), { color: '#3bb273', sw: 7 });
  const gd = span(concl, '梯度不消失');
  const mark = s('path', { d: rectD(gd.x0 - 6, 925, gd.w + 12, 52, 12, seed + 17, 1.5), fill: C.yellow, 'fill-opacity': 0.65 }, band);
  const mw = wiper(defs, mark, gd.x0 - 12, 915, gd.w + 24, 70);
  const sm = span(concl, 'softmax');
  const bars = (list, a, gap) =>
    list.forEach((b, i) => {
      const k = E.outBack(seg(lessonU, a + i * gap, a + i * gap + 0.3));
      b.setAttribute('transform', `translate(0 830) scale(1 ${Math.max(0, k)}) translate(0 -830)`);
      b.setAttribute('opacity', lessonU > a + i * gap ? 1 : 0);
    });
  let lessonU = 0;
  // When each thing is written, and what the pen follows meanwhile.
  const STEPS = [
    [0.5, 1.1, () => t1w.set(seg(lessonU, 0.5, 1.1)), () => [t1w.x + t1w.w * seg(lessonU, 0.5, 1.1), 405]],
    [1.2, 1.9, () => fw.set(seg(lessonU, 1.2, 1.9)), () => [fw.x + fw.w * seg(lessonU, 1.2, 1.9), 505]],
    [2.0, 2.4, () => ringDk.draw(seg(lessonU, 2.0, 2.4)), () => ringDk],
    [2.6, 2.85, () => ax1.draw(seg(lessonU, 2.6, 2.85)), () => ax1],
    [3.5, 3.9, () => ringBar.draw(seg(lessonU, 3.5, 3.9)), () => ringBar],
    [3.95, 4.35, () => nw.set(seg(lessonU, 3.95, 4.35)), () => [nw.x + nw.w * seg(lessonU, 3.95, 4.35), 730]],
    [4.5, 4.8, () => arrow.draw(seg(lessonU, 4.5, 4.8)), () => arrow],
    [4.8, 5.0, () => ax2.draw(seg(lessonU, 4.8, 5.0)), () => ax2],
    [6.0, 6.8, () => cw.set(seg(lessonU, 6.0, 6.8)), () => [cw.x + cw.w * seg(lessonU, 6.0, 6.8), 950]],
    [6.8, 7.2, () => box.draw(seg(lessonU, 6.8, 7.2)), () => box],
  ];
  const pen = tool(parent, 'marker');
  const hi = tool(parent, 'highlighter');
  return {
    charts,
    concl,
    sm,
    CAPS: [
      [0.5, '公式里，为什么要除以 √dₖ 呢？'],
      [2.6, '不缩放的话，分数差得太大～'],
      [3.5, '权重全挤到一个词上了！'],
      [4.5, '除以 √dₖ，分数就回到正常范围'],
      [6.0, '所以 softmax 不饱和，梯度不消失！'],
    ],
    // Board state at lesson time u (Infinity: everything written, no pens).
    render(u) {
      lessonU = u;
      for (const [, , set] of STEPS) set();
      l1.setAttribute('opacity', clamp((u - 2.6) * 5));
      l2.setAttribute('opacity', clamp((u - 4.8) * 5));
      bars(redBars, 2.85, 0.12);
      bars(blueBars, 5.0, 0.16);
      ah.setAttribute('opacity', u > 4.8 ? 1 : 0);
      aT.setAttribute('opacity', clamp((u - 4.6) * 4));
      mw.set(seg(u, 7.4, 7.8));
      const on = STEPS.find(([a, b]) => u >= a && u <= b);
      showTool(pen, !!on);
      if (on) {
        const v = on[3]();
        if (Array.isArray(v)) place(pen, v[0], v[1] + Math.sin(u * 46) * 7);
        else follow(pen, v, seg(u, on[0], on[1]));
      }
      showTool(hi, u > 7.35 && u < 7.85);
      if (u < 7.85) place(hi, lerp(gd.x0, gd.x1, seg(u, 7.4, 7.8)), 958 + Math.sin(u * 40) * 2);
    },
  };
}

// ====================================================================
async function build() {
  await Promise.all(
    [FONT.title, FONT.hand, FONT.latin, FONT.serif].map((f) => document.fonts.load(`40px ${f}`, '页间读得进AaBb12')),
  );

  // ===== 1. 论文读不懂？小页戴上眼镜，变成页老师 =====
  scene('hook', 2.5, (S, sfx) => {
    const w = S.world;
    const head1 = headline(w, '论文读不懂？', { y: 230, size: 140 });
    const head2 = headline(w, '请页老师上白板！', { y: 220, size: 110, fill: C.tealD });
    const sub = letters(w, 'AI 边写边讲，讲给你听～', W / 2, 330, { font: FONT.hand, size: 56, fill: C.ink2, anchor: 'middle' });
    const pg = g(w);
    const pin = g(pg);
    sheet(pin, { x: -340, y: -320, w: 680, h: 600, tag: 'PDF', seed: 11 });
    T(pin, 'Attention Is All You Need', 0, -220, { font: FONT.serif, size: 40, weight: 700, anchor: 'middle' });
    const pf = T(pin, '', 0, -130, { font: FONT.latin, size: 40, anchor: 'middle' });
    for (const [txt, dy, size] of [['softmax( QK', 0, 40], ['T', -18, 24], [' / √dₖ ) V', 18, 40]])
      s('tspan', { dy, 'font-size': size }, pf).textContent = txt;
    scribbles(pin, -280, -50, 560, 4, { gap: 38, seed: 12, color: '#cbc3b4', sw: 6 });
    scribbles(pin, -280, 130, 560, 3, { gap: 38, seed: 13, color: '#cbc3b4', sw: 6 });
    const qs = [
      [300, 1060, -14, 96],
      [780, 1030, 12, 110],
      [200, 1250, 8, 80],
      [880, 1230, -10, 88],
    ].map(([x, y, rot, size], i) => {
      const e = g(w);
      T(e, '?', 0, size * 0.35, { font: FONT.title, size, fill: [C.coral, C.violet, C.sky, C.pink][i], anchor: 'middle', stroke: C.ink, 'stroke-width': 3, 'paint-order': 'stroke' });
      return { e, x, y, rot, i };
    });
    const m = new Mascot(w);
    const glint = sparkles(w, [
      [420, 1190, 26],
      [680, 1150, 30, 'star'],
      [560, 1060, 20],
    ]);
    const dood = sparkles(w, [
      [130, 460, 28, 'star'],
      [960, 520, 24],
      [120, 1240, 22, 'heart'],
      [960, 1280, 26, 'star'],
    ], 2);
    sfx('pop', 0.1);
    sfx('swish', 0.35);
    sfx('boing', 0.75);
    qs.forEach(({ i }) => sfx('pop', 1.0 + i * 0.18));
    sfx('sparkle', 2.35);
    sfx('boing', 2.4);
    sfx('pop', 2.55);
    return {
      render(u) {
        popLetters(head1, u, 0.1, { stagger: 0.07, out: 2.2 });
        popLetters(head2, u, 2.45, { stagger: 0.05 });
        popLetters(sub, u, 2.9, { stagger: 0.035 });
        const p = spring(u - 0.35, 1.8, 0.55);
        place(pg, 540, lerp(1300, 760, clamp(p, 0, 1.1)), 1, lerp(12, -4, clamp(p)));
        pg.setAttribute('opacity', u > 0.3 ? 1 : 0);
        const L = landing(u - 0.75, 900, 0.5);
        const h = hop(u - 2.4, 120, 0.45);
        const dizzy = u < 2.35;
        m.set({
          x: 540,
          y: 1380,
          scale: 1.2,
          ...idle(u),
          lift: L.lift + h.lift,
          sq: L.sq + h.sq + Math.sin(u * 4.2) * 0.02,
          rot: dizzy && u > 0.9 ? Math.sin(u * 5) * 6 : 0,
          mood: dizzy ? (u > 0.9 ? 'dizzy' : 'wow') : 'happy',
          sweat: dizzy && u > 0.9,
          glasses: u > 2.35,
          raiseL: dizzy ? 20 : 150 * E.out(seg(u, 2.4, 2.6)),
          raiseR: dizzy ? 20 : 150 * E.out(seg(u, 2.4, 2.6)),
          opacity: u > 0.2 ? 1 : 0,
        });
        for (const { e, x, y, rot, i } of qs) {
          const t0 = 1.0 + i * 0.18;
          popIn(e, u, t0, { x, y: y + Math.sin(u * 3 + i) * 10, rot: rot + Math.sin(u * 2.5 + i) * 8, out: 2.25 });
        }
        twinkle(glint, u, 2.35, 3.2);
        twinkle(dood, u, 2.6);
      },
    };
  });

  // ===== 2. 选中一段点「白板」，或者框选公式 =====
  scene(
    'pick',
    3,
    (S, sfx) => {
      const w = S.world;
      const head1 = headline(w, '选中一段，点「白板」', { size: 88 });
      const head2 = headline(w, '公式、图表？框选它！', { size: 88 });
      const doc = g(w);
      sheet(doc, { x: 90, y: 270, w: 900, h: 830, tag: 'HTML', seed: 20 });
      T(doc, 'Attention 伴读笔记', 140, 370, { size: 46 });
      const sel = g(doc);
      const LINES = ['缩放点积注意力：', '分数先除以 √dₖ，再做 softmax，', '这样梯度才稳定。'];
      const texts = LINES.map((l, i) => T(doc, l, 140, 460 + i * 68, { size: 42 }));
      shape(doc, rectD(140, 690, 800, 140, 18, 21, 1.4), { fill: '#fffaf0', sw: 3.5, off: [0, 0] });
      const f = T(doc, '', 540, 778, { font: FONT.latin, size: 50, anchor: 'middle' });
      for (const [txt, dy, size] of [['softmax( QK', 0, 50], ['T', -22, 30], [' / √dₖ ) V', 22, 50]])
        s('tspan', { dy, 'font-size': size }, f).textContent = txt;
      scribbles(doc, 140, 900, 780, 4, { gap: 44, seed: 22 });
      // selection over lines 2 and 3
      const bands = [1, 2].map((i) => {
        const x1 = 140 + texts[i].getComputedTextLength();
        const y = 460 + i * 68;
        const b = s('path', { d: rectD(132, y - 42, x1 - 124, 56, 8, 23 + i, 1), fill: C.sky, 'fill-opacity': 0.4 }, sel);
        return { wipe: wiper(S.defs, b, 126, y - 48, x1 - 112, 68), x1, y };
      });
      const bar = g(w);
      shape(bar, rectD(-340, -38, 680, 76, 22, 25, 1.4), { fill: '#fff', sw: 4.5 });
      const BTN = ['高亮', '划线', '解释', '翻译', '提问', '白板'];
      BTN.forEach((b, i) => T(bar, b, -275 + i * 110, 12, { size: 34, anchor: 'middle', fill: b === '白板' ? C.tealD : C.ink }));
      const hot = g(bar, { transform: 'translate(275 0)' });
      shape(hot, rectD(-50, -26, 100, 52, 14, 26, 1), { fill: C.tealL, stroke: C.tealD, sw: 3.5, off: [0, 0] });
      hot.parentNode.insertBefore(hot, hot.parentNode.children[1]);
      // framing
      const frame = g(w);
      const fr = s('path', { fill: C.teal, 'fill-opacity': 0.12, stroke: C.tealD, 'stroke-width': 5, 'stroke-dasharray': '16 12', 'stroke-linecap': 'round' }, frame);
      const hint = pill(w, '拖动框选要讲解的公式、图表或段落 · Esc 取消', { size: 28, fill: C.ink, color: '#fff', seed: 27, sw: 0 });
      const cross = g(w);
      line(cross, 'M-20 0 L20 0 M0 -20 L0 20', C.ink, 4.5);
      const ptr = tool(w, 'pointer');
      const rip = ripple(w, C.teal);
      const m = new Mascot(w);
      const say = new Bubble(w, { x: 640, y: 1250, w: 320, h: 104, tail: [790, 1320], lines: ['交给我～'], size: 52, font: FONT.title });
      sfx('pop', 0.1);
      sfx('scribble', 0.5, 0.6);
      sfx('pop', 1.2);
      sfx('click', 2.0);
      sfx('ding', 2.1);
      sfx('pop', 2.35);
      sfx('scribble', 2.6, 0.8);
      sfx('click', 3.45);
      sfx('sparkle', 3.5);
      sfx('boing', 4.0);
      sfx('pop', 4.25);
      return {
        render(u) {
          popLetters(head1, u, 0.1, { stagger: 0.04, out: 2.2 });
          popLetters(head2, u, 2.35, { stagger: 0.04 });
          const fade = 1 - clamp((u - 2.2) * 4);
          bands[0].wipe.set(seg(u, 0.5, 0.8));
          bands[1].wipe.set(seg(u, 0.8, 1.1));
          sel.setAttribute('opacity', fade);
          popIn(bar, u, 1.2, { x: 560, y: 445, out: 2.2 });
          const press = u > 2.0 && u < 2.14 ? 0.86 : 1;
          hot.setAttribute('transform', `translate(275 0) scale(${press})`);
          // pointer: drags the selection, goes for 「白板」, then drags a frame round the formula
          const btn = [560 + 275, 445];
          let px;
          let py;
          if (u < 1.2) {
            const k = u < 0.8 ? seg(u, 0.5, 0.8) : seg(u, 0.8, 1.1);
            const b = u < 0.8 ? bands[0] : bands[1];
            px = lerp(140, b.x1, k);
            py = b.y;
          } else if (u < 2.3) {
            const k = E.inOut(seg(u, 1.4, 1.9));
            px = lerp(bands[1].x1, btn[0], k);
            py = lerp(bands[1].y, btn[1], k);
          } else {
            const k = E.inOut(seg(u, 2.3, 2.6));
            const d = E.inOut(seg(u, 2.6, 3.4));
            px = lerp(lerp(btn[0], 120, k), 960, d);
            py = lerp(lerp(btn[1], 670, k), 850, d);
          }
          const dragging = u > 2.6 && u < 3.5;
          place(ptr, px, py, (u > 2.0 && u < 2.14) || (u > 3.42 && u < 3.56) ? 0.85 : 1);
          ptr.setAttribute('opacity', clamp((u - 0.4) * 5) * (1 - clamp((u - 4.0) * 4)) * (dragging ? 0 : 1));
          place(cross, px, py);
          cross.setAttribute('opacity', dragging ? 1 : 0);
          rip.at(u, 2.0, btn[0], btn[1]);
          fr.setAttribute('d', u > 2.6 ? rectD(120, 670, Math.max(2, (u > 3.4 ? 960 : px) - 120), Math.max(2, (u > 3.4 ? 850 : py) - 670), 12, 28, 0.6) : '');
          fr.setAttribute('stroke-dashoffset', -u * 60);
          fr.setAttribute('fill-opacity', u > 3.45 ? 0.12 + 0.2 * Math.max(0, Math.cos((u - 3.45) * 8)) * Math.exp(-(u - 3.45) * 2) : 0.08);
          popIn(hint, u, 2.45, { x: 540, y: 1170, out: 3.6 });
          rip.at(u, 3.45, 960, 850);
          const peek = spring(u - 3.95, 2, 0.5);
          m.set({
            x: 900,
            y: 1440 + (1 - clamp(peek)) * 320,
            scale: 0.95,
            ...idle(u),
            glasses: true,
            mood: u > 4.2 ? 'happy' : 'smile',
            raiseL: 150 * E.out(seg(u, 4.1, 4.4)),
            rot: -6,
          });
          say.show(u, 4.25);
        },
      };
    },
    { enter: 'slide' },
  );

  // ===== 3. 页老师边写边讲 =====
  scene(
    'teach',
    5,
    (S, sfx) => {
      const w = S.world;
      const head = headline(w, '页老师 边写边讲～', { size: 96, fill: C.tealD });
      const win = boardWin(w);
      const L = lesson(w, S.defs);
      const m = new Mascot(w);
      const waves = speakerIcon(w, 290, 1300, { waves: 2, col: C.tealD });
      const capNote = pill(w, '↑ 字幕就是页老师说的话', { size: 34, fill: C.yellowL, seed: 330 });
      const dood = sparkles(w, [
        [960, 1290, 26, 'star'],
        [880, 1380, 20],
        [1010, 1400, 18, 'heart'],
      ]);
      sfx('pop', 0.1);
      [[0.5, 0.6], [1.2, 0.7], [2.0, 0.4], [2.6, 0.25], [3.5, 0.4], [3.95, 0.4], [4.5, 0.3], [4.8, 0.2], [6.0, 0.8], [6.8, 0.4], [7.4, 0.4]].forEach(([a, d]) => sfx('scribble', a, d));
      [0, 1, 2, 3].forEach((i) => sfx('pop', 2.85 + i * 0.12));
      [0, 1, 2, 3].forEach((i) => sfx('pop', 5.0 + i * 0.16));
      sfx('ding', 7.3);
      sfx('sparkle', 7.9);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.05 });
          win.paused(false);
          L.render(u);
          const talking = captions(win.cap, L.CAPS, u);
          const voice = u > 0.5 && u < 7.9;
          m.set({
            x: 150,
            y: 1428,
            scale: 0.72,
            ...idle(u),
            glasses: true,
            mood: u > 7.9 ? 'happy' : talking && Math.sin(u * 14) > 0 ? 'talk' : 'smile',
            raiseR: 70 + Math.sin(u * 3) * 12,
            look: [5, -4],
          });
          popIn(capNote, u, 1.0, { x: 650, y: 1290, rot: -2 });
          waves.setAttribute('opacity', voice ? 1 : 0.25);
          waves.waves.forEach((e, i) => e.setAttribute('opacity', voice ? 0.35 + 0.65 * Math.max(0, Math.sin(u * 9 - i * 1.2)) : 0));
          twinkle(dood, u, 7.9);
        },
      };
    },
    { enter: 'rise', tint: '#eefaf4' },
  );

  // ===== 4. 三种讲法：静音、出声、语音对话 =====
  scene(
    'voice',
    2,
    (S, sfx) => {
      const w = S.world;
      const head = headline(w, '能出声，还能语音聊', { size: 92 });
      const MODES = [
        ['静音讲解', '只看字幕和板书', (p) => speakerIcon(p, 0, 0, { waves: 0, slash: true })],
        ['页老师出声', '边说边画，你打字提问', (p) => speakerIcon(p, -4, 0, { waves: 2 })],
        ['语音对话', '像打电话一样，随时开口打断他', (p) => phoneIcon(p, 0, 0)],
      ];
      const cards = MODES.map(([name, sub, icon], i) => {
        const c = g(w);
        shape(c, rectD(-430, -82, 860, 164, 30, 40 + i, 1.6), { fill: ['#fff', C.yellowL, C.tealL][i], sw: 5 });
        const ic = g(c, { transform: 'translate(-340 0)' });
        s('circle', { r: 46, fill: '#fff', stroke: C.ink, 'stroke-width': 4 }, ic);
        icon(ic);
        T(c, name, -260, -8, { font: FONT.title, size: 52 });
        T(c, sub, -260, 48, { size: 32, fill: C.ink2 });
        return c;
      });
      const ring = stroke(w, rectD(115, 692, 850, 176, 34, 45, 2.5), { color: C.tealD, sw: 8 });
      const check = g(w);
      s('circle', { r: 30, fill: '#3bb273', stroke: C.ink, 'stroke-width': 4 }, check);
      line(check, 'M-13 1 L-3 11 L14 -10', '#fff', 6);
      const ptr = tool(w, 'pointer');
      const rip = ripple(w, C.teal);
      const m = new Mascot(w);
      const waves = speakerIcon(w, 700, 1180, { waves: 2, col: C.tealD });
      const me = new Bubble(w, { x: 340, y: 1000, w: 560, h: 110, tail: [120, 1100], fill: C.violetL, lines: ['等等，这里没懂！'], size: 44, align: 'start', pad: 120 });
      micIcon(me.inner, -235, 0, '#6b52d6');
      const lvl = [0, 1, 2].map((i) => s('rect', { x: -205 + i * 12, y: -8, width: 7, height: 16, rx: 3.5, fill: '#6b52d6' }, me.inner));
      const ok = new Bubble(w, { x: 470, y: 1200, w: 360, h: 100, tail: [700, 1240], lines: ['好～你说！'], size: 46, font: FONT.title });
      cards.forEach((_, i) => sfx('pop', 0.2 + i * 0.18));
      sfx('click', 1.3);
      sfx('ding', 1.4);
      sfx('pop', 2.0);
      sfx('boing', 2.6);
      sfx('pop', 2.75);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.045 });
          cards.forEach((c, i) => popIn(c, u, 0.2 + i * 0.18, { x: 540, y: 380 + i * 200 }));
          const pk = E.inOut(seg(u, 0.8, 1.25));
          place(ptr, lerp(980, 820, pk), lerp(1100, 790, pk), u > 1.28 && u < 1.42 ? 0.85 : 1);
          ptr.setAttribute('opacity', clamp((u - 0.75) * 5) * (1 - clamp((u - 1.8) * 4)));
          rip.at(u, 1.3, 820, 790);
          ring.draw(seg(u, 1.35, 1.75));
          popIn(check, u, 1.45, { x: 930, y: 700 });
          // the teacher talks until you start speaking, then stops to listen
          const listening = u > 2.0;
          const enter = spring(u - 1.5, 2, 0.5);
          const h = hop(u - 2.6, 60, 0.35);
          m.set({
            x: 860,
            y: 1440 + (1 - clamp(enter)) * 320,
            scale: 0.95,
            ...idle(u),
            glasses: true,
            lift: h.lift,
            sq: h.sq,
            mood: listening ? (u < 2.6 ? 'wow' : 'smile') : Math.sin(u * 14) > 0 ? 'talk' : 'smile',
            raiseL: listening ? 40 : 80 + Math.sin(u * 4) * 15,
            look: [-5, -3],
          });
          waves.setAttribute('opacity', u > 1.6 && !listening ? 1 : 0);
          waves.waves.forEach((e, i) => e.setAttribute('opacity', 0.35 + 0.65 * Math.max(0, Math.sin(u * 9 - i * 1.2))));
          me.show(u, 2.0);
          lvl.forEach((b, i) => {
            const v = u > 2.0 ? 8 + 18 * Math.abs(Math.sin(u * 11 + i * 1.7)) : 8;
            b.setAttribute('y', -v / 2);
            b.setAttribute('height', v);
          });
          ok.show(u, 2.75);
        },
      };
    },
    { enter: 'slide' },
  );

  // ===== 5. 圈出没懂的地方，换个说法重讲 =====
  scene(
    'circle',
    4,
    (S, sfx) => {
      const w = S.world;
      const head = headline(w, '哪里没懂，圈出来！', { size: 96 });
      const win = boardWin(w);
      const L = lesson(w, S.defs);
      L.render(Infinity);
      // the student's purple ring
      const ring = stroke(w, ellipseD(L.sm.x0 + L.sm.w / 2, 948, L.sm.w / 2 + 24, 44, 360, 2.5), { color: '#8a6cff', sw: 7 });
      const purple = tool(w, 'purple');
      const marked = pill(w, '已标 1 处  ×', { size: 26, fill: C.violetL, color: '#6b52d6', seed: 361, sw: 2.5 });
      // input under the board
      const input = g(w);
      shape(input, rectD(50, 1215, 740, 84, 26, 362, 1.4), { fill: '#fff', sw: 4.5 });
      const q = T(input, '', 80, 1269, { size: 36 });
      const Q = '“饱和”是什么意思？';
      const send = pill(input, '打断提问', { x: 690, y: 1257, size: 28, fill: C.teal, color: '#fff', seed: 363 });
      const ptr = tool(w, 'pointer');
      const rip = ripple(w, C.teal);
      // the laser dot pointing at what you marked
      const laser = g(w);
      s('circle', { r: 34, fill: C.red, opacity: 0.18 }, laser);
      s('circle', { r: 13, fill: C.red, opacity: 0.85 }, laser);
      // a new way to say it: one word takes the whole cake
      const pie = g(w);
      const cx = 270;
      const cy = 705;
      const R = 105;
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI * 2 * 0.93;
      const at = (a, r = R) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const big = s('path', { d: `M${cx} ${cy} L${at(a0).join(' ')} A${R} ${R} 0 1 1 ${at(a1).join(' ')} Z`, fill: C.yellow, 'fill-opacity': 0.75 }, pie);
      const rim = stroke(pie, ellipseD(cx, cy, R, R, 364, 1.5, 0.05, a0), { sw: 6 });
      const cuts = [a0, a1, a1 + 0.17, a1 + 0.33].map((a, i) => stroke(pie, lineD(cx, cy, ...at(a), 365 + i, 0.8), { sw: 5 }));
      const k1 = T(pie, 'k₁', cx + 10, cy + 40, { font: FONT.latin, size: 44, anchor: 'middle' });
      const crown = g(w);
      s('path', { d: 'M-34 16 L-34 -10 L-17 4 L0 -20 L17 4 L34 -10 L34 16 Z', fill: C.gold, stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, crown);
      const say1 = T(w, '一个词全拿走！', 420, 650, { size: 44 });
      const s1w = wiper(S.defs, say1, 410, 600, say1.getComputedTextLength() + 20, 70);
      const say2 = T(w, '别的词 ≈ 0', 420, 712, { size: 36, fill: C.ink2 });
      const s2w = wiper(S.defs, say2, 410, 670, say2.getComputedTextLength() + 20, 60);
      const arr = stroke(w, polyD([[440, 740], [452, 775], [480, 792]], 366, 1), { sw: 5 });
      const arrH = s('path', { d: headD(480, 792, 0.4, 18), fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, w);
      const say3 = T(w, '梯度 ≈ 0，学不动啦', 495, 810, { size: 40, fill: C.red });
      const s3w = wiper(S.defs, say3, 485, 760, say3.getComputedTextLength() + 20, 70);
      const sleepy = g(w);
      s('circle', { r: 42, fill: C.pinkL, stroke: C.ink, 'stroke-width': 4.5 }, sleepy);
      line(sleepy, 'M-24 -4 Q-15 4 -6 -4 M6 -4 Q15 4 24 -4 M-6 18 Q0 14 6 18', C.ink, 4);
      const zz = [0, 1].map((i) => T(w, 'z', 0, 0, { font: FONT.latin, size: 34 - i * 8, fill: C.ink2, anchor: 'middle' }));
      const pen = tool(w, 'marker');
      const lamp = bulb(w);
      const m = new Mascot(w);
      const got = new Bubble(w, { x: 300, y: 1265, w: 330, h: 108, tail: [120, 1360], fill: C.violetL, lines: ['懂了！'], size: 56, font: FONT.title });
      const yay = sparkles(w, [
        [520, 1225, 26, 'star'],
        [560, 1310, 18],
        [490, 1390, 18, 'heart'],
      ]);
      const CAPS = [
        [2.55, '好问题！我换个比方～'],
        [3.6, '饱和就像：一个词把蛋糕全拿走了'],
        [5.6, '别的词分不到，梯度≈0，就学不动啦'],
      ];
      sfx('pop', 0.1);
      sfx('scribble', 0.6, 0.6);
      sfx('pop', 1.25);
      sfx('type', 1.5, 0.6);
      sfx('click', 2.25);
      sfx('ding', 2.45);
      sfx('swish', 3.0);
      [[3.5, 0.7], [4.2, 0.35], [5.0, 0.5], [5.4, 0.3], [5.6, 0.3], [5.9, 0.6]].forEach(([a, d]) => sfx('scribble', a, d));
      sfx('pop', 4.8);
      sfx('pop', 6.5);
      sfx('boing', 7.0);
      sfx('sparkle', 7.05);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.05 });
          const resumed = u > 2.3;
          win.paused(!resumed);
          if (!resumed) {
            win.cap.textContent = '已暂停 · 圈出没懂的地方，告诉页老师';
            win.cap.setAttribute('fill', C.ink2);
          } else {
            win.cap.setAttribute('fill', C.ink);
            captions(win.cap, CAPS, u);
          }
          ring.draw(seg(u, 0.6, 1.2));
          showTool(purple, u > 0.55 && u < 1.25);
          follow(purple, ring, seg(u, 0.6, 1.2));
          popIn(marked, u, 1.25, { x: 900, y: 1060, out: 2.3 });
          input.setAttribute('opacity', clamp((u - 1.3) * 5) * (1 - clamp((u - 6.6) * 4)));
          const n = Math.floor([...Q].length * seg(u, 1.5, 2.1));
          q.textContent = [...Q].slice(0, n).join('');
          place(send, 690, 1257, u > 2.25 && u < 2.38 ? 0.9 : 1);
          const pk = E.inOut(seg(u, 1.6, 2.2));
          place(ptr, lerp(980, 702, pk), lerp(1400, 1266, pk), u > 2.22 && u < 2.36 ? 0.85 : 1);
          ptr.setAttribute('opacity', clamp((u - 1.55) * 5) * (1 - clamp((u - 2.8) * 4)));
          rip.at(u, 2.25, 690, 1257);
          // laser dot sweeps to the ring, then the old charts are wiped off
          const lk = E.inOut(seg(u, 2.45, 2.85));
          const lx = lerp(560, L.sm.x0 + L.sm.w / 2, lk);
          place(laser, lx, lerp(1140, 948, lk), 1 + 0.15 * Math.sin(u * 12));
          laser.setAttribute('opacity', u > 2.45 && u < 3.6 ? 1 : 0);
          const wipe = E.inOut(seg(u, 3.0, 3.4));
          L.charts.setAttribute('opacity', 1 - wipe);
          L.charts.setAttribute('transform', `translate(0 ${wipe * -20})`);
          // the pie, step by step
          rim.draw(seg(u, 3.5, 4.2));
          cuts.forEach((c, i) => c.draw(seg(u, 4.2 + i * 0.08, 4.35 + i * 0.08)));
          big.setAttribute('opacity', E.out(seg(u, 4.55, 4.85)));
          k1.setAttribute('opacity', clamp((u - 4.7) * 5));
          popIn(crown, u, 4.8, { x: cx, y: 578, rot: -8 });
          s1w.set(seg(u, 5.0, 5.5));
          s2w.set(seg(u, 5.4, 5.7));
          arr.draw(seg(u, 5.6, 5.85));
          arrH.setAttribute('opacity', u > 5.85 ? 1 : 0);
          s3w.set(seg(u, 5.9, 6.5));
          popIn(sleepy, u, 6.5, { x: 940, y: 790 });
          zz.forEach((z, i) => {
            const k = ((u - 6.7 - i * 0.4) % 1.2 + 1.2) % 1.2;
            place(z, 960 + k * 25 + i * 6, 748 - k * 45 - i * 6, 1, -10);
            z.setAttribute('opacity', u > 6.7 + i * 0.4 ? Math.sin((k / 1.2) * Math.PI) : 0);
          });
          const steps = [
            [3.5, 4.2, rim],
            [4.2, 4.59, null],
            [5.0, 5.5, () => [s1w.x + s1w.w * seg(u, 5.0, 5.5), 635]],
            [5.6, 5.85, arr],
            [5.9, 6.5, () => [s3w.x + s3w.w * seg(u, 5.9, 6.5), 795]],
          ];
          const on = steps.find(([a, b]) => u >= a && u <= b);
          showTool(pen, !!on);
          if (on) {
            if (on[2] === null) {
              const i = clamp(Math.floor((u - 4.2) / 0.08), 0, 3);
              follow(pen, cuts[i], seg(u, 4.2 + i * 0.08, 4.35 + i * 0.08));
            } else if (typeof on[2] === 'function') {
              const v = on[2]();
              place(pen, v[0], v[1] + Math.sin(u * 46) * 7);
            } else follow(pen, on[2], seg(u, on[0], on[1]));
          }
          // teacher: thinks, lights up, explains, cheers
          const talking = resumed && u < 6.6 && Math.sin(u * 14) > 0;
          const h = hop(u - 7.0, 90, 0.42);
          m.set({
            x: 930,
            y: 1428,
            scale: 0.72,
            ...idle(u),
            glasses: true,
            lift: h.lift,
            sq: h.sq + Math.sin(u * 4.2) * 0.02,
            mood: u < 2.3 ? 'smile' : u > 6.9 ? 'happy' : talking ? 'talk' : 'smile',
            raiseL: u > 2.4 && u < 6.6 ? 80 + Math.sin(u * 3) * 10 : 20 + h.lift,
            raiseR: 20 + h.lift,
            look: [-5, -4],
          });
          popIn(lamp, u, 2.45, { x: 845, y: 1235, sc: 0.7, out: 3.4 });
          got.show(u, 6.95);
          twinkle(yay, u, 7.05);
        },
      };
    },
    { enter: 'iris', at: [540, 760], tint: '#eefaf4' },
  );

  // ===== 6. 不止论文：函数、树、代码、流程 =====
  scene(
    'more',
    3,
    (S, sfx) => {
      const w = S.world;
      const head = headline(w, '不止论文，题目也能讲', { size: 88 });
      const SPOTS = [
        [70, 290, '函数图像'],
        [560, 290, '二叉树'],
        [70, 750, '代码'],
        [560, 750, '流程图'],
      ];
      const minis = SPOTS.map(([x, y, name], i) => {
        const e = g(w);
        const inner = g(e, { transform: `translate(${-x - 225} ${-y - 210})` });
        shape(inner, rectD(x, y, 450, 420, 26, 400 + i, 1.5), { fill: '#fffefa', sw: 5, off: [6, 8] });
        s('rect', { x: x + 12, y: y + 12, width: 426, height: 396, fill: 'url(#grid)', opacity: 0.8 }, inner);
        pill(inner, name, { x: x + 30 + name.length * 15 + 22, y: y + 44, size: 28, fill: [C.skyL, C.yellowL, C.pinkL, C.violetL][i], seed: 405 + i });
        return { e, inner, x: x + 225, y: y + 210 };
      });
      // 1 · y = sin x
      const f1 = minis[0].inner;
      const axX = stroke(f1, lineD(100, 550, 490, 550, 410, 1), { sw: 5 });
      const axY = stroke(f1, lineD(140, 690, 140, 380, 411, 1), { sw: 5 });
      const heads = [headD(490, 550, 0, 16), headD(140, 380, -Math.PI / 2, 16)].map((d) => s('path', { d, fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, f1));
      const pts = [];
      for (let i = 0; i <= 40; i++) pts.push([150 + (i / 40) * 330, 550 - 100 * Math.sin((i / 40) * Math.PI * 2)]);
      const sine = stroke(f1, polyD(pts, 412, 0.6), { color: C.blue, sw: 6 });
      const fl = T(f1, 'y = sin x', 400, 430, { font: FONT.latin, size: 32, fill: C.blue, anchor: 'middle' });
      const dot = s('circle', { r: 10, fill: C.red, stroke: C.ink, 'stroke-width': 3 }, f1);
      // 2 · a binary tree, level by level
      const f2 = minis[1].inner;
      const N = [
        [785, 405],
        [680, 505],
        [890, 505],
        [630, 610],
        [730, 610],
        [840, 610],
        [940, 610],
      ];
      const edges = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 6]].map(([a, b], i) => {
        const [x1, y1] = N[a];
        const [x2, y2] = N[b];
        const d = Math.hypot(x2 - x1, y2 - y1);
        const ux = (x2 - x1) / d;
        const uy = (y2 - y1) / d;
        return stroke(f2, lineD(x1 + ux * 28, y1 + uy * 28, x2 - ux * 28, y2 - uy * 28, 420 + i, 1), { sw: 5 });
      });
      const nodes = N.map(([x, y], i) => {
        const e = g(f2);
        s('circle', { r: 28, fill: [C.yellowL, C.tealL, C.tealL, C.pinkL, C.pinkL, C.pinkL, C.pinkL][i], stroke: C.ink, 'stroke-width': 4.5 }, e);
        T(e, String(i + 1), 0, 11, { font: FONT.latin, size: 30, anchor: 'middle' });
        return { e, x, y };
      });
      const lvl = [[45, 405], [150, 505], [205, 610]].map(([rx, y], i) => {
        const r = stroke(f2, ellipseD(785, y, rx, 40, 427 + i, 1.5, 0.08), { color: '#ff9a3c', sw: 4.5 });
        r.setAttribute('stroke-dasharray', '0.03 0.02');
        return r;
      });
      const lvlT = T(f2, '一层一层', 785, 690, { size: 30, fill: '#ff9a3c', anchor: 'middle' });
      // 3 · code with line numbers, the recursive line boxed
      const f3 = minis[2].inner;
      const CODE = ['def fib(n):', '  if n < 2:', '    return n', '  return fib(n-1)+fib(n-2)'];
      const codeT = CODE.map((l, i) => {
        T(f3, String(i + 1), 112, 870 + i * 44, { font: FONT.latin, size: 24, fill: '#c4bba9', anchor: 'end' });
        return T(f3, '', 128, 870 + i * 44, { font: 'Menlo, monospace', size: 24, fill: i === 0 ? '#8a6cff' : C.ink });
      });
      const cl = 128 + 26 * 14.5;
      const cbox = stroke(f3, rectD(120, 870 + 3 * 44 - 32, cl - 110, 46, 10, 430, 1.4), { color: C.red, sw: 5 });
      const cnote = T(f3, '递归在这里！', 300, 1100, { size: 32, fill: C.red, anchor: 'middle' });
      const carr = stroke(f3, lineD(300, 1070, 300, 1024, 431, 1), { color: C.red, sw: 5 });
      const carrH = s('path', { d: headD(300, 1024, -Math.PI / 2, 14), fill: 'none', stroke: C.red, 'stroke-width': 5, 'stroke-linecap': 'round' }, f3);
      // 4 · a flow, top to bottom
      const f4 = minis[3].inner;
      const FLOW = ['Q · Kᵀ', '÷ √dₖ', 'softmax · V'];
      const boxes = FLOW.map((txt, i) => {
        const e = g(f4);
        shape(e, rectD(-120, -32, 240, 64, 18, 440 + i, 1.2), { fill: [C.skyL, C.yellowL, C.tealL][i], sw: 4 });
        T(e, txt, 0, 11, { font: FONT.latin, size: 30, anchor: 'middle' });
        return e;
      });
      const flows = [0, 1].map((i) => {
        const y1 = 865 + i * 105 + 34;
        const a = stroke(f4, lineD(785, y1, 785, y1 + 36, 445 + i, 0.6), { sw: 5 });
        const h = s('path', { d: headD(785, y1 + 36, Math.PI / 2, 14), fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, f4);
        return { a, h };
      });
      const note = sticky(w, { x: 430, y: 1310, w: 660, h: 130, rot: -2, color: C.yellowL, lines: ['直接问一道题，贴图也行～'], size: 44, seed: 450 });
      const m = new Mascot(w);
      minis.forEach((_, i) => sfx('pop', 0.3 + i * 0.12));
      sfx('scribble', 0.8, 0.9);
      [0, 1, 2].forEach((i) => sfx('pop', 1.6 + i * 0.22));
      sfx('scribble', 2.3, 0.3);
      sfx('type', 2.5, 0.8);
      sfx('scribble', 3.3, 0.4);
      [0, 1, 2].forEach((i) => sfx('pop', 3.8 + i * 0.25));
      sfx('slap', 4.7);
      sfx('boing', 4.9);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.045 });
          minis.forEach((mi, i) => popIn(mi.e, u, 0.3 + i * 0.12, { x: mi.x, y: mi.y, rot: [-1.5, 1.2, 1, -1.2][i] }));
          axX.draw(seg(u, 0.6, 0.8));
          axY.draw(seg(u, 0.65, 0.85));
          heads.forEach((h) => h.setAttribute('opacity', u > 0.85 ? 1 : 0));
          const ks = seg(u, 0.85, 1.7);
          sine.draw(ks);
          fl.setAttribute('opacity', clamp((u - 1.5) * 4));
          const p = pts[Math.round(ks * 40)];
          dot.setAttribute('cx', p[0]);
          dot.setAttribute('cy', p[1]);
          dot.setAttribute('opacity', u > 0.85 ? 1 : 0);
          const lv = [0, 1, 1, 2, 2, 2, 2];
          nodes.forEach(({ e, x, y }, i) => popIn(e, u, 1.6 + lv[i] * 0.22 + (i % 2) * 0.05, { x, y }));
          edges.forEach((e, i) => e.draw(seg(u, 1.7 + (i < 2 ? 0 : 0.22), 1.9 + (i < 2 ? 0 : 0.22))));
          lvl.forEach((r, i) => r.setAttribute('opacity', u > 2.25 + i * 0.15 ? 1 : 0));
          lvlT.setAttribute('opacity', clamp((u - 2.4) * 4));
          const all = CODE.join('');
          const n = Math.floor([...all].length * seg(u, 2.5, 3.3));
          let left = n;
          codeT.forEach((t, i) => {
            t.textContent = [...CODE[i]].slice(0, Math.max(0, left)).join('');
            left -= [...CODE[i]].length;
          });
          cbox.draw(seg(u, 3.3, 3.7));
          cnote.setAttribute('opacity', clamp((u - 3.6) * 4));
          carr.draw(seg(u, 3.6, 3.8));
          carrH.setAttribute('opacity', u > 3.8 ? 1 : 0);
          boxes.forEach((b, i) => popIn(b, u, 3.8 + i * 0.25, { x: 785, y: 865 + i * 105 }));
          flows.forEach(({ a, h }, i) => {
            a.draw(seg(u, 3.95 + i * 0.25, 4.1 + i * 0.25));
            h.setAttribute('opacity', u > 4.1 + i * 0.25 ? 1 : 0);
          });
          slap(note, u, 4.7);
          const enter = spring(u - 4.8, 2, 0.5);
          m.set({
            x: 935,
            y: 1440 + (1 - clamp(enter)) * 260,
            scale: 0.66,
            ...idle(u),
            glasses: true,
            mood: 'happy',
            raiseL: 150 * E.out(seg(u, 4.95, 5.2)) + Math.sin(u * 12) * 10 * clamp((u - 5.2) * 3),
            rot: -6,
          });
        },
      };
    },
    { enter: 'flip' },
  );

  // ===== 7. 自动保存，存进笔记 =====
  scene(
    'keep',
    2,
    (S, sfx) => {
      const w = S.world;
      const head = headline(w, '自动保存，随时接着问', { size: 88 });
      const list = g(w);
      shape(list, rectD(80, 250, 920, 520, 30, 500, 1.6), { fill: '#fff', sw: 5 });
      historyIcon(list, 132, 308);
      T(list, '白板记录', 160, 322, { size: 40 });
      const ROWS = [
        ['为什么要除以 √dₖ', '论文.pdf 第 3 页 · 问了 2 次 · 刚刚'],
        ['二叉树的层序遍历', '直接提问 · 昨天'],
        ['梯度消失是怎么回事', '讲义.pdf 第 12 页 · 3 天前'],
      ];
      const rows = ROWS.map(([a, b], i) => {
        const e = g(w);
        const inner = g(e, { transform: 'translate(-430 -50)' });
        const hl = s('path', { d: rectD(0, 0, 860, 100, 18, 501 + i, 1.2), fill: i ? '#faf6ee' : C.tealL, stroke: i ? C.line : C.tealD, 'stroke-width': 3.5 }, inner);
        s('rect', { x: 18, y: 14, width: 72, height: 72, rx: 10, fill: '#fffefa', stroke: C.ink, 'stroke-width': 3 }, inner);
        scribbles(inner, 28, 34, 50, 2, { gap: 16, seed: 505 + i, sw: 4 });
        s('rect', { x: 32, y: 66, width: 9, height: 14, fill: '#ffb3b8' }, inner);
        s('rect', { x: 48, y: 72, width: 9, height: 8, fill: '#c9defc' }, inner);
        T(inner, a, 115, 46, { size: 36 });
        T(inner, b, 115, 84, { size: 26, fill: C.ink2 });
        return { e, hl, y: 400 + i * 118 };
      });
      const save = pill(w, '    存入笔记', { size: 32, fill: C.violetL, color: '#6b52d6', seed: 510 });
      noteIcon(save, -save.w / 2 + 34, 0, '#6b52d6');
      const doc = g(w);
      shape(doc, rectD(120, 840, 840, 500, 26, 511, 1.6), { fill: '#fffdf8', sw: 5 });
      T(doc, '伴读笔记.md', 160, 895, { size: 28, fill: C.ink2 });
      T(doc, '## 白板：为什么要除以 √dₖ', 160, 950, { font: FONT.hand, size: 38, fill: C.ink });
      const shot = g(doc);
      s('rect', { x: 160, y: 980, width: 500, height: 280, rx: 14, fill: '#fffefa', stroke: C.ink, 'stroke-width': 3.5 }, shot);
      s('rect', { x: 168, y: 988, width: 484, height: 264, fill: 'url(#grid)' }, shot);
      T(shot, '为什么要除以 √dₖ ？', 190, 1030, { size: 28 });
      [86, 7, 5, 4].forEach((h, i) => s('rect', { x: 200 + i * 38, y: 1180 - h, width: 24, height: h, fill: '#ffb3b8', stroke: C.red, 'stroke-width': 2.5 }, shot));
      [60, 48, 37, 28].forEach((h, i) => s('rect', { x: 460 + i * 40, y: 1180 - h, width: 24, height: h, fill: '#c9defc', stroke: C.blue, 'stroke-width': 2.5 }, shot));
      line(shot, 'M190 1180 L350 1180 M450 1180 L630 1180', C.ink, 3);
      T(shot, 'softmax 不饱和，梯度不消失！', 190, 1230, { size: 24 });
      const from = T(doc, '来自 论文.pdf 第 3 页 · ', 160, 1305, { size: 26, fill: C.ink2 });
      const fl = from.getComputedTextLength();
      T(doc, '在白板中打开', 160 + fl, 1305, { size: 26, fill: C.tealD });
      line(doc, `M${162 + fl} 1314 L${160 + fl + 156} 1314`, C.tealD, 3);
      const ptr = tool(w, 'pointer');
      const rip = ripple(w, C.violet);
      const yay = sparkles(w, [
        [720, 1010, 28, 'star'],
        [900, 1150, 22],
        [760, 1250, 20, 'heart'],
      ]);
      rows.forEach((_, i) => sfx('pop', 0.3 + i * 0.15));
      sfx('pop', 1.1);
      sfx('click', 1.65);
      sfx('swish', 1.8);
      sfx('ding', 2.5);
      sfx('sparkle', 2.55);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.045 });
          rows.forEach((r, i) => popIn(r.e, u, 0.3 + i * 0.15, { x: 540, y: r.y }));
          popIn(save, u, 1.1, { x: 820, y: 322 });
          const pk = E.inOut(seg(u, 1.1, 1.6));
          place(ptr, lerp(980, 830, pk), lerp(1150, 330, pk), u > 1.62 && u < 1.76 ? 0.85 : 1);
          ptr.setAttribute('opacity', clamp((u - 1.05) * 5) * (1 - clamp((u - 2.2) * 4)));
          rip.at(u, 1.65, 820, 322);
          const d = spring(u - 1.75, 1.8, 0.6);
          doc.setAttribute('transform', `translate(0 ${lerp(700, 0, clamp(d, 0, 1.08))})`);
          doc.setAttribute('opacity', u > 1.7 ? 1 : 0);
          const k = E.inOut(seg(u, 1.9, 2.45));
          shot.setAttribute('transform', `translate(${lerp(-60, 0, k)} ${lerp(-560, 0, k)}) translate(410 1120) scale(${lerp(0.25, 1, k)}) translate(-410 -1120)`);
          shot.setAttribute('opacity', u > 1.9 ? 1 : 0);
          twinkle(yay, u, 2.55);
        },
      };
    },
    { enter: 'slide' },
  );

  // ===== 8. 片尾 =====
  scene(
    'outro',
    2.5,
    (S, sfx) => {
      const w = S.world;
      const boom = confetti(g(w), { x: 540, y: 560, n: 48 });
      const m = new Mascot(w);
      const titleRow = g(w);
      const zh = letters(titleRow, '页间', 440, 1010, { font: FONT.title, size: 150, fill: C.ink, anchor: 'middle' });
      const en = T(titleRow, 'Folio', 690, 1004, { font: FONT.latin, size: 86, fill: C.tealD, anchor: 'middle', weight: 700 });
      const tag = letters(w, '没读懂？请页老师上白板～', W / 2, 1110, { font: FONT.hand, size: 54, fill: C.ink2, anchor: 'middle' });
      const btn = g(w);
      shape(btn, rectD(-280, -44, 560, 88, 44, 520, 1.4), { fill: C.teal, sw: 5 });
      T(btn, 'macOS · Windows', 0, 15, { font: FONT.latin, size: 42, fill: '#fff', anchor: 'middle' });
      const url = T(w, 'helloxxy.com/works/folio', W / 2, 1340, { font: FONT.latin, size: 38, fill: C.ink2, anchor: 'middle' });
      const bye = new Bubble(w, { x: 800, y: 470, w: 300, h: 110, tail: [640, 560], lines: ['下次见～'], size: 56, font: FONT.title });
      const dood = sparkles(w, [
        [170, 420, 32, 'star'],
        [930, 700, 28],
        [150, 760, 24, 'heart'],
        [960, 1210, 26, 'star'],
        [110, 1250, 22],
      ], 2);
      sfx('boing', 0.15);
      sfx('sparkle', 0.45);
      sfx('pop', 0.9);
      sfx('pop', 1.05);
      sfx('pop', 1.9);
      sfx('pop', 3.0);
      return {
        render(u) {
          const h = hop(u - 0.15, 160, 0.55);
          const waving = clamp(seg(u, 2.9, 3.1)) * (1 - seg(u, 4.4, 4.7));
          m.set({
            x: 540,
            y: 860,
            scale: 1.15,
            ...idle(u),
            glasses: true,
            lift: h.lift,
            sq: h.sq + Math.sin(u * 4.2) * 0.02,
            raiseL: h.lift > 10 ? 160 : 20,
            raiseR: h.lift > 10 ? 160 : waving * (140 + Math.sin(u * 14) * 18) + 20 * (1 - waving),
            mood: u < 2.8 ? 'happy' : 'smile',
            sway: Math.sin(u * 3) * 6 - h.sq * 20,
          });
          boom(u, 0.45);
          popLetters(zh, u, 0.9, { stagger: 0.15 });
          en.setAttribute('opacity', clamp((u - 1.2) * 4));
          en.setAttribute('transform', `translate(0 ${(1 - E.outBack(seg(u, 1.2, 1.6))) * 30})`);
          popLetters(tag, u, 1.4, { stagger: 0.04 });
          popIn(btn, u, 1.9, { x: 540, y: 1225 });
          url.setAttribute('opacity', clamp((u - 2.3) * 3));
          bye.show(u, 3.0);
          twinkle(dood, u, 1.0);
          const out = E.inOut(seg(u, 4.4, 5.0));
          S.world.setAttribute('opacity', 1 - out);
        },
      };
    },
    { enter: 'iris', at: [540, 700] },
  );

  EVENTS.quiet = ['hook'];
  EVENTS.melodic = ['hook', 'voice', 'more', 'outro'];
  EVENTS.scenes = scenes.map(({ id, t0, t1 }) => ({ id, t0, t1 }));
  EVENTS.duration = clock;
  window.EVENTS = EVENTS;
  return clock;
}

// ---------- 转场 ----------
const ring = s('path', { fill: 'none', stroke: C.ink, 'stroke-width': 7, 'stroke-linecap': 'round' }, over);
function transitions(t) {
  ring.setAttribute('opacity', 0);
  scenes.forEach((S, i) => {
    const r = S.root;
    const next = scenes[i + 1];
    const u = t - S.t0;
    let vis = t >= S.t0 - (S.enter === 'cut' ? 0 : TR / 2) && t < S.t1 + (next && next.enter !== 'cut' ? TR / 2 : 0);
    r.style.clipPath = '';
    r.style.transform = '';
    r.style.opacity = '';
    r.style.zIndex = '';
    r.style.boxShadow = '';
    if (vis && u < TR / 2) {
      const k = seg(u, -TR / 2, TR / 2);
      if (S.enter === 'iris') {
        const rad = E.inOutQuint(k) * 1900;
        r.style.clipPath = `circle(${rad}px at ${S.at[0]}px ${S.at[1]}px)`;
        if (k > 0 && k < 1) {
          ring.setAttribute('d', ellipseD(S.at[0], S.at[1], rad, rad, 7, 6, 0.02));
          ring.setAttribute('opacity', 1);
        }
      } else if (S.enter === 'slide') {
        r.style.transform = `translateX(${(1 - E.outBack(k)) * W}px)`;
        r.style.boxShadow = '-30px 0 60px rgba(61,58,75,.18)';
      } else if (S.enter === 'rise') {
        r.style.transform = `translateY(${(1 - E.outBack(k)) * H}px)`;
        r.style.boxShadow = '0 -30px 60px rgba(61,58,75,.18)';
      } else if (S.enter === 'fade') {
        r.style.opacity = E.inOut(k);
      }
    }
    // A page turn: the outgoing scene flips over its left edge.
    if (next && next.enter === 'flip') {
      const v = t - next.t0;
      r.style.zIndex = 5;
      if (v > -TR / 2 - 1e-6 && v < TR / 2) {
        const k = E.inOut(seg(v, -TR / 2, TR / 2));
        // In 3D, stacking follows depth, not z-index: lift the turning page a little.
        r.style.transform = `translateZ(2px) rotateY(${-180 * k}deg)`;
        r.style.boxShadow = `${20 + 60 * k}px 0 80px rgba(61,58,75,${0.25 * Math.sin(Math.PI * k)})`;
      }
      if (v >= TR / 2) vis = false;
    }
    if (next && next.enter === 'slide') {
      const v = t - next.t0;
      if (v > -TR / 2 && v < TR / 2) {
        r.style.transform = `translateX(${-E.inOut(seg(v, -TR / 2, TR / 2)) * 400}px)`;
        r.style.opacity = 1 - 0.5 * seg(v, -TR / 2, TR / 2);
      }
    }
    if (next && next.enter === 'rise') {
      const v = t - next.t0;
      if (v > -TR / 2 && v < TR / 2) {
        r.style.transform = `translateY(${-E.inOut(seg(v, -TR / 2, TR / 2)) * 300}px)`;
        r.style.opacity = 1 - 0.5 * seg(v, -TR / 2, TR / 2);
      }
    }
    r.style.visibility = vis ? 'visible' : 'hidden';
    r.vis = vis;
  });
}

async function seek(t) {
  turb.setAttribute('seed', 1 + (Math.floor(t * 8) % 4));
  transitions(t);
  for (const S of scenes) if (S.root.vis) S.render(t - S.t0, t);
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
