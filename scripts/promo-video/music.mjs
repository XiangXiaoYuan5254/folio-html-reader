// 宣传视频的配乐，全部用代码合成，不用任何外部素材：电钢琴和弦、铺底、贝斯、轻鼓、
// 拨弦琶音、铃声，加上和画面对齐的转场声和鼠标点击声。100 BPM，D 大调。
// 时间点来自 video.html 导出的 timeline.json（render.mjs 渲染时写出）。
//
//   node scripts/promo-video/music.mjs [video|cute]   读 out/timeline-<版本>.json，写 out/music-<版本>.wav
import fs from 'node:fs/promises';
import path from 'node:path';

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

export async function makeMusic(ev, file) {
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
    const quiet = new Set(['hello', 'ai']);
    const melodic = new Set(['hello', 'app', 'themes', 'ai']);
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
  if (ev.style === 'cute') arrangeCute();
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
    const d = Math.round((ev.style === 'cute' ? 0.5 : BEAT) * 0.75 * SR);
    for (let i = d; i < N; i++) {
      pluck.L[i] += pluck.R[i - d] * 0.32;
      pluck.R[i] += pluck.L[i - d] * 0.32;
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
  // A little air: lift what is above ~3 kHz.
  for (const side of ['L', 'R']) {
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
    wav.writeInt16LE(Math.round(clamp1(out.L[i] * norm) * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(clamp1(out.R[i] * norm) * 32767), 46 + i * 4);
  }
  await fs.writeFile(file, wav);
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
