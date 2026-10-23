// Opt-in network smoke test: real Edge synthesis, Electron decoding, and both playback paths.
// Uses a temporary project/profile and only sends the built-in greeting to Microsoft.
// Run after npm run build: node tests/edge-voice-live.mjs
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-edge-live-'));
const project = path.join(temp, 'project');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-edge-qa');
await fs.mkdir(project);
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(
  path.join(project, 'demo.html'),
  '<!doctype html><meta charset="utf-8"><h1>免费在线声音</h1><p>试听晓晓的中文朗读。</p>',
);

let app;
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_MEMBER: '1',
      FOLIO_USER_DATA: path.join(temp, 'profile'),
      FOLIO_WORKSPACE: project,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.document-frame');
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });

  // Observe actual playback; do not replace the player or synthesis with a mock.
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
            window.edgeMedia.push({ type, duration: this.duration }),
          );
      }
      return play.apply(this, args);
    };
    window.folio.subscribe((event) => {
      if (event.type === 'speech') window.edgeSpeech.push(event.event);
    });
  });

  await page.getByLabel('AI 助手', { exact: true }).click();
  await page.getByRole('button', { name: '配置 AI 服务', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 设置' });
  await settings.getByRole('button', { name: '语音服务' }).click();
  const edge = settings.locator('.ai-voice-service', { hasText: 'Edge TTS（推荐）' });
  assert.equal(await edge.locator('input[type="password"]').count(), 0);
  await edge.getByRole('combobox').selectOption('zh-CN-XiaoxiaoNeural');
  await edge.getByRole('button', { name: '试听', exact: true }).click();
  await edge
    .getByRole('status')
    .filter({ hasText: '可以用：这是「晓晓」的声音' })
    .waitFor({ timeout: 35000 });
  await page.waitForFunction(() => window.edgeMedia.some((e) => e.type === 'ended'), null, {
    timeout: 15000,
  });
  const media = await page.evaluate(() => window.edgeMedia);
  assert.ok(media.some((e) => e.type === 'playing' && e.duration > 1));
  assert.ok(!media.some((e) => e.type === 'error'));
  await page.screenshot({ path: path.join(evidence, 'edge-settings.png') });
  console.log(
    'PASS: no key, real Edge synthesis and MP3 decoding, page audio played to completion',
  );

  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  await page.getByRole('button', { name: '新建空白白板', exact: true }).click();
  const board = page.getByRole('dialog', { name: '白板讲解' });
  await board.locator('.wb-voice-button').click();
  const voice = page.getByRole('dialog', { name: '讲解方式' });
  const pick = voice.getByLabel('页老师的声音');
  const selected = 'cloud:edge:zh-CN-XiaoxiaoNeural';
  await pick.locator(`option[value="${selected}"]`).waitFor({ state: 'attached' });
  const support = await page.evaluate(() => window.folio.invoke('speech-voices'));
  await page.evaluate(() => {
    window.edgeMedia = [];
    window.edgeSpeech = [];
  });
  await pick.selectOption(selected);
  assert.equal(await pick.inputValue(), selected);
  await voice.getByText(/免费、无需 Key/).waitFor();
  if (support.helper) {
    await page.waitForFunction(
      () => window.edgeSpeech.some((e) => e.type === 'done' && e.id.startsWith('sample-')),
      null,
      { timeout: 35000 },
    );
    const events = await page.evaluate(() => window.edgeSpeech);
    assert.ok(events.some((e) => e.type === 'ready' && e.ms > 0));
    assert.ok(!events.some((e) => e.type === 'fail'));
  } else {
    await page.waitForFunction(() => window.edgeMedia.some((e) => e.type === 'ended'), null, {
      timeout: 35000,
    });
    assert.ok(!(await page.evaluate(() => window.edgeMedia.some((e) => e.type === 'error'))));
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('folio.board-voice')));
  assert.equal(saved.voice, selected);
  await page.screenshot({ path: path.join(evidence, 'edge-board.png') });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: whiteboard voice selection persisted and sample completed via ${support.helper ? 'native helper' : 'page player'}`,
  );
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
