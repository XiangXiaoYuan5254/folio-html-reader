// Writing and installing plugins from this computer, end to end in the real Electron app against
// a local OpenAI-compatible mock: a plugin loaded from its folder (its run, its run log with what
// its script said and which tools it registered in time, saved changes showing at once), a .zip
// installed, and the plugin directory browsed and installed from. No real network or API key.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildWebsitePlugins } from '../scripts/website-plugins.mjs';

const require = createRequire(import.meta.url);
const { writeZip } = require('../folio-plugins/cli/lib/zip.cjs');
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-plugin-dev-'));
const pluginDownloads = path.join(temp, 'downloads');
await buildWebsitePlugins({
  outputDir: pluginDownloads,
  recommendationsFile: path.join(temp, 'recommendations.json'),
});
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
const documents = path.join(temp, 'Documents');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-plugin-dev-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(
  path.join(project, '笔记.html'),
  '<!doctype html><html><meta charset="utf-8"><body><h1>笔记</h1></body></html>',
);

// A plugin being written, in a folder of the author's own.
const devDir = path.join(temp, '我的插件', 'dev-plug');
const devManifest = {
  folio: 1,
  id: 'dev-plug',
  name: '开发插件',
  version: '0.1.0',
  description: '在写的插件',
  files: ['prompt.md', 'tools.js'],
  run: { prompt: 'prompt.md', script: 'tools.js', tools: ['create_html'], where: 'folder' },
  triggers: [{ type: 'button', label: '试一下' }],
  permissions: { network: ['api.example.com'], write: ['{{out}}'] },
  settings: [{ key: 'out', type: 'folder', label: '放在哪', default: '开发输出' }],
};
await fs.mkdir(devDir, { recursive: true });
await fs.writeFile(path.join(devDir, 'folio-plugin.json'), JSON.stringify(devManifest));
await fs.writeFile(path.join(devDir, 'prompt.md'), '写一页，用 {{typo}}。');
await fs.writeFile(
  path.join(devDir, 'tools.js'),
  `folio.registerTool({ name: 'early_tool', description: '顶层注册' }, () => {
  // A tool call only arrives after setup has finished, regardless of timer throttling.
  folio.registerTool({ name: 'too_late', description: '太晚' }, () => 'x');
  return 'early';
});
(async () => {
  const r = await folio.fetch('https://api.example.com/config');
  folio.registerTool({ name: 'after_fetch', description: '联网后注册' }, () => 'config:' + r.text);
})();
folio.log('hello from script', { n: 1 });
folio.warn('careful');`,
);
const zipPath = path.join(temp, 'zip-plug.zip');
const zipManifest = {
  folio: 1,
  id: 'zip-plug',
  name: '压缩插件',
  version: '1.0.0',
  description: '从压缩包装的',
  files: ['prompt.md'],
  run: { prompt: 'prompt.md', tools: ['list_files'] },
};
await fs.writeFile(
  zipPath,
  writeZip([
    { name: 'zip-plug/folio-plugin.json', data: JSON.stringify(zipManifest) },
    { name: 'zip-plug/prompt.md', data: '列一下文件。' },
    { name: '__MACOSX/zip-plug/._prompt.md', data: 'junk' },
  ]),
);
// A plugin in the directory, served by a stand-in GitHub.
const listedManifest = {
  folio: 1,
  id: 'listed-plug',
  name: '目录插件',
  version: '2.0.0',
  description: '目录里的',
  files: ['prompt.md'],
  run: { prompt: 'prompt.md', tools: ['list_files'] },
};
const sha = 'b'.repeat(40);

