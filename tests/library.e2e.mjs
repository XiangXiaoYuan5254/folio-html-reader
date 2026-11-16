// 文献库, end to end in the real Electron app: the library tab opens from the sidebar; a
// document joins the library from its menu with its record looked up (OpenAlex stood in for);
// a folder's documents join at once; a paper is marked read from the list and shows so in the
// file tree; its record is edited; its file is followed when moved; BibTeX is imported; and a
// plugin's page (a dashboard) reads the library, hears it change, opens a paper's document,
// may go online by itself and runs no code from elsewhere. No real network.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-library-e2e-'));
const project = path.join(temp, '论文库');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-library-qa');
await fs.mkdir(path.join(project, '大模型'), { recursive: true });
await fs.mkdir(path.join(project, '智能体'), { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
const note = (title, body) =>
  `<!doctype html><html><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${body}</p></body></html>`;
await fs.writeFile(
  path.join(project, '大模型', 'Attention Is All You Need.html'),
  note('Attention Is All You Need', '注意力机制让模型关注重要的词。'),
);
await fs.writeFile(path.join(project, '大模型', 'BERT.html'), note('BERT', '双向预训练。'));
await fs.writeFile(path.join(project, '智能体', 'ReAct.html'), note('ReAct', '推理与行动交替。'));
await fs.writeFile(path.join(project, '智能体', 'Reflexion.md'), '# Reflexion\n\n用语言反思。\n');

// A site the page may reach, with code it must not be able to load.
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
  res.end('pong');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;

// A plugin with a page that may read the library.
const plugin = path.join(temp, 'probe-page');
await fs.mkdir(plugin, { recursive: true });
await fs.writeFile(
  path.join(plugin, 'folio-plugin.json'),
  JSON.stringify({
    folio: 2,
    id: 'probe-page',
    name: '页面测试',
    version: '0.1.0',
    description: '读文献库的页面',
    files: ['index.html', 'page.js'],
    page: { entry: 'index.html', title: '阅读概览', library: 'read' },
  }),
);
await fs.writeFile(
  path.join(plugin, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="count">…</h1><ul id="list"></ul><button id="open">打开第一篇</button><script src="page.js"></script></body></html>',
);
await fs.writeFile(
  path.join(plugin, 'page.js'),
  `const report = (check, result) => folio.log('probe ' + JSON.stringify({ check, result }));
async function draw() {
  const { papers } = await folio.library.list();
  document.getElementById('count').textContent = papers.filter((p) => p.status === 'done').length + '/' + papers.length;
  document.getElementById('list').innerHTML = papers.map((p) => '<li>' + p.title.replace(/</g, '&lt;') + '</li>').join('');
  return papers;
}
draw().then((papers) => report('list', papers.length));
folio.on('library', () => draw().then(() => report('changed', 'yes')));
folio.on('theme', (t) => report('theme', typeof t.dark));
folio.project().then((p) => report('project', p.name));
document.getElementById('open').onclick = async () => {
  const { papers } = await folio.library.list();
  const paper = papers.find((p) => p.files.length);
  const detail = await folio.library.get(paper.id);
  report('detail', detail.documents.length);
  await folio.open(paper.files[0]);
};
folio.library.update('x', { status: 'done' }).then(
  () => report('write', 'allowed'),
  (e) => report('write', 'refused'),
);
folio.open('../outside.html').then(() => report('outside', 'opened'), () => report('outside', 'refused'));
// Online by itself, like a widget.
fetch(${JSON.stringify(site)} + '/data').then(
  (r) => r.text().then((t) => report('fetch', t === 'pong' ? 'reached' : 'odd: ' + t)),
  (e) => report('fetch', 'blocked: ' + e.message),
);
// No code from elsewhere: not from another site, not by eval.
const tag = document.createElement('script');
tag.src = ${JSON.stringify(site)} + '/remote.js';
tag.onload = () => report('script-src', 'loaded');
tag.onerror = () => report('script-src', 'blocked');
document.head.appendChild(tag);
try {
  eval('1');
  report('eval', 'ran');
} catch {
  report('eval', 'blocked');
}
try {
  report('parent', 'reached: ' + window.parent.document.title);
} catch {
  report('parent', 'blocked');
}`,
);
await fs.writeFile(
  path.join(userData, 'plugins.json'),
  JSON.stringify({
    version: 1,
    thirdParty: true,
    plugins: { 'probe-page': { enabled: true, source: { type: 'folder', path: plugin } } },
  }),
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await wait(150);
  }
  throw Error('Timeout: ' + label);
}
const saved = async () =>
  JSON.parse(await fs.readFile(path.join(project, '.html-reader', 'library.json'), 'utf8'));
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

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
    },
  });
  // OpenAlex and arXiv, stood in for.
  await app.evaluate(({ net }) => {
    const real = net.fetch.bind(net);
    net.fetch = (url, init) => {
      const u = String(url);
      if (u.includes('api.openalex.org'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: /attention/i.test(decodeURIComponent(u))
                ? [
                    {
                      title: 'Attention Is All You Need',
                      publication_year: 2017,
                      cited_by_count: 123456,
                      doi: 'https://doi.org/10.48550/arxiv.1706.03762',
                      authorships: [
                        { author: { display_name: 'Ashish Vaswani' } },
                        { author: { display_name: 'Noam Shazeer' } },
                      ],
                      primary_location: {
                        source: { display_name: 'Neural Information Processing Systems' },
                      },
                      id: 'https://openalex.org/W1',
                    },
                  ]
                : [],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      if (u.includes('export.arxiv.org')) return Promise.resolve(new Response('<feed></feed>'));
      return real(url, init);
    };
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.document-frame');
  const shot = (name) => page.screenshot({ path: path.join(evidence, `${name}.png`) });
  const tree = (name) => page.locator('.tree-row', { hasText: name });
  const menuItem = (name) => page.getByRole('menuitem', { name, exact: true });
  // An action of the open project, as the window asks for it.
  const call = (action, payload) =>
    page.evaluate(
      async ([action, payload]) =>
        window.folio.invoke(action, payload, (await window.folio.invoke('workspace')).token),
      [action, payload],
    );
  const library = page.locator('.library-view');
  const row = (title) => library.locator('.library-row', { hasText: title });

  // Empty at first, a click away in the sidebar.
  await page.locator('.page-shelf').getByRole('button', { name: '文献库' }).click();
  await library.getByText('文献库还是空的').waitFor();
  assert.equal(await page.locator('.document-tab.page-tab.selected').innerText(), '文献库');
  await shot('1-empty');

  // A document joins from its menu; its record is found by its name.
  await tree('Attention Is All You Need.html').click({ button: 'right' });
  await menuItem('加入文献库…').click();
  const dialog = page.getByRole('dialog', { name: '加入文献库' });
  await waitFor(
    async () => (await dialog.getByLabel('作者').inputValue()).includes('Vaswani'),
    'record looked up',
  );
  assert.equal(await dialog.getByLabel('年份').inputValue(), '2017');
  assert.equal(
    await dialog.getByLabel('出处').inputValue(),
    'Neural Information Processing Systems',
  );
  await dialog.getByLabel('标签').fill('Transformer、必读');
  await shot('2-add-dialog');
  await dialog.getByRole('button', { name: '加入文献库' }).click();
  await dialog.waitFor({ state: 'detached' });
  await row('Attention Is All You Need').waitFor();
  let data = await saved();
  assert.equal(data.papers.length, 1);
  assert.deepEqual(data.papers[0].files, ['大模型/Attention Is All You Need.html']);
  assert.equal(data.papers[0].citations, 123456);
  assert.deepEqual(data.papers[0].tags, ['Transformer', '必读']);
  console.log('PASS: a document joins the library with its record looked up');

  // A folder's documents join at once; the one already there isn't doubled.
  await tree('智能体').first().click({ button: 'right' });
  await menuItem('里面的文档加入文献库').click();
  await row('ReAct').waitFor();
  await row('Reflexion').waitFor();
  await tree('大模型').first().click({ button: 'right' });
  await menuItem('里面的文档加入文献库').click();
  await row('BERT').waitFor();
  assert.equal((await saved()).papers.length, 4);
  console.log('PASS: a folder joins at once');

  // Marked read in the list: the day is kept, the file tree shows it.
  await row('ReAct').getByLabel('标为已读').click();
  await waitFor(
    async () => (await tree('ReAct.html').locator('.tree-read.done').count()) === 1,
    'tree mark',
  );
  data = await saved();
  const react = data.papers.find((p) => p.title === 'ReAct');
  assert.deepEqual([react.status, react.readAt], ['done', today]);
  assert.match(await page.locator('.page-shelf').innerText(), /1\/4/);
  // From the tree, back to unread and then being read.
  await tree('ReAct.html').click({ button: 'right' });
  await menuItem('标为未读').click();
  await waitFor(
    async () => (await tree('ReAct.html').locator('.tree-read').count()) === 0,
    'unmarked',
  );
  await tree('BERT.html').click({ button: 'right' });
  await menuItem('标为在读').click();
  await waitFor(
    async () => (await tree('BERT.html').locator('.tree-read.reading').count()) === 1,
    'reading',
  );
  await row('Attention Is All You Need').getByLabel('标为已读').click();
  await waitFor(async () => (await library.locator('.library-row.done').count()) === 1, 'read');
  console.log('PASS: read and reading show in the list and the tree');

  // Filtering and the record's dialog.
  await library.getByRole('tab', { name: /已读/ }).click();
  assert.equal(await library.locator('.library-row').count(), 1);
  await library.getByRole('tab', { name: /全部/ }).click();
  await library.getByLabel('搜索文献').fill('vaswani');
  assert.equal(await library.locator('.library-row').count(), 1);
  await library.getByLabel('搜索文献').fill('');
  await row('BERT').hover();
  await row('BERT').getByLabel('「BERT」的操作').click();
  await menuItem('文献信息…').click();
  const info = page.getByRole('dialog', { name: '文献信息' });
  await info.getByLabel('标题').fill('BERT: Pre-training of Deep Bidirectional Transformers');
  await info.getByLabel('作者').fill('Jacob Devlin; Ming-Wei Chang');
  await info.getByLabel('年份').fill('2019');
  await info.getByLabel('别名').fill('BERT');
  await info.getByRole('button', { name: '保存' }).click();
  await info.waitFor({ state: 'detached' });
  await row('BERT: Pre-training').getByText('Devlin 等 · 2019').waitFor();
  await shot('3-library');
  console.log('PASS: filtered, searched, a record edited');

  // Opening a paper shows its document; the library stays a tab away.
  await row('ReAct').locator('.library-main').click();
  await waitFor(async () => await page.locator('.page-host').isHidden(), 'document in front');
  assert.match(await page.locator('.document-tab.selected').innerText(), /ReAct\.html/);
  await page.locator('.document-tab.page-tab', { hasText: '文献库' }).getByRole('tab').click();
  await library.waitFor();

  // A file moved in 页间 stays its paper's; BibTeX comes in.
  await call('move', { from: '智能体/ReAct.html', to: 'ReAct.html' });
  await waitFor(
    async () => (await saved()).papers.find((p) => p.title === 'ReAct').files[0] === 'ReAct.html',
    'moved',
  );
  const imported = await call('library-import', {
    text: '@article{a, title={Language Models are Few-Shot Learners}, author={Brown, Tom}, year={2020}}\n@misc{b, title={ReAct}, year={2022}}',
  });
  assert.deepEqual(imported, { created: 1, updated: 1 });
  await row('Language Models are Few-Shot Learners').getByText('没有文件').waitFor();
  assert.equal((await saved()).papers.find((p) => p.title === 'ReAct').year, 2022);
  console.log('PASS: moved files follow, BibTeX imported');

  // Other AI tools on this computer: off until turned on here; then the address answers with
  // the library, and stops answering when turned off again.
  await library.getByLabel('导入、导出和补全').click();
  await page.getByRole('menuitem', { name: /让其他 AI 工具读文献库/ }).click();
  const share = page.getByRole('dialog', { name: '让其他 AI 工具读文献库' });
  assert.equal(await share.locator('.library-mcp-url').count(), 0, 'off at first');
  await share.getByRole('checkbox').check();
  await share.locator('.library-mcp-url code').first().waitFor();
  const address = await share.locator('.library-mcp-url code').first().innerText();
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[\w-]{24,}$/);
  const ask = () =>
    fetch(address, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_papers', arguments: { status: 'done' } },
      }),
    }).then((r) => r.json());
  const answered = (await ask()).result.content[0].text;
  assert.match(answered, /Project "论文库"/);
  assert.match(answered, /Library: 5 papers — 1 read/);
  assert.match(answered, /Attention Is All You Need/);
  await shot('5-mcp');
  await share.getByRole('checkbox').uncheck();
  await waitFor(async () => (await share.locator('.library-mcp-url').count()) === 0, 'turned off');
  await assert.rejects(ask(), 'nothing listens once it is off');
  await share.getByLabel('关闭').click();
  console.log('PASS: the library over MCP, only while turned on');

  // A plugin's page: in the sidebar, a tab of its own, reading the library.
  const log = () => page.evaluate(() => window.folio.invoke('plugin-log', { id: 'probe-page' }));
  const results = async () => {
    const out = {};
    for (const e of await log()) {
      const m = e.text.match(/^页面：probe (.*)$/);
      if (m) {
        const { check, result } = JSON.parse(m[1]);
        out[check] = result;
      }
    }
    return out;
  };
  await page.locator('.page-shelf').getByRole('button', { name: '阅读概览' }).click();
  const frame = page.frameLocator('.plugin-page iframe');
  await frame.locator('#count').getByText('1/5').waitFor();
  await waitFor(async () => {
    const r = await results();
    return r.fetch && r['script-src'] && r.eval && r.write && r.outside && r.project;
  }, 'page probes');
  let r = await results();
  assert.equal(r.list, 5);
  assert.equal(r.project, '论文库');
  assert.equal(r.theme, 'boolean');
  assert.equal(r.write, 'refused', 'a page given "read" cannot change the library');
  assert.equal(r.outside, 'refused');
  assert.equal(r.fetch, 'reached', 'a page may go online by itself');
  assert.equal(r['script-src'], 'blocked', 'but loads no code from elsewhere');
  assert.equal(r.eval, 'blocked');
  assert.equal(r.parent, 'blocked');
  assert.deepEqual(hits, ['/data'], 'the request it made, and no script fetched');
  // It hears the library change while its tab is open.
  await call('library-add', { paper: { title: 'Toolformer', status: 'done' } });
  await frame.locator('#count').getByText('2/6').waitFor();
  assert.equal((await results()).changed, 'yes');
  await shot('4-plugin-page');
  // And opens a paper's document in the reader.
  await frame.locator('#open').click();
  await waitFor(
    async () => await page.locator('.page-host').isHidden(),
    'document opened by the page',
  );
  assert.equal((await results()).detail, 1);
  assert.match(
    await page.locator('.document-tab.selected').innerText(),
    /Attention Is All You Need\.html/,
  );
  // Closing the tabs.
  for (const title of ['阅读概览', '文献库'])
    await page
      .locator('.document-tab.page-tab', { hasText: title })
      .getByLabel(`关闭 ${title}`)
      .click();
  assert.equal(await page.locator('.document-tab.page-tab').count(), 0);
  console.log(
    'PASS: a plugin page reads the library, hears changes, opens documents, runs only its own code',
  );

  assert.deepEqual(errors, [], 'no page errors');
  console.log('library e2e: ok');
} finally {
  await app?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
