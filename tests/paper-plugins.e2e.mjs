// The library's tools at work, end to end in the real Electron app against a local
// OpenAI-compatible mock, with 文献库 (plugins/library) installed: a 精读笔记 made from a paper
// in the library becomes one of its files (the library's background script hears it was made);
// the AI assistant is given the library's tools and shows the change it proposes before making
// it; and 文献综述 (plugins/literature-review), which names 文献库 among its dependencies, reads
// the library and what the reader marked through them, and writes its review. No real API key or
// network is used.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-paper-plugins-qa');
await fs.mkdir(evidence, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-paper-plugins-'));
const project = path.join(temp, '论文库');
const userData = path.join(temp, 'user-data');
await fs.mkdir(path.join(project, '论文'), { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(
  path.join(project, '论文', 'attention.html'),
  '<!doctype html><html><meta charset="utf-8"><title>Attention Is All You Need</title><body><h1>Attention Is All You Need</h1><p>Ashish Vaswani et al., 2017. We propose the Transformer, based solely on attention mechanisms.</p></body></html>',
);
const realProject = await fs.realpath(project);
// The paper, already in the library and being read.
const seeded = {
  id: '11111111-2222-4333-8444-555555555555',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani'],
  year: 2017,
  summary: '只用注意力，不用循环和卷积。',
  status: 'reading',
  tags: [],
  addedAt: 1_700_000_000_000,
  files: ['论文/attention.html'],
};
await fs.mkdir(path.join(project, '.html-reader'), { recursive: true });
await fs.writeFile(
  path.join(project, '.html-reader', 'library.json'),
  JSON.stringify({ version: 1, papers: [seeded], lists: [] }),
);
const exists = (rel) =>
  fs.stat(path.join(project, rel)).then(
    () => true,
    () => false,
  );
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

// The mock service: each plugin's run as a short script of tool calls.
const systems = {};
const results = { assistant: [], review: [] };
function stream(res, { text = '', toolCalls = [] }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunks = [];
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
    usage: { prompt_tokens: 300, completion_tokens: 40 },
  });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}
const page1 = (title) =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>内容。</p></body></html>`;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  const system = body.messages.find((m) => m.role === 'system')?.content || '';
  const tools = body.messages.filter((m) => m.role === 'tool');
  const offered = (body.tools || []).map((t) => t.function?.name).sort();
  if (system.includes('精读伴读笔记'))
    return stream(res, {
      text: [
        '<header class="hero"><p class="kicker">精读笔记</p><h1>Transformer 精读</h1><p class="tldr">只用注意力。</p></header>',
        '<section class="card"><h2>30 秒读懂</h2><p>要点。</p></section>',
        '<section class="card"><h2>背景与问题</h2><p>背景。</p></section>',
        '<section class="card"><h2>方法详解</h2><p>方法。</p></section>',
      ].join(''),
    });
  // The assistant in 整个项目: asks the library, then proposes a change to it.
  if (body.tools && !system.includes('插件「')) {
    systems.assistant = { offered };
    results.assistant = tools.map((t) => t.content);
    const turns = [
      { toolCalls: [{ name: 'list_library', input: { status: 'reading' } }] },
      {
        toolCalls: [
          {
            name: 'update_library',
            input: { papers: [{ id: seeded.id.slice(0, 8), tags: ['必读'] }] },
          },
        ],
      },
      { text: '记好了。' },
    ];
    return stream(res, turns[Math.min(tools.length, turns.length - 1)]);
  }
  if (system.includes('插件「文献综述」')) {
    systems.review = { system, offered };
    results.review = tools.map((t) => t.content);
    const turns = [
      { toolCalls: [{ name: 'list_library', input: {} }] },
      { toolCalls: [{ name: 'get_paper', input: { id: seeded.id.slice(0, 8) } }] },
      // Not one of its tools.
      { toolCalls: [{ name: 'update_library', input: { papers: [{ title: '不该有的论文' }] } }] },
      {
        toolCalls: [
          {
            name: 'create_html',
            input: { path: `综述/综述-注意力-${today}.html`, content: page1('文献综述｜注意力') },
          },
        ],
      },
      { text: '综述写好了。' },
    ];
    return stream(res, turns[Math.min(tools.length, turns.length - 1)]);
  }
  return stream(res, { text: '好的。' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await fs.writeFile(
  path.join(userData, 'ai.json'),
  JSON.stringify({
    version: 1,
    providers: [
      {
        id: 'mock',
        preset: 'custom',
        kind: 'openai',
        name: '本地模拟',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: 'mock-model',
        context: 128000,
        maxOutput: 0,
        keyHint: 'mock',
        key: 'txt:' + Buffer.from('mock-key').toString('base64'),
      },
    ],
    active: 'mock',
    prefs: { consented: ['mock'] },
    uses: {},
    speech: {},
  }),
);
await fs.writeFile(
  path.join(userData, 'plugins.json'),
  JSON.stringify({
    version: 1,
    thirdParty: true,
    plugins: Object.fromEntries(
      ['library', 'literature-review'].map((id) => [
        id,
        {
          enabled: true,
          enabledAt: Date.now(),
          root: realProject,
          source: { type: 'folder', path: path.join(root, 'plugins', id) },
          settings: id === 'literature-review' ? { topic: '注意力机制' } : {},
        },
      ]),
    ),
  }),
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await wait(150);
  }
  throw Error('Timeout: ' + label);
}
const library = async () =>
  JSON.parse(await fs.readFile(path.join(project, '.html-reader', 'library.json'), 'utf8'));

let app;
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
      FOLIO_DOCUMENTS: path.join(temp, 'Documents'),
      FOLIO_NO_SPEECH_HELPER: '1',
      FOLIO_APP_VERSION: '0.33.0',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.document-frame');
  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手', exact: true }).click();
  const panel = page.locator('.assistant-panel');

  const tree = (name) => page.locator('.tree-row', { hasText: name });
  // What the reader marked in the paper, for get_paper to tell.
  const doc = await page.evaluate(async () =>
    window.folio.invoke(
      'document',
      { path: '论文/attention.html' },
      (await window.folio.invoke('workspace')).token,
    ),
  );
  await page.evaluate(
    async ([doc]) =>
      window.folio.invoke(
        'save-data',
        {
          id: doc.id,
          data: {
            ...doc.data,
            annotations: [
              {
                id: 'h1',
                type: 'highlight',
                color: '#d49b00',
                createdAt: 1,
                note: '这是全文的核心',
                quote: {
                  exact: 'based solely on attention mechanisms',
                  prefix: '',
                  suffix: '',
                  start: 0,
                  end: 10,
                },
              },
            ],
          },
        },
        (await window.folio.invoke('workspace')).token,
      ),
    [doc],
  );
  // The library's background script has marked the paper in the tree.
  await waitFor(
    async () => (await tree('attention.html').locator('.tree-badge.half').count()) === 1,
    'tree mark',
  );

  // 精读笔记 from the paper: it becomes one of the paper's files.
  await tree('attention.html').click();
  await panel.getByRole('tab').first().click();
  await panel.getByRole('button', { name: '制作精读笔记' }).click();
  await waitFor(() => exists('论文/attention-精读笔记.html'), 'notes written');
  await waitFor(
    async () => (await library()).papers[0].files.includes('论文/attention-精读笔记.html'),
    'notes joined the paper',
  );
  assert.deepEqual((await library()).papers[0].files, [
    '论文/attention.html',
    '论文/attention-精读笔记.html',
  ]);
  console.log('PASS: a 精读笔记 joins the paper it was made from');

  // The assistant is given the library's tools, and a change waits for a yes.
  await panel.getByRole('tab', { name: /整个项目/ }).click();
  await panel.getByLabel('向 AI 提问').fill('我在读哪些论文？把它标成必读');
  await panel.getByLabel('向 AI 提问').press('Enter');
  const step = panel.locator('.agent-step.waiting', { hasText: '文献库：修改文献库（1 项）' });
  await step.locator('.agent-plugin').getByText('Attention Is All You Need').waitFor();
  await step.locator('.agent-plugin').getByText('修改标签').waitFor();
  assert.ok(systems.assistant.offered.includes('list_library'));
  assert.ok(systems.assistant.offered.includes('get_paper'));
  assert.match(results.assistant[0], /文献库共 1 篇：已读 0，在读 1，未读 0/);
  assert.deepEqual((await library()).papers[0].tags, [], 'nothing changed before the yes');
  await page.screenshot({ path: path.join(evidence, 'library-tool-preview.png') });
  await step.getByRole('button', { name: '应用', exact: true }).click();
  await waitFor(
    async () => (await library()).papers[0].tags[0] === '必读',
    'changed after the yes',
  );
  console.log("PASS: the assistant uses the library's tools, asking before a change");

  // 文献综述: reads the library and the reader's marks, writes its review, changes nothing.
  await panel.getByRole('button', { name: '写一篇文献综述', exact: true }).click();
  await waitFor(() => exists(`综述/综述-注意力-${today}.html`), 'review written');
  await waitFor(() => results.review.length >= 4, 'the review run finished');
  const r = systems.review;
  assert.match(r.system, /主题：注意力机制/);
  assert.ok(r.offered.includes('list_library') && r.offered.includes('get_paper'));
  assert.ok(!r.offered.includes('update_library'));
  assert.match(results.review[0], /文献库共 1 篇：已读 0，在读 1，未读 0/);
  assert.match(results.review[0], /Attention Is All You Need — 2017 — Vaswani · 在读/);
  assert.match(results.review[0], /文件：论文\/attention\.html、论文\/attention-精读笔记\.html/);
  assert.match(results.review[0], /总结：只用注意力/);
  assert.match(
    results.review[1],
    /读者划的重点：\n- “based solely on attention mechanisms”\n  批注：这是全文的核心/,
  );
  assert.match(results.review[2], /没有名为 update_library 的工具/);
  assert.equal((await library()).papers.length, 1, 'the review changed nothing in the library');
  console.log('PASS: 文献综述 read the library and wrote its review');
  console.log('paper plugins e2e: ok');
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
