// Picking which models the model menu shows, in the real Electron app, against a local
// OpenAI-compatible mock. A menu that already listed every model shows just the picked ones
// once they are saved, without asking the service again.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-picks-'));
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-picks-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(
  path.join(project, '01_文档.html'),
  '<!doctype html><html><meta charset="utf-8"><body><h1>文档</h1><p>一段文字。</p></body></html>',
);

const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-large' }, { id: 'mock-extra' }] }),
    );
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const lists = () => requests.filter((url) => url.endsWith('/models')).length;
// A saved service pointed at the mock; the key only exists for the mock.
await fs.writeFile(
  path.join(userData, 'ai.json'),
  JSON.stringify({
    version: 1,
    active: 'p1',
    prefs: {},
    uses: {},
    speech: {},
    providers: [
      {
        id: 'p1',
        preset: 'custom',
        kind: 'openai',
        name: '本地模拟',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: 'mock-model',
        context: 128000,
        maxOutput: 0,
        effort: '',
        keyHint: 'moc…test',
        key: 'txt:' + Buffer.from('mock-key-for-local-test').toString('base64'),
        vision: {},
      },
    ],
  }),
);

let app;
const errors = [];
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_MEMBER: '1',
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.document-frame');
  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手', exact: true }).click();
  const panel = page.locator('.assistant-panel');
  const picker = panel.getByRole('button', { name: '选择模型和推理强度' });
  const menu = page.getByRole('menu', { name: '模型和推理强度' });

  // Nothing picked: the menu lists all the service's models.
  await picker.click();
  await menu.getByRole('menuitemradio', { name: 'mock-extra' }).waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });

  // Pick one model in the settings, with the menu above still holding the whole list.
  await panel.getByLabel('AI 设置', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 设置' });
  await settings.getByRole('button', { name: '只显示部分模型' }).click();
  const shown = settings.getByRole('group', { name: '要显示的模型' });
  await shown.getByRole('checkbox', { name: 'mock-large' }).check();
  // A click anywhere else closes the list; the picks stay.
  await settings.getByText('名称', { exact: true }).click();
  await shown.waitFor({ state: 'hidden' });
  await settings.locator('.ai-picks-chips', { hasText: 'mock-large' }).waitFor();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await settings.getByText('已保存').waitFor();
  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  const asked = lists();

  // The same menu now shows just the picked model and the one in use.
  await picker.click();
  await menu.getByRole('menuitemradio', { name: 'mock-large' }).waitFor();
  await menu.getByRole('menuitemradio', { name: 'mock-model' }).waitFor();
  assert.equal(await menu.getByRole('menuitemradio', { name: 'mock-extra' }).count(), 0);
  assert.equal(lists(), asked, 'picked models are listed without asking the service');
  await page.screenshot({ path: path.join(evidence, 'model-menu-picked.png') });
  await page.keyboard.press('Escape');

  // Picking none again brings the whole list back.
  await panel.getByLabel('AI 设置', { exact: true }).click();
  await settings.getByRole('button', { name: '修改' }).click();
  await settings.getByRole('button', { name: '全部取消' }).click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await settings.getByText('已保存').waitFor();
  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  await picker.click();
  await menu.getByRole('menuitemradio', { name: 'mock-extra' }).waitFor();

  assert.deepEqual(errors, []);
  console.log('PASS: a model menu that listed everything shows only the picked models once saved');
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
