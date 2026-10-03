// Listening in the whiteboard's voice conversation where there is no macOS helper (Windows).
// The window opens the microphone and sends it here; a utility process (hearing-worker.cjs)
// tells when the student talks and writes down what they say, with SenseVoice on this
// computer or with a speech service they have a key for. Its events reach the window as
// { type: 'speech', event }, like the macOS helper's.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// SenseVoice Small by Alibaba's Tongyi Lab (FunAudioLLM), in sherpa-onnx's format, downloaded
// the first time. Its license asks that its source and name be kept.
const senseVoice = {
  dir: 'sense-voice-2024-07-17',
  files: [
    {
      name: 'model.int8.onnx',
      size: 239233841,
      sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    },
    {
      name: 'tokens.txt',
      size: 315894,
      sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    },
  ],
  // ModelScope first, which is quick in mainland China.
  sources: [
    (file) =>
      `https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/${file}`,
    (file) =>
      `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/${file}`,
  ],
};

function createHearing({ app, utilityProcess, fetch, speechKey, send }) {
  const vadModel = app.isPackaged
    ? path.join(process.resourcesPath, 'silero_vad.onnx')
    : path.join(__dirname, '..', 'native', 'hearing', 'silero_vad.onnx');
  const modelDir = () => path.join(app.getPath('userData'), 'speech-models', senseVoice.dir);
  let worker = null;
  let downloading = null;
  let starting = 0;
  const event = (e) => send({ type: 'speech', event: e });

  function available() {
    try {
      require.resolve('sherpa-onnx-node');
      return fs.existsSync(vadModel);
    } catch {
      return false;
    }
  }
  function start() {
    if (worker) return worker;
    const proc = utilityProcess.fork(path.join(__dirname, 'hearing-worker.cjs'), [], {
      serviceName: 'Folio Hearing',
    });
    worker = proc;
    proc.on('message', event);
    proc.on('exit', () => {
      if (worker !== proc) return;
      worker = null;
      event({ type: 'exit' });
    });
    return proc;
  }

  const has = (file) => {
    try {
      return fs.statSync(path.join(modelDir(), file.name)).size === file.size;
    } catch {
      return false;
    }
  };
  // Downloads what isn't there yet, saying how far it has got.
  function model() {
    if (senseVoice.files.every(has)) return Promise.resolve();
    return (downloading ||= (async () => {
      fs.mkdirSync(modelDir(), { recursive: true });
      const total = senseVoice.files.reduce((n, f) => n + f.size, 0);
      let done = senseVoice.files.filter(has).reduce((n, f) => n + f.size, 0);
      let told = 0;
      event({ type: 'installing', progress: done / total });
      for (const file of senseVoice.files.filter((f) => !has(f))) {
        let failure = null;
        for (const source of senseVoice.sources) {
          const target = path.join(modelDir(), file.name);
          const part = `${target}.part`;
          let got = 0;
          try {
            const res = await fetch(source(file.name));
            if (!res.ok) throw Error(`HTTP ${res.status}`);
            const hash = crypto.createHash('sha256');
            await pipeline(
              Readable.fromWeb(res.body),
              new Transform({
                transform(chunk, _, next) {
                  hash.update(chunk);
                  got += chunk.length;
                  const progress = (done + got) / total;
                  if (progress - told >= 0.01) {
                    told = progress;
                    event({ type: 'installing', progress });
                  }
                  next(null, chunk);
                },
              }),
              fs.createWriteStream(part),
            );
            if (hash.digest('hex') !== file.sha256) throw Error('下载的文件不完整');
            fs.renameSync(part, target);
            done += file.size;
            failure = null;
            break;
          } catch (e) {
            fs.rmSync(part, { force: true });
            failure = e;
          }
        }
        if (failure)
          throw Error(`语音识别模型下载失败，请检查网络后再试（${failure.message || failure}）`);
      }
    })().finally(() => (downloading = null)));
  }

  return {
    available,
    // `ears`: 'local' for this computer, or the speech service that writes it down.
    async listen({ on, locale, ears }) {
      const attempt = ++starting;
      if (!on) {
        if (worker) worker.postMessage({ type: 'listen', on: false });
        else event({ type: 'listening', on: false });
        return true;
      }
      const message = { type: 'listen', on: true, locale: String(locale || ''), vad: vadModel };
      if (!ears || ears === 'local') {
        await model();
        Object.assign(message, {
          ears: 'local',
          model: path.join(modelDir(), 'model.int8.onnx'),
          tokens: path.join(modelDir(), 'tokens.txt'),
        });
      } else Object.assign(message, { ears: String(ears) }, await speechKey(String(ears)));
      if (attempt === starting) start().postMessage(message);
      return true;
    },
    // 16-bit samples at 16 kHz from the window's microphone.
    audio(pcm) {
      if (worker && pcm instanceof Uint8Array) worker.postMessage({ type: 'audio', pcm });
      return true;
    },
    mute(on) {
      worker?.postMessage({ type: 'mute', on: !!on });
      return true;
    },
    stop() {
      starting++;
      const proc = worker;
      worker = null;
      proc?.kill();
    },
  };
}

module.exports = { createHearing };
