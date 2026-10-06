// AI features end to end in the real Electron app, against a local OpenAI-compatible mock
// service. No real API key or network is used; the key below only exists for the mock.
import { _electron as electron } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-'));
const project = path.join(temp, 'AI 项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-ai-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const testKey = 'mock-key-for-local-test';
const S1 = '注意力机制让模型在处理每个词时，都能直接参考句子里的其他所有词。';
const S2 = '与循环网络相比，这种结构更容易并行计算，训练速度明显更快。';
const S3 = '位置编码为每个位置加上一组正弦和余弦信号，弥补了结构本身不区分顺序的缺点。';
await fs.writeFile(
  path.join(project, '01_注意力.html'),
  `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>注意力机制简介</title>
<style>body{font:18px/1.9 system-ui;padding:40px 60px;color:#253342}</style></head>
<body>
<h1>注意力机制简介</h1>
<p><span id="s1">${S1}</span>这是它和早期模型最大的不同。</p>
<h2>为什么更快</h2>
<p>${S2}在大规模数据上，这一点尤其重要。</p>
<h2>顺序从哪里来</h2>
<p>${S3}</p>
</body>
</html>
`,
);
await fs.writeFile(
  path.join(project, '02_笔记.html'),
  '<!doctype html><html><meta charset="utf-8"><body><h1>读书笔记</h1><p>这里记录一些零散的想法。</p></body></html>',
);
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page1 = pdf.addPage([600, 800]);
page1.drawText('Attention Paper', { x: 60, y: 720, size: 26, font });
page1.drawText('Attention lets every token look at all other tokens.', {
  x: 60,
  y: 660,
  size: 16,
  font,
});
page1.drawText('Positional encodings add sine and cosine signals.', {
  x: 60,
  y: 620,
  size: 16,
  font,
});
await fs.writeFile(path.join(project, '03_paper.pdf'), Buffer.from(await pdf.save()));

// The mock service answers according to what each request asks for.
const requests = [];
function stream(res, { reasoning = '', text = '', toolCalls = [] }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunks = [];
  if (reasoning) chunks.push({ choices: [{ delta: { reasoning_content: reasoning } }] });
  for (let i = 0; i < text.length; i += 12)
    chunks.push({ choices: [{ delta: { content: text.slice(i, i + 12) } }] });
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
      setTimeout(next, 15);
    } else res.end('data: [DONE]\n\n');
  };
  next();
}
function agentTurn(messages) {
  const tools = messages.filter((m) => m.role === 'tool');
  if (!tools.length)
    return {
      text: '我先读一下这篇文档。',
      toolCalls: [{ name: 'read_document', input: { path: '01_注意力.html' } }],
    };
  if (tools.length === 1)
    return {
      toolCalls: [
        {
          name: 'write_note',
          input: {
            path: '01_注意力.html',
            content: '## 三句话摘要\n\n注意力让每个词参考其他词；结构便于并行；位置编码补充顺序。',
          },
        },
      ],
    };
  if (tools.length === 2)
    return {
      toolCalls: [
        {
          name: 'add_highlights',
          input: { path: '01_注意力.html', items: [{ quote: S2, note: '并行' }] },
        },
      ],
    };
  return { text: `已写好摘要。关键一句：<cite doc="01_注意力.html">${S2.slice(0, -1)}</cite>` };
}
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: req.url, auth: req.headers.authorization, body });
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-large' }] }));
  }
  if (req.headers.authorization !== `Bearer ${testKey}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"bad key"}}');
  }
  // DeepSeek's balance, beside its /v1 address.
  if (req.url === '/user/balance') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '12.34',
            granted_balance: '2.00',
            topped_up_balance: '10.34',
          },
        ],
      }),
    );
  }
  const system = body.messages.find((m) => m.role === 'system')?.content || '';
  const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (user.includes('连接测试')) return stream(res, { text: 'OK' });
  if (system.includes('专业译者'))
    return stream(res, {
      text: 'The attention mechanism lets the model consult every other word.',
    });
  if (system.includes('解释用户选中的文字'))
    return stream(res, { text: '意思是每个词都能看到整句话。' });
  if (system.includes('HTML 编辑助手'))
    return stream(res, {
      text: '把标题改成紫色。\n<<<<<<< SEARCH\n<h1>注意力机制简介</h1>\n=======\n<h1 style="color:#6654d9">注意力机制简介</h1>\n>>>>>>> REPLACE\n',
    });
  if (body.tools) return stream(res, agentTurn(body.messages));
  if (system.includes('精读伴读笔记'))
    return stream(res, {
      text: [
        '<header class="hero"><p class="kicker">精读笔记</p><h1>注意力论文精读</h1><p class="tldr">一句话概括。</p></header>',
        '<section class="card"><h2>30 秒读懂</h2><ul><li>要点一 <a class="page" data-page="1">第 1 页</a></li></ul></section>',
        '<section class="card" onclick="alert(1)"><h2>背景与问题</h2><p>背景。</p><script>window.hacked = true</script></section>',
        '<section class="card"><h2>方法详解</h2><ol class="steps"><li>第一步</li></ol><div class="formula">softmax(QKᵀ/√d)V</div></section>',
        '<section class="card"><h2>原文金句</h2><blockquote class="quote"><p>Attention lets every token look at all other tokens.</p><footer><a class="page" data-page="1">第 1 页</a> · 注意力让每个词看到其他词</footer></blockquote></section>',
      ].join(''),
    });
  // The DeepSeek-type service's model turns pictures away, the way text-only models do.
  if (Array.isArray(user) && body.model === 'mock-large') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"image input is not supported by this model"}}');
  }
  if (Array.isArray(user))
    return stream(res, {
      text: `看到了 ${user.filter((part) => part.type === 'image_url').length} 张图。`,
    });
  if (user.includes('"highlights"')) {
    const items = system.includes('type="PDF"')
      ? [
          {
            quote: 'Attention lets every token look at all other tokens',
            note: '核心',
            kind: '观点',
          },
        ]
      : [
          { quote: S1, note: '核心思想', kind: '观点' },
          { quote: S3.slice(0, 20), note: '顺序信息', kind: '方法' },
          { quote: '文档里并没有这一句话，定位应当失败', note: '', kind: '数据' },
        ];
    return stream(res, { text: JSON.stringify({ highlights: items }) });
  }
  return stream(res, {
    reasoning: '先找到文档里讲注意力的句子。',
    text: `注意力机制的核心是<cite>${S1.slice(0, -1)}</cite>。\n\n- 训练更快\n- 需要位置编码<cite>这句话在文档中不存在</cite>`,
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${server.address().port}/v1`;

let app, page;
const errors = [];
async function waitFor(fn, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
async function dataFor(relative) {
  const index = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/workspace.json'), 'utf8'),
  );
  const id = index.files[relative].id;
  return {
    id,
    data: JSON.parse(
      await fs.readFile(path.join(project, '.html-reader/documents', id + '.json'), 'utf8'),
    ),
  };
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
const panel = () => page.locator('.assistant-panel');
async function waitForFrame(part) {
  let found;
  await waitFor(async () => (found = page.frames().find((x) => x.url().includes(part))), part);
  await found.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  return found;
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
  await frame();

  // Setup: the assistant asks for a service first.
  await page.getByLabel('AI 助手', { exact: true }).click();
  await panel().getByText('接入你自己的 AI').waitFor();
  await panel().getByRole('button', { name: '配置 AI 服务', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 设置' });
  await settings.getByRole('button', { name: /DeepSeek/ }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'ai-settings-presets.png') });
  // A DeepSeek-type service pointed at the mock, so it has reasoning levels.
  await settings.getByRole('button', { name: /^DeepSeek/ }).click();
  await settings.getByLabel('名称').fill('本地模拟');
  await settings.getByLabel('API Key').fill(testKey);
  await settings.getByRole('button', { name: /高级设置/ }).click();
  await settings.getByLabel('接口地址').fill(mockUrl);
  await settings.getByRole('button', { name: '获取列表' }).click();
  await settings.getByRole('option', { name: 'mock-model', exact: true }).click();
  assert.equal(await settings.getByLabel('模型', { exact: true }).inputValue(), 'mock-model');
  await settings.getByRole('button', { name: '测试连接' }).click();
  await settings.getByText(/连接成功/).waitFor();
  await settings.getByRole('button', { name: '添加', exact: true }).click();
  await settings.getByText('已保存').waitFor();
  await page.screenshot({ path: path.join(evidence, 'ai-settings-provider.png') });
  const stored = await fs.readFile(path.join(userData, 'ai.json'), 'utf8');
  assert.ok(!stored.includes(testKey), 'the key is not stored as plain text');
  // What's left on the account shows under the key.
  await settings
    .locator('.balance-line', { hasText: '余额 ¥12.34' })
    .filter({ hasText: '赠送 ¥2.00 · 充值 ¥10.34' })
    .waitFor();
  // Speech services: whether each is set up, and which of its voices to try.
  await settings.getByRole('button', { name: '语音服务' }).click();
  const doubaoVoice = settings.locator('.ai-voice-service', { hasText: '豆包语音' });
  await doubaoVoice.locator('.ai-voice-state', { hasText: '未接入' }).waitFor();
  const voicePick = doubaoVoice.getByLabel('试听 豆包语音 的哪个声音');
  await voicePick.selectOption({ label: '云舟（男声，自然）' });
  assert.ok(
    await doubaoVoice.getByRole('button', { name: '试听' }).isDisabled(),
    'nothing to try without a key',
  );
  await doubaoVoice.getByLabel('豆包语音 的 API Key').fill('mock-speech-key');
  await doubaoVoice.getByRole('button', { name: '保存' }).click();
  await doubaoVoice.locator('.ai-voice-state.on', { hasText: '已接入' }).waitFor();
  assert.equal(await voicePick.inputValue(), 'zh_male_m191_uranus_bigtts', 'picked voice kept');
  assert.ok(await doubaoVoice.getByRole('button', { name: '试听' }).isEnabled(), 'can try');
  await page.screenshot({ path: path.join(evidence, 'ai-settings-voices.png') });
  await doubaoVoice.getByRole('button', { name: '删除 Key' }).click();
  await doubaoVoice.locator('.ai-voice-state', { hasText: '未接入' }).waitFor();
  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  console.log(
    'PASS: add a service, list models, test the connection, key kept out of plain text, balance, speech services',
  );

  // A question: consent once, streamed answer, verified citations that jump to the text.
  await panel().getByLabel('向 AI 提问').fill('注意力机制的核心是什么？');
  await panel().getByLabel('向 AI 提问').press('Enter');
  const consent = page.getByRole('dialog', { name: /发送给 本地模拟/ });
  await consent.waitFor();
  await consent.getByRole('button', { name: '同意并继续' }).click();
  await panel().locator('.chat-answer.done').waitFor();
  await waitFor(async () => (await panel().locator('.cite-chip').count()) === 2, 'two citations');
  await waitFor(
    async () => (await panel().locator('.cite-chip.missing').count()) === 1,
    'invented citation marked',
  );
  assert.equal(await panel().locator('.cite-chip').first().getAttribute('class'), 'cite-chip ');
  const ask = requests.findLast(
    (r) => r.body?.messages?.at(-1)?.content === '注意力机制的核心是什么？',
  );
  assert.equal(ask.auth, `Bearer ${testKey}`);
  assert.ok(ask.body.messages[0].content.includes(S3), 'document text sent as context');
  await panel().locator('.chat-reasoning summary').click();
  assert.ok((await panel().locator('.chat-reasoning').innerText()).includes('先找到文档'));
  await panel().locator('.cite-chip').first().click();
  let f = await frame();
  await f.locator('[data-folio-cite] rect').first().waitFor({ state: 'attached' });
  await page.screenshot({ path: path.join(evidence, 'ai-answer-citation.png') });
  await panel().getByRole('button', { name: '存入笔记' }).click();
  await waitFor(
    async () => (await dataFor('01_注意力.html')).data.note.includes('注意力机制的核心是「'),
    'answer saved to the note',
  );
  // The saved answer is one click away: the note tab, scrolled to where it was appended.
  await panel().getByRole('button', { name: '已存入 · 查看笔记' }).click();
  const noteBox = page.getByLabel('文档笔记', { exact: true });
  await noteBox.waitFor();
  assert.ok((await noteBox.innerText()).includes('注意力机制的核心是「'));
  await waitFor(
    () =>
      noteBox.evaluate((t) => {
        const view = t.closest('.cm-scroller').getBoundingClientRect();
        const line = [...t.querySelectorAll('.cm-line')].findLast((l) =>
          l.textContent.includes('注意力机制的核心是'),
        );
        const r = line?.getBoundingClientRect();
        return !!r && r.top >= view.top && r.bottom <= view.bottom;
      }),
    'note scrolled to the saved answer',
  );
  await page.screenshot({ path: path.join(evidence, 'ai-saved-note.png') });
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手' }).click();
  await panel().getByRole('button', { name: '已存入 · 查看笔记' }).waitFor();
  console.log(
    'PASS: consent, streamed answer with reasoning, verified citations, jump, save to note, view note',
  );

  // Model and reasoning level are switched right in the chat box.
  const picker = panel().getByRole('button', { name: '选择模型和推理强度' });
  // No level picked yet: the model's default shows.
  assert.match(await picker.innerText(), /本地模拟[\s\S]*mock-model[\s\S]*高/);
  await picker.click();
  const menu = page.getByRole('menu', { name: '模型和推理强度' });
  await menu.getByRole('menuitemradio', { name: 'mock-large' }).waitFor();
  await menu.locator('.balance-line', { hasText: '余额 ¥12.34' }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'ai-model-menu.png') });
  await menu.getByRole('menuitemradio', { name: '最高', exact: true }).click();
  await waitFor(async () => /最高/.test(await picker.innerText()), 'level shown');
  await panel().getByLabel('向 AI 提问').fill('位置编码呢？');
  await panel().getByLabel('向 AI 提问').press('Enter');
  await waitFor(async () => (await panel().locator('.chat-answer.done').count()) === 2, 'answer');
  const deep = requests.findLast((r) => r.body?.messages?.at(-1)?.content === '位置编码呢？');
  assert.deepEqual(deep.body.thinking, { type: 'enabled' });
  assert.equal(deep.body.reasoning_effort, 'max');
  // Picking a model keeps the menu open for the level; picking the level closes it.
  await picker.click();
  await menu.getByRole('menuitemradio', { name: 'mock-large' }).click();
  await waitFor(async () => /mock-large/.test(await picker.innerText()), 'model switched');
  assert.ok(await menu.isVisible(), 'menu stays open after choosing a model');
  await menu.getByRole('menuitemradio', { name: '低', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  await waitFor(async () => /低/.test(await picker.innerText()), 'level switched');
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'ai.json'), 'utf8'));
  assert.equal(saved.providers[0].model, 'mock-large');
  assert.equal(saved.providers[0].effort, 'low');
  console.log('PASS: model and reasoning level switched in the chat box and used by requests');

  // The right panel is resized by dragging its edge; chat and annotations keep their widths.
  const inspector = page.locator('.inspector');
  const narrow = (await inspector.boundingBox()).width;
  const edge = await page.locator('.sidebar-resizer.right').boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 300);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 120, edge.y + 300, { steps: 8 });
  await page.mouse.up();
  const wider = (await inspector.boundingBox()).width;
  assert.ok(Math.abs(wider - narrow - 120) < 6, `${narrow} -> ${wider}`);
  await page.locator('.inspector-tabs button', { hasText: '笔记' }).click();
  assert.ok((await inspector.boundingBox()).width < wider - 60, 'notes keep their own width');
  await page.locator('.inspector-tabs button', { hasText: '助手' }).click();
  assert.ok(Math.abs((await inspector.boundingBox()).width - wider) < 2, 'chat width remembered');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('folio.assistant-width')),
    String(Math.round(wider)),
  );
  // At its narrowest the panel still shows every quick action in full.
  const edge2 = await page.locator('.sidebar-resizer.right').boundingBox();
  await page.mouse.move(edge2.x + edge2.width / 2, edge2.y + 300);
  await page.mouse.down();
  await page.mouse.move(edge2.x + 600, edge2.y + 300, { steps: 8 });
  await page.mouse.up();
  const panelBox = await panel().boundingBox();
  assert.ok(panelBox.width < 300, `narrow panel: ${panelBox.width}`);
  for (const chip of await panel().locator('.assistant-chips button').all()) {
    const b = await chip.boundingBox();
    assert.ok(
      b.x >= panelBox.x && b.x + b.width <= panelBox.x + panelBox.width + 1,
      'chip fully visible',
    );
  }
  await page.screenshot({ path: path.join(evidence, 'ai-narrow-panel.png') });
  await page.locator('.sidebar-resizer.right').dblclick();
  console.log('PASS: right panel resized by dragging, width remembered per tab');

  // AI highlights land as one undo step.
  await panel().locator('.assistant-chips').getByRole('button', { name: 'AI 划重点' }).click();
  await waitFor(
    async () =>
      (await dataFor('01_注意力.html')).data.annotations.filter((a) => a.by === 'ai').length === 2,
    'AI highlights saved',
  );
  const { data } = await dataFor('01_注意力.html');
  const ai = data.annotations.filter((a) => a.by === 'ai');
  assert.equal(ai[0].quote.exact, S1);
  assert.equal(ai[0].color, '#d49b00');
  assert.ok(ai[0].note.startsWith('【核心观点】'));
  assert.equal(ai[1].color, '#7a5bd6');
  await panel()
    .getByText(/另有1 处没能在原文中找到/)
    .waitFor();
  // The sentence that couldn't be placed is shown, so a failure can be understood.
  await panel().getByText('文档里并没有这一句话，定位应当失败').waitFor();
  await page.locator('.inspector-tabs button', { hasText: '批注' }).click();
  assert.equal(await page.locator('.annotation-ai-badge').count(), 2);
  await page.getByLabel('撤销批注', { exact: true }).click();
  await waitFor(
    async () => (await dataFor('01_注意力.html')).data.annotations.length === 0,
    'one undo removes all AI highlights',
  );
  await page.getByLabel('重做批注', { exact: true }).click();
  await waitFor(
    async () => (await dataFor('01_注意力.html')).data.annotations.length === 2,
    'redo restores them',
  );
  console.log('PASS: AI highlights anchored in the text, colored by kind, one undo step');

  // Selection card: translate, then keep the translation as a highlight note.
  f = await frame();
  const s1 = await screenBox(f, '#s1');
  await page.mouse.move(s1.x + 2, s1.y + s1.height / 2);
  await page.mouse.down();
  await page.mouse.move(s1.x + s1.width - 30, s1.y + s1.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.locator('.selection-toolbar').getByRole('button', { name: '翻译' }).click();
  const card = page.locator('.ai-card');
  await card.getByText('翻译成英文').waitFor();
  await card.getByText(/consult every other word/).waitFor();
  await page.screenshot({ path: path.join(evidence, 'ai-selection-card.png') });
  await card.getByRole('button', { name: '存为高亮笔记' }).click();
  await waitFor(
    async () =>
      (await dataFor('01_注意力.html')).data.annotations.some((a) =>
        a.note.startsWith('译文\nThe attention mechanism'),
      ),
    'translation saved on a highlight',
  );
  await card.getByRole('button', { name: '关闭 AI 卡片' }).click();
  // Its note preview stays while the pointer moves onto it, scrolls, and opens for editing.
  await page.keyboard.press('Escape');
  const target = await screenBox(f, '#s1');
  await page.mouse.move(target.x + 40, target.y + target.height / 2, { steps: 4 });
  const preview = f.locator('[data-folio-ui=annotation-popup] .preview');
  await preview.getByText(/译文/).waitFor();
  const box = await screenBox(f, '[data-folio-ui=annotation-popup] .preview');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(await preview.isVisible(), 'preview stays under the pointer');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const editor = f.locator('[data-folio-ui=annotation-popup] textarea');
  await editor.waitFor();
  assert.ok((await editor.inputValue()).startsWith('译文\nThe attention mechanism'));
  // One text size for all highlight notes, set from the editor and remembered.
  const popupHost = f.locator('[data-folio-ui=annotation-popup]');
  const larger = f.getByRole('button', { name: '放大笔记字号' });
  await larger.click();
  await larger.click();
  await waitFor(
    async () =>
      (await popupHost.evaluate((e) => e.style.getPropertyValue('--note-size'))) === '17px',
    'note font size applied',
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('folio.note-font-size')), '17');
  assert.equal(await editor.evaluate((e) => getComputedStyle(e).fontSize), '17px');
  await editor.evaluate((e) => e.setSelectionRange(e.value.length, e.value.length));
  await editor.pressSequentially('（已核对）');
  await waitFor(
    async () =>
      (await dataFor('01_注意力.html')).data.annotations.some((a) => a.note.endsWith('（已核对）')),
    'note edited from its preview',
  );
  await page.keyboard.press('Escape');
  console.log('PASS: select text -> translate -> saved as highlight note -> preview -> edited');

  // Source mode: review an AI edit as a diff and live preview, then apply it.
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.locator('.cm-content').waitFor();
  await page.getByRole('button', { name: 'AI 修改' }).click();
  await page.getByLabel('修改要求').fill('把标题改成紫色');
  await page.getByRole('button', { name: '生成修改' }).click();
  await page.locator('.ai-source .diff-view').waitFor();
  assert.ok((await page.locator('.ai-source .diff-add').innerText()).includes('#6654d9'));
  await waitFor(async () => {
    const src = await page.locator('.document-frame').getAttribute('src');
    const preview = page.frames().find((x) => x.url() === src);
    return (
      preview &&
      (await preview
        .locator('h1')
        .evaluate((e) => getComputedStyle(e).color)
        .catch(() => '')) === 'rgb(102, 84, 217)'
    );
  }, 'preview shows the proposed edit');
  await page.screenshot({ path: path.join(evidence, 'ai-source-edit.png') });
  await page.getByRole('button', { name: '应用修改' }).click();
  await waitFor(
    async () =>
      (await fs.readFile(path.join(project, '01_注意力.html'), 'utf8')).includes(
        '<h1 style="color:#6654d9">',
      ),
    'edit written to the file',
  );
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  console.log('PASS: source mode AI edit -> diff + preview -> applied and saved');

  // The project agent reads, then waits for approval before each change.
  await page.getByLabel('AI 助手', { exact: true }).click();
  if (!(await panel().isVisible())) await page.getByLabel('AI 助手', { exact: true }).click();
  await panel().getByRole('tab', { name: '整个项目' }).click();
  await panel().getByLabel('向 AI 提问').fill('给这篇文档写三句话摘要');
  await panel().getByLabel('向 AI 提问').press('Enter');
  await panel().locator('.agent-step.done', { hasText: '阅读《01_注意力.html》' }).waitFor();
  const noteStep = panel().locator('.agent-step.waiting', {
    hasText: '写入《01_注意力.html》的笔记',
  });
  await noteStep.locator('.diff-view').waitFor();
  await page.screenshot({ path: path.join(evidence, 'ai-agent-approval.png') });
  await noteStep.getByRole('button', { name: '应用', exact: true }).click();
  await waitFor(
    async () => (await dataFor('01_注意力.html')).data.note.includes('## 三句话摘要'),
    'agent note written after approval',
  );
  const highlightStep = panel().locator('.agent-step.waiting', { hasText: '添加 1 处高亮' });
  await highlightStep.getByText('并行', { exact: true }).waitFor();
  const before = (await dataFor('01_注意力.html')).data.annotations.length;
  await highlightStep.getByRole('button', { name: '跳过' }).click();
  await panel().getByText('已写好摘要').waitFor();
  await panel()
    .locator('.agent-step.done', { hasText: '写入《01_注意力.html》的笔记' })
    .getByRole('button', { name: '查看笔记' })
    .waitFor();
  assert.equal((await dataFor('01_注意力.html')).data.annotations.length, before);
  const skipped = requests.findLast((r) => r.body?.tools);
  assert.ok(skipped.body.messages.at(-1).content.includes('用户没有同意'));
  console.log('PASS: agent reads, waits for approval, applies one change and skips another');

  // PDF: AI highlights keep page geometry.
  await page
    .getByRole('navigation', { name: '项目文件' })
    .getByRole('button', { name: '03_paper.pdf', exact: true })
    .click();
  await waitFor(
    async () =>
      (await page.locator('.document-frame').getAttribute('src')).includes('03_paper.pdf'),
    'pdf opened',
  );
  await panel().getByRole('tab', { name: '本文' }).click();
  await panel().locator('.assistant-tasks').getByRole('button', { name: 'AI 划重点' }).click();
  await waitFor(
    async () => {
      const pdfData = await dataFor('03_paper.pdf');
      return pdfData.data.annotations.some(
        (a) => a.by === 'ai' && a.quote.pdfRects?.[0]?.page === 1,
      );
    },
    'PDF AI highlight with page rectangles',
    30000,
  );
  await page.screenshot({ path: path.join(evidence, 'ai-pdf-highlight.png') });
  console.log('PASS: PDF text extraction and AI highlight with page geometry');

  // 精读笔记: a clean notes page beside the PDF, whose page links move the PDF.
  await panel().locator('.assistant-chips').getByRole('button', { name: '制作精读笔记' }).click();
  const notePath = path.join(project, '03_paper-精读笔记.html');
  await waitFor(() => fs.stat(notePath).then(() => true), 'notes page written', 20000);
  const note = await fs.readFile(notePath, 'utf8');
  assert.ok(!note.includes('<script>window.hacked'), 'scripts removed');
  assert.ok(!note.includes('onclick'), 'event handlers removed');
  assert.ok(note.includes('href="03_paper.pdf#page=1"'), 'page references link to the PDF');
  assert.ok(note.includes('<nav class="toc"'), 'contents added');
  assert.ok(note.includes('由页间 AI 根据《03_paper.pdf》生成'));
  await page
    .locator('.reading-column')
    .nth(1)
    .locator('.pane-document-title', { hasText: '03_paper-精读笔记.html' })
    .waitFor();
  await page
    .locator('.reading-column')
    .nth(0)
    .locator('.pane-document-title', { hasText: '03_paper.pdf' })
    .waitFor();
  // The paper stays active, so the result stays in the assistant.
  await panel()
    .getByText(/已生成精读笔记/)
    .waitFor();
  const noteFrame = await waitForFrame('03_paper-%E7%B2%BE%E8%AF%BB%E7%AC%94%E8%AE%B0.html');
  assert.equal(await noteFrame.evaluate(() => window.hacked), undefined);
  await page.screenshot({ path: path.join(evidence, 'ai-companion.png') });
  await noteFrame.locator('a.page').first().click();
  await waitFor(
    async () =>
      (await page.locator('.reading-column.active-column .pane-document-title').innerText()) ===
      '03_paper.pdf',
    'page link activates the PDF',
  );
  console.log(
    'PASS: 精读笔记 written next to the PDF, cleaned, opened beside it, page links jump back',
  );

  // Conversations are kept next to the document's annotations.
  const { id } = await dataFor('01_注意力.html');
  const history = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/ai', id + '.json'), 'utf8'),
  );
  assert.ok(history.threads[0].messages.length >= 4);
  const projectHistory = path.join(project, '.html-reader/ai/project.json');
  await waitFor(
    () => fs.stat(projectHistory).then(() => true),
    'project conversation saved: ' + (await page.locator('.toast').allInnerTexts()).join(' | '),
  );
  const agentHistory = JSON.parse(await fs.readFile(projectHistory, 'utf8'));
  assert.ok(agentHistory.threads[0].messages[1].parts.some((p) => p.type === 'step'));
  console.log('PASS: conversation history saved in the project');

  // Pictures: pasted, dropped or framed on the page, and held back from a text-only model.
  const composer = panel().getByLabel('向 AI 提问');
  const thumbs = panel().locator('.assistant-images img');
  const chats = () => requests.filter((r) => r.url.endsWith('/chat/completions'));
  async function pasteImage(color) {
    await composer.evaluate(async (el, color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const g = canvas.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, 320, 200);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, color);
  }
  await page
    .getByRole('navigation', { name: '项目文件' })
    .getByRole('button', { name: '01_注意力.html', exact: true })
    .click();
  await waitFor(
    async () => (await page.locator('.document-frame').first().getAttribute('src')).includes('01_'),
    'document opened',
  );
  if (!(await panel().isVisible())) await page.getByLabel('AI 助手', { exact: true }).click();
  // The 精读笔记 is still open beside it, so the tab reads 这两篇.
  await panel()
    .getByRole('tab', { name: /^(本文|这两篇)$/ })
    .click();
  if (await panel().locator('.assistant-new').isEnabled())
    await panel().locator('.assistant-new').click();
  await pasteImage('#e0533d');
  await waitFor(async () => (await thumbs.count()) === 1, 'pasted picture attached');
  // A model's name alone doesn't hold pictures back; once it turns them away, it is known
  // not to take them and the next pictures wait with a note.
  await composer.fill('图里是什么？');
  await composer.press('Enter');
  await panel()
    .locator('.chat-error')
    .getByText(/不能看图/)
    .waitFor();
  await panel().locator('.assistant-new').click();
  await pasteImage('#e0533d');
  await waitFor(async () => (await thumbs.count()) === 1, 'pasted picture attached again');
  await panel()
    .locator('.assistant-vision-note')
    .getByText(/不能看图/)
    .waitFor();
  assert.equal(await panel().getByRole('button', { name: '发送' }).isDisabled(), true);

  // A region of the page, framed by dragging; the overlay is gone before the shot.
  await panel().getByLabel('框选区域问 AI', { exact: true }).click();
  await page.locator('.region-capture').waitFor();
  const heading = await screenBox(await frame(), 'h1');
  await page.mouse.move(heading.x - 6, heading.y - 6);
  await page.mouse.down();
  await page.mouse.move(heading.x + heading.width * 0.7, heading.y + heading.height + 6, {
    steps: 8,
  });
  await page.mouse.up();
  await waitFor(async () => (await thumbs.count()) === 2, 'framed region attached');
  assert.equal(await page.locator('.region-capture').count(), 0);
  const shot = await thumbs.nth(1).evaluate((img) => ({
    src: img.src,
    width: img.naturalWidth,
    ratio: devicePixelRatio,
  }));
  assert.ok(shot.src.startsWith('data:image/jpeg;base64,'));
  assert.ok(
    Math.abs(shot.width - Math.round((heading.width * 0.7 + 6) * shot.ratio)) <= 2 * shot.ratio,
    `capture width ${shot.width}`,
  );
  await fs.writeFile(
    path.join(evidence, 'ai-region-capture.jpg'),
    Buffer.from(shot.src.split(',')[1], 'base64'),
  );
  await panel().getByLabel('移除图片 1').click();
  await waitFor(async () => (await thumbs.count()) === 1, 'picture removed');
  await pasteImage('#2864d7');
  await waitFor(async () => (await thumbs.count()) === 2, 'second picture attached');

  // A service whose model may see pictures: added, then picked in the chat box.
  await panel().getByLabel('AI 设置', { exact: true }).click();
  const aiSettings = page.getByRole('dialog', { name: 'AI 设置' });
  await aiSettings.getByRole('button', { name: '添加服务' }).click();
  await aiSettings.getByRole('button', { name: /^其他/ }).click();
  await aiSettings.getByLabel('名称').fill('看图模拟');
  await aiSettings.getByLabel('API Key').fill(testKey);
  if (!(await aiSettings.getByLabel('接口地址').isVisible()))
    await aiSettings.getByRole('button', { name: /高级设置/ }).click();
  await aiSettings.getByLabel('接口地址').fill(mockUrl);
  await aiSettings.getByLabel('模型', { exact: true }).fill('mock-model');
  await aiSettings.getByRole('button', { name: '添加', exact: true }).click();
  await aiSettings.getByText('已保存').waitFor();
  await aiSettings.getByRole('button', { name: '关闭 AI 设置' }).click();
  await panel().getByRole('button', { name: '选择模型和推理强度' }).click();
  const models = page.getByRole('menu', { name: '模型和推理强度' });
  await models.getByRole('button', { name: /看图模拟/ }).click();
  await models.getByRole('menuitemradio', { name: 'mock-model' }).click();
  await page.keyboard.press('Escape');
  await panel().locator('.assistant-vision-note').waitFor({ state: 'detached' });
  await composer.fill('图里是什么？');
  await composer.press('Enter');
  const seeConsent = page.getByRole('dialog', { name: /发送给 看图模拟/ });
  await seeConsent.getByRole('button', { name: '同意并继续' }).click();
  await panel().getByText('看到了 2 张图。').waitFor();
  const withImages = chats().at(-1).body.messages.at(-1).content;
  assert.deepEqual(
    withImages.map((part) => part.type),
    ['image_url', 'image_url', 'text'],
  );
  assert.ok(withImages[0].image_url.url.startsWith('data:image/jpeg;base64,'));
  assert.equal(withImages[2].text, '图里是什么？');
  assert.equal(await thumbs.count(), 0, 'sent pictures leave the composer');
  const sent = panel().locator('.chat-user .chat-images img');
  assert.equal(await sent.count(), 2);
  await sent.first().click();
  await page.locator('.image-viewer').waitFor();
  await page.screenshot({ path: path.join(evidence, 'ai-image-viewer.png') });
  await page.keyboard.press('Escape');
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  // A follow-up carries the earlier pictures; a question of only pictures still asks something.
  await composer.fill('再说详细点');
  await composer.press('Enter');
  await waitFor(
    async () => chats().at(-1).body.messages.at(-1).content === '再说详细点',
    'follow-up',
  );
  assert.ok(
    chats()
      .at(-1)
      .body.messages.some((m) => Array.isArray(m.content) && m.content.length === 3),
  );
  await panel().locator('.chat-answer.done').nth(1).waitFor();
  await pasteImage('#087f72');
  await waitFor(async () => (await thumbs.count()) === 1, 'third picture attached');
  await panel().getByRole('button', { name: '发送' }).click();
  await panel().locator('.chat-answer.done').nth(2).waitFor();
  assert.equal(
    chats().at(-1).body.messages.at(-1).content.at(-1).text,
    '请结合文档内容，解释图片里的内容。',
  );
  // Dropped files: pictures only.
  await panel().evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'drop.png', { type: 'image/png' }));
    el.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }),
    );
    el.dispatchEvent(
      new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  });
  await waitFor(async () => (await thumbs.count()) === 1, 'dropped picture attached');
  await page.screenshot({ path: path.join(evidence, 'ai-images.png') });
  await panel().getByLabel('移除图片 1').click();
  // The project agent sees pictures too.
  await panel().getByRole('tab', { name: '整个项目' }).click();
  await pasteImage('#d49b00');
  await waitFor(async () => (await thumbs.count()) === 1, 'picture for the agent');
  await composer.fill('这张图和哪篇文档有关？');
  await composer.press('Enter');
  await waitFor(
    async () =>
      chats().some((r) => r.body.tools && r.body.messages.some((m) => Array.isArray(m.content))),
    'agent request with a picture',
  );
  await panel().getByRole('button', { name: '停止' }).click();
  console.log(
    'PASS: pictures pasted, dropped and framed; blocked for text-only models; sent to the model',
  );

  assert.deepEqual(errors, []);
  console.log('PASS: no renderer errors');
} finally {
  await app?.close().catch(() => {});
  server.close();
}
