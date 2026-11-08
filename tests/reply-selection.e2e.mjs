// Text selected in an AI reply: quoted in the next question, 解释, 翻译 and 提问 beside it,
// and 继续追问 to take one into the conversation. In the real Electron app against a local
// OpenAI-compatible mock; no network or real key.
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
  if (system.includes('回答用户关于选中文字的问题'))
    return stream(res, 'token 就是一个词或词的一部分。');
  if (system.includes('解释用户选中的文字')) return stream(res, '这句话是说质量可以变成能量。');
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

  // Selecting quotes it in the next question: the passage reads as written, formula as TeX,
  // no citation number. Going to the input keeps it.
  await drag('说明质量和能量');
  for (const name of ['解释', '翻译', '提问'])
    await bar().getByRole('button', { name, exact: true }).waitFor();
  assert.equal(await bar().getByRole('button', { name: '引用' }).count(), 0, 'three buttons');
  const chip = panel().locator('.assistant-attached span');
  assert.equal(await chip.innerText(), '公式 $E=mc^2$ 说明质量和能量可以互换。');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(evidence, 'reply-selection-toolbar.png') });
  await box.click();
  await bar().waitFor({ state: 'detached' });
  await page.waitForTimeout(200);
  assert.equal(await chip.innerText(), '公式 $E=mc^2$ 说明质量和能量可以互换。', 'kept');
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
  console.log('PASS: selecting in a reply quotes it in the next question');

  // 解释: beside the selection, read in the reply and its question, not in the conversation.
  await box.fill('还没写完的草稿');
  await pick('Attention lets every token');
  assert.equal(await chip.evaluate((e) => Math.round(e.offsetHeight / 18)), 2, 'two lines');
  await bar().getByRole('button', { name: '解释', exact: true }).click();
  const card = bar().locator('.reply-card');
  await card.getByText('这句话是说质量可以变成能量。').waitFor();
  assert.equal(await card.getByText('解释', { exact: true }).count(), 1);
  const explained = lastUser().content;
  assert.ok(
    explained.includes(
      '<selection>\nAttention lets every token look at all other tokens.\n</selection>',
    ),
    explained,
  );
  assert.ok(explained.includes('用户的问题：为什么能互换？'), 'the question it answered');
  assert.ok(explained.includes('AI 助手的回答：\n公式 $E=mc^2$'), 'the reply it is in');
  assert.equal(requests.at(-1).messages.length, 2, 'only the explanation is asked for');
  assert.equal(await panel().locator('.chat-answer').count(), 2, 'nothing added to the chat');
  assert.equal(await box.inputValue(), '还没写完的草稿', 'draft kept');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(evidence, 'reply-selection-explain.png') });
  console.log('PASS: 解释 shows beside the selection without adding to the conversation');

  // 继续追问: the explanation joins the conversation, and the next question goes on from it.
  const asked = requests.length;
  await card.getByRole('button', { name: '继续追问' }).click();
  await bar().waitFor({ state: 'detached' });
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 3, 'kept');
  assert.equal(requests.length, asked, 'nothing asked again');
  const kept = panel().locator('.chat-user').last();
  assert.equal(
    await kept.locator('.chat-selection').innerText(),
    'Attention lets every token look at all other tokens.',
  );
  assert.equal(await kept.locator('.chat-bubble').innerText(), '解释选中的文字');
  assert.equal(await panel().locator('.assistant-attached').count(), 0, 'not quoted again');
  await panel().locator('.chat-answer').last().getByText('这句话是说质量可以变成能量。').waitFor();
  assert.ok(await box.evaluate((e) => e === document.activeElement), 'the input has focus');
  assert.equal(await box.inputValue(), '还没写完的草稿', 'draft still kept');
  await box.fill('举个例子');
  await box.press('Enter');
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 4, 'reply 4');
  const wire = requests.at(-1).messages;
  assert.ok(
    wire.some(
      (m) =>
        m.role === 'user' &&
        m.content.startsWith('我引用你前面回答里的这段话：\n<selection>\nAttention') &&
        m.content.endsWith('解释选中的文字'),
    ),
    'the kept question goes with the next one',
  );
  assert.ok(
    wire.some((m) => m.role === 'assistant' && m.content.includes('质量可以变成能量')),
    'and so does the explanation',
  );
  assert.equal(lastUser().content, '举个例子');
  console.log('PASS: 继续追问 puts the explanation in the conversation to ask on');

  // 翻译: beside the selection, not added to the conversation; Esc puts it away.
  const before = requests.length;
  await drag('说明质量', panel().locator('.chat-answer').nth(0));
  await bar().getByRole('button', { name: '翻译', exact: true }).click();
  await card.getByText('Mass and energy are interchangeable.').waitFor();
  assert.equal(await card.getByText('翻译成英文').count(), 1);
  assert.equal(requests.length, before + 1);
  assert.equal(lastUser().content, '公式 $E=mc^2$ 说明质量和能量可以互换。');
  assert.equal(await panel().locator('.chat-answer').count(), 4, 'nothing added to the chat');
  await card.getByRole('button', { name: '继续追问' }).waitFor();
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

  // At the end of the conversation, a quote coming and going leaves it where it is. The
  // translated passage is still selected, and quoted, after Esc.
  await panel().getByRole('button', { name: '不引用选中的文字' }).click();
  await panel().locator('.assistant-attached').waitFor({ state: 'detached' });
  await list.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await page.waitForTimeout(100);
  const passage = panel()
    .locator('.chat-answer')
    .last()
    .locator('p', { hasText: 'Attention lets every token' });
  const where = () => passage.evaluate((e) => Math.round(e.getBoundingClientRect().top));
  assert.ok(
    await list.evaluate(
      (e) => e.scrollTop > 0 && e.scrollHeight - e.scrollTop - e.clientHeight < 2,
    ),
    'read at its end',
  );
  const resting = await where();
  await pick('Attention lets every token');
  assert.equal(await chip.innerText(), 'Attention lets every token look at all other tokens.');
  await page.waitForTimeout(100);
  assert.equal(await where(), resting, 'quoting moves nothing');
  await panel().getByRole('button', { name: '不引用选中的文字' }).click();
  await panel().locator('.assistant-attached').waitFor({ state: 'detached' });
  await page.waitForTimeout(100);
  assert.equal(await where(), resting, 'nor letting go of it');
  console.log('PASS: a quote coming and going leaves the conversation where it is');

  // 提问: a question of one's own about the passage, answered beside it; 继续追问 keeps it.
  await pick('Attention lets every token');
  await bar().getByRole('button', { name: '提问', exact: true }).click();
  const field = card.getByLabel('关于选中文字的问题');
  await field.waitFor();
  assert.ok(await field.evaluate((e) => e === document.activeElement), 'the box has focus');
  // The box takes the selection: the passage stays marked, and is selected again on closing.
  const marked = () => page.evaluate(() => CSS.highlights.has('reply-picked'));
  assert.ok(await marked(), 'still marked');
  await card.getByRole('button', { name: '关闭提问' }).click();
  await bar().waitFor({ state: 'detached' });
  await page.waitForTimeout(200);
  const reselected = await page.evaluate(() => document.getSelection().toString());
  assert.ok(reselected.includes('Attention lets every token'), reselected);
  assert.equal(await marked(), false, 'mark gone with the card');
  assert.equal(await chip.innerText(), 'Attention lets every token look at all other tokens.');
  await pick('Attention lets every token');
  await bar().getByRole('button', { name: '提问', exact: true }).click();
  await field.waitFor();
  await page.keyboard.type('这里的 token 是什么？');
  await page.keyboard.press('Enter');
  await card.getByText('token 就是一个词或词的一部分。').waitFor();
  const askedAbout = lastUser().content;
  assert.ok(askedAbout.includes('问题：这里的 token 是什么？'), askedAbout);
  assert.ok(askedAbout.includes('<selection>\nAttention lets every token'), askedAbout);
  assert.ok(askedAbout.includes('用户的问题：举个例子'), 'the question the reply answered');
  assert.equal(await panel().locator('.chat-answer').count(), 4, 'nothing added to the chat');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(evidence, 'reply-selection-ask.png') });
  await card.getByRole('button', { name: '继续追问' }).click();
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 5, 'asked');
  const keptAsk = panel().locator('.chat-user').last();
  assert.equal(await keptAsk.locator('.chat-bubble').innerText(), '这里的 token 是什么？');
  assert.equal(
    await keptAsk.locator('.chat-selection').innerText(),
    'Attention lets every token look at all other tokens.',
  );
  console.log('PASS: 提问 answers beside the passage, and 继续追问 keeps the question');

  // ✕ lets go of the quote and the selection for good.
  const selected = () => page.evaluate(() => document.getSelection().toString());
  await drag('说明质量', panel().locator('.chat-answer').nth(0));
  assert.equal(await chip.innerText(), '公式 $E=mc^2$ 说明质量和能量可以互换。');
  await panel().getByRole('button', { name: '不引用选中的文字' }).click();
  await page.waitForTimeout(300);
  assert.equal(await panel().locator('.assistant-attached').count(), 0, 'not quoted again');
  assert.equal(await bar().count(), 0, 'no toolbar');
  assert.equal(await selected(), '');

  // A click on the conversation's empty space lets go of both, as a click on text does; a
  // question's own text gets none.
  for (const away of [
    () =>
      panel()
        .locator('.assistant-messages')
        .click({ position: { x: 4, y: 4 } }),
    () => panel().locator('.chat-answer').nth(0).locator('li').first().click(),
  ]) {
    await drag('说明质量', panel().locator('.chat-answer').nth(0));
    assert.equal(await chip.innerText(), '公式 $E=mc^2$ 说明质量和能量可以互换。');
    await away();
    await bar().waitFor({ state: 'detached' });
    await waitFor(
      async () => (await panel().locator('.assistant-attached').count()) === 0,
      'quote let go',
    );
    await page.waitForTimeout(200);
    assert.equal(await bar().count(), 0, 'toolbar stays away');
    assert.equal(await selected(), '');
  }
  await panel().locator('.chat-user .chat-bubble').first().click({ clickCount: 3 });
  await page.waitForTimeout(200);
  assert.equal(await bar().count(), 0, 'no toolbar on the question');
  console.log('PASS: ✕ and a click elsewhere let go of the toolbar and the quote');

  // 整个项目: the quote goes with the request to the agent too.
  await panel()
    .getByRole('tab', { name: /整个项目/ })
    .click();
  await box.fill('位置编码有什么用？');
  await box.press('Enter');
  await panel().locator('.chat-answer.done').waitFor();
  await pick('位置编码补上了顺序');
  assert.equal(await chip.innerText(), '项目里的回答：位置编码补上了顺序。');
  await box.click();
  await page.keyboard.type('展开说说');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 2, 'agent 2');
  assert.ok(lastUser().content.startsWith('我引用你前面回答里的这段话'), lastUser().content);
  assert.ok(requests.at(-1).tools, 'asked as the agent');
  console.log('PASS: quoting works in 整个项目');

  // 整个项目: 解释 reads the agent's reply, and 继续追问 keeps it for the agent to go on from.
  await pick('位置编码补上了顺序');
  await bar().getByRole('button', { name: '解释', exact: true }).click();
  await card.getByText('这句话是说质量可以变成能量。').waitFor();
  assert.ok(lastUser().content.includes('用户的问题：展开说说'), lastUser().content);
  assert.ok(!requests.at(-1).tools, 'explained on its own, not by the agent');
  await card.getByRole('button', { name: '继续追问' }).click();
  await waitFor(
    async () => (await panel().locator('.chat-answer.done').count()) === 3,
    'agent kept',
  );
  await box.fill('接着说');
  await box.press('Enter');
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 4, 'agent 4');
  assert.ok(requests.at(-1).tools, 'asked as the agent');
  assert.ok(
    requests
      .at(-1)
      .messages.some((m) => m.role === 'assistant' && m.content.includes('质量可以变成能量')),
    'the kept explanation goes to the agent',
  );
  console.log('PASS: 解释 and 继续追问 work in 整个项目');

  assert.deepEqual(errors, []);
  console.log(`Evidence in ${evidence}`);
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
