// The whiteboard lesson, finding and saving a paper with the project assistant, and interface
// themes, in the real app against a local OpenAI-compatible mock. The paper search goes to the
// real OpenAlex and arXiv; the PDF itself comes from the mock. Runs on macOS and Windows.
import { _electron as electron } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-board-'));
const project = path.join(temp, '白板 项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-board-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const testKey = 'mock-key-for-local-test';
await fs.writeFile(
  path.join(project, '01_注意力.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>注意力</title>
<style>body{font:18px/1.9 system-ui;padding:40px 60px;color:#253342}</style></head>
<body><h1>缩放点积注意力</h1>
<p><span id="why">公式里除以根号 d k，是为了让点积的方差回到 1，softmax 不会饱和。</span>这样梯度不会消失。</p>
</body></html>`,
);
const paper = await PDFDocument.create();
const font = await paper.embedFont(StandardFonts.Helvetica);
paper.addPage([600, 800]).drawText('Attention Is All You Need', { x: 60, y: 720, size: 26, font });
const paperBytes = Buffer.from(await paper.save());

// A short lesson in the board's script: a title, a formula with a part to circle, a figure.
const LESSON = String.raw`say 这段在回答一个问题：公式里为什么要除以根号 d k。
title t0 | 为什么要除以 √dₖ
math m1 | \mathrm{Attention}=\mathrm{softmax}\left(\frac{[[qk:QK^\top]]}{[[dk:\sqrt{d_k}]]}\right)V
say 先看分子，Q 和 K 的点积。
circle qk blue
figure g1 | 600 250
draw g1 | <text x="150" y="26" text-anchor="middle" font-size="17">不缩放</text><line x1="40" y1="200" x2="260" y2="200"/>
draw g1 | <rect id="big" x="58" y="48" width="30" height="152" stroke="red" fill="red" fill-opacity="0.18"/>
circle big red
text t2 | 除以 $\sqrt{d_k}$：方差 $d_k \to 1$，softmax 不饱和
box t2 green
say 所以除以根号 d k，就是让 softmax 别饱和。`;

const requests = [];
function stream(res, { text = '', toolCalls = [] }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunks = [];
  for (let i = 0; i < text.length; i += 24)
    chunks.push({ choices: [{ delta: { content: text.slice(i, i + 24) } }] });
  toolCalls.forEach((call, index) =>
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${Math.random().toString(36).slice(2)}`,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          },
        },
      ],
    }),
  );
  chunks.push({
    choices: [{ delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 500, completion_tokens: 60 },
  });
  let i = 0;
  const next = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
      setTimeout(next, 4);
    } else res.end('data: [DONE]\n\n');
  };
  next();
}
// The assistant searches, then saves the paper under a name with a colon, as models do.
const paperName = '论文/Attention: All You Need.pdf';
function agentTurn(messages) {
  const results = messages.filter((m) => m.role === 'tool');
  if (!results.length)
    return {
      toolCalls: [
        {
          name: 'search_papers',
          input: { query: 'attention is all you need transformer', limit: 4, pdf_only: true },
        },
      ],
    };
  if (results.length === 1)
    return {
      toolCalls: [
        {
          name: 'save_pdf',
          input: { url: `${base}/paper.pdf`, path: paperName, title: 'Attention Is All You Need' },
        },
      ],
    };
  return { text: '论文已经存好了。' };
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/paper.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end(paperBytes);
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, body });
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  if (req.headers.authorization !== `Bearer ${testKey}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"bad key"}}');
  }
  // DeepSeek's balance, which the settings and the model menu ask for.
  if (req.url === '/user/balance') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      '{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"10.00"}]}',
    );
  }
  const system = body.messages.find((m) => m.role === 'system')?.content || '';
  const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (typeof user === 'string' && user.includes('连接测试')) return stream(res, { text: 'OK' });
  if (system.includes('白板老师')) return stream(res, { text: LESSON });
  if (body.tools) return stream(res, agentTurn(body.messages));
  return stream(res, { text: '好的。' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

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
async function frame() {
  const src = await page.locator('.document-frame').first().getAttribute('src');
  let f;
  await waitFor(async () => (f = page.frames().find((x) => x.url() === src)), 'frame');
  await f.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  return f;
}
async function screenBox(f, selector) {
  const local = await f.locator(selector).evaluate((e) => e.getBoundingClientRect().toJSON());
  const parent = await page.locator('.document-frame').first().boundingBox();
  const scale = await page
    .locator('.document-frame')
    .first()
    .evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
  return {
    x: parent.x + local.x * scale,
    y: parent.y + local.y * scale,
    width: local.width * scale,
    height: local.height * scale,
  };
}
const board = () => page.getByRole('dialog', { name: '白板讲解' });
const panel = () => page.locator('.assistant-panel');
const consent = () => page.getByRole('dialog', { name: /发送给 本地模拟/ });
// Asks for the lesson on the selected sentence and waits until the teacher has finished it.
async function lesson() {
  const f = await frame();
  const why = await screenBox(f, '#why');
  await page.mouse.move(why.x + 2, why.y + why.height / 2);
  await page.mouse.down();
  await page.mouse.move(why.x + why.width - 20, why.y + why.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.locator('.selection-toolbar').getByRole('button', { name: '白板' }).click();
  // Caption/drawing checks do not need the default cloud voice.
  await board().locator('.wb-voice-button').click();
  await board()
    .getByRole('radio', { name: /^静音讲解/ })
    .click();
  await page.keyboard.press('Escape');
  await board().getByRole('button', { name: '直接讲' }).click();
  if (
    await consent()
      .isVisible()
      .catch(() => false)
  )
    await consent().getByRole('button', { name: '同意并继续' }).click();
  await board().locator('.wb-speed').click();
  await board().locator('.wb-speed').click();
  await board()
    .locator('.wb-caption-text', { hasText: '让 softmax 别饱和' })
    .waitFor({ timeout: 90000 });
}

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
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.waitForSelector('.document-frame');
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
  await frame();

  // A service pointed at the mock, as in tests/ai.e2e.mjs.
  await page.getByLabel('AI 助手', { exact: true }).click();
  await panel().getByRole('button', { name: '配置 AI 服务', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 设置' });
  await settings.getByRole('button', { name: /^DeepSeek/ }).click();
  await settings.getByLabel('名称').fill('本地模拟');
  await settings.getByLabel('API Key').fill(testKey);
  await settings.getByRole('button', { name: /高级设置/ }).click();
  await settings.getByLabel('接口地址').fill(`${base}/v1`);
  await settings.getByRole('button', { name: '获取列表' }).click();
  await settings.getByRole('option', { name: 'mock-model', exact: true }).click();
  await settings.getByRole('button', { name: '添加', exact: true }).click();
  await settings.getByText('已保存').waitFor();
  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();

  // The whiteboard: the lesson is drawn and captioned, then kept in the project.
  await lesson();
  await board().locator('.wb-title', { hasText: '为什么要除以' }).waitFor();
  assert.ok((await board().locator('.wb-math .katex').count()) > 0, 'formula typeset');
  assert.ok((await board().locator('.wb-figure rect').count()) > 0, 'figure drawn');
  await board().locator('.wb-text .katex').first().waitFor();
  await page.screenshot({ path: path.join(evidence, 'board-lesson.png') });
  await board().getByLabel('关闭白板', { exact: true }).click();
  await board().waitFor({ state: 'detached' });
  const shelf = page.getByRole('region', { name: '白板' });
  await shelf.locator('.board-row').first().waitFor();
  const saved = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/boards/index.json'), 'utf8'),
  );
  assert.equal(saved.length, 1, 'board kept in the project');
  await shelf.locator('.board-row-open').first().click();
  await board().locator('.wb-title', { hasText: '为什么要除以' }).waitFor();
  await board().getByLabel('关闭白板', { exact: true }).click();
  await board().waitFor({ state: 'detached' });
  console.log('PASS: whiteboard lesson drawn, captioned, kept and reopened');

  // The teacher speaking: the page's speech synthesis where there is no macOS helper.
  if (process.platform !== 'darwin') {
    await lesson();
    await board().locator('.wb-voice-button').click();
    const voicePanel = board().getByRole('dialog', { name: '讲解方式' });
    await voicePanel.getByRole('radio', { name: /页老师出声/ }).click();
    const talk = voicePanel.getByRole('radio', { name: /语音对话/ });
    assert.ok(!(await talk.isDisabled()), 'voice conversation offered without the macOS helper');
    await page.keyboard.press('Escape');
    await board().getByLabel('向页老师提问').fill('再讲一遍');
    await board().getByRole('button', { name: '提问' }).click();
    await board()
      .locator('.wb-caption-text', { hasText: '让 softmax 别饱和' })
      .waitFor({ timeout: 90000 });
    await waitFor(
      async () =>
        !(await board().getByRole('button', { name: '暂停' }).isEnabled()) &&
        (await board().locator('.wb-caption-text', { hasText: '别饱和' }).count()) > 0,
      'spoken lesson finished',
      90000,
    );
    await board().getByLabel('关闭白板', { exact: true }).click();
    await board().waitFor({ state: 'detached' });
    console.log('PASS: the teacher speaks with the system speech and finishes the lesson');
  }

  // The assistant finds papers and, once approved, saves one into the project.
  // Still open from setting up the service; a click would slide it shut.
  if (!(await panel().isVisible())) await page.getByLabel('AI 助手', { exact: true }).click();
  await panel().getByRole('tab', { name: '整个项目' }).click();
  await panel().getByLabel('向 AI 提问').fill('找一篇 Transformer 的原始论文存到“论文”文件夹');
  await panel().getByLabel('向 AI 提问').press('Enter');
  if (
    await consent()
      .isVisible()
      .catch(() => false)
  )
    await consent().getByRole('button', { name: '同意并继续' }).click();
  await panel().locator('.agent-step.done', { hasText: '查找论文' }).waitFor({ timeout: 40000 });
  const searched = requests
    .findLast((r) => r.body?.tools && r.body.messages.some((m) => m.role === 'tool'))
    .body.messages.find((m) => m.role === 'tool').content;
  assert.match(searched, /找到 \d+ 篇/, `paper search: ${searched.slice(0, 300)}`);
  assert.match(searched, /Attention Is All You Need/i, 'the paper is among the results');
  // Windows can't store a colon in a name, so there the name is made valid before approval.
  const expected = process.platform === 'win32' ? '论文/Attention - All You Need.pdf' : paperName;
  const step = panel().locator('.agent-step.waiting', { hasText: `保存 PDF 到 ${expected}` });
  await step.getByText(`${base}/paper.pdf`).waitFor();
  await step.getByRole('button', { name: '应用', exact: true }).click();
  await panel().getByText('论文已经存好了').waitFor();
  assert.deepEqual(await fs.readFile(path.join(project, expected)), paperBytes);
  await page
    .getByRole('navigation', { name: '项目文件' })
    .getByRole('button', { name: path.basename(expected), exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(evidence, 'papers-saved.png') });
  console.log('PASS: assistant searches OpenAlex/arXiv and saves an approved PDF');

  // Themes change the interface and are remembered with the window colors.
  await page.getByLabel('界面主题', { exact: true }).click();
  await page
    .getByRole('dialog', { name: '界面主题' })
    .getByLabel(/^夜读：/)
    .click();
  await page.keyboard.press('Escape');
  // The new theme fades in over the old one.
  await waitFor(
    async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'night',
    'night theme',
  );
  await waitFor(async () => {
    const s = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    return s.appearance?.titlebar === '#15191f';
  }, 'window colors remembered');
  await page.screenshot({ path: path.join(evidence, 'theme-night.png') });
  console.log('PASS: switching to a dark theme recolors the interface and is remembered');

  assert.deepEqual(errors, []);
  console.log('BOARD AND PAPERS E2E PASS');
} catch (error) {
  console.error('BOARD AND PAPERS E2E FAILED:', error);
  console.error('ERRORS:', errors);
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  // Closing (not killing) the app, so its helper processes go too and node can exit.
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      .catch(() => {});
    await app.close().catch(() => {});
  }
  server.closeAllConnections();
  server.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
