// Widgets (folio: 2), end to end in the real Electron app against a local OpenAI-compatible
// mock: a widget on top of the AI assistant's question box hears the AI think, write and finish,
// gets the open document's title and the reader's presence, keeps its own storage, may go online
// but runs no code from elsewhere and can't reach Folio's page; one stuck in a loop runs in a
// process of its own and is taken away without freezing the window; and the reader can put a
// widget away. No real network or API key.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-widget-'));
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-widget-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(
  path.join(project, '文档.html'),
  '<!doctype html><html><meta charset="utf-8"><body><h1>文档</h1><p>注意力机制让模型关注重要的词。</p></body></html>',
);

// The mock: an AI that thinks a moment before it writes, slowly; a site a widget may read; and
// code a widget must not be able to load.
const hits = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer(async (req, res) => {
  hits.push(req.url);
  if (req.url === '/cors') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    return res.end('pong');
  }
  if (req.url.endsWith('.js')) {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/javascript' });
    return res.end('folio.log("probe " + JSON.stringify({ check: "remote", result: "ran" }))');
  }
  for await (const chunk of req) void chunk;
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, extra = {}) =>
    res.write(`data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`);
  await wait(1500);
  for (const piece of ['注意力', '机制', '让模型', '关注', '重要的词。']) {
    send({ content: piece });
    await wait(300);
  }
  send({}, { finish_reason: 'stop' });
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;
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
        baseUrl: `${site}/v1`,
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

