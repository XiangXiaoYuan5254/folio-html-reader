// 宣传视频的配乐，全部用代码合成，不用任何外部素材：电钢琴和弦、铺底、贝斯、轻鼓、
// 拨弦琶音、铃声，加上和画面对齐的转场声和鼠标点击声。100 BPM，D 大调。
// 时间点来自 video.html 导出的 timeline.json（render.mjs 渲染时写出）。
//
//   node scripts/promo-video/music.mjs [video|cute|whiteboard]   读 out/timeline-<版本>.json，写 out/music-<版本>.wav
import fs from 'node:fs/promises';
import path from 'node:path';

const moduleDir = path.dirname(new URL(import.meta.url).pathname);
const SR = 48000;
const BEAT = 0.6;
const BAR = BEAT * 4;
const TAU = Math.PI * 2;

// Deterministic noise, so every render sounds the same.
let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const noise = () => rnd() * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// music: false leaves only the sound effects and the narration (for a version to put other music
// under); `gain` is then the full mix's music gain, which it returns.
export async function makeMusic(ev, file, { music = true, gain } = {}) {
  const dur = ev.duration + 2.5;
  const N = Math.ceil(dur * SR);
  const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
  const keys = bus(); // electric piano, pad
  const pluck = bus();
  const bells = bus();
  const drums = bus();
  const fx = bus();
  const at = (id) => ev.scenes.find((s) => s.id === id);

  function put(b, i, s, pan = 0) {
    if (i < 0 || i >= N) return;
    b.L[i] += s * Math.cos(((pan + 1) * Math.PI) / 4);
    b.R[i] += s * Math.sin(((pan + 1) * Math.PI) / 4);
  }

  // ---------- 乐器 ----------
  // FM electric piano: bright attack that mellows, a little tine on top.
  function ep(t0, midi, len, vel = 0.5, pan = 0) {
    const f = mtof(midi);
    const n = Math.floor((len + 2.2) * SR);
    const i0 = Math.floor(t0 * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env =
        Math.min(1, t / 0.004) *
        Math.exp(-t * 1.3) *
        (t > len ? Math.exp(-(t - len) * 9) : 1);
      if (env < 1e-4 && t > len) break;
      const idx = 1.1 * Math.exp(-t * 5) + 0.22;
      const tine = Math.sin(TAU * f * 14 * t) * Math.exp(-t * 40) * 0.6;
      const s =
        Math.sin(TAU * f * t + idx * Math.sin(TAU * f * t) + tine) * 0.75 +
        Math.sin(TAU * f * 1.0015 * t + idx * 0.6 * Math.sin(TAU * f * t)) * 0.25;
      put(keys, i0 + i, s * env * vel, pan);
    }
  }
  // Soft additive pad with a slow swell.
  function pad(t0, midis, len, vel = 0.12) {
    const i0 = Math.floor(t0 * SR);
    const n = Math.floor((len + 1.6) * SR);
    midis.forEach((m, v) => {
      const f = mtof(m);
      const pan = ((v % 3) - 1) * 0.5;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = Math.min(1, t / 0.9) * (t > len ? Math.exp(-(t - len) * 3) : 1);
        let s = 0;
        for (let k = 1; k <= 6; k++)
          s += Math.sin(TAU * f * k * t * (1 + (k === 1 ? 0 : 0.0007 * v)) + v) / Math.pow(k, 1.6);
        s *= 1 + 0.15 * Math.sin(TAU * 0.3 * t + v);
        put(keys, i0 + i, s * env * vel, pan);
      }
    });
  }
  // Karplus–Strong string.
  function string(t0, midi, vel = 0.3, pan = 0, decay = 0.994) {
    const f = mtof(midi);
    const len = Math.max(2, Math.round(SR / f));
    const buf = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.5 * (noise() - lp);
      buf[i] = lp;
    }
    const i0 = Math.floor(t0 * SR);
    const n = Math.floor(1.6 * SR);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const a = buf[p];
      const b = buf[(p + 1) % len];
      buf[p] = decay * 0.5 * (a + b);
      p = (p + 1) % len;
      const env = Math.min(1, i / 60);
      put(pluck, i0 + i, a * vel * env, pan);
    }
  }
  function bell(t0, midi, vel = 0.25, pan = 0) {
    const f = mtof(midi);
    const i0 = Math.floor(t0 * SR);
    const n = Math.floor(3 * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const idx = 2.2 * Math.exp(-t * 5);
      const s =
        Math.sin(TAU * f * t + idx * Math.sin(TAU * f * 3.5 * t)) * Math.exp(-t * 1.8) +
        0.3 * Math.sin(TAU * f * 2 * t) * Math.exp(-t * 3);
      put(bells, i0 + i, s * vel * Math.min(1, t / 0.002), pan);
    }
  }
  function bass(t0, midi, len, vel = 0.5) {
    const f = mtof(midi);
    const i0 = Math.floor(t0 * SR);
    const n = Math.floor((len + 0.2) * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.01) * (t > len ? Math.exp(-(t - len) * 25) : Math.exp(-t * 0.8));
      const s = Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 4);
      put(keys, i0 + i, Math.tanh(s * 1.2) * env * vel);
    }
  }
  const kicks = [];
  function kick(t0, vel = 0.9) {
    kicks.push(t0);
    const i0 = Math.floor(t0 * SR);
    let ph = 0;
    for (let i = 0; i < 0.5 * SR; i++) {
      const t = i / SR;
      ph += (TAU * (46 + 120 * Math.exp(-t * 38))) / SR;
      const s = Math.sin(ph) * Math.exp(-t * 7) * Math.min(1, t / 0.002) + noise() * Math.exp(-t * 400) * 0.12;
      put(drums, i0 + i, s * vel);
    }
  }
  function clap(t0, vel = 0.22) {
    const i0 = Math.floor(t0 * SR);
    let hp = 0;
    let lp = 0;
    let prev = 0;
    for (let i = 0; i < 0.3 * SR; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.85 * (hp + x - prev);
      prev = x;
      lp += 0.45 * (hp - lp);
      const bursts = [0, 0.011, 0.022].reduce((a, d) => a + (t >= d ? Math.exp(-(t - d) * (d < 0.02 ? 140 : 18)) : 0), 0);
      const s = lp * bursts + Math.sin(TAU * 190 * t) * Math.exp(-t * 35) * 0.25;
      put(drums, i0 + i, s * vel, 0.05);
    }
  }
  function hat(t0, vel = 0.06, open = false) {
    const i0 = Math.floor(t0 * SR);
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < (open ? 0.25 : 0.06) * SR; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.6 * (hp + x - prev);
      prev = x;
      put(drums, i0 + i, hp * Math.exp(-t * (open ? 14 : 70)) * vel, 0.3);
    }
  }
  function shaker(t0, vel = 0.035) {
    const i0 = Math.floor(t0 * SR);
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < 0.08 * SR; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.7 * (hp + x - prev);
      prev = x;
      const env = Math.min(1, t / 0.012) * Math.exp(-t * 45);
      put(drums, i0 + i, hp * env * vel, -0.35);
    }
  }
  // Filtered noise that rises into `t0` and falls away after it.
  function whoosh(t0, vel = 0.16, up = 0.55, down = 0.5) {
    const a = t0 - up;
    const i0 = Math.floor(a * SR);
    const n = Math.floor((up + down) * SR);
    let low = 0;
    let band = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const k = t < up ? t / up : 1 - (t - up) / down;
      const fc = 250 + 3800 * k * k;
      const g = 2 * Math.sin((Math.PI * fc) / SR);
      const x = noise();
      low += g * band;
      band += g * (x - low - 0.6 * band);
      const env = Math.pow(Math.max(0, k), 2.2);
      put(fx, i0 + i, band * env * vel, Math.sin(t * 5) * 0.6);
    }
  }
  function boom(t0, vel = 0.7) {
    const i0 = Math.floor(t0 * SR);
    let ph = 0;
    let lp = 0;
    for (let i = 0; i < 2.2 * SR; i++) {
      const t = i / SR;
      ph += (TAU * (46 + 40 * Math.exp(-t * 9))) / SR;
      lp += 0.02 * (noise() - lp);
      const s = Math.sin(ph) * Math.exp(-t * 2.2) + lp * Math.exp(-t * 1.5) * 1.5;
      put(fx, i0 + i, s * vel * Math.min(1, t / 0.003));
    }
  }
  // Reversed cymbal-like swell into `t0`.
  function swell(t0, len = 1.2, vel = 0.1) {
    const i0 = Math.floor((t0 - len) * SR);
    const n = Math.floor(len * SR);
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.92 * (hp + x - prev);
      prev = x;
      put(fx, i0 + i, hp * Math.pow(t / len, 3) * vel, 0);
    }
  }
  function click(t0, vel = 0.11) {
    const i0 = Math.floor(t0 * SR);
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < 0.03 * SR; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.5 * (hp + x - prev);
      prev = x;
      const s = hp * Math.exp(-t * 900) + Math.sin(TAU * 3200 * t) * Math.exp(-t * 260) * 0.35;
      put(fx, i0 + i, s * vel, 0.15);
    }
  }

  // ---------- 编曲：实拍版 ----------
  function arrangeReal() {
    // Dmaj9 – Bm11 – Gmaj9 – A(sus4 → 6)
    const CHORDS = [
      { bass: 38, ep: [57, 61, 64, 66], pad: [50, 57, 61, 64, 69] },
      { bass: 35, ep: [54, 57, 61, 64], pad: [47, 54, 57, 61, 66] },
      { bass: 31, ep: [54, 57, 59, 62], pad: [43, 50, 54, 57, 62] },
      { bass: 33, ep: [57, 59, 62, 64], pad: [45, 52, 57, 59, 64], then: [57, 61, 64, 66] },
    ];
    const bars = Math.ceil(ev.duration / BAR);
    const end = at('outro').t0;
    const sectionOf = (t) => ev.scenes.find((s) => t >= s.t0 && t < s.t1)?.id || 'outro';
    const calm = new Set(['intro', 'folder', 'ai', 'boardTitle']);
    const arpPattern = [0, 1, 2, 3, 2, 1, 3, 2];

    for (let b = 0; b < bars; b++) {
      const t0 = b * BAR;
      const ch = CHORDS[b % 4];
      const sec = sectionOf(t0 + 0.01);
      const outro = t0 >= end;
      if (outro) break;
      const quiet = calm.has(sec);
      // Keys: a long chord on 1; in the groove, pushed hits on the and-of-2 and on 4.
      ch.ep.forEach((m, i) => ep(t0 + i * 0.012, m, quiet ? 2.2 : 1.0, quiet ? 0.2 : 0.17, (i - 1.5) * 0.25));
      if (!quiet) {
        const late = ch.then || ch.ep;
        late.forEach((m, i) => ep(t0 + 1.5 * BEAT + i * 0.01, m, 0.35, 0.11, (i - 1.5) * 0.25));
        late.forEach((m, i) => ep(t0 + 3 * BEAT + i * 0.01, m, 0.5, 0.12, (i - 1.5) * 0.25));
      } else if (ch.then) ch.then.forEach((m, i) => ep(t0 + 2 * BEAT + i * 0.012, m, 1.0, 0.13, (i - 1.5) * 0.25));
      pad(t0, ch.pad, BAR, quiet ? 0.05 : 0.028);
      if (b * BAR >= at('reveal').t0 - 0.01 && !quiet) {
        bass(t0, ch.bass, 1.4 * BEAT, 0.3);
        bass(t0 + 1.5 * BEAT, ch.bass, 0.4 * BEAT, 0.22);
        bass(t0 + 2 * BEAT, ch.bass + 12, 0.4 * BEAT, 0.17);
        bass(t0 + 3 * BEAT, ch.bass, 0.9 * BEAT, 0.25);
        // Drums
        kick(t0, 0.62);
        kick(t0 + 1.5 * BEAT, 0.4);
        kick(t0 + 2 * BEAT, 0.55);
        clap(t0 + BEAT);
        clap(t0 + 3 * BEAT);
        for (let k = 0; k < 8; k++) hat(t0 + k * (BEAT / 2) + (k % 2 ? 0.025 : 0), k % 2 ? 0.12 : 0.07, k === 7);
        // Plucked arpeggio, two octaves up.
        const notes = (ch.then || ch.ep).map((m) => m + 12);
        for (let k = 0; k < 8; k++) {
          const m = notes[arpPattern[k]] + (k >= 4 && sec === 'themes' ? 12 : 0);
          string(t0 + k * (BEAT / 2), m, k === 0 ? 0.28 : 0.18, k % 2 ? 0.45 : -0.45);
        }
      } else if (sec === 'ai' || sec === 'boardTitle') {
        for (let k = 0; k < 8; k++) hat(t0 + k * (BEAT / 2), 0.025);
      }
      if (sec === 'themes') for (let k = 0; k < 16; k++) shaker(t0 + k * (BEAT / 4), k % 4 === 2 ? 0.05 : 0.03);
    }

    // Intro bells: the bookmark drops, then the name.
    bell(1.4, 81, 0.16, 0.2);
    bell(1.55, 86, 0.12, -0.2);
    bell(2.6, 78, 0.1, 0.3);
    bell(2.9, 81, 0.1, -0.3);
    // AI and board chapters: a quick upward sparkle.
    for (const id of ['ai', 'boardTitle']) {
      const t0 = at(id).t0 + 0.25;
      [74, 78, 81, 85, 86].forEach((m, i) => bell(t0 + i * 0.075, m + 12, 0.07, i % 2 ? 0.4 : -0.4));
    }
    // Each theme switch rings a note of the chord.
    const themeNotes = [86, 88, 90, 93, 90, 88, 86, 85, 86];
    ev.themes.forEach((t, i) => bell(t, themeNotes[i % themeNotes.length], 0.07, i % 2 ? 0.3 : -0.3));

    // Outro: one last chord that rings out.
    {
      const t0 = end;
      boom(t0, 0.45);
      [50, 57, 61, 64, 66, 69].forEach((m, i) => ep(t0 + i * 0.03, m, 5, 0.17, (i - 2.5) * 0.2));
      pad(t0, [38, 50, 57, 61, 64, 69], 5.5, 0.05);
      bass(t0, 38, 3.5, 0.3);
      [86, 90, 93, 98].forEach((m, i) => bell(t0 + 0.6 + i * 0.3, m, 0.08, (i - 1.5) * 0.3));
    }

    for (const t of ev.whooshes) whoosh(t, 0.14);
    for (const t of ev.swells) swell(t, 1.4, 0.07);
    for (const t of ev.impacts.filter((t) => t < end - 0.1)) boom(t, 0.35);
    for (const t of ev.clicks) click(t, 0.1);

  }

  // ---------- 编曲：手绘可爱版（C 大调，120 BPM） ----------
  // Marimba: a soft mallet tone with a quick bright overtone.
  function marimba(t0, midi, vel = 0.3, pan = 0) {
    const f = mtof(midi);
    const i0 = Math.floor(t0 * SR);
    for (let i = 0; i < 1.4 * SR; i++) {
      const t = i / SR;
      const s =
        Math.sin(TAU * f * t) +
        0.35 * Math.sin(TAU * 4 * f * t) * Math.exp(-t * 18) +
        0.12 * Math.sin(TAU * 9.9 * f * t) * Math.exp(-t * 45);
      put(keys, i0 + i, s * Math.exp(-t * 5.5) * Math.min(1, t / 0.002) * vel, pan);
    }
  }
  function glock(t0, midi, vel = 0.12, pan = 0) {
    const f = mtof(midi);
    const i0 = Math.floor(t0 * SR);
    for (let i = 0; i < 1.8 * SR; i++) {
      const t = i / SR;
      const idx = 1.4 * Math.exp(-t * 7);
      const s = Math.sin(TAU * f * t + idx * Math.sin(TAU * f * 3.5 * t)) * Math.exp(-t * 2.8) + 0.25 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 5);
      put(bells, i0 + i, s * vel * Math.min(1, t / 0.001), pan);
    }
  }
  // Ukulele-ish strum: plucked strings a few milliseconds apart.
  function strum(t0, notes, vel = 0.12, up = false) {
    (up ? [...notes].reverse() : notes).forEach((m, i) => string(t0 + i * 0.016, m, vel, (i - 1.5) * 0.25, 0.988));
  }
  function snap(t0, vel = 0.16) {
    const i0 = Math.floor(t0 * SR);
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < 0.12 * SR; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.75 * (hp + x - prev);
      prev = x;
      const s = hp * Math.exp(-t * 60) + Math.sin(TAU * 1800 * t) * Math.exp(-t * 90) * 0.3;
      put(drums, i0 + i, s * vel, 0.1);
    }
  }
  function boing(t0, vel = 0.22) {
    const i0 = Math.floor(t0 * SR);
    let ph = 0;
    for (let i = 0; i < 0.5 * SR; i++) {
      const t = i / SR;
      const f = 190 + 340 * (1 - Math.exp(-t * 30)) + 70 * Math.sin(TAU * 17 * t) * Math.exp(-t * 6);
      ph += (TAU * f) / SR;
      const s = Math.sin(ph) + 0.3 * Math.sin(2 * ph);
      put(fx, i0 + i, s * Math.exp(-t * 7) * Math.min(1, t / 0.004) * vel, 0);
    }
  }
  function pop(t0, vel = 0.14, pitch = 1) {
    const i0 = Math.floor(t0 * SR);
    let ph = 0;
    for (let i = 0; i < 0.09 * SR; i++) {
      const t = i / SR;
      ph += (TAU * pitch * (520 + 900 * Math.min(1, t / 0.035))) / SR;
      put(fx, i0 + i, Math.sin(ph) * Math.exp(-t * 55) * Math.min(1, t / 0.002) * vel, (rnd() - 0.5) * 0.6);
    }
  }
  function slapNote(t0, vel = 0.3) {
    const i0 = Math.floor(t0 * SR);
    let lp = 0;
    for (let i = 0; i < 0.12 * SR; i++) {
      const t = i / SR;
      lp += 0.25 * (noise() - lp);
      const s = lp * Math.exp(-t * 70) * 1.6 + Math.sin(TAU * 150 * t) * Math.exp(-t * 35) * 0.6;
      put(fx, i0 + i, s * vel, 0);
    }
  }
  // Pen on paper: band-passed noise in little strokes.
  function scribble(t0, dur, vel = 0.07) {
    const i0 = Math.floor(t0 * SR);
    let low = 0;
    let band = 0;
    const g = 2 * Math.sin((Math.PI * 3600) / SR);
    let rate = 12 + rnd() * 6;
    let ph = 0;
    for (let i = 0; i < dur * SR; i++) {
      const t = i / SR;
      ph += (TAU * rate) / SR;
      if (ph > TAU) {
        ph -= TAU;
        rate = 10 + rnd() * 10;
      }
      const x = noise();
      low += g * band;
      band += g * (x - low - 0.9 * band);
      const stroke = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(ph)), 2);
      const env = Math.min(1, t / 0.03) * Math.min(1, (dur - t) / 0.05);
      put(fx, i0 + i, band * stroke * env * vel, 0.2);
    }
  }
  // Round plucked bass: a sine that dies away quickly. (A plucked-string model this low
  // keeps its noisy attack for a long time and buzzes.)
  function softBass(t0, midi, vel = 0.3) {
    const f = mtof(midi);
    const i0 = Math.floor(t0 * SR);
    for (let i = 0; i < 0.7 * SR; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.006) * Math.exp(-t * 5);
      const s = Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 8);
      put(keys, i0 + i, s * env * vel);
    }
  }
  function arrangeCute() {
    const B = 0.5;
    const BR = B * 4;
    const CH = [
      { bass: 48, tri: [60, 64, 67, 72], strum: [60, 64, 67, 72], mel: [76, 79, 84, 79] },
      { bass: 43, tri: [59, 62, 67, 71], strum: [59, 62, 67, 71], mel: [74, 79, 83, 79] },
      { bass: 45, tri: [57, 60, 64, 69], strum: [57, 60, 64, 69], mel: [72, 76, 81, 76] },
      { bass: 41, tri: [57, 60, 65, 69], strum: [57, 60, 65, 69], mel: [72, 77, 81, 84] },
    ];
    const end = at('outro').t0;
    const sec = (t) => ev.scenes.find((x) => t >= x.t0 - 1e-6 && t < x.t1)?.id || 'outro';
    // A page can name its own quiet (no groove) and melodic (glockenspiel tune) scenes.
    const quiet = new Set(ev.quiet || ['hello', 'ai']);
    const melodic = new Set(ev.melodic || ['hello', 'app', 'themes', 'ai']);
    const bars = Math.ceil(end / BR);
    const arp = [0, 2, 1, 3, 2, 1, 3, 2];
    for (let b = 0; b < bars; b++) {
      const t0 = b * BR;
      const ch = CH[b % 4];
      const id = sec(t0 + 0.01);
      const calm = quiet.has(id) || (id === 'board' && t0 < at('board').t0 + 1.8) || (id === 'mess' && t0 < at('mess').t0 + 2);
      // marimba: bouncy eighths
      for (let k = 0; k < 8; k++) marimba(t0 + k * (B / 2), ch.tri[arp[k]], calm ? 0.1 : 0.13, k % 2 ? 0.35 : -0.35);
      // melody on the glockenspiel in the lighter sections
      if (melodic.has(id)) {
        const rhythm = [0, 1, 1.5, 2.5];
        ch.mel.forEach((m, i) => glock(t0 + rhythm[i] * B, m, 0.09, i % 2 ? 0.25 : -0.25));
      }
      if (!calm) {
        // pizzicato bass and the groove
        softBass(t0, ch.bass, 0.3);
        softBass(t0 + 1.5 * B, ch.bass, 0.22);
        softBass(t0 + 2 * B, ch.bass + 12, 0.15);
        softBass(t0 + 3 * B, ch.bass, 0.25);
        kick(t0, 0.45);
        kick(t0 + 2 * B, 0.4);
        snap(t0 + B);
        snap(t0 + 3 * B);
        strum(t0 + B + B / 2, ch.strum, 0.1);
        strum(t0 + 3 * B + B / 2, ch.strum, 0.09, true);
        for (let k = 0; k < 8; k++) shaker(t0 + k * (B / 2), k % 2 ? 0.05 : 0.03);
      } else if (id !== 'hello' || b > 0) {
        for (let k = 0; k < 4; k++) shaker(t0 + k * B + B / 2, 0.03);
      }
    }
    // The ending: one bright chord that rings, and a last little tune.
    const t0 = end;
    [48, 60, 64, 67, 72, 76].forEach((m, i) => marimba(t0 + i * 0.02, m, 0.16, (i - 2.5) * 0.2));
    strum(t0, [60, 64, 67, 72], 0.14);
    kick(t0, 0.5);
    [79, 84, 88, 91, 96].forEach((m, i) => glock(t0 + 0.5 + i * 0.25, m, 0.1, (i - 2) * 0.25));
    [[2.0, 72], [2.5, 76], [3.0, 79], [4.0, 84]].forEach(([d, m]) => marimba(t0 + d, m, 0.12));
    // sound effects, lined up with the picture
    for (const t of ev.boing) boing(t);
    for (const t of ev.pop) pop(t, 0.12, 0.85 + rnd() * 0.4);
    for (const t of ev.slap) slapNote(t);
    for (const [t, d] of ev.scribble) scribble(t, d);
    for (const t of ev.swish) whoosh(t, 0.08, 0.3, 0.35);
    for (const t of ev.sparkle) [84, 88, 91, 96, 100].forEach((m, i) => glock(t + i * 0.045, m, 0.05, (i - 2) * 0.3));
    for (const t of ev.click) click(t, 0.12);
    for (const [t, d] of ev.type) for (let x = t; x < t + d; x += 0.055 + rnd() * 0.04) click(x, 0.05 + rnd() * 0.03);
    for (const t of ev.ding) glock(t, 96, 0.13);
    const up = [84, 86, 88, 91, 93, 96, 98, 100, 103];
    ev.themes.forEach((t, i) => glock(t, up[i % up.length], 0.08, i % 2 ? 0.3 : -0.3));
  }

  // ---------- 粉笔的声音 ----------
  // Chalk on a board: grainy noise in quick strokes, with little ticks where it catches.
  function chalkScratch(t0, dur, vel = 0.06) {
    const i0 = Math.floor(t0 * SR);
    let low = 0;
    let band = 0;
    let fc = 3200 + rnd() * 1600;
    let g = 2 * Math.sin((Math.PI * fc) / SR);
    let rate = 7 + rnd() * 6;
    let ph = 0;
    for (let i = 0; i < dur * SR; i++) {
      const t = i / SR;
      ph += (TAU * rate) / SR;
      if (ph > TAU) {
        ph -= TAU;
        rate = 6 + rnd() * 8;
        fc = 2600 + rnd() * 2600;
        g = 2 * Math.sin((Math.PI * fc) / SR);
      }
      const x = noise();
      low += g * band;
      band += g * (x - low - 0.7 * band);
      const stroke = 0.25 + 0.75 * Math.pow(Math.max(0, Math.sin(ph)), 1.5);
      const grit = rnd() < 0.0009 ? 3 : 1;
      const env = Math.min(1, t / 0.02) * Math.min(1, (dur - t) / 0.04);
      put(fx, i0 + i, band * stroke * grit * env * vel, 0.15);
    }
  }
  // Chalk set down on the board.
  function tap(t0, vel = 0.1) {
    const i0 = Math.floor(t0 * SR);
    for (let i = 0; i < 0.06 * SR; i++) {
      const t = i / SR;
      const s = Math.sin(TAU * 2100 * t) * Math.exp(-t * 160) * 0.6 + noise() * Math.exp(-t * 500) * 0.5 + Math.sin(TAU * 180 * t) * Math.exp(-t * 60) * 0.4;
      put(fx, i0 + i, s * vel, 0.1);
    }
  }
  // The felt eraser rubbed back and forth.
  function rub(t0, dur, vel = 0.13, sweeps = 9) {
    const i0 = Math.floor(t0 * SR);
    let lp = 0;
    let lp2 = 0;
    for (let i = 0; i < dur * SR; i++) {
      const t = i / SR;
      lp += 0.08 * (noise() - lp);
      lp2 += 0.3 * (lp - lp2);
      const k = (t / dur) * sweeps;
      const stroke = 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * (k % 1)), 0.8);
      const env = Math.min(1, t / 0.04) * Math.min(1, (dur - t) / 0.08);
      put(fx, i0 + i, (lp - lp2) * 6 * stroke * env * vel, Math.sin(k * Math.PI) * 0.5);
    }
  }
  // A puff of chalk dust.
  function puff(t0, vel = 0.12) {
    whoosh(t0 + 0.15, vel, 0.12, 0.45);
    const i0 = Math.floor(t0 * SR);
    for (let i = 0; i < 0.3 * SR; i++) {
      const t = i / SR;
      put(fx, i0 + i, Math.sin(TAU * (90 + 60 * Math.exp(-t * 20)) * t) * Math.exp(-t * 14) * vel * 1.2, 0);
    }
  }
  // Nylon-string guitar: a plucked string (Karplus–Strong) picked a little off the bridge,
  // through the low resonances of a wooden body.
  function nylon(t0, midi, vel = 0.2, pan = 0, len = 2.2) {
    const f = mtof(midi);
    const P = Math.max(2, Math.round(SR / f));
    const buf = new Float32Array(P);
    let lp = 0;
    for (let i = 0; i < P; i++) {
      lp += 0.35 * (noise() - lp);
      buf[i] = lp;
    }
    // picked at about a fifth of the string: that harmonic and its multiples go quiet
    const pick = Math.max(1, Math.round(P / 5));
    const ex = Float32Array.from(buf, (x, i) => x - 0.8 * buf[(i + pick) % P]);
    buf.set(ex);
    const decay = Math.min(0.9985, 0.996 + midi * 0.00002);
    const body = [
      [105, 0.0045],
      [210, 0.006],
      [2600, 0.02],
    ].map(([fc, bw]) => ({ g: 2 * Math.sin((Math.PI * fc) / SR), q: bw * 60, low: 0, band: 0 }));
    const i0 = Math.floor(t0 * SR);
    let p = 0;
    let prev = 0;
    for (let i = 0; i < len * SR; i++) {
      const a = buf[p];
      const nx = buf[(p + 1) % P];
      const y = decay * (0.5 * (a + nx) * 0.8 + prev * 0.2);
      prev = y;
      buf[p] = y;
      p = (p + 1) % P;
      let res = 0;
      for (const r of body) {
        r.low += r.g * r.band;
        r.band += r.g * (a - r.low - r.q * r.band);
        res += r.band;
      }
      const env = Math.min(1, i / 40) * (i / SR > len - 0.15 ? (len - i / SR) / 0.15 : 1);
      put(keys, i0 + i, (a * 0.8 + res * 0.12) * env * vel, pan);
    }
  }
  // A whistled note: a pure tone with a little breath in it, gliding in from the last note,
  // vibrato coming in as it is held.
  function whistle(t0, midi, len, vel = 0.1, from = null) {
    const f1 = mtof(midi);
    const f0 = from ? mtof(from) : f1 * 0.985;
    const i0 = Math.floor(t0 * SR);
    let ph = 0;
    let low = 0;
    let band = 0;
    for (let i = 0; i < (len + 0.1) * SR; i++) {
      const t = i / SR;
      const glide = Math.min(1, t / 0.05);
      const f = f0 * Math.pow(f1 / f0, glide) * (1 + 0.007 * Math.sin(TAU * 5.6 * t) * Math.min(1, Math.max(0, t - 0.12) / 0.25));
      ph += (TAU * f) / SR;
      const g = 2 * Math.sin((Math.PI * Math.min(f, 6000)) / SR);
      low += g * band;
      band += g * (noise() - low - 0.08 * band);
      const env = Math.min(1, t / 0.03) * (t > len ? Math.exp(-(t - len) * 40) : 1) * (0.94 + 0.06 * Math.sin(TAU * 2.3 * t));
      put(bells, i0 + i, (Math.sin(ph) + 0.06 * Math.sin(2 * ph) + band * 0.05) * env * vel, 0.12);
    }
  }
  // Brushes on a snare: a soft swish rather than a crack.
  function brush(t0, vel = 0.1, long = false) {
    const i0 = Math.floor(t0 * SR);
    let lp = 0;
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < (long ? 0.35 : 0.18) * SR; i++) {
      const t = i / SR;
      const x = noise();
      hp = 0.8 * (hp + x - prev);
      prev = x;
      lp += 0.35 * (hp - lp);
      const env = Math.min(1, t / (long ? 0.04 : 0.006)) * Math.exp(-t * (long ? 9 : 22));
      put(drums, i0 + i, lp * env * vel, -0.1);
    }
  }
  // ---------- 编曲：黑板粉笔版（原声小清新，D 大调，96 BPM） ----------
  // Fingerpicked nylon guitar, a bass, brushes and a shaker; a whistled tune that answers
  // the narration in its pauses rather than talking over it.
  function arrangeChalk() {
    const B = 60 / 96;
    const BR = B * 4;
    // Dmaj7 – F#m7 – Gmaj7 – A | Dmaj7 – Bm7 – Em7 – A7
    const CH = [
      { bass: 38, pick: [50, 57, 61, 66], keys: [61, 66, 69] },
      { bass: 42, pick: [54, 61, 64, 69], keys: [61, 64, 69] },
      { bass: 43, pick: [55, 62, 66, 71], keys: [62, 66, 71] },
      { bass: 45, pick: [57, 64, 69, 73], keys: [61, 64, 69] },
      { bass: 38, pick: [50, 57, 61, 66], keys: [61, 66, 69] },
      { bass: 47, pick: [59, 62, 66, 69], keys: [62, 66, 69] },
      { bass: 40, pick: [52, 59, 62, 67], keys: [62, 67, 71] },
      { bass: 45, pick: [57, 64, 67, 73], keys: [61, 64, 67] },
    ];
    // the tune, a bar at a time: [beat, beats, note]
    const TUNE = [
      [[0, 0.5, 69], [0.5, 0.5, 74], [1, 1, 78], [2, 0.5, 76], [2.5, 1.5, 74]],
      [[0, 0.5, 73], [0.5, 0.5, 74], [1, 1, 76], [2, 2, 78]],
      [[0, 1, 83], [1, 0.5, 81], [1.5, 0.5, 79], [2, 1, 78], [3, 1, 76]],
      [[0, 1.5, 76], [1.5, 0.5, 78], [2, 1, 76], [3, 1, 73]],
      [[0, 0.5, 69], [0.5, 0.5, 74], [1, 1, 78], [2, 0.5, 81], [2.5, 1.5, 83]],
      [[0, 1, 81], [1, 1, 78], [2, 2, 74]],
      [[0, 0.5, 74], [0.5, 0.5, 76], [1, 0.5, 78], [1.5, 0.5, 79], [2, 1, 81], [3, 1, 83]],
      [[0, 1, 81], [1, 0.5, 79], [1.5, 0.5, 76], [2, 2, 74]],
    ];
    // Where the narration is, in 20 ms steps, to keep the tune out of its way.
    const STEP = 0.02;
    const talk = new Uint8Array(Math.ceil(N / SR / STEP) + 1);
    for (let i = 0; i < N; i += SR * STEP) {
      let m = 0;
      for (let j = i; j < Math.min(N, i + SR * STEP); j++) m = Math.max(m, Math.abs(voice[j]));
      if (m > 0.02) talk[Math.floor(i / SR / STEP)] = 1;
    }
    const quiet = (a, b) => {
      for (let k = Math.max(0, Math.floor(a / STEP)); k <= Math.min(talk.length - 1, Math.ceil(b / STEP)); k++) if (talk[k]) return false;
      return true;
    };
    const lineAt = (id) => (ev.voice || []).find(([, f]) => f.endsWith(`/${id}.wav`))?.[0];
    const voiceEnd = Math.max(0, ...(ev.voice || []).map(([t]) => t)) + 4.2;
    const sceneOf = (t) => ev.scenes.find((x) => t >= x.t0 - 1e-6 && t < x.t1)?.id || 'bye';
    const hello = at('hello')?.t0 ?? 4;
    const pick = at('pick')?.t0 ?? 8;
    const again = lineAt('again');
    // the last bar the band plays: the one where the narration has ended
    const last = Math.ceil(Math.min(voiceEnd, ev.duration - 2) / BR);
    const bars = music ? last : 0;
    let prevNote = null;
    for (let b = 0; b < bars; b++) {
      const t0 = b * BR;
      const ch = CH[b % 8];
      const id = sceneOf(t0 + 0.01);
      const full = t0 >= pick - 0.01;
      const broke = again != null && t0 >= again - BR * 0.5 && t0 < again + BR * 0.5;
      // fingerpicking: the bass string on one and three, the others in between
      const pat = [0, 2, 1, 3, 0, 2, 1, 3];
      pat.forEach((k, j) => {
        const m = j % 4 === 0 ? ch.bass + 12 : ch.pick[k];
        nylon(t0 + j * (B / 2) + (rnd() - 0.5) * 0.008, m, (j % 2 ? 0.13 : 0.17) * (id === 'stuck' ? 0.85 : 1), (k - 1.5) * 0.25);
      });
      if (t0 >= hello - 0.01) {
        softBass(t0, ch.bass, 0.3);
        softBass(t0 + 2 * B, ch.bass + 7, 0.22);
        softBass(t0 + 3.5 * B, (CH[(b + 1) % 8].bass + ch.bass) / 2 > ch.bass ? ch.bass + 2 : ch.bass - 1, 0.14);
        for (let k = 0; k < 16; k++) shaker(t0 + k * (B / 4), k % 4 === 2 ? 0.045 : k % 2 ? 0.018 : 0.03);
      }
      if (full && !broke) {
        // electric piano on the offbeats
        [1.5, 3.5].forEach((x) => ch.keys.forEach((m, i) => ep(t0 + x * B + i * 0.01, m, B * 0.35, 0.07, (i - 1) * 0.3)));
        kick(t0, 0.36);
        kick(t0 + 2.5 * B, 0.24);
        brush(t0 + B, 0.11);
        brush(t0 + 3 * B, 0.11, true);
      }
      // the tune, where nobody is talking
      for (const [x, len, m] of TUNE[b % 8]) {
        const a = t0 + x * B;
        const d = len * B * 0.92;
        if (t0 < 1.5 || !quiet(a - 0.25, a + d + 0.15)) {
          prevNote = null;
          continue;
        }
        whistle(a, m + 12, d, 0.075, prevNote ? prevNote + 12 : null);
        prevNote = m;
      }
    }
    // the ending: a strum of the home chord left to ring, and a little run up on top
    if (music) {
      const tEnd = last * BR;
      [38, 50, 57, 62, 66, 69, 74].forEach((m, i) => nylon(tEnd + i * 0.03, m, 0.2, (i - 3) * 0.2, 3.5));
      softBass(tEnd, 38, 0.3);
      [74, 78, 81, 86].forEach((m, i) => glock(tEnd + 0.4 + i * 0.16, m, 0.06, (i - 1.5) * 0.3));
    }
    // sound effects, lined up with the picture
    for (const [t, d] of ev.chalk || []) chalkScratch(t, d);
    for (const t of ev.tap || []) tap(t);
    for (const [t, d] of ev.erase || []) rub(t, d);
    for (const t of ev.poof || []) puff(t);
    for (const t of ev.pluck || []) {
      const ch = CH[Math.floor(Math.max(0, t) / BR) % 8];
      glock(t, ch.keys[Math.floor(rnd() * 3)] + 12, 0.05, (rnd() - 0.5) * 0.6);
    }
    for (const t of ev.click || []) click(t, 0.1);
    for (const t of ev.ding || []) glock(t, 86, 0.09);
    for (const t of ev.sparkle || []) [81, 85, 88, 93, 97].forEach((m, i) => glock(t + i * 0.05, m, 0.04, (i - 2) * 0.3));
  }
  // The narration: each line's recording where it is said.
  const voice = new Float32Array(N);
  for (const [t, file] of ev.voice || []) {
    const buf = await fs.readFile(path.resolve(moduleDir, file));
    let at0 = 12;
    let rate = SR;
    while (at0 + 8 <= buf.length) {
      const id = buf.toString('ascii', at0, at0 + 4);
      const size = buf.readUInt32LE(at0 + 4);
      if (id === 'fmt ') rate = buf.readUInt32LE(at0 + 12);
      if (id === 'data') {
        const n = Math.floor(size / 2);
        const i0 = Math.floor(t * SR);
        for (let i = 0; i < (n * SR) / rate; i++) {
          const x = (i * rate) / SR;
          const j = Math.floor(x);
          if (j + 1 >= n || i0 + i >= N) break;
          const a = buf.readInt16LE(at0 + 8 + j * 2);
          const b = buf.readInt16LE(at0 + 10 + j * 2);
          voice[i0 + i] += ((a + (b - a) * (x - j)) / 32768);
        }
        break;
      }
      at0 += 8 + size + (size % 2);
    }
  }
  if (ev.style === 'cute') arrangeCute();
  else if (ev.style === 'chalk') arrangeChalk();
  else arrangeReal();

  // ---------- 混音 ----------
  // Keys and plucks duck a little under each kick.
  const duck = new Float32Array(N).fill(1);
  for (const k of kicks) {
    const i0 = Math.floor(k * SR);
    for (let i = 0; i < 0.35 * SR && i0 + i < N; i++)
      duck[i0 + i] = Math.min(duck[i0 + i], 1 - 0.3 * Math.exp(-(i / SR) * 9));
  }
  for (const b of [keys, pluck])
    for (let i = 0; i < N; i++) {
      b.L[i] *= duck[i];
      b.R[i] *= duck[i];
    }
  // Ping-pong echo on the plucks, dotted eighth.
  {
    const d = Math.round((ev.style === 'cute' ? 0.5 : ev.style === 'chalk' ? 60 / 96 : BEAT) * 0.75 * SR);
    for (let i = d; i < N; i++) {
      pluck.L[i] += pluck.R[i - d] * 0.32;
      pluck.R[i] += pluck.L[i - d] * 0.32;
    }
  }
  // Under the narration the music steps back (the effects a little less).
  if (ev.voice?.length) {
    let env = 0;
    const duckV = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.abs(voice[i]);
      env = a > env ? env + (a - env) * 0.02 : env * 0.99995;
      duckV[i] = 1 - 0.62 * Math.min(1, env / 0.06);
    }
    for (let i = 0; i < N; i++)
      for (const [b, k] of [[keys, 1], [pluck, 1], [bells, 1], [drums, 1], [fx, 0.5]]) {
        const g = 1 - k * (1 - duckV[i]);
        b.L[i] *= g;
        b.R[i] *= g;
      }
  }
  const out = bus();
  const mix = (b, g) => {
    for (let i = 0; i < N; i++) {
      out.L[i] += b.L[i] * g;
      out.R[i] += b.R[i] * g;
    }
  };
  const verbIn = bus();
  for (const [b, g] of [
    [keys, 0.35],
    [pluck, 0.45],
    [bells, 0.6],
    [drums, 0.08],
    [fx, 0.3],
  ])
    for (let i = 0; i < N; i++) {
      verbIn.L[i] += b.L[i] * g;
      verbIn.R[i] += b.R[i] * g;
    }
  const verb = reverb(verbIn, N);
  mix(keys, 1);
  mix(pluck, 0.8);
  mix(bells, 0.8);
  mix(drums, 0.9);
  mix(fx, 0.9);
  mix(verb, 0.32);

  // High-pass at ~30 Hz: nothing useful lives below it.
  for (const side of ['L', 'R']) {
    const x = out[side];
    const a = 1 / (1 + (TAU * 30) / SR);
    for (let pass = 0; pass < 2; pass++) {
      let py = 0;
      let px = 0;
      for (let i = 0; i < N; i++) {
        const y = a * (py + x[i] - px);
        px = x[i];
        x[i] = py = y;
      }
    }
  }
  // A little air: lift what is above ~3 kHz. (Not under narration, where it would hiss.)
  for (const side of ev.style === 'chalk' ? [] : ['L', 'R']) {
    const x = out[side];
    const g = 1 - Math.exp((-TAU * 3000) / SR);
    let lp = 0;
    for (let i = 0; i < N; i++) {
      lp += g * (x[i] - lp);
      x[i] += 0.6 * (x[i] - lp);
    }
  }
  // Fades and a soft limiter, then to -1 dBFS peak. The video fades to nothing at its
  // end, and so does the music.
  const fadeOut = ev.duration * SR;
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const g = Math.min(1, i / (0.05 * SR)) * Math.pow(Math.min(1, Math.max(0, (fadeOut - i) / (2.4 * SR))), 1.5);
    out.L[i] = Math.tanh(out.L[i] * 1.1 * g);
    out.R[i] = Math.tanh(out.R[i] * 1.1 * g);
    peak = Math.max(peak, Math.abs(out.L[i]), Math.abs(out.R[i]));
  }
  let norm = 0.89 / peak;
  // The voice goes on top, untouched by the soft clipper. Levels by loudness rather than peaks:
  // speech at about -18 dBFS RMS, the music on its own about 7 dB under it (the version without
  // music is handed the full mix's gain, so its effects sit the same). A look-ahead limiter
  // catches the peaks that would go over.
  let musicGain = null;
  if (ev.voice?.length) {
    let env = 0;
    let vs = 0;
    let vn = 0;
    let ms = 0;
    let mn = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.abs(voice[i]);
      env = a > env ? a : env * 0.9997;
      if (env > 0.02) {
        vs += voice[i] * voice[i];
        vn++;
      } else {
        ms += out.L[i] * out.L[i] + out.R[i] * out.R[i];
        mn += 2;
      }
    }
    const vg = 0.126 / Math.sqrt(vs / vn);
    const mg = gain ?? 0.056 / Math.sqrt(ms / mn);
    musicGain = mg;
    const ceil = 0.89;
    const need = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      out.L[i] = out.L[i] * mg + voice[i] * vg;
      out.R[i] = out.R[i] * mg + voice[i] * vg;
      const m = Math.max(Math.abs(out.L[i]), Math.abs(out.R[i]));
      need[i] = m > ceil ? ceil / m : 1;
    }
    const look = Math.round(0.003 * SR);
    const back = 1 / (0.08 * SR);
    let held = 1;
    for (let i = 0; i < N; i++) {
      let want = 1;
      for (let j = i; j < Math.min(N, i + look); j++) want = Math.min(want, need[j]);
      held = want < held ? want : Math.min(want, held + back);
      out.L[i] *= held;
      out.R[i] *= held;
    }
    norm = 1;
  }
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
    wav.writeInt16LE(Math.round(clamp1(out.L[i] * norm) * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(clamp1(out.R[i] * norm) * 32767), 46 + i * 4);
  }
  await fs.writeFile(file, wav);
  return { gain: musicGain };
}
const clamp1 = (x) => Math.max(-1, Math.min(1, x));

