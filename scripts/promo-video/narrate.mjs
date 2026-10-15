// 录黑板粉笔版的旁白，两种声音：
// - 豆包语音（--voice "doubao:Tina 老师"）：全部台词连成一段一口气念完，语气前后连贯；服务按字给出
//   时间，照着切成一句一个文件，每个字的时间也记下来，画面照着对齐。用 页间 AI 设置里填的豆包语音 Key。
// - Codex（ChatGPT）的声音（--voice cove）：和白板里的页老师一样，经本机的 Codex app server 开一个
//   实时语音会话（WebRTC），Chrome 当另一端录音，台词一句一句交给它念。用的是 ChatGPT 套餐的额度。
//
//   node scripts/promo-video/narrate.mjs --voice "doubao:Tina 老师"   录 chalk-lines.js 的全部台词 → out/voice-chalk/
//   node scripts/promo-video/narrate.mjs --voices              列出 Codex 能用的声音
//   node scripts/promo-video/narrate.mjs --voice cove          用 Codex 的声音录
//   node scripts/promo-video/narrate.mjs --voice cove --only why,bye   只重录这几句（Codex）
//   node scripts/promo-video/narrate.mjs --voice cove --sample out.wav "一句话"   试听一个声音（Codex）
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fsSync, { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { LINES } from './chalk-lines.js';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const codex = require(path.join(root, 'electron/ai-codex.cjs'));
const cloudVoice = require(path.join(root, 'electron/cloud-voice.cjs'));
const version = require(path.join(root, 'package.json')).version;
const outDir = path.join(here, 'out/voice-chalk');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? null : (args[i + 1] ?? true);
};
const RATE = 48000;

const prompt = [
  '你是页老师，「页间」这个阅读软件里在白板上给人讲题的老师，亲切、温暖、带一点俏皮。',
  '现在你在给一支介绍白板讲解功能的短视频配旁白。系统会用开发者消息一句一句发来台词，每条开发者消息就是下一句台词本身。',
  '每收到一句，就用自然、轻快、带笑意的口语语气，把这句台词完整地说出来：一字不差，不增不减；不加“好的”“嗯”之类的开头或结尾，不评论，不提问，不解释，不接着往下发挥。说完就安静地等下一句。',
  '台词里的字母照常一个个读出来，比如“d k”读作“D K”。全角括号（）里的是给你的提示，不要念出来。',
].join('\n\n');

// Characters only, to compare what was said with the line.
const bare = (s) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
function likeness(a, b) {
  const x = [...bare(a)];
  const y = [...bare(b)];
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[x.length][y.length] / Math.max(x.length, y.length, 1);
}

function wav(pcm, rate = RATE) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

if (opt('voices')) {
  console.log((await codex.voice(version, { type: 'voices' }, () => {})).join('  '));
  codex.stop();
  process.exit(0);
}

const voiceName = String(opt('voice') || 'cove');
if (voiceName.startsWith('doubao:')) {
  await doubaoNarration(voiceName.slice(7));
  process.exit(0);
}