// The widgets, loaded from folders the way an author loads one being written.
async function widget(id, { anchor, events = [], html, js }) {
  const dir = path.join(temp, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'folio-plugin.json'),
    JSON.stringify({
      folio: 2,
      id,
      name: id,
      version: '0.1.0',
      description: '挂件测试',
      files: ['widget.html', 'widget.js'],
      widget: { entry: 'widget.html', size: { width: 96, height: 104 }, anchor, events },
    }),
  );
  await fs.writeFile(path.join(dir, 'widget.html'), html);
  await fs.writeFile(path.join(dir, 'widget.js'), js);
  return dir;
}
const probe = await widget('probe-widget', {
  anchor: 'assistant',
  events: ['ai', 'reading', 'document'],
  html: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:transparent}</style>
<script>folio.log('probe ' + JSON.stringify({ check: 'own-inline', result: 'ran' }));</script></head>
<body><div style="width:96px;height:104px;background:#4d6bfe;border-radius:50%"></div><script src="widget.js"></script></body></html>`,
  js: `const site = ${JSON.stringify(site)};
const report = (check, result) => folio.log('probe ' + JSON.stringify({ check, result }));
folio.on('ai', ({ state }) => folio.log('ai ' + state));
folio.on('document', (d) => report('document', d.title + '/' + d.kind));
folio.on('reading', (r) => report('reading', r.state + '/' + r.kind));
folio.on('theme', (t) => report('theme', typeof t.dark + '/' + typeof t.reducedMotion));
folio.on('visible', (v) => report('visible', String(v.visible)));
// Online by itself.
fetch(site + '/cors').then((r) => r.text()).then(
  (t) => report('fetch', t === 'pong' ? 'reached' : 'odd: ' + t),
  (e) => report('fetch', 'blocked: ' + e.message),
);
// No code from elsewhere: not added inline, not by eval, not from another site.
const inline = document.createElement('script');
inline.textContent = 'folio.log("probe " + JSON.stringify({ check: "injected", result: "ran" }))';
document.head.appendChild(inline);
setTimeout(() => report('injected', 'blocked'), 800);
try {
  eval('1');
  report('eval', 'ran');
} catch {
  report('eval', 'blocked');
}
const tag = document.createElement('script');
tag.src = site + '/remote.js';
tag.onload = () => report('script-src', 'loaded');
tag.onerror = () => report('script-src', 'blocked');
document.head.appendChild(tag);
// Not Folio's page.
try {
  report('parent', 'reached: ' + window.parent.document.title);
} catch {
  report('parent', 'blocked');
}
// Its own storage.
folio.storage
  .set({ pats: 3 })
  .then(() => folio.storage.get())
  .then((v) => report('storage', JSON.stringify(v)), (e) => report('storage', 'failed: ' + e.message));`,
});
const stuck = await widget('stuck-widget', {
  anchor: 'bottom-left',
  html: '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="widget.js"></script></body></html>',
  js: 'setTimeout(() => { for (;;) {} }, 2500);',
});
await fs.writeFile(
  path.join(userData, 'plugins.json'),
  JSON.stringify({
    version: 1,
    thirdParty: true,
    plugins: Object.fromEntries(
      [
        ['probe-widget', probe],
        ['stuck-widget', stuck],
      ].map(([id, dir]) => [id, { enabled: true, source: { type: 'folder', path: dir } }]),
    ),
  }),
);

let app;
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
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.document-frame');
  const log = (id) => page.evaluate((id) => window.folio.invoke('plugin-log', { id }), id);
  const results = async () => {
    const out = {};
    for (const e of await log('probe-widget')) {
      const m = e.text.match(/^挂件：probe (.*)$/);
      if (m) {
        const { check, result } = JSON.parse(m[1]);
        // Whether it's shown changes (hidden until the assistant is open); the rest is once.
        if (check === 'visible') out[check] = result;
        else out[check] ??= result;
      }
    }
    return out;
  };

  // On top of the question box, at its right.
  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手', exact: true }).click();
  const box = page.locator('.widget-box[data-widget="probe-widget"]');
  await waitFor(async () => !(await box.getAttribute('class')).includes('away'), 'widget shown');
  await wait(600);
  const composer = await page.locator('.assistant-composer').boundingBox();
  const placed = await box.boundingBox();
  // A quarter of it (up to 28px) over the box's edge, in its top right corner.
  assert.ok(
    Math.abs(placed.y + placed.height - (composer.y + 26)) <= 2,
    `sits in the box's top corner (${placed.y + placed.height} vs ${composer.y})`,
  );
  assert.ok(placed.x + placed.width <= composer.x + composer.width, 'at the right of the box');
  // The box keeps its text clear of the widget.
  const padding = await page
    .locator('.assistant-composer textarea')
    .evaluate((e) => parseFloat(getComputedStyle(e).paddingRight));
  assert.equal(padding, 12 + 96, 'the question box makes room for it');
  console.log('PASS: on top of the question box');

  // What it may and may not do.
  const checks = [
    'own-inline',
    'fetch',
    'injected',
    'eval',
    'script-src',
    'parent',
    'storage',
    'document',
    'reading',
    'theme',
    'visible',
  ];
  await waitFor(async () => {
    const now = await results();
    return checks.every((c) => c in now);
  }, 'every check reported');
  const r = await results();
  console.log(JSON.stringify(r));
  assert.equal(r['own-inline'], 'ran', "its own inline script runs");
  assert.equal(r.fetch, 'reached', 'it can go online');
  assert.equal(r.injected, 'blocked', 'a script it adds does not run');
  assert.equal(r.eval, 'blocked', 'no eval');
  assert.equal(r['script-src'], 'blocked', 'no code from another site');
  assert.equal(r.remote, undefined, 'the other site’s code never ran');
  assert.ok(!hits.includes('/remote.js'), 'the other site’s code was never even asked for');
  assert.equal(r.parent, 'blocked', "Folio's page is out of reach");
  assert.equal(r.storage, '{"pats":3}', 'its own storage');
  assert.equal(r.document, '文档/html', "the open document's title, when asked for");
  assert.equal(r.reading, 'reading/html');
  assert.equal(r.theme, 'boolean/boolean');
  assert.equal(r.visible, 'true');
  console.log('PASS: online, no code from elsewhere, storage, document, reading, theme');

  // In a process of its own.
  const frames = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0].webContents.mainFrame;
    return main.framesInSubtree.map((f) => ({ url: f.url, pid: f.osProcessId }));
  });
  const mainPid = frames[0].pid;
  const widgetFrame = frames.find((f) => f.url.startsWith('app://widget/probe-widget/'));
  assert.ok(widgetFrame, 'the widget frame is there');
  assert.notEqual(widgetFrame.pid, mainPid, 'the widget runs in a process of its own');
  const stuckFrame = frames.find((f) => f.url.startsWith('app://widget/stuck-widget/'));
  if (stuckFrame) assert.notEqual(stuckFrame.pid, widgetFrame.pid, 'not shared with another widget');
  console.log('PASS: own process');

  // The AI thinking, writing, done, and back to idle.
  const question = page.locator('.assistant-panel').getByLabel('向 AI 提问');
  await question.fill('注意力机制是什么？');
  await question.press('Enter');
  await page.locator('.assistant-panel .chat-answer.done').waitFor();
  await waitFor(
    async () => (await log('probe-widget')).some((e) => e.text.endsWith('ai idle') && e.at > 0),
    'idle again',
  );
  await wait(3800);
  const states = (await log('probe-widget'))
    .map((e) => e.text.match(/^挂件：ai (\w+)$/)?.[1])
    .filter(Boolean);
  const order = states.filter((s, i) => s !== states[i - 1]);
  console.log('ai states:', order.join(' → '));
  const seq = ['thinking', 'writing', 'done', 'idle'];
  let at = order.indexOf('thinking');
  for (const s of seq) {
    const next = order.indexOf(s, at);
    assert.ok(next >= at && next >= 0, `${s} after the one before (${order.join(',')})`);
    at = next;
  }
  console.log('PASS: thinking → writing → done → idle');
  await page.screenshot({ path: path.join(evidence, 'widget-on-question-box.png') });

  // The stuck one is taken away and the window still answers.
  await page
    .locator('.widget-box[data-widget="stuck-widget"]')
    .waitFor({ state: 'detached', timeout: 30000 });
  const started = Date.now();
  await page.evaluate(() => document.title);
  assert.ok(Date.now() - started < 1000, 'the window still answers');
  // The log says why (written a moment later, with the next batch).
  await waitFor(
    async () =>
      (await log('stuck-widget')).some((e) => e.kind === 'error' && e.text.includes('没有响应')),
    'the log says why',
  );
  console.log('PASS: a stuck widget is taken away, the window keeps working');

  // The reader can put one away.
  await box.hover();
  await box.locator('.widget-handle').click();
  await box.waitFor({ state: 'detached' });
  console.log('PASS: put away');
  console.log('widget e2e: ok');
} finally {
  await app?.close().catch(() => {});
  server.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
