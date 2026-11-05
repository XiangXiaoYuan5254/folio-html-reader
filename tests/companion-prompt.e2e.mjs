// The 精读笔记 writing in the reader's own words (AI 设置 › 精读笔记提示词), in the real
// Electron app against a local OpenAI-compatible mock: it replaces Folio's writing, the
// reader profile and Folio's format still go with it, 恢复默认 brings Folio's back, and
// Folio's own prompt never shows in the settings.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-companion-prompt-'));
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(
  path.join(project, '01_文档.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>注意力</title></head><body><h1>注意力机制</h1><p>注意力让每个词都能参考句子里的其他词。</p></body></html>',
);
const mine = '你是我的导读助手。只写三部分：一句话总结、关键概念、思考题。';

const systems = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    return res.end();
  }
  const body = JSON.parse(raw);
  systems.push(body.messages.find((m) => m.role === 'system')?.content || '');
  const text =
    '<header class="hero"><p class="kicker">精读笔记</p><h1>注意力精读</h1><p class="tldr">一句话。</p></header><section class="card"><h2>关键概念</h2><p>注意力。</p></section>';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await fs.writeFile(
  path.join(userData, 'ai.json'),
  JSON.stringify({
    version: 1,
    active: 'p1',
    prefs: { consented: ['p1'], profile: '我是医学生' },
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
const prefs = async () =>
  JSON.parse(await fs.readFile(path.join(userData, 'ai.json'), 'utf8')).prefs;
async function waitFor(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}

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
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  async function openPromptPage() {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: 'AI' })
      .click();
    await settings.getByRole('button', { name: '精读笔记提示词' }).click();
  }
  const writing = () => settings.getByLabel('精读笔记的写作要求');

  // Folio's writing to start with; the reader's own in its place.
  await openPromptPage();
  // Folio's own prompt is not shown: the box starts empty.
  assert.equal(await writing().inputValue(), '');
  await settings.getByText('留空使用页间默认提示词').waitFor();
  const shown = await settings.evaluate((e) => e.innerText + e.innerHTML);
  for (const part of ['耐心、严谨的导读作者', '【讲解原则】', '【输出格式】', 'class="hero"'])
    assert.ok(!shown.includes(part), `Folio's prompt shows: ${part}`);
  await writing().fill(mine);
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await settings.getByText('已保存').waitFor();
  assert.equal((await prefs()).companionPrompt, mine);
  await settings.getByText('正在使用你的版本').waitFor();
  await settings.getByRole('button', { name: '关闭设置' }).click();

  // The notes are written with it, the profile and Folio's format after it.
  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手', exact: true }).click();
  await page.locator('.assistant-panel').getByRole('button', { name: '制作精读笔记' }).click();
  await waitFor(
    () => fs.stat(path.join(project, '01_文档-精读笔记.html')).then(() => true),
    'notes written',
  );
  const system = systems.at(-1);
  assert.ok(system.startsWith(mine), 'the reader’s writing comes first');
  assert.ok(system.includes('【读者自述】') && system.includes('我是医学生'), 'profile');
  assert.ok(system.includes('【输出格式】'), 'Folio’s format');
  assert.ok(!system.includes('耐心、严谨的导读作者'), 'Folio’s writing left out');

  // 恢复默认: Folio's writing again, nothing of the reader's kept.
  await openPromptPage();
  await settings.getByRole('button', { name: '恢复默认' }).click();
  await settings.getByText('已恢复默认').waitFor();
  assert.equal((await prefs()).companionPrompt, '');
  assert.equal(await writing().inputValue(), '');
  await settings.getByText('留空使用页间默认提示词').waitFor();

  assert.deepEqual(errors, []);
  console.log('PASS: 精读笔记 written with the reader’s own prompt, Folio’s format kept');
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
