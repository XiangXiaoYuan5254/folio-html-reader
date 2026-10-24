// Opt-in network test: real Edge synthesis, decoding, playback and saved-board replay.
// Only the teacher's text is a local fixture; TTS and both audio players are real.
// Uses temporary projects/profiles; sends only the built-in greetings and lesson below.
// Run after npm run build and node scripts/build-speech.mjs: node tests/edge-voice-live.mjs
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-edge-live-'));
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-edge-qa');
await fs.mkdir(evidence, { recursive: true });
const lines = ['你好，现在开始白板讲解。', '这段声音保存后，可以再次播放。'];
let modelRequests = 0;
const server = http.createServer((req, res) => {
  req.resume();
  if (req.url.endsWith('/models')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  modelRequests++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: lines.map((s) => 'say ' + s).join('\n') + '\n' } }] })}\n\n`,
  );
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const results = [];
let app;
let page;
let profile;

async function observeAudio() {
  await page.evaluate(() => {
    window.edgeMedia = [];
    window.edgeSpeech = [];
    const observed = new WeakSet();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this instanceof HTMLAudioElement && !observed.has(this)) {
        observed.add(this);
        for (const type of ['playing', 'ended', 'error'])
          this.addEventListener(type, () =>
            window.edgeMedia.push({
              type,
              duration: this.duration,
              muted: this.muted,
              volume: this.volume,
            }),
          );
      }
      return play.apply(this, args);
    };
    window.folio.subscribe((event) => {
      if (event.type === 'speech') window.edgeSpeech.push(event.event);
    });
  });
}
async function resetAudio() {
  await page.evaluate(() => {
    window.edgeMedia = [];
    window.edgeSpeech = [];
  });
}
async function played(count, helper = false) {
  await page.waitForFunction(
    ({ count, helper }) =>
      helper
        ? window.edgeSpeech.filter((e) => e.type === 'done').length >= count
        : window.edgeMedia.filter((e) => e.type === 'ended').length >= count,
    { count, helper },
    { timeout: 90000 },
  );
  const events = await page.evaluate(() => ({
    media: window.edgeMedia,
    speech: window.edgeSpeech,
  }));
  assert.ok(
    !events.speech.some((e) => ['fail', 'error', 'exit'].includes(e.type)),
    JSON.stringify(events),
  );
  assert.ok(!events.media.some((e) => e.type === 'error'), JSON.stringify(events));
  if (helper)
    assert.ok(events.speech.filter((e) => e.type === 'ready' && e.ms > 1000).length >= count);
  else
    assert.ok(
      events.media.filter((e) => e.type === 'playing' && e.duration > 1 && !e.muted && e.volume > 0)
        .length >= count,
    );
  return events;
}
async function speechLog() {
  return (await fs.readFile(path.join(profile, 'logs/speech.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
}

try {
  for (const helper of process.platform === 'darwin' ? [true, false] : [false]) {
    const mode = helper ? 'helper' : 'page';
    const project = path.join(temp, mode, 'project');
    profile = path.join(temp, mode, 'profile');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, 'demo.html'),
      '<!doctype html><meta charset="utf-8"><h1>语音测试</h1><p>试听、讲解和回放。</p>',
    );
    app = await electron.launch({
      args: [path.resolve('.')],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        FOLIO_MEMBER: '1',
        FOLIO_USER_DATA: profile,
        FOLIO_WORKSPACE: project,
        FOLIO_NO_SPEECH_HELPER: helper ? undefined : '1',
        FOLIO_SPEECH_SILENT: undefined,
      },
    });
    // No need to discover the user's Codex account for this Edge-only test.
    await app.evaluate(({ BrowserWindow }, modulePath) => {
      process.mainModule.require(modulePath).status = async () => ({ account: null });
      for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(false);
    }, path.resolve('electron/ai-codex.cjs'));
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.document-frame');
    await page.evaluate(async (baseUrl) => {
      const { provider } = await window.folio.invoke('ai-save-provider', {
        preset: 'custom',
        name: 'Local test',
        model: 'mock-model',
        baseUrl,
        key: 'mock-test-key',
      });
      await window.folio.invoke('ai-prefs', { consented: [provider.id] });
      localStorage.setItem(
        'folio.board-voice',
        JSON.stringify({ mode: 'speak', voice: 'cloud:edge:zh-CN-XiaoxiaoNeural', ears: 'local' }),
      );
    }, baseUrl);
    await page.reload();
    await page.waitForSelector('.document-frame');
    await page.locator('.reader-loading').waitFor({ state: 'hidden' });
    await observeAudio();
    assert.equal((await page.evaluate(() => window.folio.invoke('speech-voices'))).helper, helper);

    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '语音', exact: true })
      .click();
    const edge = settings.locator('.ai-voice-service', { hasText: 'Edge TTS（推荐）' });
    assert.equal(await edge.locator('input[type="password"]').count(), 0);
    await edge.getByRole('combobox').selectOption('zh-CN-XiaoxiaoNeural');
    await edge.getByRole('button', { name: '试听', exact: true }).click();
    await edge
      .getByRole('status')
      .filter({ hasText: '可以用：这是「晓晓」的声音' })
      .waitFor({ timeout: 90000 });
    const sample = await played(1);
    await page.screenshot({ path: path.join(evidence, `${mode}-settings.png`) });
    await settings.getByRole('button', { name: '关闭设置' }).click();
    console.log(`PASS (${mode}): real Edge settings sample played to completion`);

    // The voice chooser's sample uses the same path as a live lesson.
    await page.getByRole('button', { name: '新建空白白板', exact: true }).click();
    const board = page.getByRole('dialog', { name: '白板讲解', exact: true });
    await board.locator('.wb-voice-button').click();
    const voices = board.getByRole('dialog', { name: '讲解方式' });
    await resetAudio();
    await voices.getByLabel('页老师的声音').selectOption('cloud:edge:zh-CN-YunxiNeural');
    const voiceSample = await played(1, helper);
    await board.locator('.wb-voice-button').click();
    assert.equal(
      (await page.evaluate(() => JSON.parse(localStorage.getItem('folio.board-voice')))).voice,
      'cloud:edge:zh-CN-YunxiNeural',
    );

    await resetAudio();
    await board.getByLabel('向页老师提问').fill('请讲解语音测试');
    await board.getByLabel('向页老师提问').press('Enter');
    const lesson = await played(lines.length, helper);
    await board.getByRole('button', { name: '重看讲解', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="重看讲解"]').disabled);
    await board.getByRole('button', { name: '字幕记录', exact: true }).click();
    assert.deepEqual(
      (await board.locator('.wb-log p[data-who="teacher"]').allInnerTexts()).map((s) =>
        s.replace(/^页老师\s*/, ''),
      ),
      lines,
    );
    await page.screenshot({ path: path.join(evidence, `${mode}-lesson.png`) });
    const entries = JSON.parse(
      await fs.readFile(path.join(project, '.html-reader', 'boards', 'index.json'), 'utf8'),
    );
    assert.equal(entries.length, 1);
    const sounds = path.join(project, '.html-reader', 'boards', 'sounds', entries[0].id);
    for (const line of lines) {
      const key = createHash('sha1').update(line).digest('hex').slice(0, 24);
      const saved = await fs.readFile(path.join(sounds, `${key}.ogg`));
      assert.equal(saved.subarray(0, 4).toString(), 'OggS');
      assert.ok(saved.length > 1000);
    }
    console.log(`PASS (${mode}): voice chooser, all lesson sentences and persisted Opus audio`);

    // Reload to discard in-memory audio, then open the saved board and replay from disk.
    await board.getByRole('button', { name: '关闭白板', exact: true }).click();
    await page.reload();
    await page.waitForSelector('.document-frame');
    await observeAudio();
    await page.locator('.board-row-open').filter({ hasText: entries[0].title }).click();
    await board.waitFor();
    const modelBeforeReplay = modelRequests;
    const startsBeforeReplay = (await speechLog()).filter((e) => e.event === 'start').length;
    // Fail any accidental TTS request during replay; cached audio must suffice.
    await app.evaluate(({}, modulePath) => {
      globalThis.replayTtsRequests = 0;
      process.mainModule.require(modulePath).synthesize = async () => {
        globalThis.replayTtsRequests++;
        throw Error('Replay must use saved audio');
      };
    }, path.resolve('electron/edge-voice.cjs'));
    await board.getByRole('button', { name: '重看讲解', exact: true }).click();
    const replay = await played(lines.length);
    await board.getByRole('button', { name: '再看一遍', exact: true }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(evidence, `${mode}-replay.png`) });
    assert.equal(modelRequests, modelBeforeReplay);
    assert.equal(await app.evaluate(() => globalThis.replayTtsRequests), 0);
    const log = await speechLog();
    assert.equal(log.filter((e) => e.event === 'start').length, startsBeforeReplay);
    assert.equal(log.filter((e) => ['failed', 'client-failed'].includes(e.event)).length, 0);
    assert.equal(log.filter((e) => e.event === 'success').length, 2 + lines.length);
    assert.deepEqual(errors, []);
    results.push({
      mode,
      sample,
      voiceSample,
      lesson,
      replay,
      synthesisSuccesses: log.filter((e) => e.event === 'success').length,
      replayTtsRequests: 0,
      errors,
    });
    console.log(
      `PASS (${mode}): reopened board replayed every cached sentence with no TTS/model requests`,
    );
    await app.close();
    app = null;
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    console.error(
      await page
        .locator('body')
        .innerText()
        .catch(() => 'No page'),
    );
  }
  if (profile) console.error(await speechLog().catch(() => 'No speech log'));
  throw error;
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
