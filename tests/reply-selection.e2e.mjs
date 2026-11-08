// Text selected in an AI reply: 引用 into the question, 解释 in the conversation, 翻译 beside
// it. In the real Electron app against a local OpenAI-compatible mock; no network or real key.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-reply-'));
const project = path.join(temp, '划词项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-reply-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const testKey = 'mock-key-for-local-test';
const S1 = '注意力机制让模型在处理每个词时，都能直接参考句子里的其他所有词。';
await fs.writeFile(
  path.join(project, '01_注意力.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>注意力</title></head>
<body><h1>注意力机制简介</h1><p>${S1}</p><p>Positional encodings add sine and cosine signals.</p></body></html>`,
);

const answer = `公式 $E=mc^2$ 说明质量和能量可以互换<cite>${S1.slice(0, -1)}</cite>。\n\nAttention lets every token look at all other tokens.\n\n- 第一点\n- 第二点`;
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
  const system = body.messages.find((m) => m.role === 'system')?.content || '';
  const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (user.includes('连接测试')) return stream(res, 'OK');
  if (system.includes('专业译者')) return stream(res, 'Mass and energy are interchangeable.');
  if (user.includes('解释一下这段话')) return stream(res, '这句话是说质量可以变成能量。');
  if (body.tools) return stream(res, '项目里的回答：位置编码补上了顺序。');
  return stream(res, answer);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${server.address().port}/v1`;

let app, page;
const errors = [];
async function waitFor(fn, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
const panel = () => page.locator('.assistant-panel');
const bar = () => panel().locator('.reply-selection');
const lastUser = () => [...requests.at(-1).messages].reverse().find((m) => m.role === 'user');
// Selects a paragraph of the latest reply the way a reader does, with a triple click.
async function pick(text) {
  await panel().locator('.chat-answer').last().locator('p, li', { hasText: text }).first().click({
    clickCount: 3,
  });
  await bar().waitFor();
}
// Drags across a whole paragraph, as a triple click stops at a formula.
async function drag(text, answer = panel().locator('.chat-answer').last()) {
  const { a, b } = await answer
    .locator('p', { hasText: text })
    .first()
    .evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()];
      const [first, last] = [rects[0], rects.at(-1)];
      return {
        a: { x: first.left + 1, y: first.top + first.height / 2 },
        b: { x: last.right + 4, y: last.top + last.height / 2 },
      };
    });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await bar().waitFor();
}
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
  await box.fill('讲讲这个公式');
  await box.press('Enter');
  await page
    .getByRole('dialog', { name: /发送给 本地模拟/ })
    .getByRole('button', { name: '同意并继续' })
    .click();
  await panel().locator('.chat-answer.done').waitFor();
  await panel().locator('.chat-answer .katex').first().waitFor();

  // 引用: the passage reads as written, formula as TeX, no citation number, into the input.
  await drag('说明质量和能量');
  for (const name of ['引用', '解释', '翻译'])
    await bar().getByRole('button', { name, exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(evidence, 'reply-selection-toolbar.png') });
  await bar().getByRole('button', { name: '引用', exact: true }).click();
  await bar().waitFor({ state: 'detached' });
  const chip = panel().locator('.assistant-attached span');
  assert.equal(await chip.innerText(), '公式 $E=mc^2$ 说明质量和能量可以互换。');
  assert.ok(await box.evaluate((e) => e === document.activeElement), 'the input has focus');
  await page.screenshot({ path: path.join(evidence, 'reply-selection-quoted.png') });
  await page.keyboard.type('为什么能互换？');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 2, 'reply 2');
  const quoted = lastUser().content;
  assert.ok(quoted.startsWith('我引用你前面回答里的这段话：\n<selection>\n公式 $E=mc^2$'), quoted);
  assert.ok(quoted.endsWith('为什么能互换？'), quoted);
  assert.equal(await panel().locator('.assistant-attached').count(), 0, 'chip gone after sending');
  assert.equal(
    await panel().locator('.chat-user').last().locator('.chat-selection').innerText(),
    '公式 $E=mc^2$ 说明质量和能量可以互换。',
  );
  console.log('PASS: 引用 puts the passage in the question and sends it as a quote of the reply');

  // 解释: asked in the conversation, leaving what's being typed.
  await box.fill('还没写完的草稿');
  await pick('Attention lets every token');
  await bar().getByRole('button', { name: '解释', exact: true }).click();
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 3, 'reply 3');
  assert.equal(
    lastUser().content,
    '我引用你前面回答里的这段话：\n<selection>\nAttention lets every token look at all other tokens.\n</selection>\n\n解释一下这段话',
  );
  assert.ok(
    requests.at(-1).messages.some((m) => m.role === 'assistant' && m.content.includes('互换')),
    'the conversation goes with it',
  );
  assert.equal(await box.inputValue(), '还没写完的草稿', 'draft kept');
  await panel().locator('.chat-answer').last().getByText('这句话是说质量可以变成能量。').waitFor();
  console.log('PASS: 解释 asks in the conversation and keeps the draft');

  // 翻译: beside the selection, not added to the conversation; Esc puts it away.
  const before = requests.length;
  await drag('说明质量', panel().locator('.chat-answer').nth(0));
  await bar().getByRole('button', { name: '翻译', exact: true }).click();
  const card = bar().locator('.reply-translation');
  await card.getByText('Mass and energy are interchangeable.').waitFor();
  assert.equal(await card.getByText('翻译成英文').count(), 1);
  assert.equal(requests.length, before + 1);
  assert.equal(lastUser().content, '公式 $E=mc^2$ 说明质量和能量可以互换。');
  assert.equal(await panel().locator('.chat-answer').count(), 3, 'nothing added to the chat');
  const placed = await bar().boundingBox();
  const area = await panel().locator('.assistant-messages').boundingBox();
  assert.ok(placed.x >= area.x && placed.x + placed.width <= area.x + area.width, 'inside panel');
  await page.screenshot({ path: path.join(evidence, 'reply-selection-translation.png') });
  // With the conversation long enough to scroll, the buttons under a reply stay on one line.
  const list = panel().locator('.assistant-messages');
  assert.ok(await list.evaluate((e) => e.scrollHeight > e.clientHeight), 'the chat scrolls');
  const heights = await panel()
    .locator('.chat-actions button')
    .evaluateAll((all) => all.map((b) => b.getBoundingClientRect().height));
  assert.ok(heights.length && heights.every((h) => h < 30), `one line: ${heights}`);
  await card.getByRole('button', { name: '复制' }).click();
  await card.getByRole('button', { name: '已复制' }).waitFor();
  await page.keyboard.press('Escape');
  await bar().waitFor({ state: 'detached' });
  console.log('PASS: 翻译 shows beside the selection without adding to the conversation');

  // A click elsewhere puts the toolbar away; a question's own text doesn't get one.
  await drag('说明质量', panel().locator('.chat-answer').nth(0));
  await panel()
    .locator('.assistant-messages')
    .click({ position: { x: 4, y: 4 } });
  await bar().waitFor({ state: 'detached' });
  await panel().locator('.chat-user .chat-bubble').first().click({ clickCount: 3 });
  await page.waitForTimeout(200);
  assert.equal(await bar().count(), 0, 'no toolbar on the question');
  console.log('PASS: the toolbar goes on a click elsewhere and stays off questions');

  // 整个项目: the quote goes with the request to the agent too.
  await panel()
    .getByRole('tab', { name: /整个项目/ })
    .click();
  await box.fill('位置编码有什么用？');
  await box.press('Enter');
  await panel().locator('.chat-answer.done').waitFor();
  await pick('位置编码补上了顺序');
  await bar().getByRole('button', { name: '引用', exact: true }).click();
  assert.equal(await chip.innerText(), '项目里的回答：位置编码补上了顺序。');
  await page.keyboard.type('展开说说');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 2, 'agent 2');
  assert.ok(lastUser().content.startsWith('我引用你前面回答里的这段话'), lastUser().content);
  assert.ok(requests.at(-1).tools, 'asked as the agent');
  console.log('PASS: 引用 works in 整个项目');

  assert.deepEqual(errors, []);
  console.log(`Evidence in ${evidence}`);
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
