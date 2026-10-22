// 宣传片（纸页版）的配乐：钢琴和弦乐，用 GarageBand 自带的采样（Steinway D 钢琴、弦乐合奏），
// Apple Loops 和这些采样可以免版税用在自己的视频配乐里。曲子按 film.html 的时间表写：90 BPM，
// 片头 B 小调、走神时一个高音，换一种读法时悬停，图标出来落到 D 大调，功能部分是左手分解和弦、
// 右手旋律，换主题时一串十六分音符，盖章时落在 D 大调上。翻页、点击、打字、盖章的声音按画面的时间点加。
//
//   node scripts/promo-video/music-film.mjs     读 out/timeline-film.json，写 out/music-film.wav
import fs from 'node:fs/promises';
import { openSync, readSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SR = 48000;
const TAU = Math.PI * 2;
const LOGIC = '/Library/Application Support/Logic';
const PIANO_CAF = `${LOGIC}/EXS Factory Samples/01 Acoustic Pianos/Steinway Piano_consolidated.caf`;
const PIANO_EXS = `${LOGIC}/Sampler Instruments/01 Acoustic Pianos/Steinway Grand Piano 2.exs`;
const STRINGS =
  '/Library/Application Support/GarageBand/Instrument Library/Sampler/Sampler Files/String Ensemble';

let seed = 20261016;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const noise = () => rnd() * 2 - 1;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const interleave = ({ L, R }) => {
  const o = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) ((o[2 * i] = L[i]), (o[2 * i + 1] = R[i]));
  return o;
};

// ---------- 钢琴：Logic 的 EXS 映射表 + 合并在一个 CAF 里的采样 ----------
function readExs(file) {
  const b = readFileSync(file);
  const zones = [];
  const groups = [];
  for (let i = 0; i < b.length - 20;) {
    const sig = b.readUInt32LE(i);
    const size = b.readUInt32LE(i + 4);
    if (b.toString('latin1', i + 16, i + 20) !== 'TBOS') break;
    const type = sig >>> 24;
    const name = b.toString('latin1', i + 20, i + 84).split('\0')[0];
    if (type === 0x41)
      zones.push({
        root: b[i + 85],
        tune: b.readInt8(i + 86),
        vol: b.readInt8(i + 88),
        lo: b[i + 90],
        hi: b[i + 91],
        a: b.readUInt32LE(i + 96),
        e: b.readUInt32LE(i + 108),
        g: b.readInt32LE(i + 172),
      });
    if (type === 0x42) groups.push({ name, vlo: b[i + 89], vhi: b[i + 90] });
    i += 84 + size;
  }
  // Pedal-down groups are sympathetic resonance layers; the plain layers are enough here.
  return zones
    .filter((z) => !groups[z.g].name.startsWith('p'))
    .map((z) => ({ ...z, vlo: groups[z.g].vlo, vhi: groups[z.g].vhi }));
}
const pianoZones = readExs(PIANO_EXS);
const caf = openSync(PIANO_CAF, 'r');
const pianoCache = new Map();
// A zone's audio as float L/R at 44.1 kHz, at most `max` frames.
function pianoSample(z, max) {
  const n = Math.min(z.e - z.a, max);
  const key = z.a;
  const hit = pianoCache.get(key);
  if (hit && hit.L.length >= n) return hit;
  const buf = Buffer.alloc(n * 4);
  readSync(caf, buf, 0, n * 4, 4096 + z.a * 4);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = buf.readInt16BE(i * 4) / 32768;
    R[i] = buf.readInt16BE(i * 4 + 2) / 32768;
  }
  const s = { L, R };
  pianoCache.set(key, s);
  return s;
}

