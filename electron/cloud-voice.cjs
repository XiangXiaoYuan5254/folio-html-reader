// Voices from speech services people bring their own API key for, for the whiteboard teacher
// reading its script out loud: 通义百炼 (Qwen-TTS), 豆包语音 and MiniMax. A sentence is
// synthesized here, with the key attached, and comes back as 16-bit mono samples.
const crypto = require('node:crypto');
const { httpError, AiError } = require('./ai-providers.cjs');

// `voices` are the ones fit for teaching, in Mandarin, best first. `shares` is the AI
// service whose key also works here. `hears`: it can also write down what the student says
// in a voice conversation (cloud-hearing.cjs).
const services = [
  {
    id: 'qwen',
    name: '通义百炼',
    about: '阿里云百炼的千问语音，价格低，和「通义千问」共用一个 Key',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    shares: 'qwen',
    hears: true,
    voices: [
      { id: 'Cherry', name: '芊悦', about: '女声，阳光亲切' },
      { id: 'Elias', name: '墨讲师', about: '女声，讲课清楚' },
      { id: 'Maia', name: '四月', about: '女声，知性温柔' },
      { id: 'Serena', name: '苏瑶', about: '女声，温柔' },
      { id: 'Katerina', name: '卡捷琳娜', about: '女声，成熟' },
      { id: 'Ethan', name: '晨煦', about: '男声，阳光温暖' },
      { id: 'Andre', name: '安德雷', about: '男声，沉稳有磁性' },
      { id: 'Neil', name: '阿闻', about: '男声，播音腔' },
      { id: 'Kai', name: '凯', about: '男声，舒缓' },
      { id: 'Eldric Sage', name: '沧明子', about: '男声，睿智长者' },
    ],
  },
  {
    id: 'doubao',
    name: '豆包语音',
    about: '火山引擎的豆包语音合成 2.0，中文自然；要在豆包语音控制台单独申请 Key',
    keyUrl: 'https://console.volcengine.com/speech/new',
    hears: true,
    voices: [
      { id: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Tina 老师', about: '女声，教学' },
      { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi', about: '女声，自然' },
      { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何', about: '女声，亲切' },
      { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿', about: '女声，知性' },
      { id: 'zh_female_zhixingnv_uranus_bigtts', name: '知性女声', about: '女声，沉稳' },
      { id: 'zh_female_wenrouxiaoya_uranus_bigtts', name: '温柔小雅', about: '女声，温柔' },
      { id: 'zh_male_m191_uranus_bigtts', name: '云舟', about: '男声，自然' },
      { id: 'zh_male_taocheng_uranus_bigtts', name: '小天', about: '男声，年轻' },
      { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞', about: '男声，沉稳' },
      { id: 'zh_male_yuanboxiaoshu_uranus_bigtts', name: '渊博小叔', about: '男声，博学' },
      { id: 'zh_male_ruyaqingnian_uranus_bigtts', name: '儒雅青年', about: '男声，儒雅' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    about: 'MiniMax 语音 2.8，最接近真人，价格较高；在 MiniMax 开放平台申请 Key',
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
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
      throw new AiError(`请求太频繁，请稍后再试（MiniMax：${message}）`);
    throw new AiError(`MiniMax 合成失败（${status}：${message}）`);
  }
  if (typeof value?.data?.audio !== 'string' || !value.data.audio)
    throw new AiError('MiniMax 没有返回声音');
  return samplesOf(
    Buffer.from(value.data.audio, 'hex'),
    value.extra_info?.audio_sample_rate || 24000,
  );
}

const synthesizers = { qwen, doubao, minimax };
// Says `text` in a service's voice: { pcm: 16-bit mono samples, rate }.
async function synthesize({ fetch, service, voice, key, host, text }) {
  if (!key) throw new AiError(`还没有填 ${service.name} 的 API Key：请在 AI 设置 › 语音服务里填写`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await synthesizers[service.id]({
      fetch,
      key,
      host,
      voice,
      text,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
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

module.exports = { services, serviceFor, parseVoice, synthesize, samplesOf, limiter };
