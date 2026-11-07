// What a plugin's script can and can't do in its sandbox (app://plugin/<id>, electron/plugins.cjs):
// it may go online by itself and has a page to parse HTML with, but it loads no code from anywhere
// else and can't reach Folio's own page or storage. Two broken scripts check that what went wrong
// comes with the line of the script it was on. Runs in the real Electron app, offline: the only
// server is on this computer.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-plugin-sandbox-'));
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(userData, { recursive: true });

const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : 'text/plain',
  });
  res.end(req.url.endsWith('.js') ? 'folio.log("probe " + JSON.stringify({ check: "remote", result: "ran" }))' : 'pong');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;

const checks = ['fetch', 'parse', 'script-src', 'import', 'injected', 'eval', 'parent', 'storage'];
const probe = `const site = ${JSON.stringify(site)};
const report = (check, result) => folio.log('probe ' + JSON.stringify({ check, result }));
// Online by itself.
fetch(site + '/fetch').then((r) => r.text()).then(
  (text) => report('fetch', text === 'pong' ? 'reached' : 'odd: ' + text),
  (e) => report('fetch', 'blocked: ' + e.message),
);
// A page to parse HTML with.
try {
  const doc = new DOMParser().parseFromString('<p class="x">你好</p>', 'text/html');
  report('parse', doc.querySelector('.x').textContent);
} catch (e) {
  report('parse', 'threw: ' + e.message);
}
// No code from anywhere else.
const tag = document.createElement('script');
tag.src = site + '/remote.js';
tag.onload = () => report('script-src', 'loaded');
tag.onerror = () => report('script-src', 'blocked');
document.head.appendChild(tag);
import(site + '/module.js').then(
  () => report('import', 'loaded'),
  () => report('import', 'blocked'),
);
// Nor code fetched and put in a <script> of its own, nor eval.
const injected = document.createElement('script');
injected.textContent = 'folio.log("probe " + JSON.stringify({ check: "injected", result: "ran" }))';
document.head.appendChild(injected);
setTimeout(() => report('injected', 'blocked'), 500);
try {
  eval('1');
  report('eval', 'ran');
} catch (e) {
  report('eval', 'blocked');
}
// Not Folio's page, nor any storage.
try {
  report('parent', 'reached: ' + window.parent.document.title);
} catch (e) {
  report('parent', 'blocked');
}
try {
  localStorage.setItem('x', '1');
  report('storage', 'reached');
} catch (e) {
  report('storage', 'blocked');
}`;
const scripts = {
  'net-probe': probe,
  // Scripts that go wrong: the run still gets going, and the log says on which line.
  'err-syntax': 'const fine = 1;\n\nconst = 1;\n',
  'err-runtime':
    "folio.registerTool({ name: 'ok_tool', description: '还能用' }, () => 'ok');\nsetTimeout(() => missingLater(), 10);\nmissingNow();\n",
};
const plugins = {};
for (const [id, code] of Object.entries(scripts)) {
  const dir = path.join(temp, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'folio-plugin.json'),
    JSON.stringify({
      folio: 1,
      id,
      name: id,
      version: '0.1.0',
      description: '沙箱测试',
      files: ['prompt.md', 'probe.js'],
      run: { prompt: 'prompt.md', script: 'probe.js', tools: [] },
    }),
  );
  await fs.writeFile(path.join(dir, 'prompt.md'), '什么也不用做。');
  await fs.writeFile(path.join(dir, 'probe.js'), code);
  plugins[id] = { enabled: true, source: { type: 'folder', path: dir } };
}
await fs.writeFile(
  path.join(userData, 'plugins.json'),
  JSON.stringify({ version: 1, thirdParty: true, plugins }),
);

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
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Each plugin's page, opened the way src/plugins/sandbox.ts opens it.
  await page.evaluate((ids) => {
    window.__probe = {};
    for (const id of ids) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
      frame.src = `app://plugin/${encodeURIComponent(id)}?t=${Date.now()}`;
      const seen = (window.__probe[id] = []);
      addEventListener('message', (e) => {
        if (e.source === frame.contentWindow && e.data?.folioPlugin === 1) seen.push(e.data);
      });
      document.body.appendChild(frame);
    }
  }, Object.keys(scripts));
  const resultsOf = (messages) => {
    const results = {};
    for (const m of messages)
      if (m.type === 'log' && m.text.startsWith('probe ')) {
        const { check, result } = JSON.parse(m.text.slice(6));
        results[check] ??= result;
      }
    return results;
  };
  let all = {};
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    all = await page.evaluate(() => window.__probe);
    const done = checks.every((c) => c in resultsOf(all['net-probe']));
    if (done && Object.keys(scripts).every((id) => all[id].some((m) => m.type === 'ready'))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Time for anything that would load late.
  await new Promise((r) => setTimeout(r, 1000));
  all = await page.evaluate(() => window.__probe);
  const results = resultsOf(all['net-probe']);
  for (const check of checks) console.log(`${check.padEnd(11)} ${results[check] ?? '(no report)'}`);
  console.log('requests:', JSON.stringify(hits));
  const errorsOf = (id) =>
    all[id].filter((m) => m.type === 'log' && m.level === 'error').map((m) => m.text);
  const readyOf = (id) => all[id].find((m) => m.type === 'ready');
  for (const id of ['err-syntax', 'err-runtime'])
    console.log(
      `${id}: ready ${!!readyOf(id)}, tools ${JSON.stringify(readyOf(id)?.tools?.map((t) => t.name))}, errors ${JSON.stringify(errorsOf(id))}`,
    );

  assert.ok(readyOf('net-probe'), 'the plugin page loaded and its script ran');
  assert.equal(results.fetch, 'reached', 'a script can go online by itself');
  assert.equal(results.parse, '你好', 'a script can parse HTML');
  assert.equal(results['script-src'], 'blocked', 'no <script src> from elsewhere');
  assert.equal(results.import, 'blocked', 'no import() from elsewhere');
  assert.equal(results.injected, 'blocked', 'a script it adds itself does not run');
  assert.equal(results.eval, 'blocked', 'no eval');
  assert.equal(results.remote, undefined, 'no code from elsewhere ran');
  assert.deepEqual(hits, ['/fetch'], 'only the fetch reached the server, not the code requests');
  assert.equal(results.parent, 'blocked', "Folio's own page is out of reach");
  assert.equal(results.storage, 'blocked', 'no storage');

  assert.ok(readyOf('err-syntax'), 'a script that does not parse still lets the run go on');
  assert.ok(
    errorsOf('err-syntax').some((t) => t.includes('脚本第 3 行')),
    'a syntax error says its line',
  );
  assert.deepEqual(
    readyOf('err-runtime')?.tools.map((t) => t.name),
    ['ok_tool'],
    'what a script registered before it failed is still offered',
  );
  assert.ok(
    errorsOf('err-runtime').some((t) => t.includes('missingNow') && t.includes('脚本第 3 行')),
    'an error at the top of a script says its line',
  );
  assert.ok(
    errorsOf('err-runtime').some((t) => t.includes('missingLater') && t.includes('脚本第 2 行')),
    'an error later on says its line',
  );
  console.log('plugin sandbox: ok');
} finally {
  await app?.close().catch(() => {});
  server.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