// ---------- 弦乐：WAV，带循环点 ----------
function readWav(file) {
  const b = readFileSync(file);
  let i = 12;
  let data = null;
  let loop = null;
  let unity = 60;
  let ch = 2;
  while (i < b.length - 8) {
    const id = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === 'fmt ') ch = b.readUInt16LE(i + 10);
    if (id === 'data') data = b.subarray(i + 8, i + 8 + size);
    if (id === 'smpl') {
      unity = b.readUInt32LE(i + 8 + 12);
      if (b.readUInt32LE(i + 8 + 28) > 0)
        loop = [b.readUInt32LE(i + 8 + 36 + 8), b.readUInt32LE(i + 8 + 36 + 12)];
    }
    i += 8 + size + (size & 1);
  }
  const n = data.length / (2 * ch);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    L[k] = data.readInt16LE(k * 2 * ch) / 32768;
    R[k] = data.readInt16LE(k * 2 * ch + (ch > 1 ? 2 : 0)) / 32768;
  }
  return { L, R, loop: loop || [Math.floor(n * 0.4), n - 1], unity };
}
// Soft and medium takes ("n", "m"); the loud ones are too rough under a piano.
const strings = readdirSync(STRINGS)
  .filter((f) => f.endsWith('.wav') && /^\d+[nm]/.test(f))
  .map((f) => ({ file: f, ...readWav(path.join(STRINGS, f)) }));

// 4-point Hermite interpolation.
function hermite(x, i, f) {
  const xm = x[i - 1] ?? x[i];
  const x0 = x[i];
  const x1 = x[i + 1] ?? x0;
  const x2 = x[i + 2] ?? x1;
  const c = (x1 - xm) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const bn = w + a;
  return ((a * f - bn) * f + c) * f + x0;
}

