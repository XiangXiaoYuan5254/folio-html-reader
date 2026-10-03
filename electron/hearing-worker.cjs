// Listening in the whiteboard's voice conversation where there is no macOS helper, in a
// utility process (electron/hearing.cjs starts it). The window's microphone comes in as 16 kHz
// 16-bit samples; Silero VAD tells when the student talks, and each stretch of talk is written
// down by SenseVoice on this computer or by a speech service the student has a key for
// (cloud-hearing.cjs). It sends the macOS helper's events: listening, level, heard, utterance,
// error.
//
// In:  {type:'listen', on, ears:'local'|<service>, vad, model, tokens, key, host, locale}
//      {type:'audio', pcm} {type:'mute', on}
const sherpa = require('sherpa-onnx-node');
const { cloudEars } = require('./cloud-hearing.cjs');

const rate = 16000;
const port = process.parentPort;
const emit = (event) => port.postMessage(event);

let vad = null;
let rest = new Float32Array(0);
const recognizers = new Map();
let listening = null;
let starting = 0;
let muted = false;
let talking = false;
let silent = 0;
let lastLevel = 0;
// The last half second before the student is heard talking, which holds their first sound.
let before = [];
let beforeLength = 0;
// The stretch of talk being written down.
let talk = null;

function vadFor(model) {
  vad ||= new sherpa.Vad(
    {
      sileroVad: {
        model,
        threshold: 0.5,
        minSpeechDuration: 0.15,
        minSilenceDuration: 0.35,
        windowSize: 512,
      },
      sampleRate: rate,
      numThreads: 1,
    },
    30,
  );
  return vad;
}
async function recognizerFor(model, tokens, locale) {
  const language = locale.startsWith('en') ? 'en' : 'zh';
  const id = `${model}|${language}`;
  if (!recognizers.has(id))
    recognizers.set(
      id,
      sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: rate, featureDim: 80 },
        modelConfig: {
          senseVoice: { model, language, useInverseTextNormalization: 1 },
          tokens,
          numThreads: 2,
        },
      }).catch((e) => {
        recognizers.delete(id);
        throw e;
      }),
    );
  return recognizers.get(id);
}

// SenseVoice over the whole stretch so far, again whenever enough more has been said: it
// takes a tenth of a second for several seconds of speech, so the text keeps up.
function localEars(recognizer, heard) {
  const pieces = [];
  let length = 0;
  let decoded = 0;
  let running = null;
  let stopped = false;
  const all = () => {
    const samples = new Float32Array(length);
    let at = 0;
    for (const p of pieces) {
      samples.set(p, at);
      at += p.length;
    }
    return samples;
  };
  const decode = () => {
    decoded = length;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: all(), sampleRate: rate });
    running = recognizer
      .decodeAsync(stream)
      .then((r) => String(r?.text || ''))
      .finally(() => (running = null));
    return running;
  };
  return {
    feed(samples) {
      pieces.push(samples);
      length += samples.length;
      // The first time once there is more than a syllable to go on.
      if (!running && !stopped && length - decoded >= rate * (decoded ? 0.4 : 1))
        void decode().then(
          (text) => stopped || heard(text),
          () => {},
        );
    },
    async finish() {
      await running?.catch(() => {});
      return stopped ? '' : decode();
    },
    stop() {
      stopped = true;
    },
  };
}

