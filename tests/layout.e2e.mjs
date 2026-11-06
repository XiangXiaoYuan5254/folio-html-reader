// Exercise the shared reader chrome in an isolated desktop session.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-layout-'));
const project = path.join(temp, 'hello-agent');
const evidence = process.env.FOLIO_QA_DIR || path.join(root, 'output/layout-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
// Hold a local mock answer to exercise the minimized board while it is thinking.
let reply;
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) {
    /* drain the request */
  }
  reply = () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'text t1 | 对照阅读\nsay 讲解完成。\n' } }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  };
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const userData = path.join(temp, 'user-data');
await fs.mkdir(userData);
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
for (let i = 1; i <= 8; i++) {
  await fs.writeFile(
    path.join(project, `chapter0${i}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{max-width:760px;margin:55px auto;padding:0 45px;font:17px/1.95 system-ui;color:#31434a}h1{font-size:30px}h2{font-size:21px;margin-top:35px}mark{background:#fff0b8}</style><h1>让智能体拥有记忆</h1><p>一次对话可以回答眼前的问题，而持续的协作，需要记住此前发生过什么。</p><p><mark>记忆的价值，在于让下一次行动建立在已有经验之上。</mark>它让分散的信息逐渐形成连贯的上下文。</p><h2>从上下文到长期记忆</h2><p>我们可以将当前任务需要的信息放在工作记忆中，将值得长期保留的经验整理下来，在需要时重新取回。</p></html>`,
  );
}
const app = await electron.launch({
  args: [root],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    FOLIO_USER_DATA: userData,
    FOLIO_NO_SPEECH_HELPER: '1',
    FOLIO_WORKSPACE: project,
  },
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.document-frame').waitFor();
  const resize = async (width, height = 900) => {
    await app.evaluate(
      ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setContentSize(...bounds),
      [width, height],
    );
    await page.waitForTimeout(200);
  };
  const tabs = page.getByRole('navigation', { name: '阅读侧栏功能' });
  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  await resize(1500);
  for (const i of [5, 6, 7, 8])
    await page
      .locator('.file-tree')
      .getByRole('button', { name: `chapter0${i}.html`, exact: true })
      .click();
  await page.getByRole('tab', { name: 'chapter07.html', exact: true }).click();
  assert.equal(await page.locator('.titlebar .document-tab-row').count(), 1);
  assert.equal(await page.locator('.main-panel .document-tab-row').count(), 0);
  assert.equal(await tabs.getByRole('button').count(), 4);
  assert.equal(await page.locator('.inspector-rail').count(), 0);
  assert.match(await page.locator('.brand').innerText(), /Folio/);
  assert.equal(await toggle.count(), 1);
  assert.equal(
    await page.locator('.reader-toolbar').getByLabel('AI 助手', { exact: true }).count(),
    0,
  );
  const top = await page.locator('.reader-toolbar').boundingBox();
  assert.ok(top.y <= 49, 'reader tools move up by one tab row');
  const wideBefore = (await page.locator('.main-panel').boundingBox()).width;
  await toggle.click();
  await page.locator('.inspector').waitFor({ state: 'hidden' });
  assert.ok((await page.locator('.main-panel').boundingBox()).width > wideBefore + 200);
  await toggle.click();
  await tabs.getByRole('button', { name: '笔记', exact: true }).click();
  await page.getByLabel('文档笔记', { exact: true }).waitFor();
  await tabs.getByRole('button', { name: '目录', exact: true }).click();
  await page.locator('.outline-list').waitFor();
  await tabs.getByRole('button', { name: '助手', exact: true }).click();
  assert.equal(await page.locator('.inspector-heading:visible').count(), 1);
  assert.equal(await page.getByLabel('新对话', { exact: true }).getAttribute('title'), null);
  await page.getByLabel('收起侧栏', { exact: true }).click();
  await page.locator('.inspector').waitFor({ state: 'hidden' });
  await toggle.click();
  assert.equal(
    await tabs.getByRole('button', { name: '助手', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  console.log('PASS: merged titlebar, bilingual brand, one panel toggle, remembered panel tab');

  assert.equal(await page.locator('.member-chip').count(), 0, 'no membership button');
  assert.equal(await page.locator('.status-summary, .status-format, .save-state').count(), 0);
  const footerBox = await page.locator('.statusbar').boundingBox();
  assert.ok(footerBox.height < 55, 'bottom controls share one compact row');
  await page.getByLabel('阅读提示与快捷键', { exact: true }).click();
  await page.getByRole('dialog', { name: '阅读提示与快捷键' }).waitFor();
  await page.getByLabel('关闭阅读提示', { exact: true }).click();
  await page.getByLabel('界面主题', { exact: true }).click();
  const themes = page.getByRole('dialog', { name: '界面主题', exact: true });
  await themes.waitFor();
  const themeBox = await themes.boundingBox();
  assert.ok(themeBox.x >= 0 && themeBox.y >= 48 && themeBox.x + themeBox.width <= 1500);
  await page.keyboard.press('Escape');
  await themes.waitFor({ state: 'hidden' });
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  console.log('PASS: theme picker and settings in the bottom-left');
  await page.screenshot({ path: path.join(evidence, 'mac-reader.png') });

  await resize(1800);
  await toggle.click();
  assert.equal(
    await page.locator('.annotation-tools > button:visible').count(),
    10,
    'all annotation tools fit at wide widths',
  );
  assert.equal(await page.locator('.tool-overflow').count(), 0);
  await resize(1050);
  await toggle.click();
  await page.locator('.tool-overflow').waitFor();
  const narrowCount = await page.locator('.annotation-tools > button:visible').count();
  assert.ok(narrowCount >= 1 && narrowCount < 10);
  const toolbarFits = () =>
    page
      .locator('.reader-toolbar')
      .evaluate((bar) =>
        [...bar.children]
          .filter((el) => getComputedStyle(el).display !== 'none')
          .every((el) => el.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1),
      );
  assert.ok(await toolbarFits(), 'narrow reader toolbar fits without overlap with the inspector');
  await page.locator('.tool-overflow').click();
  await page.getByRole('menu', { name: '更多工具' }).waitFor();
  await page.keyboard.press('Escape');
  await resize(1800);
  assert.equal(
    await page.locator('.annotation-tools > button:visible').count(),
    10,
    'tools reappear when width returns',
  );
  console.log('PASS: tools overflow only as needed and reappear on resize');
  assert.equal(await page.getByLabel('双栏阅读', { exact: true }).count(), 0);

  await page.getByLabel('新建空白白板', { exact: true }).click();
  const board = page.getByRole('dialog', { name: '白板讲解', exact: true });
  await board.locator('.wb-voice-button').click();
  await board.getByRole('radio', { name: /^静音讲解/ }).click();
  await page.keyboard.press('Escape');
  await board.getByLabel('向页老师提问').fill('讲解一下对照阅读');
  await board.locator('.wb-send').click();
  await board.locator('.wb-status').waitFor();
  await board.getByLabel('收起白板', { exact: true }).click();
  const away = page.locator('.whiteboard-tool .wb-away');
  await away.waitFor();
  assert.equal(await page.locator('.titlebar .wb-away').count(), 0);
  assert.equal(
    await page.getByLabel('白板讲解', { exact: true }).count(),
    1,
    'only the hidden board dialog keeps this label',
  );
  assert.equal(await page.locator('.whiteboard-tool > .icon-button').count(), 0);
  assert.match(await away.innerText(), /页老师/);
  for (const width of [1500, 1050, 1800]) {
    await resize(width);
    assert.ok(await toolbarFits(), `whiteboard progress fits at ${width}px`);
  }
  await page.screenshot({ path: path.join(evidence, 'whiteboard-progress.png') });
  const deadline = Date.now() + 12000;
  while (!reply && Date.now() < deadline) await page.waitForTimeout(50);
  assert.ok(reply, 'mock received the board question');
  reply();
  await page.locator('.whiteboard-tool .wb-away[data-ready]').waitFor();
  await away.click();
  await board.waitFor({ state: 'visible' });
  await page.locator('.wb-away').waitFor({ state: 'hidden' });
  await board.getByLabel('关闭白板', { exact: true }).click();
  await page.locator('.whiteboard-tool').getByLabel('白板讲解', { exact: true }).waitFor();
  console.log(
    'PASS: board progress replaces its toolbar button, fits on resize, and restores the same lesson',
  );

  // CSS regression check on macOS; native caption buttons are covered by windows.e2e.mjs.
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'win32';
  });
  await resize(1050);
  const chrome = await page.evaluate(() => {
    const tabs = document.querySelector('.document-tab-row').getBoundingClientRect();
    const brand = document.querySelector('.brand').getBoundingClientRect();
    return { width: innerWidth, tabsRight: tabs.right, brandLeft: brand.left, tabsLeft: tabs.left };
  });
  assert.ok(chrome.brandLeft < 30 && chrome.tabsLeft > chrome.brandLeft + 50);
  assert.ok(chrome.tabsRight <= chrome.width - 138, 'caption button area remains unobstructed');
  await page.screenshot({ path: path.join(evidence, 'windows-layout.png') });
  await page.evaluate(() => {
    document.documentElement.dataset.platform = window.folio.platform;
  });
  console.log('PASS: Windows logo left, caption controls reserved on the right');

  await resize(1500);
  await page.getByLabel('专注阅读', { exact: true }).click();
  await page.locator('.app-shell.focus-mode').waitFor();
  assert.equal(await tabs.isVisible(), false);
  assert.equal(await page.locator('.titlebar').isVisible(), false);
  await page.keyboard.press('Escape');
  await page.locator('.app-shell:not(.focus-mode)').waitFor();
  assert.equal(await tabs.isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: focus mode hides and restores chrome; no renderer errors');
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
