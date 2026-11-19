// Drawings in AI replies: a ```svg block and a ```plot block drawn in the chat, cleaned of
// anything but shapes, with their code a click away. In the real Electron app against a
// local OpenAI-compatible mock; no network or real key.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-figures-'));
const project = path.join(temp, '画图项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-figures-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const testKey = 'mock-key-for-local-test';
await fs.writeFile(
  path.join(project, '01_积分.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>定积分</title></head><body><h1>定积分</h1><p>定积分是曲线下方的面积。</p></body></html>',
);

const answer = [
  '三角形和正方形：',
  '',
  '```svg',
  '<svg viewBox="0 0 360 170">',
  '  <polygon points="20,140 100,20 180,140" stroke="blue"/>',
  '  <rect x="220" y="30" width="110" height="110" stroke="red" onclick="alert(1)"/>',
  '  <script>window.drawn = 1</script>',
  '  <text x="100" y="162" text-anchor="middle" font-size="14">三角形</text>',
  '  <text x="275" y="162" text-anchor="middle" font-size="14">正方形</text>',
  '</svg>',
  '```',
  '',
  '定积分 $\\int_0^2 x^2\\,dx$ 就是下面涂色部分的面积：',
  '',
  '```plot',
  'axes -0.5 2.5 -0.5 5',
  'plot x^2',
  'area x^2 | 0 2',
  'text 1.45 0.9 | S',
  '```',
].join('\n');
const requests = [];
function stream(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunks = [];
  for (let i = 0; i < text.length; i += 12)
    chunks.push({ choices: [{ delta: { content: text.slice(i, i + 12) } }] });
  chunks.push({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
  let i = 0;
  const next = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
      setTimeout(next, 15);
    } else res.end('data: [DONE]\n\n');
  };
  next();
}
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  if (req.headers.authorization !== `Bearer ${testKey}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"bad key"}}');
  }
  if (!body.messages) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ is_available: true, balance_infos: [] }));
  }
  requests.push(body);
  const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (user.includes('连接测试')) return stream(res, 'OK');
  return stream(res, answer);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${server.address().port}/v1`;

let app, page;
const errors = [];
const panel = () => page.locator('.assistant-panel');
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.waitForSelector('.document-frame');
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });

  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手', exact: true }).click();
  await panel().getByRole('button', { name: '配置 AI 服务', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 设置' });
  await settings.getByRole('button', { name: /^DeepSeek/ }).click();
  await settings.getByLabel('名称').fill('本地模拟');
  await settings.getByLabel('API Key').fill(testKey);
  await settings.getByRole('button', { name: /高级设置/ }).click();
  await settings.getByLabel('接口地址').fill(mockUrl);
  await settings.getByRole('button', { name: '获取列表' }).click();
  await settings.getByRole('option', { name: 'mock-model', exact: true }).click();
  await settings.getByRole('button', { name: '添加', exact: true }).click();
  await settings.getByText('已保存', { exact: true }).waitFor();
  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();

  const box = panel().getByLabel('向 AI 提问');
  await box.fill('画个三角形、正方形和 x² 的积分图');
  await box.press('Enter');
  await page
    .getByRole('dialog', { name: /发送给 本地模拟/ })
    .getByRole('button', { name: '同意并继续' })
    .click();
  await panel().locator('.chat-answer.done').waitFor();

  // The model is told how to draw.
  const system = requests.at(-1).messages.find((m) => m.role === 'system').content;
  assert.ok(system.includes('```svg') && system.includes('```plot'), 'drawing in the prompt');
  assert.ok(system.includes('area 表达式 | a b'), 'integral regions in the prompt');

  const answerEl = panel().locator('.chat-answer').last();
  const figures = answerEl.locator('.md-figure');
  assert.equal(await figures.count(), 2, 'two drawings');
  assert.equal(await answerEl.locator('.md-code').count(), 0, 'no code shown');

  // The SVG: its shapes, in board colors, and nothing that runs.
  const svg = figures.nth(0).locator('svg.md-figure-art');
  assert.equal(await svg.getAttribute('viewBox'), '0 0 360 170');
  assert.equal(await svg.locator('polygon').count(), 1);
  assert.equal(await svg.locator('polygon').getAttribute('stroke'), 'var(--board-blue)');
  assert.equal(await svg.locator('rect').getAttribute('onclick'), null, 'handlers dropped');
  assert.equal(await answerEl.locator('script').count(), 0, 'scripts dropped');
  assert.equal(await page.evaluate(() => window.drawn), undefined);
  assert.deepEqual(await svg.locator('text').allTextContents(), ['三角形', '正方形']);
  // Drawn in the chat's ink, not black on a dark theme.
  const ink = await svg
    .locator('text')
    .first()
    .evaluate((el) => getComputedStyle(el).fill);
  const text = await answerEl.evaluate((el) => getComputedStyle(el).color);
  assert.equal(ink, text, 'text in the chat color');

  // The graph: axes, the curve, and the shaded region under it.
  const plot = figures.nth(1).locator('svg.md-figure-art');
  assert.equal(await plot.locator('path[fill-opacity="0.2"]').count(), 1, 'shaded region');
  assert.ok((await plot.locator('path[stroke-width="3"]').count()) === 1, 'the curve');
  assert.ok((await plot.locator('text', { hasText: 'S' }).count()) >= 1, 'the label');
  const size = await plot.boundingBox();
  const room = await answerEl.boundingBox();
  assert.ok(size.width <= room.width + 1, 'fits the panel');
  await answerEl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await answerEl.screenshot({ path: path.join(evidence, 'chat-figures-light.png') });

  // The code is a click away, and the drawing a click back.
  await figures.nth(0).hover();
  await figures.nth(0).getByRole('button', { name: '代码' }).click();
  const source = answerEl.locator('.md-figure-source').first();
  await source.locator('pre').waitFor();
  assert.match(await source.locator('pre').innerText(), /<polygon points="20,140 100,20 180,140"/);
  await source.hover();
  await page.waitForTimeout(200);
  await source.screenshot({ path: path.join(evidence, 'chat-figures-code.png') });
  await source.getByRole('button', { name: '图', exact: true }).click();
  await figures.nth(0).locator('svg.md-figure-art').waitFor();
  assert.equal(await answerEl.locator('.md-figure').count(), 2);

  // A dark theme draws in light ink.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'night'));
  await page.waitForTimeout(300);
  const dark = await svg
    .locator('text')
    .first()
    .evaluate((el) => getComputedStyle(el).fill);
  assert.notEqual(dark, ink, 'ink follows the theme');
  await answerEl.screenshot({ path: path.join(evidence, 'chat-figures-dark.png') });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`chat figures ok — screenshots in ${evidence}`);
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