// Freeverb-style: parallel damped combs into series allpasses, slightly different per side.
function reverb(input, N) {
  const out = { L: new Float32Array(N), R: new Float32Array(N) };
  const k = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const alls = [556, 441, 341, 225];
  for (const [side, spread] of [
    ['L', 0],
    ['R', 23],
  ]) {
    const x = input[side];
    const y = out[side];
    for (const c of combs) {
      const len = Math.round((c + spread) * k);
      const buf = new Float32Array(len);
      let p = 0;
      let store = 0;
      for (let i = 0; i < N; i++) {
        const o = buf[p];
        store = o * 0.75 + store * 0.25;
        buf[p] = x[i] * 0.015 + store * 0.86;
        y[i] += o;
        p = (p + 1) % len;
      }
    }
    for (const a of alls) {
      const len = Math.round((a + spread) * k);
      const buf = new Float32Array(len);
      let p = 0;
      for (let i = 0; i < N; i++) {
        const b = buf[p];
        const v = y[i];
        buf[p] = v + b * 0.5;
        y[i] = b - v;
        p = (p + 1) % len;
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const page = process.argv[2] || 'video';
  const ev = JSON.parse(await fs.readFile(path.join(here, `out/timeline-${page}.json`), 'utf8'));
  const file = path.join(here, `out/music-${page}.wav`);
  const t = Date.now();
  await makeMusic(ev, file);
  console.log(`${file}（${((Date.now() - t) / 1000).toFixed(1)} 秒）`);
}