// The whole script read in one go by a 豆包 voice, cut into lines at the times the service gives
// for each word.
async function doubaoNarration(name) {
  const service = cloudVoice.services.find((x) => x.id === 'doubao');
  const voice = service.voices.find((v) => v.name === name || v.id === name);
  if (!voice) throw Error(`豆包语音没有「${name}」：${service.voices.map((v) => v.name).join('、')}`);
  const stored = JSON.parse(await fs.readFile(path.join(process.env.HOME, 'Library/Application Support/页间/ai.json'), 'utf8')).speech?.doubao?.key || '';
  if (!stored.startsWith('txt:')) throw Error('页间里还没有填豆包语音的 Key');
  const key = Buffer.from(stored.slice(4), 'base64').toString('utf8');
  const text = LINES.map((l) => l.text).join('');
  const rate = 24000;
  const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'X-Api-Key': key,
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user: { uid: 'folio' },
      req_params: { text, speaker: voice.id, audio_params: { format: 'pcm', sample_rate: rate, enable_subtitle: true } },
    }),
  });
  if (!res.ok) throw Error(`豆包语音：${res.status} ${(await res.text()).slice(0, 200)}`);
  const pieces = [];
  const words = [];
  for (const line of (await res.text()).split(/\r?\n|(?<=\})(?=\{)/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.code === 0 && typeof e.data === 'string') pieces.push(Buffer.from(e.data, 'base64'));
    else if (e.code && e.code !== 20000000) throw Error(`豆包语音：${e.code} ${e.message}`);
    if (e.sentence?.words?.length) words.push(...e.sentence.words);
  }
  const pcm = Buffer.concat(pieces);
  // When each character of the script is said: the words in order, matched to its characters.
  const chars = [...text];
  const at = new Array(chars.length).fill(null);
  let cursor = 0;
  for (const w of words) {
    const want = [...bare(w.word)];
    want.forEach((c, k) => {
      for (let i = cursor; i < Math.min(chars.length, cursor + 8); i++)
        if (bare(chars[i]) === c) {
          const step = (w.endTime - w.startTime) / want.length;
          at[i] = [w.startTime + step * k, w.startTime + step * (k + 1)];
          cursor = i + 1;
          return;
        }
    });
  }
  await fs.mkdir(outDir, { recursive: true });
  const kept = {};
  let from = 0;
  const spans = LINES.map((l) => {
    const n = [...l.text].length;
    const times = at.slice(from, from + n);
    from += n;
    const said = times.filter(Boolean);
    return { l, times, start: said[0][0], end: said.at(-1)[1] };
  });
  spans.forEach(({ l, times, start, end }, i) => {
    const next = spans[i + 1]?.start ?? pcm.length / 2 / rate;
    const a = Math.max(0, start - 0.06);
    const b = Math.min(next - 0.04, end + 0.3);
    const clip = pcm.subarray(Math.round(a * rate) * 2, Math.round(b * rate) * 2);
    const file = `${l.id}.wav`;
    fsSync.writeFileSync(path.join(outDir, file), wav(clip, rate));
    kept[l.id] = {
      file,
      heard: l.text,
      score: 1,
      dur: clip.length / 2 / rate,
      voice: `doubao:${voice.name}`,
      // when each character starts, from the start of the clip (null for punctuation)
      times: times.map((x) => (x ? +(x[0] - a).toFixed(3) : null)),
    };
    console.log(`${l.id.padEnd(6)} ${(b - a).toFixed(2)}s  ${l.text}`);
  });
  await fs.writeFile(path.join(outDir, 'lines.json'), JSON.stringify(kept, null, 1));
  console.log(path.join(outDir, 'lines.json'));
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
let id = '';
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  // What the voice says, as its events come in over the data channel.
  const waiters = new Set();
  let said = '';
  let saying = false;
  await page.exposeFunction('voiceEvent', (e) => {
    if (e.type === 'turn.created' && e.turn?.role === 'assistant') {
      saying = true;
      said = String(e.turn.transcript || '');
    } else if (e.type === 'turn.delta' && typeof e.delta === 'string' && saying) said += e.delta;
    else if (e.type === 'turn.done' && e.turn?.role === 'assistant') {
      saying = false;
      said = String(e.turn.transcript || said);
      for (const w of waiters) w(said);
      waiters.clear();
    } else if (e.type === 'error') console.error('语音会话出错：', e.error?.message || e);
  });
  await page.exposeFunction('codexStart', async (sdp) => {
    const answer = await codex.voice(version, { type: 'start', sdp, voice: voiceName, prompt }, (m) => {
      if (m.event?.type === 'error' || m.event?.type === 'closed') console.error('语音会话：', m.event.type, m.event.message || '');
    });
    id = answer.id;
    return answer.sdp;
  });
  await page.setContent('<!doctype html><title>narrate</title>');
  // Chrome's end: a silent microphone, and everything the voice says kept as samples.
  await page.evaluate(async (RATE) => {
    const ctx = new AudioContext({ sampleRate: RATE });
    await ctx.resume();
    const rec = (window.rec = { chunks: [], n: 0, lastLoud: 0 });
    const pc = new RTCPeerConnection();
    const events = pc.createDataChannel('oai-events');
    let started;
    const begun = new Promise((r) => (started = r));
    events.onmessage = (m) => {
      let e;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === 'session.started') {
        events.send(JSON.stringify({ type: 'input_audio.pause' }));
        setTimeout(started, 1500);
      }
      window.voiceEvent(e);
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      // Chrome only lets a remote stream's sound through once something plays it.
      const audio = new Audio();
      audio.srcObject = stream;
      audio.muted = true;
      audio.play().catch(() => {});
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (ev) => {
        const c = new Float32Array(ev.inputBuffer.getChannelData(0));
        rec.chunks.push(c);
        rec.n += c.length;
        let peak = 0;
        for (const v of c) peak = Math.max(peak, Math.abs(v));
        if (peak > 0.02) rec.lastLoud = rec.n;
      };
      ctx.createMediaStreamSource(stream).connect(proc);
      proc.connect(ctx.destination);
    };
    const silence = ctx.createMediaStreamDestination();
    const tone = ctx.createOscillator();
    const off = ctx.createGain();
    off.gain.value = 0;
    tone.connect(off).connect(silence);
    tone.start();
    const track = silence.stream.getAudioTracks()[0];
    pc.addTrack(track, new MediaStream([track]));
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
      setTimeout(resolve, 2000);
    });
    const sdp = await window.codexStart(pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp });
    await Promise.race([begun, new Promise((_, no) => setTimeout(() => no(Error('ChatGPT 的语音没有接通')), 20000))]);
    // Samples a..b as 16-bit, base64.
    window.take = (a, b) => {
      const out = new Int16Array(Math.max(0, b - a));
      let at = 0;
      for (const c of rec.chunks) {
        for (let i = 0; i < c.length; i++, at++)
          if (at >= a && at < b) out[at - a] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
        if (at >= b) break;
      }
      let s = '';
      const bytes = new Uint8Array(out.buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
  }, RATE);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => page.evaluate(() => [rec.n, rec.lastLoud]);
  // Some voices say something of their own when the session opens: let them finish first.
  await sleep(2500);
  for (let quiet = 0; quiet < 4; ) {
    await sleep(500);
    const [n, loud] = await now();
    quiet = saying || n - loud < RATE * 1.5 ? 0 : quiet + 1;
  }

  // Says one line and returns its samples, trimmed, with what was heard.
  async function say(text) {
    const [from] = await now();
    const done = new Promise((resolve, reject) => {
      waiters.add(resolve);
      setTimeout(() => reject(Error('等不到这句说完')), 40000);
    });
    await codex.voice(version, { type: 'tell', id, text }, () => {});
    const heard = await done;
    // The sound runs a little behind the words: wait for a quiet stretch after it.
    for (;;) {
      await sleep(200);
      const [n, loud] = await now();
      if (loud > from && n - loud > RATE * 0.9) break;
    }
    const [, loud] = await now();
    const pcm = Buffer.from(await page.evaluate(([a, b]) => window.take(a, b), [from, loud + RATE * 0.25]), 'base64');
    // Trim the silence before the first sound.
    let start = 0;
    for (let i = 0; i < pcm.length / 2; i++)
      if (Math.abs(pcm.readInt16LE(i * 2)) > 650) {
        start = Math.max(0, i - RATE * 0.06);
        break;
      }
    return { pcm: pcm.subarray(Math.floor(start) * 2), heard };
  }

  // Says a line until it comes out as written (up to three times), keeping the closest.
  async function sayLine(text, name = '') {
    let best = null;
    for (let tries = 0; tries < 3; tries++) {
      const r = await say(tries ? `（刚才那句不对，请照原文重新说一遍，只说台词本身。）${text}` : text);
      r.score = likeness(r.heard, text);
      if (!best || r.score > best.score) best = r;
      console.log(`${name}  ${(r.score * 100).toFixed(0)}%  ${r.heard}`);
      if (r.score >= 0.9) break;
    }
    return best;
  }

  if (opt('sample')) {
    const { pcm } = await sayLine(args.at(-1), voiceName);
    await fs.writeFile(String(opt('sample')), wav(pcm));
  } else {
    await fs.mkdir(outDir, { recursive: true });
    const index = path.join(outDir, 'lines.json');
    const kept = existsSync(index) ? JSON.parse(await fs.readFile(index, 'utf8')) : {};
    const only = opt('only') ? String(opt('only')).split(',') : null;
    for (const line of LINES) {
      if (only && !only.includes(line.id)) continue;
      const best = await sayLine(line.text, line.id);
      const file = `${line.id}.wav`;
      await fs.writeFile(path.join(outDir, file), wav(best.pcm));
      kept[line.id] = { file, heard: best.heard, score: best.score, dur: best.pcm.length / 2 / RATE, voice: voiceName };
      await fs.writeFile(index, JSON.stringify(kept, null, 1));
    }
    console.log(index);
  }
} finally {
  if (id) await codex.voice(version, { type: 'stop', id }, () => {}).catch(() => {});
  codex.stop();
  await browser.close();
}