function startTalk() {
  const l = listening;
  const t = { text: '', changed: Date.now(), length: 0, ears: null };
  const heard = (text) => {
    text = text.trim();
    if (talk !== t || muted || text === t.text) return;
    t.text = text;
    t.changed = Date.now();
    emit({ type: 'heard', text });
  };
  if (l.ears === 'local') t.ears = localEars(l.recognizer, heard);
  else {
    const ears = cloudEars(l.ears, l, (text) => heard(text));
    t.ears = {
      feed: (samples) => ears.feed(pcmOf(samples)),
      finish: () => ears.finish(),
      stop: () => ears.stop(),
    };
    // A key that doesn't work won't on the next stretch either: listening stops.
    void ears.failed.then((error) => {
      if (!error || listening !== l) return;
      emit({ type: 'error', message: error.message });
      if (error.status === 401 || error.status === 403) stopListening();
    });
  }
  talk = t;
  for (const piece of before) feed(piece);
  before = [];
  beforeLength = 0;
}
function feed(samples) {
  talk.length += samples.length;
  talk.ears.feed(samples);
}
// The student has stopped: what they said goes to the teacher.
function finishTalk() {
  const t = talk;
  talk = null;
  t.ears.finish().then(
    (text) => {
      text = String(text || '').trim();
      if (text && listening && !muted) emit({ type: 'utterance', text });
    },
    () => {},
  );
}
function dropTalk() {
  talk?.ears.stop();
  talk = null;
}

const pcmOf = (samples) => {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++)
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  return pcm;
};

function hear(pcm) {
  if (!listening || muted) return;
  const ints = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const samples = new Float32Array(ints.length);
  let sum = 0;
  for (let i = 0; i < ints.length; i++) {
    samples[i] = ints[i] / 32768;
    sum += samples[i] * samples[i];
  }
  const ms = (samples.length / rate) * 1000;
  // The detector takes 512 samples at a time.
  const all = new Float32Array(rest.length + samples.length);
  all.set(rest);
  all.set(samples, rest.length);
  let at = 0;
  for (; at + 512 <= all.length; at += 512) vad.acceptWaveform(all.subarray(at, at + 512));
  rest = all.slice(at);
  while (!vad.isEmpty()) vad.pop();
  talking = vad.isDetected();
  silent = talking ? 0 : silent + ms;
  const now = Date.now();
  if (now - lastLevel > 80) {
    lastLevel = now;
    const db = 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-10);
    emit({ type: 'level', v: Math.max(0, Math.min(1, (db + 60) / 50)), talking });
  }
  if (!talk && talking) startTalk();
  if (talk) {
    feed(samples);
    // Stopped talking for a moment, or long enough that the teacher should hear it now.
    if ((!talking && (silent >= 900 || now - talk.changed >= 2500)) || talk.length > rate * 25)
      finishTalk();
  } else {
    before.push(samples);
    beforeLength += samples.length;
    while (beforeLength - before[0].length >= rate * 0.5) beforeLength -= before.shift().length;
  }
}

function stopListening() {
  dropTalk();
  listening = null;
  emit({ type: 'listening', on: false });
}
async function listen(m) {
  const attempt = ++starting;
  if (!m.on) return stopListening();
  dropTalk();
  const l = {
    ears: String(m.ears || 'local'),
    locale: /^[a-z]{2}(-[A-Z]{2})?$/.test(m.locale) ? m.locale : 'zh-CN',
    key: m.key,
    host: m.host,
  };
  listening = null;
  try {
    vadFor(m.vad).reset();
    if (l.ears === 'local') l.recognizer = await recognizerFor(m.model, m.tokens, l.locale);
  } catch (e) {
    if (attempt !== starting) return;
    emit({ type: 'error', message: `语音识别打不开：${e?.message || e}` });
    return emit({ type: 'listening', on: false });
  }
  if (attempt !== starting) return;
  listening = l;
  talking = false;
  silent = 0;
  rest = new Float32Array(0);
  before = [];
  beforeLength = 0;
  emit({ type: 'listening', on: true });
}

port.on('message', ({ data: m }) => {
  try {
    if (m.type === 'audio') hear(m.pcm);
    else if (m.type === 'listen') void listen(m);
    else if (m.type === 'mute') {
      muted = !!m.on;
      if (muted) {
        dropTalk();
        vad?.reset();
        rest = new Float32Array(0);
        talking = false;
      }
    }
  } catch (e) {
    emit({ type: 'error', message: String(e?.message || e) });
  }
});
