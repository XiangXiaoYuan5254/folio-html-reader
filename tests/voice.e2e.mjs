// The voice conversation where there is no macOS helper, as on Windows (on a Mac the helper is
// turned off): the listening process downloads SenseVoice the first time and writes down a
// recorded question, and on the whiteboard the question is heard through the page's
// microphone and goes to the teacher, a local OpenAI-compatible mock. FOLIO_APP runs an
// installed app instead of the development build.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-voice-'));
const project = path.join(temp, '语音 项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-voice-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(
  path.join(project, '01_注意力.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>注意力</title>
<style>body{font:18px/1.9 system-ui;padding:40px 60px;color:#253342}</style></head>
<body><h1>缩放点积注意力</h1>
<p><span id="why">公式里除以根号 d k，是为了让点积的方差回到 1，softmax 不会饱和。</span>这样梯度不会消失。</p>
</body></html>`,
);

// The question, with the quiet of a room around it, as 16 kHz samples and as a WAV file.
const spoken = (await fs.readFile(path.join(root, 'tests/fixtures/voice-question.wav'))).subarray(
  44,
);
const pcm = Buffer.concat([Buffer.alloc(16000 * 3), spoken, Buffer.alloc(16000 * 12)]);
const head = Buffer.alloc(44);
head.write('RIFF', 0);
head.writeUInt32LE(36 + pcm.length, 4);
head.write('WAVEfmt ', 8);
head.writeUInt32LE(16, 16);
head.writeUInt16LE(1, 20);
head.writeUInt16LE(1, 22);
head.writeUInt32LE(16000, 24);
head.writeUInt32LE(32000, 28);
head.writeUInt16LE(2, 32);
head.writeUInt16LE(16, 34);
head.write('data', 36);
head.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([head, pcm]);

// The model once downloaded, kept for the next run on this machine.
const cache = path.join(os.tmpdir(), 'folio-voice-models');
const models = path.join(userData, 'speech-models', 'sense-voice-2024-07-17');
const modelFiles = ['model.int8.onnx', 'tokens.txt'];
const cached = (
  await Promise.all(modelFiles.map((f) => fs.stat(path.join(cache, f)).catch(() => null)))
).every(Boolean);
if (cached) {
  await fs.mkdir(models, { recursive: true });
  for (const f of modelFiles) await fs.copyFile(path.join(cache, f), path.join(models, f));
}

const testKey = 'mock-key-for-local-test';
const LESSON = `say 这段在回答一个问题。
title t0 | 为什么要除以 √dₖ
say 所以除以根号 d k，就是让 softmax 别饱和。`;
const asked = [];
function stream(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
}
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  const system = body.messages?.find((m) => m.role === 'system')?.content || '';
  const users = body.messages?.filter((m) => m.role === 'user') || [];
  const last = users.at(-1)?.content;
  if (system.includes('白板老师')) {
    asked.push(typeof last === 'string' ? last : JSON.stringify(last));
    // Questions after the first get an answer with nothing to say out loud.
    return stream(res, users.length > 1 ? 'title t9 | 收到' : LESSON);
  }
  return stream(res, '好的。');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(
  path.join(userData, 'ai.json'),
  JSON.stringify({
    version: 1,
    providers: [
      {
        id: 'mock',
        preset: 'deepseek',
        kind: 'openai',
        name: '本地模拟',
        baseUrl: `${base}/v1`,
        model: 'mock-model',
        context: 128000,
        maxOutput: 0,
        keyHint: 'moc…test',
        key: 'txt:' + Buffer.from(testKey).toString('base64'),
      },
    ],
    active: 'mock',
    prefs: {},
    uses: {},
    speech: {},
  }),
);

let app, page;
const errors = [];
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('Timeout: ' + label);
}
const board = () => page.getByRole('dialog', { name: '白板讲解' });
try {
  app = await electron.launch({
    ...(process.env.FOLIO_APP
      ? { executablePath: process.env.FOLIO_APP, args: [] }
      : { args: [root] }),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
      FOLIO_NO_SPEECH_HELPER: '1',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.waitForSelector('.document-frame');
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });

  // The listening process on its own: the model (downloaded unless cached), then the question.
  const heard = await page.evaluate(async (b64) => {
    const samples = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const events = [];
    const support = await window.folio.invoke('speech-voices', {});
    let listening;
    const on = new Promise((r) => (listening = r));
    const said = new Promise((resolve) =>
      window.folio.subscribe((e) => {
        if (e.type !== 'speech' || e.event.type === 'level') return;
        events.push(e.event);
        if (e.event.type === 'listening' && e.event.on) listening();
        if (e.event.type === 'utterance') resolve(e.event.text);
      }),
    );
    await window.folio.invoke('hearing', {
      type: 'listen',
      on: true,
      ears: 'local',
      locale: 'zh-CN',
    });
    // The first time, the model downloads meanwhile.
    await Promise.race([on, new Promise((r) => setTimeout(r, 600000))]);
    for (let i = 0; i < samples.length; i += 2048) {
      await window.folio.invoke('hearing', { type: 'audio', pcm: samples.slice(i, i + 2048) });
      await new Promise((r) => setTimeout(r, 64));
    }
    const text = await Promise.race([said, new Promise((r) => setTimeout(() => r(''), 15000))]);
    await window.folio.invoke('hearing', { type: 'listen', on: false });
    return {
      helper: support.helper,
      hearing: support.hearing,
      installing: events.filter((e) => e.type === 'installing').length,
      partials: events.filter((e) => e.type === 'heard').map((e) => e.text),
      errors: events.filter((e) => e.type === 'error').map((e) => e.message),
      text,
    };
  }, pcm.toString('base64'));
  console.log(JSON.stringify(heard));
  assert.equal(heard.helper, false);
  assert.equal(heard.hearing, true, 'listening without the macOS helper');
  if (!cached) assert.ok(heard.installing > 1, 'model download reported its progress');
  assert.match(heard.text, /老师.*根号/);
  assert.ok(heard.partials.length > 1, 'words shown while still talking');
  console.log(`PASS: SenseVoice ${cached ? 'loaded' : 'downloaded'} and wrote down the question`);
  if (!cached) {
    await fs.mkdir(cache, { recursive: true });
    for (const f of modelFiles) await fs.copyFile(path.join(models, f), path.join(cache, f));
  }
  // A lesson, silently.
  const src = await page.locator('.document-frame').first().getAttribute('src');
  let f;
  await waitFor(async () => (f = page.frames().find((x) => x.url() === src)), 'frame');
  await f.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  const toolbar = page.locator('.selection-toolbar').getByRole('button', { name: '白板' });
  await waitFor(async () => {
    const local = await f.locator('#why').evaluate((e) => e.getBoundingClientRect().toJSON());
    const frame = page.locator('.document-frame').first();
    const parent = await frame.boundingBox();
    const scale = await frame.evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
    const y = parent.y + (local.y + local.height / 2) * scale;
    await page.mouse.move(parent.x + (local.x + 2) * scale, y);
    await page.mouse.down();
    await page.mouse.move(parent.x + (local.x + local.width - 20) * scale, y, { steps: 12 });
    await page.mouse.up();
    await toolbar.waitFor({ timeout: 3000 });
    return true;
  }, 'selection toolbar');
  await toolbar.click();
  await board().getByRole('button', { name: '直接讲' }).click();
  const consent = page.getByRole('dialog', { name: /发送给 本地模拟/ });
  if (await consent.isVisible().catch(() => false))
    await consent.getByRole('button', { name: '同意并继续' }).click();
  await board().locator('.wb-speed').click();
  await board().locator('.wb-speed').click();
  await board().locator('.wb-caption-text', { hasText: '别饱和' }).waitFor({ timeout: 60000 });
  await waitFor(
    async () => !(await board().getByRole('button', { name: '暂停' }).isEnabled()),
    'lesson finished',
    60000,
  );

  // The recording, looped, in place of the microphone.
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
      source.loop = true;
      const out = ctx.createMediaStreamDestination();
      source.connect(out);
      source.start();
      return out.stream;
    };
  }, wav.toString('base64'));

  // A voice conversation: the question is heard through the page and goes to the teacher.
  await board().locator('.wb-voice-button').click();
  const voicePanel = board().getByRole('dialog', { name: '讲解方式' });
  const talk = voicePanel.getByRole('radio', { name: /语音对话/ });
  assert.ok(!(await talk.isDisabled()), 'voice conversation offered');
  // Capture before starting the microphone: on a busy runner, screenshots can finish
  // after the first recognized question has already been submitted.
  const before = asked.length;
  await talk.click();
  await voicePanel.getByText(/SenseVoice/).waitFor();
  await page.screenshot({ path: path.join(evidence, 'voice-panel.png') });
  await page.keyboard.press('Escape');
  const bar = board().locator('.wb-listen');
  await waitFor(async () => (await bar.getAttribute('data-status')) === 'on', 'listening', 30000);
  await waitFor(
    async () => asked.length > before || (await bar.locator('.wb-heard b').count()) > 0,
    'heard',
    30000,
  );
  await page.screenshot({ path: path.join(evidence, 'voice-heard.png') });
  await waitFor(async () => asked.length > before, 'question sent', 30000);
  assert.match(asked.at(-1), /我说（语音）：页老师.*根号/);
  console.log('PASS: the spoken question goes to the teacher:', asked.at(-1).split('：').at(-1));
  assert.deepEqual(
    errors.filter((e) => !/Autofill/.test(e)),
    [],
  );
} finally {
  await app?.close().catch(() => {});
  server.close();
}
