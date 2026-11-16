// 论文伴读 and 文献综述 (plugins/), end to end in the real Electron app against a local
// OpenAI-compatible mock: each runs from its button in 整个项目; 论文伴读 is told which
// document is open ({{document}}), reads it, writes its notes page and keeps the paper in the
// library with the page as one of its files; 文献综述 reads the library and what the reader
// marked, and writes its review. Neither is asked to confirm a change to the library (a
// plugin given update_library may make it), and neither may write outside its folder.
// No real API key or network is used.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
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
const results = { companion: [], review: [] };
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
  if (system.includes('插件「论文伴读」')) {
    systems.companion = { system, offered };
    results.companion = tools.map((t) => t.content);
    const turns = [
      { toolCalls: [{ name: 'read_document', input: { path: '论文/attention.html' } }] },
      // Outside its folder: refused.
      {
        toolCalls: [
          { name: 'create_html', input: { path: '论文/偷偷.html', content: page1('x') } },
        ],
      },
      {
        toolCalls: [
          {
            name: 'create_html',
            input: { path: '伴读笔记/Transformer.html', content: page1('伴读｜Transformer') },
          },
        ],
      },
      { toolCalls: [{ name: 'list_library', input: { query: 'attention' } }] },
      {
        toolCalls: [
          {
            name: 'update_library',
            input: {
              papers: [
                {
                  title: 'Attention Is All You Need',
                  authors: ['Ashish Vaswani'],
                  year: 2017,
                  summary: '只用注意力，不用循环和卷积。',
                  status: 'reading',
                  files: ['论文/attention.html', '伴读笔记/Transformer.html'],
                },
              ],
            },
          },
        ],
      },
      { text: '伴读笔记写好了：伴读笔记/Transformer.html，已记进文献库。' },
    ];
    return stream(res, turns[Math.min(tools.length, turns.length - 1)]);
  }
  if (system.includes('插件「文献综述」')) {
    systems.review = { system, offered };
    results.review = tools.map((t) => t.content);
    const turns = [
      { toolCalls: [{ name: 'list_library', input: {} }] },
      { toolCalls: [{ name: 'read_annotations', input: { path: '论文/attention.html' } }] },
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
      ['paper-companion', 'literature-review'].map((id) => [
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
      FOLIO_APP_VERSION: '0.32.0',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.document-frame');
  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手', exact: true }).click();
  const panel = page.locator('.assistant-panel');
  await panel.getByRole('tab', { name: /整个项目/ }).click();

  // 论文伴读: told which document is open; its notes page and the paper end up in the library.
  await panel.getByRole('button', { name: '给正在读的论文写伴读笔记', exact: true }).click();
  await waitFor(() => exists('伴读笔记/Transformer.html'), 'notes page written');
  await waitFor(async () => (await library()).papers.length === 1, 'paper kept in the library');
  const c = systems.companion;
  assert.match(c.system, /用户现在打开的文档是：`论文\/attention\.html`/, '{{document}} filled in');
  assert.match(c.system, /## 输出模板/);
  assert.match(c.system, /只能在这些文件夹里新建或修改文件：伴读笔记\//);
  assert.deepEqual(c.offered, [
    'create_html',
    'list_files',
    'list_library',
    'read_document',
    'update_library',
  ]);
  assert.equal(await exists('论文/偷偷.html'), false, 'nothing written outside its folder');
  await waitFor(() => results.companion.length >= 5, 'the run finished');
  assert.match(results.companion[3], /文献库还是空的/);
  assert.match(results.companion[4], /文献库已更新：新增 1 篇/);
  const [paper] = (await library()).papers;
  assert.deepEqual(
    [paper.title, paper.authors, paper.year, paper.summary, paper.status, paper.files],
    [
      'Attention Is All You Need',
      ['Ashish Vaswani'],
      2017,
      '只用注意力，不用循环和卷积。',
      'reading',
      ['论文/attention.html', '伴读笔记/Transformer.html'],
    ],
  );
  // The notes page is opened when the run is done, and the tree shows the paper being read.
  await waitFor(
    async () => /Transformer\.html/.test(await page.locator('.document-tab.selected').innerText()),
    'notes page opened',
  );
  await waitFor(async () => (await page.locator('.tree-read.reading').count()) === 2, 'tree marks');
  console.log('PASS: 论文伴读 wrote its notes and kept the paper in the library');

  // 文献综述: reads the library and the reader's marks, writes its review, changes nothing.
  await panel.getByRole('button', { name: '写一篇文献综述', exact: true }).click();
  await waitFor(() => exists(`综述/综述-注意力-${today}.html`), 'review written');
  await waitFor(() => results.review.length >= 4, 'the review run finished');
  const r = systems.review;
  assert.match(r.system, /主题：注意力机制/);
  assert.ok(!r.offered.includes('update_library'));
  assert.match(results.review[0], /文献库共 1 篇：已读 0，在读 1，未读 0/);
  assert.match(results.review[0], /Attention Is All You Need — 2017 — Vaswani · 在读/);
  assert.match(results.review[0], /文件：论文\/attention\.html、伴读笔记\/Transformer\.html/);
  assert.match(results.review[0], /总结：只用注意力/);
  assert.match(results.review[2], /没有名为 update_library 的工具/);
  assert.equal((await library()).papers.length, 1, 'the review changed nothing in the library');
  console.log('PASS: 文献综述 read the library and wrote its review');
  console.log('paper plugins e2e: ok');
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
