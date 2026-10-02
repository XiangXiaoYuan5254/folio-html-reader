// 两个版本共用的动画工具：缓动、弹簧、平滑曲线、DOM 小工具、调试用的进度条。
// ---------- 数学与缓动 ----------
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const E = {
  linear: (k) => k,
  in: (k) => k * k * k,
  out: (k) => 1 - Math.pow(1 - k, 3),
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  outQuint: (k) => 1 - Math.pow(1 - k, 5),
  inOutQuint: (k) => (k < 0.5 ? 16 * k ** 5 : 1 - Math.pow(-2 * k + 2, 5) / 2),
  outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
  inExpo: (k) => (k <= 0 ? 0 : Math.pow(2, 10 * k - 10)),
  outBack: (k) => 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2),
};
// Underdamped spring from 0 to 1, t in seconds.
export function spring(t, freq = 2, damp = 0.5) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq;
  const wd = w * Math.sqrt(1 - damp * damp);
  return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + ((damp * w) / wd) * Math.sin(wd * t));
}
// Smooth monotone curve through points (Fritsch–Carlson), linear past the ends.
export function monotone(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = pts.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      m[i] = (3 / Math.sqrt(s)) * a * d[i];
      m[i + 1] = (3 / Math.sqrt(s)) * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0] + (x - xs[0]) * m[0];
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]) * m[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

// ---------- DOM ----------
export function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  parent?.append(e);
  return e;
}
export function css(e, styles) {
  for (const k in styles) e.style[k] = styles[k];
}
// Text split into characters for staggered reveals.
export function chars(parent, cls, text, style) {
  const box = el('div', cls, parent);
  if (style) css(box, style);
  box.chars = [...text].map((c) => el('span', 'ch', box, c === ' ' ? '&nbsp;' : c));
  return box;
}
export function revealChars(box, t, t0, { stagger = 0.035, dur = 0.9, dy = 0.45, blur = 14 } = {}) {
  box.chars.forEach((s, i) => {
    const k = E.outExpo(seg(t, t0 + i * stagger, t0 + i * stagger + dur));
    s.style.opacity = k;
    s.style.transform = `translateY(${((1 - k) * dy).toFixed(3)}em)`;
    s.style.filter = k < 0.999 ? `blur(${((1 - k) * blur).toFixed(2)}px)` : 'none';
  });
}
// Fade a whole element in (k: 0→1) with a lift and blur.
export function fadeIn(e, k, { dy = 30, blur = 12, scale = 1 } = {}) {
  e.style.opacity = k;
  e.style.transform = `translateY(${(1 - k) * dy}px) scale(${lerp(scale, 1, k)})`;
  e.style.filter = k < 0.999 ? `blur(${(1 - k) * blur}px)` : 'none';
}
export function fadeOut(e, k, { dy = -24, blur = 12, scale = 1 } = {}) {
  e.style.opacity = 1 - k;
  e.style.transform = `translateY(${k * dy}px) scale(${lerp(1, scale, k)})`;
  e.style.filter = k > 0.001 ? `blur(${k * blur}px)` : 'none';
}


// ?preview: a scrub bar to drag through the timeline or play it.
export function startPreview(stage, seek, total, from = 0) {
  const W = 1920;
  const H = 1080;
  const bar = document.getElementById('scrub');
  bar.hidden = false;
  const range = document.getElementById('time');
  const clock = document.getElementById('clock');
  range.max = total;
  let playing = false;
  let start = 0;
  let at = 0;
  const show = (x) => {
    range.value = x;
    clock.textContent = `${x.toFixed(2)} / ${total.toFixed(2)}`;
  };
  range.oninput = () => {
    playing = false;
    seek(Number(range.value));
    show(Number(range.value));
  };
  document.getElementById('play').onclick = () => {
    playing = !playing;
    start = performance.now();
    at = Number(range.value);
    const loop = async () => {
      if (!playing) return;
      const x = (at + (performance.now() - start) / 1000) % total;
      await seek(x);
      show(x);
      requestAnimationFrame(loop);
    };
    loop();
  };
  show(from);
  const fit = () => (stage.style.zoom = Math.min(innerWidth / W, (innerHeight - 40) / H));
  addEventListener('resize', fit);
  fit();
}
