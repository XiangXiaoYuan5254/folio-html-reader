// Real Electron IPC, retry scheduling, UI, cache and both players; only the external
// model/TTS services are replaced. Uses temporary profiles, never the installed app.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-voice-recovery-'));
const project = path.join(temp, 'project');
await fs.mkdir(project);
await fs.writeFile(
  path.join(project, 'test.html'),
  '<!doctype html><meta charset="utf-8"><p>语音恢复测试</p>',
);
const lines = ['第一句正常。', '第二句需要重试。', '第三句不能抢先。'];
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  req.resume();
  if (req.url.endsWith('/models')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: lines.map((s) => 'say ' + s).join('\n') + '\n' } }] })}\n\n`,
  );
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let app;
try {
  for (const helper of process.platform === 'darwin' ? [true, false] : [false]) {
    const profile = path.join(temp, helper ? 'helper' : 'page');
    app = await electron.launch({
      args: [path.resolve('.')],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        FOLIO_USER_DATA: profile,
        FOLIO_WORKSPACE: project,
        FOLIO_SPEECH_SILENT: '1',
        FOLIO_NO_SPEECH_HELPER: helper ? undefined : '1',
      },
    });
    await app.evaluate(({ BrowserWindow }, modulePath) => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.setAudioMuted(true));
      globalThis.recoveryTest = { recover: false, attempts: {} };
      const edge = process.mainModule.require(modulePath);
      // This test doesn't use Codex; don't start the user's real Codex account discovery.
      process.mainModule.require(modulePath.replace('edge-voice.cjs', 'ai-codex.cjs')).status =
        async () => ({ account: null });
      edge.synthesize = async ({ text }) => {
        const state = globalThis.recoveryTest;
        state.attempts[text] = (state.attempts[text] || 0) + 1;
        if (text === '第二句需要重试。' && !state.recover)
          throw Object.assign(Error('Edge TTS 连接中断，声音没有生成完整，请重试'), {
            retry: true,
            stage: 'receive',
            code: 'ECONNRESET',
          });
        const pcm = Buffer.alloc((24000 / 5) * 2);
        for (let i = 0; i < pcm.length / 2; i++)
          pcm.writeInt16LE(Math.round(1000 * Math.sin(i / 10)), i * 2);
        return { pcm, rate: 24000 };
      };
    }, path.resolve('electron/edge-voice.cjs'));
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.document-frame');
    await page.evaluate(
      async ({ baseUrl, project }) => {
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
          JSON.stringify({
            mode: 'speak',
            voice: 'cloud:edge:zh-CN-XiaoxiaoNeural',
            ears: 'local',
          }),
        );
      },
      { baseUrl, project },
    );
    await page.reload();
    await page.waitForSelector('.document-frame');
    const support = await page.evaluate(() => window.folio.invoke('speech-voices'));
    assert.equal(support.helper, helper);
    await page.getByRole('button', { name: '新建空白白板', exact: true }).click();
    const board = page.getByRole('dialog', { name: '白板讲解' });
    await board.getByLabel('向页老师提问').fill('请讲解测试内容');
    await board.getByLabel('向页老师提问').press('Enter');
    await board
      .getByRole('button', { name: '重试本句', exact: true })
      .waitFor()
      .catch(async (error) => {
        console.error(await board.innerText());
        console.error({ requests, errors });
        console.error(await app.evaluate(() => globalThis.recoveryTest));
        console.error(
          await fs
            .readFile(path.join(profile, 'logs/speech.jsonl'), 'utf8')
            .catch(() => 'No speech log'),
        );
        throw error;
      });
    await board.getByRole('alert').filter({ hasText: '连接中断' }).waitFor();
    assert.equal(await app.evaluate(() => globalThis.recoveryTest.attempts['第二句需要重试。']), 3);
    await board.getByRole('button', { name: '字幕记录', exact: true }).click();
    const captions = board.locator('.wb-log p[data-who="teacher"]');
    assert.equal(await captions.count(), 1);
    assert.ok((await captions.first().innerText()).includes(lines[0]));
    // The failed sentence holds its place, even though the following audio is ready.
    await page.waitForTimeout(500);
    assert.equal(await captions.count(), 1);
    await app.evaluate(() => {
      globalThis.recoveryTest.recover = true;
    });
    await board.getByRole('button', { name: '重试本句', exact: true }).click();
    await captions.filter({ hasText: lines[2] }).waitFor();
    assert.deepEqual(
      (await captions.allInnerTexts()).map((s) => s.replace(/^页老师\s*/, '')),
      lines,
    );
    assert.equal(await board.getByRole('button', { name: '重试本句', exact: true }).count(), 0);
    const log = (await fs.readFile(path.join(profile, 'logs/speech.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    const failed = log.find((e) => e.event === 'failed');
    assert.equal(failed.code, 'ECONNRESET');
    assert.equal(failed.attempt, 3);
    assert.ok(failed.board && failed.textHash && failed.request);
    assert.ok(log.some((e) => e.event === 'success' && e.textHash === failed.textHash));
    assert.equal(log.filter((e) => e.event === 'retry').length, 2);
    assert.deepEqual(errors, []);
    console.log(
      `PASS: ${helper ? 'native helper' : 'page audio'} retries twice, holds failed sentence, resumes in order and persists diagnostics`,
    );
    await app.close();
    app = null;
  }
} finally {
  await app?.close();
  await new Promise((r) => server.close(r));
  await fs.rm(temp, { recursive: true, force: true });
}