export async function makeMusic(ev, file, { stems } = {}) {
  const BEAT = 60 / ev.bpm;
  const BAR = BEAT * 4;
  const T = (bar, beat = 1) => (bar - 1) * BAR + (beat - 1) * BEAT;
  const dur = ev.duration + 4.5;
  const N = Math.ceil(dur * SR);
  const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
  const piano = bus();
  const strs = bus();
  const fx = bus();

  // ---------- 演奏 ----------
  // A piano note: held (pedal) for `len` seconds, then the dampers come down.
  function key(t, note, vel, len, pan = 0) {
    t += (rnd() - 0.5) * 0.012;
    vel = clamp(Math.round(vel + (rnd() - 0.5) * 6), 1, 127);
    const z =
      pianoZones.find((z) => vel >= z.vlo && vel <= z.vhi && note >= z.lo && note <= z.hi) ||
      pianoZones.find((z) => note >= z.lo && note <= z.hi);
    const ratio = Math.pow(2, (note - z.root - z.tune / 100) / 12) * (44100 / SR);
    const release = 0.35;
    const n = Math.floor((len + release) * SR);
    const src = pianoSample(z, Math.ceil(n * ratio) + 4);
    const g = Math.pow(vel / 127, 1.1) * Math.pow(10, z.vol / 20) * 0.9;
    const i0 = Math.floor(t * SR);
    const pl = Math.cos(((pan + 1) * Math.PI) / 4);
    const pr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const k = Math.floor(x);
      if (k + 2 >= src.L.length) break;
      const f = x - k;
      const tt = i / SR;
      // Fade the last ~40 ms of a sample that ends before the note does.
      const tail = clamp((src.L.length - 4 - x) / 1800);
      const env = (tt < len ? 1 : Math.exp(-(tt - len) / 0.11)) * tail;
      const o = i0 + i;
      if (o < 0 || o >= N) continue;
      piano.L[o] += hermite(src.L, k, f) * g * env * pl * 1.41;
      piano.R[o] += hermite(src.R, k, f) * g * env * pr * 1.41;
    }
  }
  // A string note: attack from the sample, then its loop, a slow swell and release.
  function bow(t, note, vel, len, { attack = 0.6, release = 1.4, pan = 0 } = {}) {
    let best = strings[0];
    for (const s of strings) if (Math.abs(s.unity - note) < Math.abs(best.unity - note)) best = s;
    const ratio = Math.pow(2, (note - best.unity) / 12) * (44100 / SR);
    const [ls, le] = best.loop;
    const span = le - ls;
    const n = Math.floor((len + release) * SR);
    const i0 = Math.floor(t * SR);
    const g = Math.pow(vel / 127, 1.4) * 0.55;
    const pl = Math.cos(((pan + 1) * Math.PI) / 4);
    const pr = Math.sin(((pan + 1) * Math.PI) / 4);
    const xf = 2400;
    for (let i = 0; i < n; i++) {
      let x = i * ratio;
      if (x >= le) x = ls + ((x - ls) % span);
      const k = Math.floor(x);
      const f = x - k;
      let l = hermite(best.L, k, f);
      let r = hermite(best.R, k, f);
      // Cross-fade into the loop start just before the loop end.
      if (k > le - xf && k < le) {
        const w = (k - (le - xf)) / xf;
        const k2 = k - span;
        l = l * (1 - w) + hermite(best.L, k2, f) * w;
        r = r * (1 - w) + hermite(best.R, k2, f) * w;
      }
      const tt = i / SR;
      const env =
        Math.min(1, tt / attack) ** 1.5 * (tt > len ? Math.exp(-(tt - len) * (3 / release)) : 1);
      const o = i0 + i;
      if (o < 0 || o >= N) continue;
      strs.L[o] += l * g * env * pl * 1.41;
      strs.R[o] += r * g * env * pr * 1.41;
    }
  }
  const chord = (t, notes, vel, len, opts) =>
    notes.forEach((m, i) =>
      bow(t, m, vel, len, { pan: (i / Math.max(1, notes.length - 1) - 0.5) * 0.7, ...opts }),
    );

  // ---------- 曲谱 ----------
  // Note names → MIDI.
  const M = (s) => {
    const [, n, acc, o] = s.match(/^([A-G])(#|b)?(-?\d)$/);
    return (
      12 * (Number(o) + 1) +
      { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[n] +
      (acc === '#' ? 1 : acc === 'b' ? -1 : 0)
    );
  };
  const LH = (t, names, vel, len) =>
    names.split(' ').forEach((n, i) => key(t + i * 0.012, M(n), vel - i * 3, len, -0.25));
  const RH = (bar, beat, name, beats, vel, pan = 0.15) =>
    key(T(bar, beat), M(name), vel, beats * BEAT + 0.15, pan);

  // 1–2：B 小调，很轻，像在翻一篇读不进去的论文。
  LH(T(1), 'B1 F#2', 40, BAR);
  RH(1, 1.0, 'D5', 1, 40);
  RH(1, 2, 'C#5', 1, 34);
  RH(1, 3, 'B4', 2, 38);
  LH(T(2), 'G1 D2', 40, BAR);
  RH(2, 1, 'D5', 1, 40);
  RH(2, 2, 'C#5', 1, 34);
  RH(2, 3, 'A4', 2, 36);
  // 走神：一个很高、很轻的音，像思绪飘走。
  for (const t of ev.ink) key(t, M('F#6'), 30, 2.2, 0.4);
  // 3：换一种读法。Em7 → Asus4，悬着。
  LH(T(3), 'E2 B2', 42, 2 * BEAT);
  key(T(3) + 0.05, M('G4'), 38, 2 * BEAT, 0.1);
  key(T(3) + 0.08, M('B4'), 36, 2 * BEAT, 0.15);
  key(T(3) + 0.11, M('D5'), 40, 2 * BEAT, 0.2);
  LH(T(3, 3), 'A1 E2', 42, 2 * BEAT);
  key(T(3, 3) + 0.05, M('A4'), 38, 2 * BEAT, 0.1);
  key(T(3, 3) + 0.08, M('D5'), 38, 2 * BEAT, 0.15);
  key(T(3, 3) + 0.11, M('E5'), 42, 2 * BEAT, 0.2);
  chord(T(3, 3), [M('A3'), M('E4')], 52, 2 * BEAT, { attack: 1.2, release: 0.6 });
  // 4：图标。D 大调，一闪一闪。
  LH(T(4), 'D2 A2 D3', 56, BAR + 0.2);
  for (const [n, d] of [
    ['F#4', 0.02],
    ['A4', 0.05],
    ['D5', 0.08],
  ])
    key(T(4) + d, M(n), 50, BAR, 0.15);
  RH(4, 2, 'A5', 1, 38, 0.3);
  RH(4, 2.5, 'D6', 1.5, 34, 0.35);
  RH(4, 4, 'C#5', 1, 44);
  chord(T(4), [M('D3'), M('A3'), M('F#4'), M('D5')], 62, BAR - 0.2, { attack: 0.45, release: 1.2 });

  // 5–13：主题。左手分解和弦，右手旋律，弦乐慢慢起来。
  const ARP = {
    D: 'D2 A2 D3 F#3 A3 F#3 D3 A2',
    'A/C#': 'C#2 A2 C#3 E3 A3 E3 C#3 A2',
    Bm: 'B1 F#2 B2 D3 F#3 D3 B2 F#2',
    G: 'G1 D2 G2 B2 D3 B2 G2 D2',
    'D/F#': 'F#2 A2 D3 F#3 A3 F#3 D3 A2',
    A: 'A1 E2 A2 C#3 E3 C#3 A2 E2',
    EmA: 'E2 B2 D3 G3 A1 E2 A2 C#3',
  };
  const PAD = {
    D: ['D3', 'A3', 'F#4'],
    'A/C#': ['C#3', 'A3', 'E4'],
    Bm: ['B2', 'F#3', 'D4'],
    G: ['G2', 'D3', 'B3'],
    'D/F#': ['F#2', 'A3', 'D4'],
    A: ['A2', 'E3', 'C#4'],
  };
  const PROG = {
    5: 'D',
    6: 'A/C#',
    7: 'Bm',
    8: 'G',
    9: 'D/F#',
    10: 'A',
    11: 'Bm',
    12: 'G',
    13: 'EmA',
  };
  for (let bar = 5; bar <= 13; bar++) {
    const c = PROG[bar];
    const notes = ARP[c].split(' ');
    const lift = bar >= 12 ? 6 : bar >= 8 ? 3 : 0;
    notes.forEach((n, i) => {
      const accent = i === 0 ? 8 : i === 4 ? 3 : 0;
      // Each eighth rings on (pedal) to the end of its half bar.
      const left = (i < 4 ? 4 - i : 8 - i) * (BEAT / 2);
      key(T(bar) + i * (BEAT / 2), M(n), 36 + accent + lift, left + 0.1, -0.3 + (i % 4) * 0.08);
    });
    const vel = bar >= 12 ? 50 : bar >= 8 ? 42 : 34;
    const extra = bar >= 12 ? { top: 12 } : {};
    if (c === 'EmA') {
      chord(T(bar), ['E3', 'B3', 'D4', 'G4'].map(M), vel, 2 * BEAT, { attack: 0.3, release: 0.4 });
      chord(T(bar, 3), ['A2', 'E3', 'C#4', 'E4', 'A4'].map(M), vel + 6, 2 * BEAT, {
        attack: 0.3,
        release: 0.5,
      });
    } else {
      const pad = PAD[c].map(M);
      if (extra.top) pad.push(pad.at(-1) + 12);
      chord(T(bar), pad, vel, BAR, { attack: bar === 5 ? 1.0 : 0.35, release: 0.7 });
    }
  }
  // The melody: A D F# | E . . C# | D . B C# | D . . . | A F# E D | E . C# A | B D F# . | G . . F# | E . A C# E A
  const MEL = [
    [5, 1, 'A4', 1, 56],
    [5, 2, 'D5', 1, 58],
    [5, 3, 'F#5', 2, 62],
    [6, 1, 'E5', 3, 60],
    [6, 4, 'C#5', 1, 54],
    [7, 1, 'D5', 2, 58],
    [7, 3, 'B4', 1, 52],
    [7, 4, 'C#5', 1, 54],
    [8, 1, 'D5', 4, 60],
    [8, 1, 'B4', 4, 44],
    [9, 1, 'A5', 1, 64],
    [9, 2, 'F#5', 1, 58],
    [9, 3, 'E5', 1, 56],
    [9, 4, 'D5', 1, 56],
    [10, 1, 'E5', 2, 62],
    [10, 3, 'C#5', 1, 56],
    [10, 4, 'A4', 1, 54],
    [11, 1, 'B4', 1, 58],
    [11, 2, 'D5', 1, 60],
    [11, 3, 'F#5', 2, 66],
    [12, 1, 'G5', 3, 70],
    [12, 1, 'D5', 3, 52],
    [12, 4, 'F#5', 1, 64],
    [13, 1, 'E5', 2, 66],
    [13, 1, 'G4', 2, 48],
    [13, 3, 'A4', 0.5, 56],
    [13, 3.5, 'C#5', 0.5, 58],
    [13, 4, 'E5', 0.5, 62],
    [13, 4.5, 'A5', 0.5, 66],
  ];
  for (const [bar, beat, n, beats, vel] of MEL) RH(bar, beat, n, beats, vel);

  // 14：换主题，十六分音符一路往上，每换一次一个音。
  LH(T(14), 'D2 D3', 54, 2 * BEAT);
  LH(T(14, 3), 'C#2 C#3', 52, 2 * BEAT);
  const RUN = ['D5', 'F#5', 'A5', 'D6', 'F#5', 'A5', 'D6', 'F#6', 'A5', 'D6'];
  const runAt = [ev.scenes.find((s) => s.id === 'themes').t0, ...ev.flips];
  RUN.forEach((n, i) =>
    key(runAt[i] ?? T(14) + i * (BEAT / 4), M(n), 52 + i * 2, 0.6, 0.1 + (i % 2) * 0.2),
  );
  RH(14, 3, 'C#6', 2, 60, 0.25);
  RH(14, 3, 'E5', 2, 46, 0.1);
  chord(T(14), ['D3', 'A3', 'F#4', 'D5'].map(M), 56, 2 * BEAT, { attack: 0.2, release: 0.4 });
  chord(T(14, 3), ['C#3', 'A3', 'E4', 'C#5'].map(M), 56, 2 * BEAT, { attack: 0.25, release: 0.5 });

  // 15：落款。G，然后 Asus4 → A。
  LH(T(15), 'G1 D2 G2', 50, 2 * BEAT);
  for (const [n, d] of [
    ['B4', 0.02],
    ['D5', 0.05],
    ['G5', 0.08],
  ])
    key(T(15) + d, M(n), 48, 2 * BEAT, 0.15);
  LH(T(15, 3), 'A1 E2 A2', 48, 2 * BEAT);
  for (const [n, d] of [
    ['A4', 0.02],
    ['D5', 0.05],
    ['E5', 0.08],
  ])
    key(T(15, 3) + d, M(n), 44, BEAT, 0.15);
  key(T(15, 4) + 0.05, M('C#5'), 42, BEAT, 0.15);
  chord(T(15), ['G2', 'D3', 'B3', 'G4'].map(M), 54, 2 * BEAT, { attack: 0.3, release: 0.5 });
  chord(T(15, 3), ['A2', 'E3', 'C#4', 'A4'].map(M), 54, 2 * BEAT, { attack: 0.3, release: 0.5 });
  // 16：盖章，D 大调加九音，慢慢散开。
  LH(T(16), 'D2 A2 D3', 54, 4.2);
  for (const [n, d] of [
    ['D4', 0.03],
    ['F#4', 0.06],
    ['A4', 0.09],
    ['E5', 0.12],
    ['F#5', 0.15],
  ])
    key(T(16) + d, M(n), 48, 4.2, 0.15);
  RH(16, 3, 'A5', 4, 32, 0.35);
  RH(16, 4, 'D6', 4, 26, 0.4);
  chord(T(16), ['D3', 'A3', 'F#4', 'A4', 'D5'].map(M), 56, 2.6, { attack: 0.4, release: 2.2 });

  // ---------- 声音效果 ----------
  function put(b, i, s, pan = 0) {
    if (i < 0 || i >= N) return;
    b.L[i] += s * Math.cos(((pan + 1) * Math.PI) / 4);
    b.R[i] += s * Math.sin(((pan + 1) * Math.PI) / 4);
  }
  // A page turning: air over paper, a rustle, a soft landing.
  function pageTurn(t0, vel = 0.07) {
    const len = 0.9;
    const i0 = Math.floor(t0 * SR);
    let low = 0;
    let band = 0;
    let crackle = 0;
    for (let i = 0; i < len * SR; i++) {
      const t = i / SR;
      const k = t / len;
      const env = Math.sin(Math.PI * Math.min(1, k * 1.15)) ** 2;
      const fc = 900 + 2600 * Math.sin(Math.PI * k);
      const g = 2 * Math.sin((Math.PI * fc) / SR);
      low += g * band;
      band += g * (noise() - low - 0.9 * band);
      if (rnd() < 0.004 * env) crackle = 1;
      crackle *= 0.985;
      const s = band * 0.7 * env + noise() * crackle * 0.25 * env;
      put(fx, i0 + i, s * vel, -0.4 + 0.8 * k);
    }
    // The landing.
    const j0 = Math.floor((t0 + 0.72) * SR);
    let lp = 0;
    for (let i = 0; i < 0.12 * SR; i++) {
      const t = i / SR;
      lp += 0.08 * (noise() - lp);
      put(
        fx,
        j0 + i,
        (lp * 2 + Math.sin(TAU * 140 * t) * 0.3) * Math.exp(-t * 40) * vel * 0.8,
        0.2,
      );
    }
  }
  function swish(t0, vel = 0.032) {
    const len = 0.6;
    const i0 = Math.floor(t0 * SR);
    let low = 0;
    let band = 0;
    for (let i = 0; i < len * SR; i++) {
      const t = i / SR;
      const k = t / len;
      const fc = 500 + 3500 * k;
      const g = 2 * Math.sin((Math.PI * fc) / SR);
      low += g * band;
      band += g * (noise() - low - 0.7 * band);
      put(fx, i0 + i, band * Math.sin(Math.PI * k) ** 2 * vel, -0.5 + k);
    }
  }
  function click(t0, vel = 0.05) {
    const i0 = Math.floor(t0 * SR);
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < 0.025 * SR; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.45 * (hp + x - prev);
      prev = x;
      put(
        fx,
        i0 + i,
        (hp * Math.exp(-t * 1100) + Math.sin(TAU * 2200 * t) * Math.exp(-t * 300) * 0.25) * vel,
        0.1,
      );
    }
  }
  function tap(t0, vel = 0.025) {
    const i0 = Math.floor(t0 * SR);
    let lp = 0;
    const f = 1500 + rnd() * 800;
    for (let i = 0; i < 0.03 * SR; i++) {
      const t = i / SR;
      lp += 0.3 * (noise() - lp);
      put(
        fx,
        i0 + i,
        (lp * Math.exp(-t * 500) + Math.sin(TAU * f * t) * Math.exp(-t * 400) * 0.2) * vel,
        -0.1,
      );
    }
  }
  // A pen dragged across paper.
  function scratch(t0, len = 0.42, vel = 0.05) {
    const i0 = Math.floor(t0 * SR);
    let low = 0;
    let band = 0;
    for (let i = 0; i < len * SR; i++) {
      const t = i / SR;
      const g = 2 * Math.sin((Math.PI * 4200) / SR);
      low += g * band;
      band += g * (noise() - low - 0.5 * band);
      const grain = 0.6 + 0.4 * Math.sin(TAU * 38 * t) * Math.sin(TAU * 7 * t);
      put(fx, i0 + i, band * grain * Math.sin(Math.PI * (t / len)) * vel, 0.2);
    }
  }
  // The seal pressed on paper: a muffled thump.
  function stamp(t0, vel = 0.22) {
    const i0 = Math.floor(t0 * SR);
    let lp = 0;
    let ph = 0;
    for (let i = 0; i < 0.35 * SR; i++) {
      const t = i / SR;
      ph += (TAU * (70 + 60 * Math.exp(-t * 30))) / SR;
      lp += 0.05 * (noise() - lp);
      put(fx, i0 + i, (Math.sin(ph) * Math.exp(-t * 18) + lp * 1.5 * Math.exp(-t * 35)) * vel);
    }
  }
  for (const t of ev.turns) pageTurn(t);
  for (const t of ev.swishes) swish(t);
  for (const t of ev.clicks) click(t);
  for (const t of ev.keys) tap(t);
  for (const t of ev.ink) scratch(t);
  if (ev.seal) stamp(ev.seal);

  // ---------- 混音 ----------
  if (stems)
    for (const [name, b] of Object.entries({ piano, strings: strs, fx }))
      await fs.writeFile(path.join(stems, `${name}.f32`), Buffer.from(interleave(b).buffer));
  const verbIn = new Float32Array(N);
  for (let i = 0; i < N; i++)
    verbIn[i] =
      (piano.L[i] + piano.R[i]) * 0.5 * 0.42 +
      (strs.L[i] + strs.R[i]) * 0.5 * 0.7 +
      (fx.L[i] + fx.R[i]) * 0.5 * 0.15;
  const verb = hall(verbIn, N);
  const out = bus();
  for (let i = 0; i < N; i++) {
    out.L[i] = piano.L[i] + strs.L[i] * 0.9 + fx.L[i] + verb.L[i] * 0.42;
    out.R[i] = piano.R[i] + strs.R[i] * 0.9 + fx.R[i] + verb.R[i] * 0.42;
  }
  // EQ: clear the rumble, a little less boxiness, a little more air.
  for (const side of ['L', 'R']) {
    biquad(out[side], 'highpass', 35, 0.7);
    biquad(out[side], 'peak', 280, 0.9, -2);
    biquad(out[side], 'highshelf', 7000, 0.7, 2);
  }
  // Fade at the very end.
  const end = ev.duration * SR;
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const g = Math.pow(clamp((end - i) / (1.3 * SR)), 1.3);
    out.L[i] *= g;
    out.R[i] *= g;
    peak = Math.max(peak, Math.abs(out.L[i]), Math.abs(out.R[i]));
  }
  // A gentle compressor (2.5:1 over -20 dB below the peak), so the quiet piano carries on a
  // phone speaker, then a soft knee for what still pokes out.
  {
    const thr = 20 * Math.log10(peak) - 20;
    const att = Math.exp(-1 / (0.012 * SR));
    const rel = Math.exp(-1 / (0.3 * SR));
    let env = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.max(Math.abs(out.L[i]), Math.abs(out.R[i]));
      env = a > env ? att * env + (1 - att) * a : rel * env + (1 - rel) * a;
      const db = 20 * Math.log10(env + 1e-9);
      const gr = db > thr ? (db - thr) * (1 - 1 / 2.5) : 0;
      const g = Math.pow(10, -gr / 20);
      out.L[i] *= g;
      out.R[i] *= g;
    }
  }
  peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out.L[i]), Math.abs(out.R[i]));
  const knee = (x) =>
    Math.abs(x) < 0.7 ? x : Math.sign(x) * (0.7 + 0.28 * Math.tanh((Math.abs(x) - 0.7) / 0.28));
  for (let i = 0; i < N; i++) {
    out.L[i] = knee((out.L[i] / peak) * 1.25);
    out.R[i] = knee((out.R[i] / peak) * 1.25);
  }
  peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out.L[i]), Math.abs(out.R[i]));
  const norm = 0.89 / peak;
  const wav = Buffer.alloc(44 + N * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + N * 4, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(SR, 24);
  wav.writeUInt32LE(SR * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) {
    wav.writeInt16LE(Math.round(clamp(out.L[i] * norm, -1, 1) * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(clamp(out.R[i] * norm, -1, 1) * 32767), 46 + i * 4);
  }
  await fs.writeFile(file, wav);
  return { gain: null };
}

// RBJ cookbook biquad, in place.
function biquad(x, type, f0, q, db = 0) {
  const A = Math.pow(10, db / 40);
  const w = (TAU * f0) / SR;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = (1 + cs) / 2;
    a0 = 1 + al;
    a1 = -2 * cs;
    a2 = 1 - al;
  } else if (type === 'peak') {
    b0 = 1 + al * A;
    b1 = -2 * cs;
    b2 = 1 - al * A;
    a0 = 1 + al / A;
    a1 = -2 * cs;
    a2 = 1 - al / A;
  } else {
    const sq = 2 * Math.sqrt(A) * al;
    b0 = A * (A + 1 + (A - 1) * cs + sq);
    b1 = -2 * A * (A - 1 + (A + 1) * cs);
    b2 = A * (A + 1 + (A - 1) * cs - sq);
    a0 = A + 1 - (A - 1) * cs + sq;
    a1 = 2 * (A - 1 - (A + 1) * cs);
    a2 = A + 1 - (A - 1) * cs - sq;
  }
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

// ---------- 混响：合成的音乐厅脉冲响应，FFT 卷积 ----------
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) ((re[i] /= n), (im[i] /= n));
}
function impulse(len, t60, s) {
  seed = s;
  const ir = new Float32Array(len);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // Darker as it decays: the low-pass closes from ~9 kHz to ~1.5 kHz.
    const fc = 1500 + 7500 * Math.exp(-t * 2.2);
    const g = 1 - Math.exp((-TAU * fc) / SR);
    lp += g * (noise() - lp);
    const onset = Math.min(1, t / 0.012);
    ir[i] = lp * Math.exp((-6.91 * t) / t60) * onset;
  }
  // Pre-delay.
  const pd = Math.floor(0.022 * SR);
  const out = new Float32Array(len + pd);
  out.set(ir, pd);
  let e = 0;
  for (const v of out) e += v * v;
  for (let i = 0; i < out.length; i++) out[i] /= Math.sqrt(e) * 1.2;
  return out;
}
function hall(x, N) {
  const irL = impulse(Math.floor(3.2 * SR), 2.6, 7);
  const irR = impulse(Math.floor(3.2 * SR), 2.6, 99);
  let size = 1;
  while (size < N + irL.length) size <<= 1;
  const xr = new Float64Array(size);
  const xi = new Float64Array(size);
  xr.set(x);
  fft(xr, xi, false);
  const out = {};
  for (const [side, ir] of [
    ['L', irL],
    ['R', irR],
  ]) {
    const hr = new Float64Array(size);
    const hi = new Float64Array(size);
    hr.set(ir);
    fft(hr, hi, false);
    for (let i = 0; i < size; i++) {
      const r = xr[i] * hr[i] - xi[i] * hi[i];
      const im = xr[i] * hi[i] + xi[i] * hr[i];
      hr[i] = r;
      hi[i] = im;
    }
    fft(hr, hi, true);
    out[side] = Float32Array.from(hr.subarray(0, N));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const ev = JSON.parse(await fs.readFile(path.join(here, 'out/timeline-film.json'), 'utf8'));
  const file = path.join(here, 'out/music-film.wav');
  const t = Date.now();
  await makeMusic(ev, file, { stems: process.env.STEMS });
  console.log(`${file}（${((Date.now() - t) / 1000).toFixed(1)} 秒）`);
}
