// Online voices for the whiteboard teacher reading its script. Edge needs no user key;
// the other services use one. Every service returns 16-bit mono samples for the same player.
const crypto = require('node:crypto');
const { httpError, money, AiError } = require('./ai-providers.cjs');
const edge = require('./edge-voice.cjs');

// `voices` are the ones fit for teaching, in Mandarin, best first; a `named` voice has a
// name to introduce itself by, the others are only described. `shares` is the AI
// service whose key also works here. `hears`: it can also write down what the student says
// in a voice conversation (cloud-hearing.cjs). `balance`: the key can ask what's left.
const services = [
  {
    id: 'edge',
    name: 'Edge TTS（推荐）',
    about: '无需 API Key，朗读文字会发给微软合成。免费通道可能限流或停用，没有官方可用性保障。',
    free: true,
    voices: [
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', about: '女声，温暖自然', named: true },
      { id: 'zh-CN-XiaoyiNeural', name: '晓伊', about: '女声，活泼', named: true },
      { id: 'zh-CN-YunxiNeural', name: '云希', about: '男声，年轻阳光', named: true },
      { id: 'zh-CN-YunjianNeural', name: '云健', about: '男声，有感染力', named: true },
      { id: 'zh-CN-YunyangNeural', name: '云扬', about: '男声，新闻播报', named: true },
      { id: 'zh-CN-YunxiaNeural', name: '云夏', about: '男声，活泼', named: true },
      { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', about: '女声，东北话', named: true },
      { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', about: '女声，陕西话', named: true },
    ],
  },
  {
    id: 'qwen',
    name: '通义百炼',
    about: '阿里云百炼的千问语音，价格低，和「通义千问」共用一个 Key',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    shares: 'qwen',
    hears: true,
    voices: [
      { id: 'Cherry', name: '芊悦', about: '女声，阳光亲切', named: true },
      { id: 'Elias', name: '墨讲师', about: '女声，讲课清楚', named: true },
      { id: 'Maia', name: '四月', about: '女声，知性温柔', named: true },
      { id: 'Serena', name: '苏瑶', about: '女声，温柔', named: true },
      { id: 'Katerina', name: '卡捷琳娜', about: '女声，成熟', named: true },
      { id: 'Ethan', name: '晨煦', about: '男声，阳光温暖', named: true },
      { id: 'Andre', name: '安德雷', about: '男声，沉稳有磁性', named: true },
      { id: 'Neil', name: '阿闻', about: '男声，播音腔', named: true },
      { id: 'Kai', name: '凯', about: '男声，舒缓', named: true },
      { id: 'Eldric Sage', name: '沧明子', about: '男声，睿智长者', named: true },
    ],
  },
  {
    id: 'doubao',
    name: '豆包语音',
    about: '火山引擎的豆包语音合成 2.0，中文自然；要在豆包语音控制台单独申请 Key',
    keyUrl: 'https://console.volcengine.com/speech/new',
    hears: true,
    voices: [
      {
        id: 'zh_female_yingyujiaoxue_uranus_bigtts',
        name: 'Tina 老师',
        about: '女声，教学',
        named: true,
      },
      { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi', about: '女声，自然', named: true },
      { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何', about: '女声，亲切', named: true },
      { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿', about: '女声，知性', named: true },
      { id: 'zh_female_zhixingnv_uranus_bigtts', name: '知性女声', about: '女声，沉稳' },
      {
        id: 'zh_female_wenrouxiaoya_uranus_bigtts',
        name: '温柔小雅',
        about: '女声，温柔',
        named: true,
      },
      { id: 'zh_male_m191_uranus_bigtts', name: '云舟', about: '男声，自然', named: true },
      { id: 'zh_male_taocheng_uranus_bigtts', name: '小天', about: '男声，年轻', named: true },
      { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞', about: '男声，沉稳', named: true },
      { id: 'zh_male_yuanboxiaoshu_uranus_bigtts', name: '渊博小叔', about: '男声，博学' },
      { id: 'zh_male_ruyaqingnian_uranus_bigtts', name: '儒雅青年', about: '男声，儒雅' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    about: 'MiniMax 语音 2.8，最接近真人，价格较高；在 MiniMax 开放平台申请 Key',
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    balance: true,
    voices: [
      { id: 'Chinese (Mandarin)_Gentle_Senior', name: '温柔学姐', about: '女声，温柔' },
      { id: 'Chinese (Mandarin)_Wise_Women', name: '阅历姐姐', about: '女声，知性' },
      { id: 'Chinese (Mandarin)_News_Anchor', name: '新闻女声', about: '女声，播音腔' },
      { id: 'Chinese (Mandarin)_Warm_Girl', name: '温暖少女', about: '女声，亲切' },
      { id: 'female-chengshu', name: '成熟女性', about: '女声，成熟' },
      { id: 'Chinese (Mandarin)_Gentleman', name: '温润男声', about: '男声，温润' },
      { id: 'Chinese (Mandarin)_Gentle_Youth', name: '温润青年', about: '男声，年轻' },
      { id: 'Chinese (Mandarin)_Reliable_Executive', name: '沉稳高管', about: '男声，沉稳' },
      { id: 'Chinese (Mandarin)_Radio_Host', name: '电台男主播', about: '男声，播音腔' },
      { id: 'male-qn-jingying', name: '精英青年', about: '男声，干练' },
    ],
  },
];
const serviceFor = (id) => services.find((s) => s.id === id);

// `cloud:<service>:<voice>`, as the window names a voice.
function parseVoice(value) {
  const m = /^cloud:([a-z]+):(.{1,120})$/.exec(typeof value === 'string' ? value : '');
  const service = m && serviceFor(m[1]);
  if (!service) throw new AiError('没有这个声音');
  return { service, voice: m[2] };
}

// The samples of a WAV file, or of raw 16-bit audio; the first channel only.
function samplesOf(audio, rate) {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF')
    return { pcm: audio.subarray(0, audio.length - (audio.length % 2)), rate };
  let format = null;
  for (let at = 12; at + 8 <= audio.length;) {
    const id = audio.toString('ascii', at, at + 4);
    let size = audio.readUInt32LE(at + 4);
    const start = at + 8;
    if (id === 'fmt ')
      format = {
        channels: audio.readUInt16LE(start + 2),
        rate: audio.readUInt32LE(start + 4),
        bits: audio.readUInt16LE(start + 14),
      };
    if (id === 'data') {
      // A streamed file says it goes on forever.
      if (size === 0 || start + size > audio.length) size = audio.length - start;
      if (!format || format.bits !== 16) throw new AiError('声音的格式不支持');
      const data = audio.subarray(start, start + size);
      if (format.channels === 1) return { pcm: data, rate: format.rate };
      const frames = Math.floor(data.length / (2 * format.channels));
      const pcm = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++)
        pcm.writeInt16LE(data.readInt16LE(i * 2 * format.channels), i * 2);
      return { pcm, rate: format.rate };
    }
    at = start + size + (size % 2);
  }
  throw new AiError('声音的格式不支持');
}

async function request(fetch, url, init, name) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e?.name === 'AbortError') throw new AiError(`${name} 合成声音超时`);
    throw new AiError(`无法连接到 ${name}，请检查网络或代理设置（${e?.message || e}）`);
  }
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), name);
  return res;
}

// 千问语音: the service makes a WAV file and says where it is.
async function qwen({ fetch, key, host, voice, text, signal }) {
  const res = await request(
    fetch,
    `https://${host}/api/v1/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-tts-flash',
        input: { text, voice, language_type: /\p{Script=Han}/u.test(text) ? 'Chinese' : 'English' },
      }),
      signal,
    },
    '通义百炼',
  );
  const url = (await res.json())?.output?.audio?.url;
  if (!url) throw new AiError('通义百炼没有返回声音');
  const file = await request(fetch, url, { signal }, '通义百炼');
  return samplesOf(Buffer.from(await file.arrayBuffer()), 24000);
}

// 豆包语音合成 2.0: lines of JSON, each with a piece of the sound, until a code that says
// it is done.
async function doubao({ fetch, key, voice, text, signal }) {
  const res = await request(
    fetch,
    'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    {
      method: 'POST',
      headers: {
        'X-Api-Key': key,
        'X-Api-Resource-Id': 'seed-tts-2.0',
        'X-Api-Request-Id': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user: { uid: 'folio' },
        req_params: { text, speaker: voice, audio_params: { format: 'pcm', sample_rate: 24000 } },
      }),
      signal,
    },
    '豆包语音',
  );
  const pieces = [];
  const body = await res.text();
  for (const line of body.split(/\r?\n|(?<=\})(?=\{)/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.code === 0 && typeof event.data === 'string')
      pieces.push(Buffer.from(event.data, 'base64'));
    else if (event.code && event.code !== 20000000) {
      const message = String(event.message || '').slice(0, 200);
      if (event.code === 45000000)
        throw new AiError(
          `豆包语音不让用这个声音：请在豆包语音控制台开通「语音合成大模型 2.0」（${message}）`,
        );
      throw new AiError(`豆包语音合成失败（${event.code}：${message}）`);
    }
  }
  if (!pieces.length) throw new AiError('豆包语音没有返回声音');
  return samplesOf(Buffer.concat(pieces), 24000);
}

// MiniMax: the sound comes in the reply, as hex.
async function minimax({ fetch, key, voice, text, signal }) {
  const res = await request(
    fetch,
    'https://api.minimax.cn/v1/t2a_v2',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'speech-2.8-hd',
        text,
        stream: false,
        output_format: 'hex',
        language_boost: 'auto',
        voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 24000, format: 'pcm', channel: 1 },
      }),
      signal,
    },
    'MiniMax',
  );
  const value = await res.json();
  const status = value?.base_resp?.status_code;
  if (status) {
    const message = String(value.base_resp.status_msg || '').slice(0, 200);
    if (status === 1004 || status === 2049)
      throw new AiError(`API Key 无效、已过期或没有权限（MiniMax：${message}）`);
    if (status === 1008) throw new AiError(`账户余额不足，请到 MiniMax 充值（${message}）`);
    if (status === 1002 || status === 1039)
      throw new AiError(`请求太频繁，请稍后再试（MiniMax：${message}）`, { status: 429 });
    throw new AiError(`MiniMax 合成失败（${status}：${message}）`);
  }
  if (typeof value?.data?.audio !== 'string' || !value.data.audio)
    throw new AiError('MiniMax 没有返回声音');
  return samplesOf(
    Buffer.from(value.data.audio, 'hex'),
    value.extra_info?.audio_sample_rate || 24000,
  );
}

const synthesizers = { qwen, doubao, minimax, edge: (options) => edge.synthesize(options) };

// MiniMax makes an account only 10 sentences a minute, or 20 once it has been topped up
// (platform.minimaxi.com/docs/guides/rate-limits), and turns the rest away. A sentence
// waits for room in the minute instead of going unsaid. One turned away all the same shows
// the account's limit is lower: it is lowered to how many got through this past minute, and
// the sentence waits and is asked for again.
function perMinute(limit) {
  let asked = [];
  return {
    // The request it may make now, or null if `stale` turns true while it waits.
    async take(stale) {
      for (;;) {
        if (stale()) return null;
        const now = Date.now();
        asked = asked.filter((a) => now - a.at < 60_000);
        if (asked.length < limit) {
          const ask = { at: now, away: false };
          asked.push(ask);
          return ask;
        }
        await new Promise((r) => setTimeout(r, Math.min(1000, 60_050 - (now - asked[0].at))));
      }
    },
    away(ask) {
      ask.away = true;
      limit = Math.max(10, Math.min(limit, asked.filter((a) => !a.away).length));
    },
  };
}
const paces = { minimax: perMinute(20) };

// Says `text` in a service's voice: { pcm: 16-bit mono samples, rate }, or null when
// `stale` turned true while it waited its turn.
async function synthesize({
  fetch,
  service,
  voice,
  key,
  host,
  text,
  stale = () => false,
  log = () => {},
  context = {},
}) {
  if (!service.free && !key)
    throw new AiError(`还没有填 ${service.name} 的 API Key：请在 AI 设置 › 语音服务里填写`);
  if (service.free && !service.voices.some((v) => v.id === voice))
    throw new AiError('Edge TTS 没有这个声音');
  const pace = paces[service.id];
  const record = (event, details = {}) =>
    log({
      ...context,
      event,
      service: service.id,
      voice,
      chars: text.length,
      spokenHash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 24),
      ...details,
    });
  for (let tries = 0; ; tries++) {
    if (stale()) return null;
    const ask = pace && (await pace.take(stale));
    if (pace && !ask) return null;
    const started = Date.now();
    const attempt = tries + 1;
    let retryMs = 0;
    await record('start', { attempt });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort({ code: 'ETIMEDOUT' }), 30_000);
    const cancelled = setInterval(() => {
      if (stale()) controller.abort();
    }, 150);
    try {
      const sound = await synthesizers[service.id]({
        fetch,
        key,
        host,
        voice,
        text,
        signal: controller.signal,
      });
      if (stale()) {
        await record('cancelled', { attempt, elapsedMs: Date.now() - started });
        return null;
      }
      await record('success', {
        attempt,
        elapsedMs: Date.now() - started,
        bytes: sound.pcm.length,
        durationMs: Math.round((sound.pcm.length / 2 / sound.rate) * 1000),
      });
      return sound;
    } catch (e) {
      if (stale()) {
        await record('cancelled', { attempt, elapsedMs: Date.now() - started });
        return null;
      }
      // Edge requests are free; retry transient failures twice. Respect Retry-After;
      // a longer server cooldown is shown to the user instead of retried too early.
      const retryEdge =
        service.id === 'edge' && e?.retry && tries < 2 && !(e.retryAfterMs > 30_000);
      const retryPaced = pace && e?.status === 429 && tries < 2;
      if (retryEdge) retryMs = Math.max(1000 * 2 ** tries, e.retryAfterMs || 0);
      await record(retryEdge || retryPaced ? 'retry' : 'failed', {
        attempt,
        elapsedMs: Date.now() - started,
        retryMs,
        stage: e.stage,
        status: e.status,
        code: e.code,
        closeCode: e.closeCode,
        bytes: e.bytes,
        message: service.id === 'edge' ? e.message : '语音合成失败',
      });
      if (!retryEdge && !retryPaced) throw e;
      if (retryPaced) pace.away(ask);
    } finally {
      clearTimeout(timer);
      clearInterval(cancelled);
    }
    const until = Date.now() + retryMs;
    while (!stale() && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, Math.min(150, until - Date.now())));
    if (stale()) {
      await record('cancelled', { attempt, stage: 'backoff', elapsedMs: Date.now() - started });
      return null;
    }
  }
}

// Runs at most `n` at a time, in the order asked: the teacher's sentences are made in the
// order they are said, without asking a service for more at once than it allows.
function limiter(n) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= n || !waiting.length) return;
    running++;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}

// What's left on a MiniMax account: its console's balance page asks this with the API key
// too, though the API docs don't list it.
async function balance({ fetch, service, key, signal }) {
  if (service.id !== 'minimax') throw new AiError(`${service.name} 查不了余额，请到官网查看`);
  let res;
  try {
    res = await fetch('https://api.minimax.cn/account/query_balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new AiError(`无法连接到 MiniMax，请检查网络或代理设置（${e?.message || e}）`);
  }
  const text = await res.text().catch(() => '');
  // A key it doesn't know comes back as bad parameters.
  if (res.status === 400) throw new AiError('API Key 无效或已过期');
  if (!res.ok) throw httpError(res.status, text, 'MiniMax');
  let value;
  try {
    value = JSON.parse(text);
  } catch {}
  if (value?.base_resp?.status_code !== 0)
    throw new AiError(
      `MiniMax 没有返回余额${value?.base_resp?.status_msg ? `（${value.base_resp.status_msg}）` : ''}`,
    );
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const left = n(value.available_amount);
  const owed = n(value.owed_amount);
  return {
    kind: 'money',
    amount: left,
    currency: 'CNY',
    detail: `代金券 ${money(n(value.voucher_balance), 'CNY')} · 现金 ${money(n(value.cash_balance), 'CNY')}${owed > 0 ? ` · 欠费 ${money(owed, 'CNY')}` : ''}`,
    empty: left <= 0,
  };
}

module.exports = { services, serviceFor, parseVoice, synthesize, samplesOf, limiter, balance };
