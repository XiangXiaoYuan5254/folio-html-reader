// The whiteboard teacher's voice on macOS: a helper (native/speech) that says sentences with
// the system's voices and, in a voice conversation, listens and writes down what is said, all
// on this computer. It starts when the board first needs it and quits when its stdin closes.
// Its events reach the window as { type: 'speech', event }.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const commands = new Set(['prepare', 'say', 'pause', 'resume', 'hush', 'speed', 'mute']);

function createSpeech({ app, systemPreferences, send }) {
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, 'folio-speech')
    : path.join(__dirname, '..', 'build', 'native', 'folio-speech');
  let child = null;
  let waiting = [];
  // FOLIO_NO_SPEECH_HELPER tries the way Windows listens (hearing.cjs) on a Mac.
  const available = () =>
    process.platform === 'darwin' && !process.env.FOLIO_NO_SPEECH_HELPER && fs.existsSync(binary);

  function start() {
    if (child) return child;
    if (!available()) throw Error('这台电脑上没有语音功能');
    const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    child = proc;
    proc.stdin.on('error', () => {});
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'voices') {
        waiting.forEach((resolve) => resolve(event.voices));
        waiting = [];
      } else send({ type: 'speech', event });
    });
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      waiting.forEach((resolve) => resolve([]));
      waiting = [];
      send({ type: 'speech', event: { type: 'exit' } });
    });
    return proc;
  }
  function write(message) {
    start().stdin.write(JSON.stringify(message) + '\n');
  }
  // What the window may ask for, with only the fields the helper reads.
  function command(payload) {
    const type = String(payload?.type || '');
    if (!commands.has(type)) throw Error('未知的语音操作');
    const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    write({
      type,
      id: text(payload.id, 40),
      text: text(payload.text, 2000),
      voice: text(payload.voice, 200),
      rate: Number(payload.rate) || 1,
      on: !!payload.on,
    });
    return true;
  }
  return {
    available,
    voices() {
      if (!available()) return Promise.resolve([]);
      return new Promise((resolve) => {
        waiting.push(resolve);
        write({ type: 'voices' });
        setTimeout(() => resolve([]), 5000);
      });
    },
    command,
    // A sentence a speech service has already said, as 16-bit mono samples.
    sound(id, pcm, rate) {
      write({ type: 'prepare', id: String(id).slice(0, 40), pcm: pcm.toString('base64'), rate });
    },
    async listen({ on, locale }) {
      // FOLIO_SPEECH_INPUT (tests) plays a recording in instead of using the microphone.
      if (on && !process.env.FOLIO_SPEECH_INPUT) {
        const status = systemPreferences.getMediaAccessStatus('microphone');
        const granted =
          status === 'granted' ||
          (status === 'not-determined' &&
            (await systemPreferences.askForMediaAccess('microphone')));
        if (!granted)
          throw Error('没有麦克风权限：请在「系统设置 › 隐私与安全性 › 麦克风」里允许「页间」');
      }
      write({
        type: 'listen',
        on: !!on,
        locale: /^[a-z]{2}(-[A-Z]{2})?$/.test(locale) ? locale : 'zh-CN',
      });
      return true;
    },
    stop() {
      child?.stdin.end();
      child = null;
    },
  };
}

module.exports = { createSpeech };
