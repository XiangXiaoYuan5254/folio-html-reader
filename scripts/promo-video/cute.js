// 页间宣传视频 · 手绘可爱版。不用录屏，画面全是 sketch.js 里的手绘 SVG，
// 主角是页间图标变成的小页，AI 是一颗小星星。和 video.js 一样按 seek(t) 逐帧算出画面。
//   cute.html?preview   拖动进度条看效果
//   cute.html?t=12.5    打开时停在这一秒
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
  sharpD,
  heartD,
  squiggleD,
  headD,
  Mascot,
  blinkAt,
  landing,
  hop,
  Buddy,
  sheet,
  scribbles,
  sticky,
  slap,
  Bubble,
  tool,
  ripple,
  confetti,
  AppWin,
  PALETTES,
} from './sketch.js';

const BAR = 2; // 120 BPM，一小节 2 秒
const TR = 0.8; // 转场长度
const scenesEl = document.getElementById('scenes');
const over = document.getElementById('over');
const turb = document.querySelector('#boil feTurbulence');
const EVENTS = {
  style: 'cute',
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

function scene(id, bars, build, { enter = 'cut', at = [960, 540], tint = C.paper } = {}) {
  const t0 = clock;
  const dur = bars * BAR;
  clock += dur;
  const root = document.createElement('div');
  root.className = 'scene';
  root.id = id;
  scenesEl.append(root);
  const svg = s('svg', { viewBox: '0 0 1920 1080', width: 1920, height: 1080 });
  root.append(svg);
  const defs = s('defs', {}, svg);
  s('rect', { width: 1920, height: 1080, fill: tint }, svg);
  s('rect', { width: 1920, height: 1080, fill: 'url(#dots)' }, svg);
  const world = g(svg, { filter: 'url(#boil)' });
  const S = { id, t0, t1: t0 + dur, dur, enter, at, root, svg, defs, world };
  const sfx = (kind, x, d) => EVENTS[kind].push(d != null ? [t0 + x, d] : t0 + x);
  if (enter !== 'cut') sfx('swish', 0);
  Object.assign(S, build(S, sfx));
  scenes.push(S);
  return S;
}

// Mascot defaults: breathing, blinking, ribbon swaying.
const idle = (u, more = {}) => ({
  blink: blinkAt(u),
  sway: Math.sin(u * 3) * 5,
  sq: Math.sin(u * 4.2) * 0.025,
  ...more,
});
// Spring a group in at t0 (and out at t1), around its own position.
function popIn(e, u, t0, { x = 0, y = 0, rot = 0, sc = 1, out, freq = 2.4, damp = 0.45 } = {}) {
  const k = spring(u - t0, freq, damp);
  let o = clamp((u - t0) * 8);
  let q = 0;
  if (out != null && u > out) q = E.in(clamp((u - out) / 0.3));
  place(e, x, y - q * 30, Math.max(0, k) * sc * (1 - q * 0.5), rot + (1 - clamp(k)) * 14);
  e.setAttribute('opacity', u < t0 ? 0 : o * (1 - q));
}
// Moves a tool along a path as it is drawn.
function follow(t, path, k) {
  const len = (path.len ||= path.getTotalLength());
  const p = path.getPointAtLength(len * clamp(k));
  place(t, p.x, p.y);
}
function showTool(t, on) {
  t.setAttribute('opacity', on ? 1 : 0);
}
// Little sparkles scattered around, popping in and twinkling.
function sparkles(parent, list, seedFill = 0) {
  const cols = [C.yellow, C.pink, C.sky, C.mint, C.violet];
  return list.map(([x, y, r, kind = 'sparkle'], i) => {
    const e = g(parent);
    const d = kind === 'star' ? starD(0, 0, r, i + 3) : kind === 'heart' ? heartD(0, 0, r) : sparkleD(0, 0, r);
    s('path', { d, fill: cols[(i + seedFill) % cols.length], stroke: C.ink, 'stroke-width': 4, 'stroke-linejoin': 'round' }, e);
    return { e, x, y, i };
  });
}
function twinkle(list, u, t0, out) {
  for (const { e, x, y, i } of list) {
    const a = t0 + i * 0.09;
    const k = spring(u - a, 2.6, 0.4);
    let o = u < a ? 0 : 1;
    if (out != null && u > out) o *= 1 - clamp((u - out) / 0.3);
    place(e, x, y, Math.max(0, k) * (1 + 0.14 * Math.sin(u * 6 + i)), Math.sin(u * 2 + i) * 18);
    e.setAttribute('opacity', o);
  }
}
// Headline label: small eyebrow plus big hand-lettered lines, left aligned.
function label(parent, x, y, eyebrow, lines, { size = 92, color = C.tealD, gap = 1.1 } = {}) {
  const eb = g(parent);
  s('path', { d: lineD(x, y - 12, x + 40, y - 12, 4, 1), stroke: color, 'stroke-width': 6, 'stroke-linecap': 'round' }, eb);
  T(eb, eyebrow, x + 56, y, { size: 38, fill: color });
  const L = lines.map((l, i) => letters(parent, l, x, y + 110 + i * size * gap, { font: FONT.title, size, fill: C.ink }));
  return {
    render(u, t0, out) {
      eb.setAttribute('opacity', clamp((u - t0) * 4) * (out != null && u > out ? 1 - clamp((u - out) / 0.3) : 1));
      L.forEach((l, i) => popLetters(l, u, t0 + 0.15 + i * 0.25, { stagger: 0.05, out }));
    },
  };
}

// ====================================================================
async function build() {
  await Promise.all(
    [FONT.title, FONT.hand, FONT.latin, FONT.serif].map((f) =>
      document.fonts.load(`40px ${f}`, '页间读得进AaBb12'),
    ),
  );

  // ===== 1. 你好：小页从天而降 =====
  scene('hello', 3, (S, sfx) => {
    const w = S.world;
    const dood = sparkles(w, [
      [1610, 400, 34],
      [930, 330, 26, 'star'],
      [1650, 650, 22],
      [905, 690, 22, 'heart'],
      [1720, 880, 26, 'star'],
      [330, 690, 26],
      [560, 250, 22],
    ]);
    const m = new Mascot(w);
    const title = letters(w, '页间', 1260, 590, { font: FONT.title, size: 220, fill: C.ink, anchor: 'middle' });
    const folio = T(w, 'Folio', 1262, 728, { font: FONT.latin, size: 104, fill: C.tealD, anchor: 'middle', weight: 700 });
    const fb = folio.getBBox();
    const fw = wiper(S.defs, folio, fb.x - 12, fb.y - 12, fb.width + 24, fb.height + 30);
    const under = stroke(w, squiggleD(fb.x + 6, 770, fb.width - 12, 9, 4, 3), { color: C.pink, sw: 9 });
    const pen = tool(w, 'red');
    const tag = letters(w, '读得进，也读得懂。', 1260, 885, { font: FONT.hand, size: 66, fill: C.ink2, anchor: 'middle' });
    const hi = new Bubble(w, { x: 470, y: 340, w: 230, h: 120, tail: [600, 450], lines: ['嗨～'], size: 66, font: FONT.title });
    sfx('boing', 0.75);
    sfx('pop', 1.25);
    sfx('pop', 1.6);
    sfx('pop', 1.78);
    sfx('scribble', 2.05, 0.9);
    sfx('sparkle', 3.0);
    for (let i = 0; i < 9; i++) sfx('pop', 3.2 + i * 0.05);
    return {
      render(u) {
        const L = landing(u - 0.75, 1000, 0.6);
        const waving = clamp(seg(u, 1.1, 1.35)) * (1 - seg(u, 2.9, 3.2));
        const mood = u > 1.5 && u < 2.7 ? 'happy' : u > 4.2 ? 'happy' : 'smile';
        m.set({
          x: 720,
          y: 870,
          scale: 1.45,
          ...idle(u),
          lift: L.lift,
          sq: L.sq + Math.sin(u * 4.2) * 0.02,
          raiseR: waving * (140 + Math.sin(u * 14) * 18),
          raiseL: u > 4.2 ? 30 * E.out(seg(u, 4.2, 4.5)) : 0,
          mood,
          sway: -L.sq * 25 + Math.sin(u * 3) * 5,
        });
        hi.show(u, 1.2, 3.0);
        popLetters(title, u, 1.55, { stagger: 0.18, freq: 2.2 });
        const k = seg(u, 2.05, 2.65);
        fw.set(k);
        under.draw(seg(u, 2.55, 2.95));
        showTool(pen, u > 2.0 && u < 3.05);
        if (u < 2.65) place(pen, fw.x + fw.w * k, 716 + Math.sin(u * 50) * 8);
        else follow(pen, under, seg(u, 2.55, 2.95));
        popLetters(tag, u, 3.1, { stagger: 0.05 });
        twinkle(dood, u, 3.2);
      },
    };
  });

  // ===== 2. 资料散落一地 → 收进文件夹 =====
  scene(
    'mess',
    3,
    (S, sfx) => {
      const w = S.world;
      const loose = g(w);
      const m = new Mascot(w);
      const head1 = letters(w, '资料东一份、西一份……', 960, 200, { font: FONT.title, size: 88, fill: C.ink, anchor: 'middle' });
      const head2 = letters(w, '打开文件夹，就能读！', 960, 200, { font: FONT.title, size: 96, fill: C.ink, anchor: 'middle' });
      const sub = T(w, 'HTML 和 PDF · 都在你自己的电脑里', 960, 290, { size: 48, fill: C.ink2, anchor: 'middle' });
      // folder held above the head
      const folder = g(w);
      const back = g(folder);
      shape(back, sharpD([[-200, -150], [-90, -150], [-70, -126], [200, -126], [200, 120], [-200, 120]], 4, 1.4), { fill: '#e9ad3c', sw: 5 });
      const papers = g(folder);
      const front = g(folder);
      shape(front, sharpD([[-214, -60], [214, -60], [196, 132], [-196, 132]], 5, 1.4), { fill: C.gold, sw: 5 });
      T(front, '论文精读', 0, 52, { size: 46, anchor: 'middle', font: FONT.title });
      const cards = [];
      const kinds = [
        ['PDF', '论文.pdf'],
        ['HTML', '笔记.html'],
        ['PDF', '讲义.pdf'],
        ['HTML', '网页.html'],
        ['HTML', '草稿.html'],
        ['PDF', '报告.pdf'],
        ['HTML', '清单.html'],
        ['PDF', '书.pdf'],
      ];
      kinds.forEach(([tag, name], i) => {
        const c = g(loose);
        const inner = g(c, { transform: 'translate(-80 -100)' });
        sheet(inner, { x: 0, y: 0, w: 160, h: 200, tag, seed: 20 + i });
        T(inner, name, 80, 70, { size: 24, anchor: 'middle' });
        scribbles(inner, 22, 104, 116, 3, { gap: 26, seed: 40 + i, sw: 6 });
        cards.push(c);
      });
      const burst = sparkles(w, [
        [700, 430, 30],
        [1220, 420, 34, 'star'],
        [640, 640, 22, 'heart'],
        [1300, 650, 24],
        [960, 330, 26],
      ]);
      const collect = (i) => 2.6 + i * 0.12;
      for (let i = 0; i < cards.length; i++) sfx('pop', collect(i) + 0.5);
      sfx('boing', 2.2);
      sfx('ding', 4.1);
      sfx('sparkle', 4.15);
      return {
        render(u) {
          const holding = E.out(seg(u, 2.1, 2.4));
          const happy = u > 4.1;
          const h = hop(u - 4.15, 70, 0.45);
          m.set({
            x: 960,
            y: 1010,
            scale: 1.1,
            ...idle(u),
            rot: u < 2.2 ? Math.sin(u * 5) * 6 : 0,
            mood: u < 2.2 ? 'dizzy' : happy ? 'happy' : 'wow',
            sweat: u < 2.2,
            raiseL: 150 * holding,
            raiseR: 150 * holding,
            lift: h.lift,
            sq: h.sq,
          });
          popLetters(head1, u, 0.2, { stagger: 0.05, out: 2.1 });
          popLetters(head2, u, 2.35, { stagger: 0.05 });
          sub.setAttribute('opacity', clamp((u - 2.9) * 3));
          // folder springs up above the head; its front closes over the papers
          const f = spring(u - 2.15, 2.2, 0.5);
          place(folder, 960, 560 - h.lift * 1.1, Math.max(0, f), (1 - clamp(f)) * -10);
          folder.setAttribute('opacity', u < 2.15 ? 0 : 1);
          const close = spring(u - 4.05, 3, 0.4);
          front.setAttribute('transform', `translate(0 132) scale(1 ${1 + 0.32 * clamp(close, 0, 1.3)}) translate(0 -132)`);
          cards.forEach((c, i) => {
            const a0 = (i / cards.length) * Math.PI * 2;
            const fly = E.outQuint(seg(u, 0, 0.9));
            const r = lerp(2.2, 1, fly);
            const at = (x) => {
              const a = a0 + x * 0.9;
              return [960 + Math.cos(a) * 700 * r, 640 + Math.sin(a) * 280 * r, Math.sin(x * 2 + i) * 25 + x * 40 * (i % 2 ? 1 : -1)];
            };
            const tc = collect(i);
            if (u < tc) {
              const [x, y, rot] = at(u);
              place(c, x, y, 1, rot);
              c.setAttribute('opacity', 1);
            } else {
              const [x0, y0, r0] = at(tc);
              const k = E.inOut(clamp((u - tc) / 0.55));
              const x1 = 960;
              const y1 = 470;
              const cx = (x0 + x1) / 2;
              const cy = Math.min(y0, y1) - 260;
              const x = (1 - k) ** 2 * x0 + 2 * (1 - k) * k * cx + k * k * x1;
              const y = (1 - k) ** 2 * y0 + 2 * (1 - k) * k * cy + k * k * y1;
              place(c, x, y, lerp(1, 0.55, k), lerp(r0, 0, k));
              c.setAttribute('opacity', 1 - clamp((k - 0.85) / 0.15));
            }
          });
          twinkle(burst, u, 4.15, 5.4);
        },
      };
    },
    { enter: 'iris', at: [720, 650] },
  );

  // ===== 3. 页间窗口 + 卖点便签 =====
  scene(
    'app',
    3,
    (S, sfx) => {
      const w = S.world;
      const cam = g(w);
      const head = letters(cam, '你的本地阅读小窝～', 960, 112, { font: FONT.title, size: 80, fill: C.ink, anchor: 'middle' });
      const win = g(cam);
      const app = new AppWin(win, { w: 1400, h: 780, seed: 31 });
      const m = new Mascot(cam);
      const notes = [
        { x: 240, y: 330, rot: -8, color: C.yellowL, lines: ['文件留在本地'], sub: '不上传 · 不同步' },
        { x: 1690, y: 290, rot: 7, color: C.pinkL, lines: ['原文一字不动'], sub: '批注另存在旁边' },
        { x: 230, y: 800, rot: 6, color: C.tealL, lines: ['不用注册'], sub: '打开就能用' },
        { x: 1700, y: 640, rot: -6, color: C.violetL, lines: ['AI 你来选'], sub: '自带 Key · 本机模型' },
      ].map((n, i) => sticky(cam, { ...n, w: 340, h: 180, size: 46, seed: 50 + i }));
      const at = [1.5, 1.8, 2.1, 2.4];
      at.forEach((x) => sfx('slap', x));
      sfx('pop', 0.1);
      sfx('boing', 1.15);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.05, out: 4.6 });
          const k = spring(u - 0.05, 1.8, 0.55);
          win.setAttribute('transform', `translate(260 160) translate(700 390) scale(${lerp(0.7, 1, clamp(k, 0, 1.2))}) rotate(${(1 - clamp(k)) * -4}) translate(-700 -390)`);
          win.setAttribute('opacity', clamp(u * 5));
          const peek = spring(u - 1.1, 2, 0.5);
          m.set({
            x: 1530,
            y: 1080 + (1 - clamp(peek)) * 300,
            scale: 0.95,
            ...idle(u),
            mood: u > 1.6 ? 'wink' : 'smile',
            raiseR: 150 * E.out(seg(u, 1.4, 1.7)),
            rot: -6,
          });
          notes.forEach((n, i) => slap(n, u, at[i], 4.5 + i * 0.05));
          // dive into the document
          const z = E.inOutQuint(seg(u, 4.7, 6.0));
          cam.setAttribute('transform', `translate(1050 560) scale(${lerp(1, 2.6, z)}) translate(-1050 -560)`);
        },
      };
    },
    { enter: 'flip' },
  );

  // ===== 4. 阅读批注：荧光笔、红笔、便签、PDF =====
  scene(
    'annotate',
    5,
    (S, sfx) => {
      const w = S.world;
      const lab = label(w, 110, 250, '阅读 · 批注', ['随手划，', '想法就写', '在原文旁～'], { size: 92 });
      const pg = g(w, { transform: 'rotate(-1 1230 550)' });
      sheet(pg, { x: 640, y: 90, w: 1180, h: 920, tag: 'HTML', seed: 61 });
      T(pg, '论文伴读 · NLP 经典', 700, 178, { size: 32, fill: C.tealD });
      const title = T(pg, 'Attention Is All You Need', 712, 252, { font: FONT.latin, size: 58, weight: 700 });
      shape(pg, rectD(690, 290, 1080, 600, 24, 62, 1.6), { fill: '#fffaf0', sw: 3.5, off: [0, 0] });
      T(pg, '一句话总结', 730, 352, { size: 38, fill: C.coral });
      const bands = g(pg);
      const LINES = [
        'Transformer 完全基于注意力机制，',
        '去掉了 RNN 的循环结构，',
        '让序列建模可以高度并行。',
        '在 WMT 2014 英德翻译上拿到',
        '28.4 BLEU，训练只用了',
        '8 张 GPU、3.5 天。',
      ];
      const texts = LINES.map((l, i) => T(pg, l, 730, 434 + i * 82, { size: 54 }));
      scribbles(pg, 700, 940, 1060, 2, { gap: 36, seed: 63 });
      // highlights on lines 2 and 3
      const hl = [1, 2].map((i) => {
        const x1 = 730 + texts[i].getComputedTextLength();
        const y = 434 + i * 82;
        const b = s('path', { d: rectD(718, y - 46, x1 - 706, 62, 14, 70 + i, 2), fill: C.yellow, 'fill-opacity': 0.6 }, bands);
        return { wipe: wiper(S.defs, b, 708, y - 52, x1 - 690, 76), y, x0: 718, x1 };
      });
      const marker = tool(pg, 'highlighter');
      // red circle around 28.4 BLEU
      const bleu = span(texts[4], '28.4 BLEU');
      const ring = stroke(pg, ellipseD(730 + bleu.x0 - 730 + bleu.w / 2 + 0, 434 + 4 * 82 - 18, bleu.w / 2 + 26, 44, 74, 2.5), { color: C.red, sw: 7 });
      const star = stroke(pg, starD(672, 230, 28, 75), { color: C.red, sw: 6 });
      const redPen = tool(pg, 'red');
      const note = sticky(pg, { x: 1625, y: 800, w: 300, h: 200, rot: 8, color: C.yellowL, lines: ['对照原文', '表 1 再看看'], size: 46, seed: 76 });
      const noteText = g(note.inner);
      note.texts.forEach((t) => noteText.append(t));
      const noteWipe = wiper(S.defs, noteText, -150, -100, 300, 200);
      const arrowEnd = [730 + bleu.x0 - 730 + bleu.w + 34, 434 + 4 * 82 - 22];
      const arrow = stroke(pg, polyD([[1478, 812], [1300, 860], [1120, 820], arrowEnd], 77, 3), { color: C.ink, sw: 6 });
      const ah = s('path', { d: headD(arrowEnd[0], arrowEnd[1], Math.PI + 0.55, 26), fill: 'none', stroke: C.ink, 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, pg);
      const g6 = span(texts[5], '8 张 GPU、3.5 天');
      const wavy = stroke(pg, squiggleD(730 + g6.x0 - 730, 434 + 5 * 82 + 18, g6.w, 7, 6, 78), { color: C.blue, sw: 6 });
      const bluePen = tool(pg, 'blue');
      // PDF page sliding in
      const pdf = g(w);
      const pin = g(pdf);
      sheet(pin, { x: 0, y: 0, w: 820, h: 880, tag: 'PDF', seed: 80 });
      T(pin, 'Attention Is All You Need', 410, 120, { font: FONT.serif, size: 46, weight: 700, anchor: 'middle' });
      scribbles(pin, 160, 170, 500, 2, { gap: 26, seed: 81, sw: 6 });
      T(pin, 'Abstract', 410, 290, { font: FONT.serif, size: 34, weight: 700, anchor: 'middle' });
      const ABS = [
        'Most sequence models today are built on recurrent',
        'or convolutional networks with an encoder-decoder.',
        'We propose a simple new architecture, the Transformer,',
        'built only on attention, with no recurrence at all.',
        'On two translation tasks it trains much faster and',
        'translates better, reaching 28.4 BLEU on the WMT',
        '2014 English-to-German task, a new best result.',
        'It also generalizes well to other kinds of tasks.',
      ];
      const pband = g(pin);
      const ptext = ABS.map((l, i) => T(pin, l, 70, 350 + i * 52, { font: FONT.serif, size: 30 }));
      const pl = ptext[3].getComputedTextLength();
      const pb = s('path', { d: rectD(60, 350 + 3 * 52 - 32, pl + 20, 44, 10, 82, 1.5), fill: C.yellow, 'fill-opacity': 0.6 }, pband);
      const pwipe = wiper(S.defs, pb, 50, 350 + 3 * 52 - 40, pl + 40, 60);
      const pbleu = span(ptext[5], '28.4 BLEU');
      const pring = stroke(pin, ellipseD(pbleu.x0 + pbleu.w / 2, 350 + 5 * 52 - 11, pbleu.w / 2 + 18, 30, 83, 2), { color: C.red, sw: 6 });
      const m = new Mascot(w);
      const say = new Bubble(w, { x: 420, y: 760, w: 380, h: 116, tail: [340, 870], lines: ['PDF 也一样！'], size: 52, font: FONT.title });
      sfx('scribble', 1.0, 1.4);
      sfx('scribble', 2.8, 0.8);
      sfx('scribble', 3.8, 0.5);
      sfx('slap', 4.6);
      sfx('scribble', 4.8, 0.7);
      sfx('scribble', 5.7, 0.5);
      sfx('scribble', 6.3, 0.5);
      sfx('swish', 7.2);
      sfx('pop', 7.6);
      sfx('scribble', 8.0, 0.6);
      sfx('scribble', 8.7, 0.6);
      sfx('boing', 2.5);
      sfx('boing', 6.9);
      return {
        render(u) {
          lab.render(u, 0.2, 9.4);
          // highlighter across lines 2 and 3
          const k1 = seg(u, 1.0, 1.65);
          const k2 = seg(u, 1.75, 2.4);
          hl[0].wipe.set(k1);
          hl[1].wipe.set(k2);
          showTool(marker, u > 0.9 && u < 2.55);
          const cur = u < 1.7 ? hl[0] : hl[1];
          const kk = u < 1.7 ? k1 : k2;
          place(marker, lerp(cur.x0, cur.x1, kk), cur.y - 4 + Math.sin(u * 40) * 2);
          // red pen: circle, then star
          const kr = seg(u, 2.8, 3.55);
          const ks = seg(u, 3.8, 4.3);
          ring.draw(kr);
          star.draw(ks);
          showTool(redPen, (u > 2.75 && u < 3.6) || (u > 3.75 && u < 4.35));
          if (u < 3.65) follow(redPen, ring, kr);
          else follow(redPen, star, ks);
          // sticky note slaps in, then gets written on
          slap(note, u, 4.6);
          noteWipe.set(seg(u, 4.8, 5.5));
          arrow.draw(seg(u, 5.7, 6.15));
          ah.setAttribute('opacity', u > 6.15 ? 1 : 0);
          wavy.draw(seg(u, 6.3, 6.8));
          showTool(bluePen, u > 6.25 && u < 6.85);
          follow(bluePen, wavy, seg(u, 6.3, 6.8));
          // PDF slides over
          const p = spring(u - 7.2, 1.6, 0.6);
          pdf.setAttribute('transform', `translate(${lerp(2150, 1000, clamp(p, 0, 1.1))} 120) rotate(${lerp(14, 3, clamp(p))} 410 440)`);
          pdf.setAttribute('opacity', u > 7.1 ? 1 : 0);
          pwipe.set(seg(u, 8.0, 8.55));
          pring.draw(seg(u, 8.7, 9.3));
          const j1 = hop(u - 2.5, 90, 0.42);
          const j2 = hop(u - 6.9, 110, 0.45);
          m.set({
            x: 330,
            y: 1045,
            scale: 0.95,
            ...idle(u),
            lift: j1.lift + j2.lift,
            sq: j1.sq + j2.sq + Math.sin(u * 4.2) * 0.02,
            mood: (u > 2.5 && u < 3.2) || (u > 6.9 && u < 7.6) ? 'happy' : u > 7.5 ? 'talk' : 'smile',
            raiseR: u > 7.4 && u < 9 ? 120 : (j1.lift + j2.lift) * 1.2,
            raiseL: (j1.lift + j2.lift) * 1.2,
            look: [u > 7 ? 4 : 3, -2],
          });
          say.show(u, 7.55, 9.5);
        },
      };
    },
    { enter: 'fade' },
  );

  // ===== 5. 双栏：搬过来，左右对照 =====
  scene(
    'split',
    2,
    (S, sfx) => {
      const w = S.world;
      const head = letters(w, '拖进来，左右对照读～', 960, 120, { font: FONT.title, size: 84, fill: C.ink, anchor: 'middle' });
      const left = g(w);
      sheet(left, { x: 0, y: 0, w: 760, h: 820, tag: 'HTML', seed: 90 });
      const lWrap = g(left);
      wiper(S.defs, lWrap, 10, 60, 740, 750).set(1);
      const lc = g(lWrap);
      T(lc, 'Attention 伴读笔记', 50, 100, { size: 46 });
      for (let b = 0; b < 4; b++) {
        scribbles(lc, 50, 170 + b * 260, 660, 4, { gap: 40, seed: 91 + b });
        if (b === 1) s('path', { d: rectD(42, 170 + b * 260 + 22, 560, 34, 10, 95, 1.4), fill: C.yellow, 'fill-opacity': 0.55 }, lc);
      }
      const zone = g(w);
      shape(zone, rectD(1010, 200, 760, 820, 30, 96, 2), { fill: C.tealL, fillOpacity: 0.6, stroke: C.tealD, sw: 5, dash: '18 14', off: [0, 0] });
      T(zone, '松开，在右栏打开', 1390, 620, { size: 48, fill: C.tealD, anchor: 'middle' });
      const right = g(w);
      const rin = g(right);
      sheet(rin, { x: 0, y: 0, w: 760, h: 820, tag: 'PDF', seed: 97 });
      const rWrap = g(rin);
      wiper(S.defs, rWrap, 10, 60, 740, 750).set(1);
      const rc = g(rWrap);
      T(rc, 'Attention Is All You Need', 380, 100, { font: FONT.serif, size: 42, weight: 700, anchor: 'middle' });
      for (let b = 0; b < 4; b++) {
        scribbles(rc, 60, 170 + b * 260, 640, 4, { gap: 36, seed: 98 + b, color: '#cbc3b4', sw: 5 });
        if (b === 1) {
          shape(rc, rectD(220, 330 + 6, 320, 90, 12, 99, 1.2), { fill: C.violetL, sw: 3.5, off: [3, 3] });
          s('path', { d: lineD(380, 350, 380, 400, 99, 1), stroke: C.ink, 'stroke-width': 3.5 }, rc);
        }
      }
      const link = g(w);
      shape(link, rectD(-34, -22, 44, 44, 18, 100, 1.2), { stroke: C.violet, sw: 7, off: [0, 0] });
      shape(link, rectD(-10, -22, 44, 44, 18, 101, 1.2), { stroke: C.violet, sw: 7, off: [0, 0] });
      const linkT = T(w, '同步滚动', 955, 640, { size: 40, fill: C.violet, anchor: 'middle', stroke: C.paper, 'stroke-width': 10, 'paint-order': 'stroke' });
      const m = new Mascot(w);
      sfx('pop', 0.1);
      sfx('boing', 1.4);
      sfx('pop', 1.45);
      sfx('pop', 2.3);
      sfx('swish', 2.5);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.045 });
          const move = E.inOutQuint(seg(u, 1.45, 1.95));
          left.setAttribute('transform', `translate(${lerp(580, 140, move)} 200)`);
          zone.setAttribute('opacity', clamp((u - 0.5) * 4) * (1 - clamp((u - 1.4) * 5)));
          const walk = clamp(seg(u, 0.1, 1.35));
          const mx = lerp(-260, 1360, E.inOut(walk));
          const step = u < 1.35 ? Math.abs(Math.sin(u * 13)) * 26 : 0;
          const drop = spring(u - 1.42, 2, 0.6);
          const after = E.inOut(seg(u, 1.9, 2.4));
          const h = hop(u - 1.42, 80, 0.4);
          m.set({
            x: lerp(mx, 955, after),
            y: lerp(1050, 1090, after),
            scale: lerp(1, 0.72, after),
            ...idle(u),
            lift: step + h.lift,
            sq: h.sq + (u < 1.35 ? Math.sin(u * 26) * 0.04 : 0),
            raiseL: u < 1.42 ? 165 : 40 * (1 - after),
            raiseR: u < 1.42 ? 165 : 40 * (1 - after),
            mood: u < 1.42 ? 'smile' : 'happy',
            rot: u < 1.35 ? Math.sin(u * 13) * 4 : 0,
          });
          // the paper rides on its head, then drops into the right column
          const top = [mx - 380 * 0.36, 1050 - step - 290 - 820 * 0.36];
          const sc = lerp(0.36, 1, clamp(drop, 0, 1.15));
          const x = u < 1.42 ? top[0] : lerp(top[0], 1010, clamp(drop, 0, 1.05));
          const y = u < 1.42 ? top[1] : lerp(top[1], 200, clamp(drop, 0, 1.05));
          right.setAttribute('transform', `translate(${x} ${y}) scale(${u < 1.42 ? 0.36 : sc})`);
          rin.setAttribute('transform', u < 1.42 ? `rotate(${Math.sin(u * 13) * 3} 380 410)` : '');
          // scroll together
          const sc2 = E.inOut(seg(u, 2.5, 3.6)) * -360;
          lc.setAttribute('transform', `translate(0 ${sc2})`);
          rc.setAttribute('transform', `translate(0 ${sc2})`);
          popIn(link, u, 2.3, { x: 955, y: 560 });
          linkT.setAttribute('opacity', clamp((u - 2.4) * 4));
        },
      };
    },
    { enter: 'slide' },
  );

  // ===== 6. AI 章节：小星登场 =====
  scene(
    'ai',
    1.5,
    (S, sfx) => {
      const w = S.world;
      const rays = g(w);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        s('path', { d: lineD(960 + Math.cos(a) * 190, 430 + Math.sin(a) * 190, 960 + Math.cos(a) * 250, 430 + Math.sin(a) * 250, i, 1), stroke: i % 2 ? C.yellow : C.violet, 'stroke-width': 9, 'stroke-linecap': 'round' }, rays);
      }
      const b = new Buddy(w);
      const head = letters(w, '有 AI 陪你读！', 960, 790, { font: FONT.title, size: 120, fill: C.ink, anchor: 'middle' });
      const chips = [
        ['DeepSeek', 330, 230],
        ['通义千问', 240, 430],
        ['Kimi', 360, 620],
        ['Claude', 620, 150],
        ['OpenAI', 1590, 230],
        ['Gemini', 1690, 430],
        ['智谱 GLM', 1570, 620],
        ['豆包', 1300, 150],
        ['Ollama · 本机也能跑', 960, 930],
      ].map(([n, x, y], i) => {
        const c = g(w);
        const latin = /^[A-Za-z]/.test(n);
        const t = T(c, n, 0, 13, { size: 40, anchor: 'middle', font: latin ? FONT.latin : FONT.hand });
        const tw = t.getComputedTextLength() + 56;
        const fills = [C.yellowL, C.pinkL, C.tealL, C.skyL, C.violetL];
        const sh = shape(c, rectD(-tw / 2, -34, tw, 68, 34, 110 + i, 1.4), { fill: fills[i % 5], sw: 4 });
        c.insertBefore(sh.g, t);
        return { c, x, y, i };
      });
      sfx('boing', 0.1);
      sfx('sparkle', 0.15);
      sfx('pop', 0.45);
      chips.forEach(({ i }) => sfx('pop', 0.75 + i * 0.08));
      return {
        render(u) {
          const k = spring(u - 0.08, 2, 0.45);
          b.set({ x: 960, y: 430, scale: 1.6 * Math.max(0, k), t: u, blink: blinkAt(u, 2.2), rot: (1 - clamp(k)) * 90 });
          const r = E.out(seg(u, 0.15, 0.6));
          rays.setAttribute('transform', `translate(960 430) scale(${0.6 + r * 0.5}) rotate(${u * 20}) translate(-960 -430)`);
          rays.setAttribute('opacity', r * (1 - seg(u, 0.6, 1.2)));
          popLetters(head, u, 0.4, { stagger: 0.06 });
          for (const { c, x, y, i } of chips) popIn(c, u, 0.75 + i * 0.08, { x, y: y + Math.sin(u * 2.5 + i) * 10, rot: Math.sin(u * 1.5 + i) * 4 });
        },
      };
    },
    { enter: 'iris', at: [960, 430], tint: '#f4efff' },
  );

  // ===== 7. 问这篇文档：回答带编号，点一下回原文 =====
  scene(
    'ask',
    3,
    (S, sfx) => {
      const w = S.world;
      const head = letters(w, '问它，它会指给你看原文', 960, 108, { font: FONT.title, size: 78, fill: C.ink, anchor: 'middle' });
      const doc = g(w);
      sheet(doc, { x: 110, y: 180, w: 760, h: 830, tag: 'HTML', seed: 120 });
      T(doc, 'Attention 伴读笔记', 160, 290, { size: 48 });
      const flash = g(doc);
      const LINES = [
        'Transformer 完全基于注意力机制，',
        '去掉了 RNN 的循环结构，让序列',
        '建模可以高度并行。',
        '更妙的是：自注意力让任意两个',
        '位置直接相连，最长路径只有 O(1)。',
        '训练只用了 8 张 GPU、3.5 天。',
      ];
      const texts = LINES.map((l, i) => T(doc, l, 160, 400 + i * 78, { size: 42 }));
      scribbles(doc, 160, 900, 650, 3, { gap: 34, seed: 121 });
      const a = span(texts[3], '自注意力让任意两个');
      const b2 = span(texts[4], '位置直接相连');
      const glow = [
        [a, 3],
        [b2, 4],
      ].map(([sp, i]) =>
        s('path', { d: rectD(sp.x0 - 8, 400 + i * 78 - 38, sp.w + 16, 54, 12, 122 + i, 1.6), fill: C.violet, 'fill-opacity': 0.35, stroke: C.violet, 'stroke-width': 4 }, flash),
      );
      const panel = g(w);
      shape(panel, rectD(930, 180, 880, 830, 32, 123, 1.8), { fill: '#fff', sw: 5 });
      T(panel, '✦ AI 助手', 975, 248, { size: 42, fill: C.violet });
      s('path', { d: lineD(960, 275, 1780, 275, 124, 1.2), stroke: C.line, 'stroke-width': 4 }, panel);
      const q = new Bubble(w, { x: 1440, y: 360, w: 700, h: 100, tail: [1760, 420], fill: C.tealL, lines: ['Transformer 为什么比 RNN 训练得快？'], size: 38 });
      const bud = new Buddy(w);
      const A = new Bubble(w, {
        x: 1430,
        y: 690,
        w: 720,
        h: 360,
        tail: [1060, 560],
        lines: ['关键在于去掉了循环结构～', '① 能并行：一次处理整句', '② 传得快：任意两个词直连', '③ 很省时：8 张 GPU、3.5 天'],
        size: 38,
        align: 'start',
        pad: 40,
      });
      const dots = [0, 1, 2].map((i) => s('circle', { cx: 1390 + i * 40, cy: 690, r: 11, fill: C.violet }, w));
      const badges = [1, 2, 3].map((n, i) => {
        const e = g(w);
        s('circle', { r: 21, fill: C.violet, stroke: C.ink, 'stroke-width': 3.5 }, e);
        T(e, String(n), 0, 10, { font: FONT.latin, size: 26, fill: '#fff', anchor: 'middle', weight: 700 });
        const t = A.texts[i + 1];
        return { e, line: i + 1, x: A.x - 360 + 40 + 0, t };
      });
      const ptr = tool(w, 'pointer');
      const rip = ripple(w);
      const arc = stroke(w, polyD([[0, 0], [0, 0]], 1, 0), { color: C.violet, sw: 7 });
      const arcHead = s('path', { fill: 'none', stroke: C.violet, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, w);
      let target = null;
      sfx('pop', 0.1);
      sfx('pop', 0.3);
      sfx('type', 0.35, 1.05);
      sfx('pop', 1.5);
      sfx('type', 2.1, 1.3);
      [2.45, 2.85, 3.3].forEach((x) => sfx('pop', x));
      sfx('click', 4.15);
      sfx('swish', 4.2);
      sfx('ding', 4.7);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.04 });
          q.show(u, 0.3);
          q.type(u, 0.35, 1.4);
          const kb = spring(u - 1.5, 2.2, 0.5);
          bud.set({ x: 1010, y: 520, scale: 0.4 * Math.max(0, kb), t: u, blink: blinkAt(u, 2.4) });
          A.show(u, 1.6);
          dots.forEach((d, i) => {
            d.setAttribute('opacity', u > 1.65 && u < 2.1 ? 1 : 0);
            d.setAttribute('cy', 690 - Math.max(0, Math.sin(u * 12 - i * 0.9)) * 14);
          });
          A.type(u, 2.1, 3.4);
          // citation badges after each line, measured once the text is all there
          badges.forEach((bd, i) => {
            if (!bd.pos) {
              const full = A.full[bd.line];
              const probe = T(w, full, 0, 0, { size: 38 });
              bd.pos = [A.x - 360 + 40 + probe.getComputedTextLength() + 34, A.y - ((A.full.length - 1) * 38 * 1.3) / 2 + bd.line * 38 * 1.3 + 13 - 13];
              probe.remove();
            }
            popIn(bd.e, u, [2.45, 2.85, 3.3][i], { x: bd.pos[0], y: bd.pos[1] });
          });
          // pointer taps ②, an arrow flies back to the source sentence
          const tgt = badges[1].pos;
          const pk = E.inOut(seg(u, 3.55, 4.1));
          const press = u > 4.12 && u < 4.24 ? 0.85 : 1;
          place(ptr, lerp(1620, tgt[0] - 4, pk), lerp(1060, tgt[1] - 4, pk), press);
          ptr.setAttribute('opacity', clamp((u - 3.5) * 5) * (1 - clamp((u - 5.4) * 4)));
          rip.at(u, 4.15, tgt[0], tgt[1]);
          if (!target) {
            target = [160 + a.x0 - 160 + a.w / 2, 400 + 3 * 78 - 60];
            const pts = [[tgt[0] - 30, tgt[1] - 30], [1150, 420], [900, 330], target];
            arc.setAttribute('d', polyD(pts, 125, 2));
            arc.len = null;
            const last = pts.at(-1);
            const prev = pts.at(-2);
            arcHead.setAttribute('d', headD(last[0], last[1], Math.atan2(last[1] - prev[1], last[0] - prev[0]), 26));
          }
          arc.draw(seg(u, 4.2, 4.7));
          arcHead.setAttribute('opacity', u > 4.7 ? 1 : 0);
          const pulse = u > 4.7 ? 0.55 + 0.45 * Math.cos((u - 4.7) * 9) : 0;
          for (const e of glow) e.setAttribute('opacity', u > 4.7 ? pulse : 0);
        },
      };
    },
    { enter: 'slide', tint: '#f7f3ff' },
  );

  // ===== 8. AI 划重点 + 划词翻译 =====
  scene(
    'highlights',
    4,
    (S, sfx) => {
      const w = S.world;
      const lab1 = label(w, 80, 250, 'AI 划重点', ['一键标出', '重点～'], { size: 84, color: '#7d63e8' });
      const lab2 = label(w, 80, 250, '划词翻译', ['选中一句，', '直接翻译～'], { size: 84, color: '#7d63e8' });
      const cam = g(w);
      const page = g(cam);
      sheet(page, { x: 500, y: 110, w: 920, h: 900, tag: 'PDF', seed: 130 });
      T(page, '1   Introduction', 560, 190, { font: FONT.serif, size: 38, weight: 700 });
      const bandG = g(page);
      const LINES = [
        'Recurrent models factor computation along positions.',
        'This inherently sequential nature precludes parallelization.',
        'Attention mechanisms have become an integral part of models,',
        'allowing dependencies to be modeled regardless of distance.',
        'Self-attention relates different positions of one sequence.',
        'It has been used in reading comprehension and summaries.',
        'The Transformer reaches a new state of the art in translation',
        'after training for twelve hours on eight P100 GPUs.',
        'To the best of our knowledge, the Transformer is the first',
        'transduction model relying entirely on self-attention.',
        'In the following sections, we describe the architecture.',
      ];
      const texts = LINES.map((l, i) => T(page, l, 560, 262 + i * 62, { font: FONT.serif, size: 31 }));
      const marks = [
        [1, 'This inherently sequential nature precludes parallelization', C.yellow, '观点', C.yellowL],
        [4, 'Self-attention relates different positions of one sequence', C.mint, '定义', C.tealL],
        [7, 'twelve hours on eight P100 GPUs', C.sky, '数据', C.skyL],
        [9, 'transduction model relying entirely on self-attention', C.pink, '结论', C.pinkL],
      ].map(([i, sub, col, tag, light], j) => {
        const sp = span(texts[i], sub);
        const y = 262 + i * 62;
        const band = s('path', { d: rectD(sp.x0 - 6, y - 32, sp.w + 12, 44, 10, 131 + j, 1.4), fill: col, 'fill-opacity': 0.6 }, bandG);
        const wp = wiper(S.defs, band, sp.x0 - 12, y - 40, sp.w + 24, 60);
        const pill = g(cam);
        shape(pill, rectD(-48, -28, 96, 56, 28, 135 + j, 1.2), { fill: light, sw: 4 });
        T(pill, tag, 0, 13, { size: 36, anchor: 'middle' });
        return { sp, y, wp, pill, t0: 0.6 + j * 0.62 };
      });
      const bud = new Buddy(cam);
      const toast = g(cam);
      shape(toast, rectD(-330, -40, 660, 80, 40, 140, 1.4), { fill: C.ink, sw: 0, off: [0, 0] });
      T(toast, '已添加 4 处 AI 高亮 · ⌘Z 一键撤销', 0, 12, { size: 36, fill: '#fff', anchor: 'middle' });
      // translate: select line 3, toolbar, card
      const sel3 = s('path', { d: rectD(552, 262 + 2 * 62 - 34, texts[2].getComputedTextLength() + 16, 48, 8, 141, 1), fill: C.sky, 'fill-opacity': 0.35 }, bandG);
      const selWipe = wiper(S.defs, sel3, 545, 262 + 2 * 62 - 44, texts[2].getComputedTextLength() + 30, 64);
      const bar = g(cam);
      shape(bar, rectD(-330, -36, 660, 72, 20, 142, 1.4), { fill: '#fff', sw: 4.5 });
      const btns = ['高亮', '划线', '解释', '翻译', '提问', '白板'];
      btns.forEach((b, i) => T(bar, b, -275 + i * 110, 12, { size: 34, anchor: 'middle', fill: b === '翻译' ? '#7d63e8' : C.ink }));
      const card = g(cam);
      shape(card, rectD(-450, -110, 900, 220, 26, 143, 1.6), { fill: '#fff', stroke: '#7d63e8', sw: 5 });
      T(card, '翻译成中文', -405, -55, { size: 32, fill: '#7d63e8' });
      const tr1 = T(card, '', -405, 10, { size: 44 });
      const tr2 = T(card, '', -405, 72, { size: 44 });
      const TR1 = '注意力机制已经成为各种序列模型里';
      const TR2 = '不可或缺的一部分。';
      const ptr = tool(cam, 'pointer');
      const rip = ripple(cam);
      marks.forEach((mk, j) => {
        sfx('scribble', mk.t0, 0.42);
        sfx('pop', mk.t0 + 0.45);
      });
      sfx('ding', 3.2);
      sfx('swish', 4.0);
      sfx('scribble', 4.3, 0.4);
      sfx('pop', 4.8);
      sfx('click', 5.35);
      sfx('pop', 5.55);
      sfx('type', 5.7, 1.1);
      return {
        render(u) {
          lab1.render(u, 0.15, 3.9);
          lab2.render(u, 4.1);
          // the buddy sweeps along each sentence, painting it
          let bx = 1760;
          let by = 120;
          for (const mk of marks) {
            const k = seg(u, mk.t0, mk.t0 + 0.42);
            mk.wp.set(k);
            if (u >= mk.t0 - 0.2) {
              const into = E.inOut(seg(u, mk.t0 - 0.2, mk.t0));
              bx = lerp(bx, lerp(mk.sp.x0, mk.sp.x0 + mk.sp.w, k), into);
              by = lerp(by, mk.y - 70, into);
            }
            popIn(mk.pill, u, mk.t0 + 0.45, { x: 1500, y: mk.y - 10, rot: -4, out: 3.9 });
          }
          if (u > 3.05) {
            const away = E.inOut(seg(u, 3.05, 3.6));
            bx = lerp(bx, 2100, away);
            by = lerp(by, -100, away);
          }
          bud.set({ x: bx, y: by, scale: 0.45, t: u, blink: blinkAt(u, 1.9), opacity: clamp((u - 0.3) * 4) });
          popIn(toast, u, 3.2, { x: 960, y: 1030, out: 4.0 });
          // camera leans in for the translation
          const z = E.inOutQuint(seg(u, 3.95, 4.6));
          cam.setAttribute('transform', `translate(960 386) scale(${lerp(1, 1.18, z)}) translate(${-960 + z * 40} -386)`);
          selWipe.set(seg(u, 4.3, 4.7));
          popIn(bar, u, 4.8, { x: 1000, y: 262 + 2 * 62 - 110 });
          const bt = [1000 - 275 + 3 * 110, 262 + 2 * 62 - 110];
          const pk = E.inOut(seg(u, 4.85, 5.3));
          place(ptr, lerp(1500, bt[0], pk), lerp(980, bt[1] + 6, pk), u > 5.32 && u < 5.45 ? 0.85 : 1);
          ptr.setAttribute('opacity', clamp((u - 4.8) * 5) * (1 - clamp((u - 6.2) * 4)));
          rip.at(u, 5.35, bt[0], bt[1]);
          popIn(card, u, 5.55, { x: 1010, y: 262 + 2 * 62 + 160 });
          const n = Math.floor(([...TR1].length + [...TR2].length) * seg(u, 5.7, 6.8));
          tr1.textContent = [...TR1].slice(0, n).join('');
          tr2.textContent = [...TR2].slice(0, Math.max(0, n - [...TR1].length)).join('');
        },
      };
    },
    { enter: 'slide', tint: '#f7f3ff' },
  );

  // ===== 9. 白板：请页老师上白板 =====
  scene(
    'board',
    5,
    (S, sfx) => {
      const w = S.world;
      const head1 = letters(w, '没读懂？', 960, 420, { font: FONT.title, size: 150, fill: C.ink, anchor: 'middle' });
      const head2 = letters(w, '请页老师上白板！', 960, 600, { font: FONT.title, size: 110, fill: C.tealD, anchor: 'middle' });
      const board = g(w);
      shape(board, rectD(380, 70, 1460, 860, 30, 150, 2), { fill: '#fffefa', sw: 6, off: [8, 10] });
      s('rect', { x: 400, y: 90, width: 1420, height: 820, fill: 'url(#dots)', opacity: 0.6 }, board);
      shape(board, rectD(520, 930, 1180, 26, 10, 151, 1), { fill: '#d9cfbd', sw: 4 });
      const ink = g(board);
      const t1 = T(ink, '为什么要除以 √dₖ ？', 460, 205, { size: 66 });
      const t1w = wiper(S.defs, t1, 440, 130, 760, 100);
      const f = T(ink, '', 500, 320, { font: FONT.latin, size: 58 });
      for (const [txt, dy, size] of [['softmax( QK', 0, 58], ['T', -24, 34], [' / √dₖ ) · V', 24, 58]])
        s('tspan', { dy, 'font-size': size }, f).textContent = txt;
      const fw = wiper(S.defs, f, 480, 250, f.getComputedTextLength() + 40, 100);
      const dk = span(f, '√dₖ');
      const ring = stroke(ink, ellipseD(dk.x0 + dk.w / 2, 300, dk.w / 2 + 22, 46, 152, 2), { color: '#ff9a3c', sw: 7 });
      // left chart
      T(ink, '不缩放', 700, 455, { size: 46, anchor: 'middle' });
      const ax1 = stroke(ink, lineD(530, 690, 900, 690, 153, 1.5), { sw: 6 });
      const redBars = [190, 16, 11, 8].map((h, i) =>
        s('path', { d: rectD(560 + i * 85, 690 - h, 52, h, 6, 154 + i, 1), fill: '#ffb3b8', stroke: C.red, 'stroke-width': 5 }, ink),
      );
      const ringBar = stroke(ink, ellipseD(586, 590, 58, 128, 158, 2), { color: C.red, sw: 6 });
      const arrow = stroke(ink, lineD(940, 600, 1060, 600, 159, 1.5), { color: '#ff9a3c', sw: 6 });
      const ah = s('path', { d: headD(1060, 600, 0, 22), fill: 'none', stroke: '#ff9a3c', 'stroke-width': 6, 'stroke-linecap': 'round' }, ink);
      const aT = T(ink, '÷√dₖ', 1000, 575, { font: FONT.latin, size: 36, fill: '#ff9a3c', anchor: 'middle' });
      T(ink, '除以 √dₖ', 1300, 455, { size: 46, anchor: 'middle' });
      const ax2 = stroke(ink, lineD(1110, 690, 1490, 690, 160, 1.5), { sw: 6 });
      const blueBars = [130, 100, 76, 56].map((h, i) =>
        s('path', { d: rectD(1140 + i * 85, 690 - h, 52, h, 6, 161 + i, 1), fill: '#c9defc', stroke: C.blue, 'stroke-width': 5 }, ink),
      );
      const concl = T(ink, 'softmax 不饱和，梯度不消失！', 480, 805, { size: 58 });
      const cw = wiper(S.defs, concl, 460, 740, concl.getComputedTextLength() + 40, 100);
      const cb = concl.getComputedTextLength();
      const box = stroke(ink, rectD(450, 735, cb + 60, 100, 14, 165, 2.5), { color: '#3bb273', sw: 7 });
      const sm = span(concl, 'softmax');
      const studentRing = stroke(ink, ellipseD(sm.x0 + sm.w / 2, 787, sm.w / 2 + 22, 44, 166, 2.5), { color: '#8a6cff', sw: 7 });
      const marker = tool(w, 'marker');
      const purple = tool(w, 'purple');
      const t0 = g(w);
      const teacher = new Mascot(t0);
      const bulb = g(w);
      s('path', { d: 'M0 -40 a32 32 0 1 1 1 0 q10 20 6 34 l-14 0 q-4 -14 7 -34z', fill: C.yellow, stroke: C.ink, 'stroke-width': 4.5, transform: 'translate(-1 0)' }, bulb);
      s('rect', { x: -12, y: -4, width: 24, height: 14, rx: 4, fill: '#ccc', stroke: C.ink, 'stroke-width': 4 }, bulb);
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.5;
        s('path', { d: lineD(Math.cos(a) * 52, -70 + Math.sin(a) * 52, Math.cos(a) * 72, -70 + Math.sin(a) * 72, i, 0.5), stroke: C.yellow, 'stroke-width': 6, 'stroke-linecap': 'round' }, bulb);
      }
      const capBox = g(w);
      shape(capBox, rectD(420, 846, 1380, 70, 22, 167, 1.2), { fill: '#f1f8f5', stroke: C.tealD, sw: 3.5, off: [0, 0] });
      const cap = T(capBox, '', 470, 893, { size: 38, fill: C.tealD });
      const CAPS = [
        [2.5, '公式里，为什么要除以 √dₖ 呢？'],
        [4.4, '分数差太大，权重全挤到一个词上～'],
        [6.0, '除以 √dₖ，分数就回到正常范围啦'],
        [7.0, '所以 softmax 不饱和，梯度不消失！'],
        [9.0, '好问题！我换个说法再讲一遍～'],
      ];
      const ask = new Bubble(w, { x: 1560, y: 1000, w: 560, h: 104, tail: [1700, 1110], fill: C.violetL, lines: ['“饱和”是什么意思？'], size: 42 });
      sfx('pop', 0.15);
      sfx('pop', 0.45);
      sfx('boing', 0.9);
      sfx('swish', 1.8);
      [[2.5, 0.7], [3.2, 0.7], [3.9, 0.45], [4.6, 0.5], [5.3, 0.4], [5.7, 0.3], [7.0, 0.7], [7.7, 0.4]].forEach(([a, d]) => sfx('scribble', a, d));
      [0, 1, 2, 3].forEach((i) => sfx('pop', 4.9 + i * 0.1));
      [0, 1, 2, 3].forEach((i) => sfx('pop', 6.05 + i * 0.18));
      sfx('scribble', 8.2, 0.45);
      sfx('pop', 8.6);
      sfx('ding', 9.0);
      return {
        render(u) {
          popLetters(head1, u, 0.15, { stagger: 0.07, out: 1.75 });
          popLetters(head2, u, 0.45, { stagger: 0.05, out: 1.8 });
          const up = E.outQuint(seg(u, 1.8, 2.5));
          board.setAttribute('transform', `translate(0 ${(1 - up) * 1100})`);
          capBox.setAttribute('transform', `translate(0 ${(1 - up) * 1100})`);
          // teacher: pops in on the right with the titles, then walks to the board
          const pk = spring(u - 0.85, 2, 0.5);
          const go = E.inOut(seg(u, 1.8, 2.4));
          const talk = u > 2.5 && u < 9.6 && Math.sin(u * 14) > 0;
          teacher.set({
            x: lerp(1560, 205, go),
            y: 1050,
            scale: lerp(1.15, 1, go),
            ...idle(u),
            glasses: true,
            lift: go > 0 && go < 1 ? Math.abs(Math.sin(u * 13)) * 22 : 0,
            mood: u > 9 ? 'happy' : talk ? 'talk' : 'smile',
            raiseR: u > 2.4 ? 70 + Math.sin(u * 3) * 10 : 30,
            look: [5, -3],
            opacity: clamp(pk * 3),
          });
          t0.setAttribute('transform', `translate(0 ${(1 - clamp(pk)) * 120})`);
          // the marker writes and draws, one thing after another
          t1w.set(seg(u, 2.5, 3.2));
          fw.set(seg(u, 3.2, 3.9));
          ring.draw(seg(u, 3.9, 4.35));
          ax1.draw(seg(u, 4.6, 4.9));
          redBars.forEach((b, i) => {
            const k = E.outBack(seg(u, 4.9 + i * 0.1, 5.2 + i * 0.1));
            b.setAttribute('transform', `translate(0 690) scale(1 ${Math.max(0, k)}) translate(0 -690)`);
            b.setAttribute('opacity', u > 4.9 + i * 0.1 ? 1 : 0);
          });
          ringBar.draw(seg(u, 5.3, 5.7));
          arrow.draw(seg(u, 5.7, 6.0));
          ah.setAttribute('opacity', u > 6.0 ? 1 : 0);
          aT.setAttribute('opacity', clamp((u - 5.8) * 4));
          ax2.draw(seg(u, 5.9, 6.1));
          blueBars.forEach((b, i) => {
            const k = E.outBack(seg(u, 6.05 + i * 0.18, 6.4 + i * 0.18));
            b.setAttribute('transform', `translate(0 690) scale(1 ${Math.max(0, k)}) translate(0 -690)`);
            b.setAttribute('opacity', u > 6.05 + i * 0.18 ? 1 : 0);
          });
          cw.set(seg(u, 7.0, 7.7));
          box.draw(seg(u, 7.7, 8.1));
          // where the marker is
          const steps = [
            [2.5, 3.2, () => [t1w.x + t1w.w * seg(u, 2.5, 3.2), 190]],
            [3.2, 3.9, () => [fw.x + fw.w * seg(u, 3.2, 3.9), 300]],
            [3.9, 4.35, () => ring],
            [4.6, 4.9, () => ax1],
            [5.3, 5.7, () => ringBar],
            [5.7, 6.0, () => arrow],
            [7.0, 7.7, () => [cw.x + cw.w * seg(u, 7.0, 7.7), 790]],
            [7.7, 8.1, () => box],
          ];
          const on = steps.find(([a, b]) => u >= a && u <= b);
          showTool(marker, !!on);
          if (on) {
            const v = on[2]();
            if (Array.isArray(v)) place(marker, v[0], v[1] + Math.sin(u * 46) * 7);
            else follow(marker, v, seg(u, on[0], on[1]));
          }
          // a student circles what they did not get
          studentRing.draw(seg(u, 8.2, 8.65));
          showTool(purple, u > 8.15 && u < 8.7);
          follow(purple, studentRing, seg(u, 8.2, 8.65));
          ask.show(u, 8.6);
          popIn(bulb, u, 9.0, { x: 205, y: 690 });
          const c = CAPS.filter(([a]) => u >= a).at(-1);
          if (c) {
            const chars = [...c[1]];
            cap.textContent = chars.slice(0, Math.ceil(chars.length * clamp((u - c[0]) / 0.6))).join('');
          } else cap.textContent = '';
        },
      };
    },
    { enter: 'flip', tint: '#eefaf4' },
  );

  // ===== 10. 源码：说一句就改好 =====
  scene(
    'source',
    2.5,
    (S, sfx) => {
      const w = S.world;
      const head = letters(w, '说一句，改源码～', 960, 115, { font: FONT.title, size: 84, fill: C.ink, anchor: 'middle' });
      const code = g(w);
      shape(code, rectD(100, 170, 880, 690, 28, 170, 1.8), { fill: '#fffdf6', sw: 5 });
      T(code, '源码', 140, 230, { size: 36, fill: C.ink2 });
      const rows = g(code);
      const LINES = [
        [['<div ', C.coral], ['class=', '#8a6cff'], ['"tldr"', C.tealD], ['>', C.coral]],
        [['  <b>', C.coral], ['一句话总结', C.ink], ['</b>', C.coral]],
        [['  <p>', C.coral], ['Transformer 完全基于…', C.ink], ['</p>', C.coral]],
        [['</div>', C.coral]],
        [],
        [['.tldr', '#8a6cff'], [' {', C.ink]],
        [['  background: ', C.ink], ['white', C.tealD], [';', C.ink]],
        [['}', C.ink]],
      ];
      const rowEls = LINES.map((parts, i) => {
        const r = g(rows);
        T(r, String(i + 1), 150, 0, { font: FONT.latin, size: 28, fill: '#c4bba9', anchor: 'end' });
        let x = 180;
        for (const [txt, col] of parts) {
          const t = T(r, txt, x, 0, { font: FONT.latin, size: 32, fill: col });
          x += t.getComputedTextLength();
        }
        return r;
      });
      const strike = stroke(rows, lineD(180, -10, 560, -12, 171, 1), { color: C.red, sw: 6 });
      const redBg = s('path', { d: rectD(168, -42, 420, 50, 8, 172, 1), fill: '#ffd5d8', opacity: 0 }, rows);
      rows.insertBefore(redBg, rows.firstChild);
      const added = g(rows);
      shape(added, rectD(168, -42, 620, 100, 8, 173, 1), { fill: '#d6f5e3', sw: 0, off: [0, 0] });
      T(added, '+ ', 150, 0, { font: FONT.latin, size: 30, fill: '#3bb273' });
      T(added, '  border-left: 8px solid teal;', 180, 0, { font: FONT.latin, size: 32, fill: '#2b7a4b' });
      T(added, '  background: mint;', 180, 48, { font: FONT.latin, size: 32, fill: '#2b7a4b' });
      const applyBtn = g(code);
      shape(applyBtn, rectD(-100, -32, 200, 64, 32, 174, 1.2), { fill: C.teal, sw: 4 });
      T(applyBtn, '应用修改', 0, 12, { size: 34, fill: '#fff', anchor: 'middle' });
      const check = g(w);
      s('circle', { r: 34, fill: '#3bb273', stroke: C.ink, 'stroke-width': 4 }, check);
      s('path', { d: 'M-15 1 L-4 13 L17 -12', fill: 'none', stroke: '#fff', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, check);
      // preview
      const prev = g(w);
      shape(prev, rectD(1040, 170, 780, 690, 28, 175, 1.8), { fill: '#fff', sw: 5 });
      T(prev, '实时预览', 1080, 230, { size: 36, fill: C.ink2 });
      T(prev, 'Attention Is All You Need', 1090, 320, { font: FONT.latin, size: 40, weight: 700 });
      const tl = g(prev);
      const plain = s('path', { d: rectD(1090, 370, 680, 250, 18, 176, 1.6), fill: '#fff', stroke: '#cfc6b4', 'stroke-width': 4 }, tl);
      const fancy = s('path', { d: rectD(1090, 370, 680, 250, 18, 176, 1.6), fill: C.tealL, stroke: C.tealD, 'stroke-width': 4, opacity: 0 }, tl);
      const bar = s('path', { d: rectD(1086, 372, 16, 246, 6, 177, 1), fill: C.tealD }, tl);
      T(tl, '一句话总结', 1130, 425, { size: 34, fill: C.coral });
      scribbles(tl, 1130, 480, 580, 3, { gap: 40, seed: 178 });
      scribbles(prev, 1090, 680, 680, 4, { gap: 38, seed: 179 });
      const m = new Mascot(w);
      const say = new Bubble(w, { x: 640, y: 960, w: 560, h: 100, tail: [430, 1000], lines: ['让总结更醒目一点～'], size: 44 });
      const wand = tool(m.armR.hand, 'wand');
      wand.setAttribute('transform', 'rotate(140) scale(.9)');
      const sp = g(w);
      const spark = [0, 1, 2, 3, 4, 5].map((i) => s('path', { d: sparkleD(0, 0, 18 + (i % 3) * 6), fill: [C.yellow, C.pink, C.sky][i % 3], stroke: C.ink, 'stroke-width': 3 }, sp));
      const ptr = tool(w, 'pointer');
      const rip = ripple(w, C.teal);
      sfx('pop', 0.1);
      sfx('type', 0.3, 0.8);
      sfx('sparkle', 1.25);
      sfx('scribble', 1.35, 0.3);
      sfx('swish', 1.7);
      sfx('click', 3.25);
      sfx('ding', 3.35);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.05 });
          say.show(u, 0.2, 4.4);
          say.type(u, 0.3, 1.1);
          const wave = E.out(seg(u, 1.0, 1.25));
          m.set({ x: 300, y: 1060, scale: 0.85, ...idle(u), raiseR: 60 + wave * 70 + Math.sin(u * 9) * 6 * wave, mood: u > 3.3 ? 'happy' : 'smile', look: [5, -4] });
          spark.forEach((e, i) => {
            const a = (i / 6) * Math.PI * 2 + u * 2;
            const k = seg(u, 1.2, 1.9);
            const r = 30 + k * 110;
            place(e, 420 + Math.cos(a) * r, 610 + Math.sin(a) * r * 0.5, Math.sin(Math.PI * k), u * 120);
            e.setAttribute('opacity', k > 0 && k < 1 ? 1 : 0);
          });
          // the old line is struck out, two new ones slide in below it
          redBg.setAttribute('opacity', clamp((u - 1.3) * 5) * 0.9);
          strike.draw(seg(u, 1.35, 1.65));
          const ins = E.outBack(seg(u, 1.7, 2.1));
          rowEls.forEach((r, i) => r.setAttribute('transform', `translate(0 ${300 + i * 56 + (i > 6 ? ins * 100 : 0)})`));
          strike.setAttribute('transform', `translate(0 ${300 + 6 * 56})`);
          redBg.setAttribute('transform', `translate(0 ${300 + 6 * 56})`);
          added.setAttribute('transform', `translate(${(1 - ins) * -40} ${300 + 7 * 56})`);
          added.setAttribute('opacity', clamp(ins * 2));
          // preview restyles itself
          const k = E.inOut(seg(u, 2.1, 2.7));
          fancy.setAttribute('opacity', k);
          plain.setAttribute('opacity', 1 - k);
          bar.setAttribute('transform', `translate(0 ${372 + 246 / 2}) scale(1 ${k}) translate(0 ${-372 - 246 / 2})`);
          tl.setAttribute('transform', `translate(1430 495) scale(${1 + Math.sin(Math.PI * k) * 0.03}) translate(-1430 -495)`);
          place(applyBtn, 820, 800, u > 3.25 && u < 3.4 ? 0.92 : 1);
          const pk = E.inOut(seg(u, 2.7, 3.2));
          place(ptr, lerp(1200, 828, pk), lerp(1060, 806, pk), u > 3.22 && u < 3.36 ? 0.85 : 1);
          ptr.setAttribute('opacity', clamp((u - 2.65) * 5) * (1 - clamp((u - 4.2) * 4)));
          rip.at(u, 3.25, 820, 800);
          popIn(check, u, 3.35, { x: 940, y: 750 });
        },
      };
    },
    { enter: 'slide' },
  );

  // ===== 11. 十套主题 =====
  scene(
    'themes',
    3,
    (S, sfx) => {
      const w = S.world;
      const head = letters(w, '十套主题，换种心情读～', 960, 140, { font: FONT.title, size: 84, fill: C.ink, anchor: 'middle' });
      const holder = g(w, { transform: 'translate(560 220)' });
      const a = new AppWin(holder, { w: 1120, h: 700, seed: 190 });
      const topG = g(holder);
      const b = new AppWin(topG, { w: 1120, h: 700, seed: 190 });
      const cp = s('clipPath', { id: 'themeClip' }, S.defs);
      const circ = s('path', { d: '' }, cp);
      topG.setAttribute('clip-path', 'url(#themeClip)');
      const edgeBox = g(holder);
      wiper(S.defs, edgeBox, 0, 0, 1120, 700).set(1);
      const edge = s('path', { fill: 'none', stroke: C.ink, 'stroke-width': 5, 'stroke-dasharray': '2 14', 'stroke-linecap': 'round' }, edgeBox);
      const name = g(w);
      const nameBox = shape(name, rectD(-120, -46, 240, 92, 46, 191, 1.4), { fill: '#fff', sw: 5 });
      const nameT = T(name, '', 0, 18, { font: FONT.title, size: 52, anchor: 'middle' });
      const m = new Mascot(w);
      const START = 0.6;
      const STEP = 0.5;
      for (let i = 1; i < PALETTES.length; i++) {
        EVENTS.themes.push(S.t0 + START + (i - 1) * STEP);
        sfx('pop', START + (i - 1) * STEP);
      }
      sfx('pop', 0.1);
      sfx('sparkle', 5.3);
      return {
        render(u) {
          popLetters(head, u, 0.1, { stagger: 0.045 });
          const i = clamp(Math.floor((u - START) / STEP) + 1, 0, PALETTES.length - 1);
          const k = u < START ? 1 : clamp((u - START - (i - 1) * STEP) / 0.36);
          const cur = PALETTES[i];
          const prev = PALETTES[Math.max(0, i - 1)];
          a.setTheme(i === 0 ? cur : prev);
          b.setTheme(cur);
          const r = i === 0 ? 2000 : E.out(k) * 1450;
          const d = ellipseD(1080, 31, Math.max(1, r), Math.max(1, r), 192 + i, Math.min(18, r * 0.06), 0, 0);
          circ.setAttribute('d', d + 'Z');
          edge.setAttribute('d', d);
          edge.setAttribute('opacity', i > 0 && k < 1 ? 1 - k : 0);
          edge.setAttribute('stroke', cur.accent);
          const pin = spring(u - (u < START ? 0.2 : START + (i - 1) * STEP), 2.8, 0.4);
          place(name, 640, 990, 0.8 + 0.2 * clamp(pin, 0, 1.3), (1 - clamp(pin)) * 8);
          nameT.textContent = cur.name;
          nameBox.f.setAttribute('fill', cur.mascot);
          nameT.setAttribute('fill', ['夜读', '墨金', '终端', '极光'].includes(cur.name) ? '#fff' : C.ink);
          const h = hop(u - (START + (i - 1) * STEP), 46, 0.3);
          const enter = spring(u - 0.3, 2, 0.5);
          m.set({ x: 1740, y: 1060 + (1 - clamp(enter)) * 300, scale: 0.95, ...idle(u), lift: i > 0 ? h.lift : 0, sq: i > 0 ? h.sq : 0, color: cur.mascot, mood: u > 5.2 ? 'happy' : 'smile', raiseL: 40 + h.lift, raiseR: 40 + h.lift, look: [-5, -2] });
        },
      };
    },
    { enter: 'iris', at: [1640, 250] },
  );

  // ===== 12. 片尾 =====
  scene(
    'outro',
    3,
    (S, sfx) => {
      const w = S.world;
      const boom = confetti(g(w), { x: 960, y: 380, n: 54 });
      const m = new Mascot(w);
      const titleRow = g(w);
      const zh = letters(titleRow, '页间', 900, 720, { font: FONT.title, size: 150, fill: C.ink, anchor: 'middle' });
      const en = T(titleRow, 'Folio', 1150, 714, { font: FONT.latin, size: 86, fill: C.tealD, anchor: 'middle', weight: 700 });
      const tag = letters(w, '读得进，也读得懂～', 960, 822, { font: FONT.hand, size: 58, fill: C.ink2, anchor: 'middle' });
      const btn = g(w);
      shape(btn, rectD(-320, -44, 640, 88, 44, 200, 1.4), { fill: C.teal, sw: 5 });
      T(btn, '免费下载 · macOS / Windows', 0, 15, { size: 44, fill: '#fff', anchor: 'middle' });
      const url = T(w, 'helloxxy.com/works/folio', 960, 1040, { font: FONT.latin, size: 38, fill: C.ink2, anchor: 'middle' });
      const bye = new Bubble(w, { x: 1310, y: 250, w: 300, h: 110, tail: [1110, 330], lines: ['下次见～'], size: 56, font: FONT.title });
      const dood = sparkles(w, [
        [520, 300, 32, 'star'],
        [1420, 520, 28],
        [460, 620, 24, 'heart'],
        [1500, 760, 26, 'star'],
        [380, 860, 22],
        [1560, 950, 22, 'heart'],
      ], 2);
      sfx('boing', 0.15);
      sfx('sparkle', 0.45);
      sfx('pop', 0.9);
      sfx('pop', 1.05);
      sfx('pop', 1.9);
      sfx('pop', 3.4);
      return {
        render(u) {
          const h = hop(u - 0.15, 160, 0.55);
          const waving = clamp(seg(u, 3.3, 3.5)) * (1 - seg(u, 5.4, 5.7));
          m.set({
            x: 960,
            y: 560,
            scale: 1.15,
            ...idle(u),
            lift: h.lift,
            sq: h.sq + Math.sin(u * 4.2) * 0.02,
            raiseL: h.lift > 10 ? 160 : 20,
            raiseR: h.lift > 10 ? 160 : waving * (140 + Math.sin(u * 14) * 18) + 20 * (1 - waving),
            mood: u < 3.2 ? 'happy' : 'smile',
            sway: Math.sin(u * 3) * 6 - h.sq * 20,
          });
          boom(u, 0.45);
          popLetters(zh, u, 0.9, { stagger: 0.15 });
          en.setAttribute('opacity', clamp((u - 1.2) * 4));
          en.setAttribute('transform', `translate(0 ${(1 - E.outBack(seg(u, 1.2, 1.6))) * 30})`);
          popLetters(tag, u, 1.4, { stagger: 0.04 });
          popIn(btn, u, 1.9, { x: 960, y: 930 });
          url.setAttribute('opacity', clamp((u - 2.3) * 3));
          bye.show(u, 3.35);
          twinkle(dood, u, 1.0);
          const out = E.inOut(seg(u, 5.4, 6.0));
          S.world.setAttribute('opacity', 1 - out);
        },
      };
    },
    { enter: 'iris', at: [960, 450] },
  );

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
        const rad = E.inOutQuint(k) * 2300;
        r.style.clipPath = `circle(${rad}px at ${S.at[0]}px ${S.at[1]}px)`;
        if (k > 0 && k < 1) {
          ring.setAttribute('d', ellipseD(S.at[0], S.at[1], rad, rad, 7, 6, 0.02));
          ring.setAttribute('opacity', 1);
        }
      } else if (S.enter === 'slide') {
        r.style.transform = `translateX(${(1 - E.outBack(k)) * 1920}px)`;
        r.style.boxShadow = '-30px 0 60px rgba(61,58,75,.18)';
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
        r.style.zIndex = 5;
        r.style.boxShadow = `${20 + 60 * k}px 0 80px rgba(61,58,75,${0.25 * Math.sin(Math.PI * k)})`;
      }
      if (v >= TR / 2) vis = false;
    }
    if (next && next.enter === 'slide') {
      const v = t - next.t0;
      if (v > -TR / 2 && v < TR / 2) {
        r.style.transform = `translateX(${-E.inOut(seg(v, -TR / 2, TR / 2)) * 600}px)`;
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