const requests = [];
function stream(res, { text = '', toolCalls = [] }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunks = [];
  if (text) chunks.push({ choices: [{ delta: { content: text } }] });
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
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/directory.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'listed-plug',
            name: '目录插件',
            author: '某人',
            description: '目录里的插件',
            repo: 'https://github.com/me/listed',
            tags: ['示例'],
          },
        ],
      }),
    );
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push(body);
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  const system = body.messages.find((m) => m.role === 'system')?.content || '';
  const tools = body.messages.filter((m) => m.role === 'tool');
  if (system.includes('插件「开发插件」')) {
    const turns = [
      { toolCalls: [{ name: 'early_tool', input: {} }] },
      { toolCalls: [{ name: 'after_fetch', input: {} }] },
      {
        toolCalls: [
          {
            name: 'create_html',
            input: { path: 'out.html', content: '<!doctype html><title>x</title><p>好</p>' },
          },
        ],
      },
      { text: '写好了 out.html' },
    ];
    return stream(res, turns[Math.min(tools.length, turns.length - 1)]);
  }
  return stream(res, { text: '好的。' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
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
        baseUrl: `http://127.0.0.1:${port}/v1`,
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
  JSON.stringify({ version: 1, thirdParty: false, plugins: {} }),
);

let app, page;
const errors = [];
async function waitFor(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
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
      FOLIO_DOCUMENTS: documents,
      FOLIO_NO_SPEECH_HELPER: '1',
      FOLIO_PLUGIN_DIRECTORY: `http://127.0.0.1:${port}/directory.json`,
    },
  });
  // The plugin's one site, and a GitHub with the directory's plugin in it.
  await app.evaluate(
    ({ net }, { sha, listed, pluginUrl, pluginZip }) => {
      globalThis.pluginDownloads = 0;
      const real = net.fetch.bind(net);
      const json = (body, type = 'application/json') =>
        new Response(body, { status: 200, headers: { 'content-type': type } });
      net.fetch = (input, init) => {
        const url = String(input);
        if (url === pluginUrl) {
          globalThis.pluginDownloads++;
          return Promise.resolve(new Response(Buffer.from(pluginZip, 'base64')));
        }
        if (url === 'https://api.example.com/config')
          return Promise.resolve(json('v1', 'text/plain'));
        if (url.startsWith('https://api.github.com/repos/me/listed/commits/'))
          return Promise.resolve(json(sha, 'text/plain'));
        if (url === `https://raw.githubusercontent.com/me/listed/${sha}/folio-plugin.json`)
          return Promise.resolve(json(JSON.stringify(listed)));
        if (url === `https://raw.githubusercontent.com/me/listed/${sha}/prompt.md`)
          return Promise.resolve(json('列一下', 'text/markdown'));
        return real(input, init);
      };
    },
    {
      sha,
      listed: listedManifest,
      pluginUrl: require('../electron/recommended-plugins.json')[0].url,
      pluginZip: (
        await fs.readFile(
          path.join(
            pluginDownloads,
            path.basename(new URL(require('../electron/recommended-plugins.json')[0].url).pathname),
          ),
        )
      ).toString('base64'),
    },
  );
  const pick = (file) =>
    app.evaluate(({ dialog: native }, file) => {
      native.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|Content Security Policy/.test(m.text()))
      errors.push(m.text());
  });
  await page.waitForSelector('.document-frame');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('button', { name: '插件' }).click();

  // A fresh install shows only recommendation metadata. Declining consent fetches nothing.
  const recommendation = dialog.getByRole('article', { name: '推荐：AI 前沿日报' });
  await recommendation.waitFor();
  await page.screenshot({ path: path.join(evidence, 'optional-plugin-recommended.png') });
  assert.equal((await page.evaluate(() => window.folio.invoke('plugins'))).plugins.length, 0);
  assert.equal(await app.evaluate(() => globalThis.pluginDownloads), 0);
  await recommendation.getByRole('button', { name: '下载', exact: true }).click();
  const warning = dialog.getByRole('alertdialog', { name: '打开外部插件前请确认' });
  await warning.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.pluginDownloads), 0);
  await recommendation.getByRole('button', { name: '下载', exact: true }).click();
  await warning.getByRole('button', { name: '我了解，打开外部插件' }).click();
  const dailyConfirm = dialog.getByRole('dialog', { name: '安装AI 前沿日报' });
  await dailyConfirm.waitFor();
  assert.equal(await app.evaluate(() => globalThis.pluginDownloads), 1);
  assert.equal((await page.evaluate(() => window.folio.invoke('plugins'))).plugins.length, 0);
  await dailyConfirm.getByRole('button', { name: '取消', exact: true }).click();
  await recommendation.getByRole('button', { name: '下载', exact: true }).click();
  await dailyConfirm.getByRole('button', { name: '安装', exact: true }).click();
  await recommendation.getByRole('button', { name: '已安装', exact: true }).waitFor();
  const dailyCard = dialog
    .locator('.plugin-card')
    .filter({ has: page.getByLabel('开启AI 前沿日报') });
  assert.equal(await dailyCard.getByLabel('开启AI 前沿日报').isChecked(), false);
  await page.screenshot({ path: path.join(evidence, 'optional-plugin-installed.png') });
  await dailyCard.getByLabel('展开AI 前沿日报').click();
  await dailyCard.getByRole('button', { name: '卸载', exact: true }).click();
  await recommendation.getByRole('button', { name: '下载', exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.pluginDownloads), 2);

  // 1. Loaded from its folder: where it is, with what its author may have got wrong.
  await pick(devDir);
  await dialog.getByRole('button', { name: '从文件夹加载…' }).click();
  const confirm = dialog.getByRole('dialog', { name: '安装开发插件' });
  await confirm.getByText('从文件夹加载「开发插件」？').waitFor();
  await confirm.getByText(/本地文件夹 · /).waitFor();
  await confirm.getByText('插件可能写错的地方').waitFor();
  await confirm.getByText(/\{\{typo\}\}/).waitFor();
  await page.screenshot({ path: path.join(evidence, 'dev-confirm.png') });
  await confirm.getByRole('button', { name: '加载', exact: true }).click();
  const card = dialog.locator('.plugin-card').filter({ hasText: '开发插件' });
  await card.getByText('开发版', { exact: true }).waitFor();
  await card.getByText(/从文件夹加载 · /).waitFor();
  assert.ok(!(await fs.stat(path.join(userData, 'plugins', 'dev-plug')).catch(() => null)));

  // 2. Run: its script's tools, the ones registered after folio.fetch included.
  await card.getByLabel('开启开发插件').click();
  await card.getByText('插件可能写错的地方').waitFor();
  await card.getByRole('button', { name: '试一下' }).click();
  const out = path.join(documents, '开发输出', 'out.html');
  await waitFor(() => fs.stat(out).then(() => true), 'the dev plugin wrote its page', 30000);
  const asked = requests.find((r) => r.messages?.[0]?.content?.includes('插件「开发插件」'));
  const names = asked.tools.map((t) => t.function?.name || t.name);
  assert.ok(names.includes('early_tool'), 'top-level tool');
  assert.ok(names.includes('after_fetch'), 'tool registered after folio.fetch');
  assert.ok(!names.includes('too_late'), 'a late tool was offered');

  // 3. Its run log says what happened, live.
  await card.locator('.plugin-log summary').click();
  const log = card.getByRole('list', { name: '运行日志' });
  await waitFor(
    async () => (await log.innerText()).includes('完成，写了 out.html'),
    'run end logged',
  );
  const text = await log.innerText();
  for (const expected of [
    '开始运行',
    '脚本准备好了，提供的工具：early_tool、after_fetch',
    'hello from script {"n":1}',
    'careful',
    'early_tool → 完成',
    'after_fetch → 完成',
    'config:v1',
    '工具 too_late 注册得太晚',
    'create_html out.html → 完成',
  ])
    assert.ok(text.includes(expected), `log has “${expected}”:\n${text}`);
  assert.ok(await card.locator('.log-error').filter({ hasText: 'too_late' }).count());
  assert.ok(await card.locator('.log-warn').filter({ hasText: 'careful' }).count());
  await card.getByText(/\d+ 条，1 个出错/).waitFor();
  await page.screenshot({ path: path.join(evidence, 'dev-log.png') });
  // Kept by the app.
  const saved = JSON.parse(
    await fs.readFile(path.join(userData, 'logs', 'plugins', 'dev-plug.json'), 'utf8'),
  );
  assert.ok(saved.some((e) => e.text.includes('hello from script')));

  // 4. Saved changes show at once; a broken manifest says why, and comes back when fixed.
  await fs.writeFile(
    path.join(devDir, 'folio-plugin.json'),
    JSON.stringify({ ...devManifest, version: '0.1.1' }),
  );
  await card.locator('.plugin-version').getByText('0.1.1').waitFor();
  await fs.writeFile(path.join(devDir, 'folio-plugin.json'), '{ oops');
  const broken = dialog.locator('.plugin-card.broken').filter({ hasText: 'dev-plug' });
  await broken
    .getByText(/这个插件读不了：.*不是有效的 JSON/)
    .waitFor()
    .catch(async (e) => {
      const listed = await page.evaluate(() => window.folio.invoke('plugins'));
      console.error('DEBUG list', JSON.stringify(listed.plugins.find((x) => x.id === 'dev-plug')));
      console.error('DEBUG errors', errors);
      await page.screenshot({ path: path.join(evidence, 'dev-broken-debug.png') });
      throw e;
    });
  await fs.writeFile(path.join(devDir, 'folio-plugin.json'), JSON.stringify(devManifest));
  await card.locator('.plugin-version').getByText('0.1.0').waitFor();

  // 5. A .zip: Finder's layout, copied in.
  await pick(zipPath);
  await dialog.getByRole('button', { name: '安装 .zip…' }).click();
  const zipConfirm = dialog.getByRole('dialog', { name: '安装压缩插件' });
  await zipConfirm.getByText('压缩包 · zip-plug.zip').waitFor();
  await zipConfirm.getByRole('button', { name: '安装', exact: true }).click();
  const zipCard = dialog.locator('.plugin-card').filter({ hasText: '压缩插件' });
  await zipCard.getByText(/从压缩包安装 · zip-plug\.zip/).waitFor();
  assert.ok(await fs.stat(path.join(userData, 'plugins', 'zip-plug', 'prompt.md')));

  // 6. The directory: searched, and installed from (its repository must hold that plugin).
  await dialog.locator('.plugin-directory summary').click();
  const directory = dialog.locator('.plugin-directory');
  await directory.getByText('目录里的插件', { exact: true }).waitFor();
  await directory.getByLabel('搜索插件目录').fill('没有这种插件');
  await directory.getByText('没有找到符合的插件。').waitFor();
  await directory.getByLabel('搜索插件目录').fill('目录');
  await page.screenshot({ path: path.join(evidence, 'directory.png') });
  await directory.getByRole('button', { name: '安装目录插件' }).click();
  const listedConfirm = dialog.getByRole('dialog', { name: '安装目录插件' });
  await listedConfirm.getByText('GitHub · me/listed').waitFor();
  await listedConfirm.getByRole('button', { name: '安装', exact: true }).click();
  await dialog.locator('.plugin-card').filter({ hasText: '目录插件' }).waitFor();
  await directory.getByRole('button', { name: '安装目录插件' }).getByText('已安装').waitFor();

  // 7. Removing the loaded plugin forgets it; the author's folder stays.
  await card.getByRole('button', { name: '移除' }).click();
  await waitFor(async () => !(await card.count()), 'dev plugin removed');
  assert.ok(await fs.stat(path.join(devDir, 'folio-plugin.json')));

  assert.deepEqual(errors, []);
  console.log('plugin dev e2e: ok');
} finally {
  // Closed, or ended if closing hangs after a failure.
  const pid = app?.process().pid;
  await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
  try {
    if (pid) process.kill(pid);
  } catch {}
  server.close();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
