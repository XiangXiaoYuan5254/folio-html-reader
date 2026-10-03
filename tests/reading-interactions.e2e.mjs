import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Browser plugin is unavailable; exercise the native Electron window and real drag/keyboard events.
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-reading-interactions-'));
const workspace = path.join(temp, '阅读项目');
const evidence = process.env.FOLIO_QA_DIR || '/tmp/folio-reading-interactions';
await fs.mkdir(workspace);
await fs.mkdir(path.join(workspace, '文件夹'));
await fs.mkdir(evidence, { recursive: true });
const sources = new Map();
for (const name of ['A.html', 'B.html', 'C.html']) {
  const source = `<!doctype html><html lang="zh"><head><meta charset="UTF-8"><title>${name}</title><style>body{margin:0;padding:30px;background:#fafbf8;color:#263a3c;font:17px/1.8 system-ui}#blank{height:190px;border:1px dashed #c0d2cc;border-radius:8px;margin:25px 0;padding:18px}h1{font-size:26px}</style></head><body><h1>${name} · 阅读与思考</h1><p id="target">两篇文章可以独立批注，也可以左右对照。</p><input id="ordinary-input" aria-label="文章表单" value="普通输入"><div id="blank">自由批注区</div>${Array.from({ length: 30 }, (_, i) => `<h2>第 ${i + 1} 节</h2><p>阅读、标记、记下想法，让每一次思考留下痕迹。</p>`).join('')}</body></html>`;
  sources.set(name, source);
  await fs.writeFile(path.join(workspace, name), source);
}
let app, page;
const errors = [];
async function wait(fn, label) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await fn()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error('Timeout: ' + label);
}
async function ready() {
  await wait(async () => (await page.locator('.reader-loading').count()) === 0, 'readers ready');
}
async function start() {
  app = await electron.launch({
    ...(process.env.FOLIO_TEST_EXECUTABLE
      ? { executablePath: process.env.FOLIO_TEST_EXECUTABLE, args: [] }
      : { args: [root] }),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: path.join(temp, 'userdata'),
      FOLIO_WORKSPACE: workspace,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await page.locator('.document-frame').first().waitFor();
  await ready();
}
async function frame(side = 'left') {
  const url = await page.locator(`[data-pane=${side}] iframe`).getAttribute('src');
  const f = page.frames().find((f) => f.url() === url);
  assert.ok(f, 'frame ' + side);
  await f.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  return f;
}
async function box(side, selector) {
  const f = await frame(side);
  const r = await f.locator(selector).evaluate((e) => e.getBoundingClientRect().toJSON());
  const el = page.locator(`[data-pane=${side}] iframe`),
    b = await el.boundingBox();
  const s = await el.evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
  return { x: b.x + r.x * s, y: b.y + r.y * s, width: r.width * s, height: r.height * s };
}
async function blank(side = 'left') {
  const b = await box(side, '#blank');
  await page.mouse.click(b.x + 35, b.y + 100);
}
async function tool(label) {
  await page.getByLabel(label, { exact: true }).click();
}
async function activeTool(label) {
  await wait(
    async () =>
      (await page.getByLabel(label, { exact: true }).getAttribute('aria-pressed')) === 'true',
    'active ' + label,
  );
}
async function index() {
  return JSON.parse(await fs.readFile(path.join(workspace, '.html-reader/workspace.json')));
}
async function data(name) {
  const i = await index();
  return JSON.parse(
    await fs.readFile(path.join(workspace, '.html-reader/documents', i.files[name].id + '.json')),
  );
}
async function title(side, name) {
  await wait(
    async () =>
      (await page.locator(`[data-pane=${side}] .pane-document-title`).textContent()) === name,
    side + ' title ' + name,
  );
  await ready();
}
async function dragFile(name, side = 'right', cancel = false) {
  const src = await page.locator(`.tree-row[data-file-path="${name}"]`).boundingBox();
  const target = await page.locator('.document-workbench').boundingBox();
  const x = target.x + target.width * (side === 'left' ? 0.2 : 0.8),
    y = target.y + 230;
  await page.mouse.move(src.x + 80, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 105, src.y + src.height / 2 + 5, { steps: 5 });
  await page.mouse.move(x, y, { steps: 20 });
  await page.mouse.move(x + 1, y + 1);
  await page.locator('.reading-drop-preview.hovered').waitFor();
  if ((await page.locator('.document-frame').count()) === 1) {
    const preview = await page.locator('.reading-drop-preview').boundingBox();
    const center = preview.x + preview.width / 2;
    assert.ok(
      side === 'left' ? center < target.x + target.width / 2 : center > target.x + target.width / 2,
      'preview matches initial drop side',
    );
    assert.equal(
      await page.locator('.reading-drop-preview strong').textContent(),
      `松开，在${side === 'left' ? '左' : '右'}栏打开`,
    );
  }
  if (cancel) await page.keyboard.press('Escape');
  else await page.screenshot({ path: path.join(evidence, 'drag-preview.png') });
  await page.mouse.up();
  await page.locator('.reading-drop-overlay').waitFor({ state: 'hidden' });
  if (!cancel) {
    await wait(
      async () => (await page.locator('.document-frame').count()) === 2,
      'split after native drop',
    );
    await ready();
  }
}
try {
  await start();
  await page.getByLabel('收起批注栏', { exact: true }).click();
  await tool('选择文字');
  await page.keyboard.press('ControlOrMeta+a');
  assert.equal(
    await page.evaluate(() => getSelection().toString()),
    '',
    'chrome is not selectable',
  );
  await blank();
  let f = await frame();
  await page.keyboard.press('ControlOrMeta+a');
  assert.ok(
    (await f.evaluate(() => getSelection().toString())).includes('两篇文章'),
    'article supports native select all',
  );
  await blank();
  await wait(
    async () => await f.evaluate(() => getSelection().isCollapsed),
    'blank clears article select all',
  );
  await page.locator('.selection-toolbar').waitFor({ state: 'hidden' });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Escape');
  assert.equal(await f.evaluate(() => getSelection().toString()), '');
  // Previously stuck ranges must also be cleared when a reading frame receives the next click.
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector('.main-panel'));
    getSelection().addRange(r);
  });
  await blank();
  await wait(
    async () => await page.evaluate(() => getSelection().isCollapsed),
    'frame click clears outer range',
  );
  console.log('PASS: native select-all, blank-click, Esc and legacy outer selection recovery');

  await tool('便签');
  await tool('画笔');
  await page.keyboard.press('Tab');
  await activeTool('便签');
  await page.keyboard.press('Tab');
  await activeTool('画笔');
  await blank();
  await page.keyboard.press('Tab');
  await activeTool('便签');
  await page.keyboard.press('Tab');
  await activeTool('画笔');
  await page.keyboard.down('e');
  await page.keyboard.up('e');
  await page.keyboard.press('Tab');
  await activeTool('便签');
  await blank();
  const note = f.getByLabel('页面便签内容', { exact: true });
  await page.keyboard.press('Tab');
  await activeTool('画笔');
  assert.equal(await note.inputValue(), '');
  assert.equal(
    await note.evaluate((el) => el.getRootNode().activeElement),
    null,
    'first Tab from a newly created note switches immediately',
  );
  await page.keyboard.press('Tab');
  await activeTool('便签');
  await note.fill('输入框仍可正常全选');
  await note.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('替换便签内容');
  assert.equal(await note.inputValue(), '替换便签内容');
  const stickySizeBefore = await note.evaluate((el) =>
    el.closest('.card').getBoundingClientRect().toJSON(),
  );
  await page.keyboard.press('Tab');
  await activeTool('画笔');
  assert.equal(
    await note.evaluate((el) => el.getRootNode().activeElement),
    null,
    'Tab leaves note editor and does not focus resize',
  );
  assert.equal(await note.inputValue(), '替换便签内容');
  await page.keyboard.press('Tab');
  await activeTool('便签');
  await f.getByLabel('调整便签大小', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await activeTool('画笔');
  assert.equal(await note.evaluate((el) => el.getRootNode().activeElement), null);
  const stickySizeAfter = await note.evaluate((el) =>
    el.closest('.card').getBoundingClientRect().toJSON(),
  );
  assert.equal(stickySizeAfter.width, stickySizeBefore.width);
  assert.equal(stickySizeAfter.height, stickySizeBefore.height);
  await f.getByLabel('文章表单', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await activeTool('画笔');
  const b = await box('left', '#blank');
  await page.mouse.move(b.x + 300, b.y + 125);
  await page.mouse.down();
  await page.mouse.move(b.x + 440, b.y + 145, { steps: 12 });
  await page.mouse.up();
  await wait(
    async () => (await data('A.html')).annotations.some((a) => a.type === 'pen'),
    'A pen saved',
  );
  assert.equal(await f.locator('[data-selection-outline]').count(), 0);
  console.log(
    'PASS: Tab swaps last two tools in toolbar and article; E does not replace history; Tab leaves the note input/resize control without changing content or size; ordinary inputs retain normal Tab',
  );

  await tool('选择文字');
  await f.evaluate(() => (window.frameIdentity = 'A-original'));
  const before = (await data('A.html')).annotations;
  await dragFile('B.html');
  await title('left', 'A.html');
  await title('right', 'B.html');
  assert.equal(await (await frame('left')).evaluate(() => window.frameIdentity), 'A-original');
  assert.equal(await page.locator('.reading-column-header select').count(), 0);
  assert.equal(await page.getByLabel('关闭左栏文档', { exact: true }).count(), 1);
  assert.equal(await page.getByLabel('关闭右栏文档', { exact: true }).count(), 1);
  for (const [name, source] of sources)
    assert.equal(await fs.readFile(path.join(workspace, name), 'utf8'), source);
  await page.getByLabel('关闭右栏文档', { exact: true }).click();
  await wait(async () => (await page.locator('.document-frame').count()) === 1, 'close right');
  await ready();
  assert.equal(await page.getByRole('tab', { name: 'B.html', exact: true }).count(), 0);
  assert.deepEqual((await data('A.html')).annotations, before);
  await dragFile('C.html', 'right', true);
  assert.equal(await page.locator('.document-frame').count(), 1);
  assert.equal(await page.getByRole('tab', { name: 'C.html', exact: true }).count(), 0);
  await dragFile('C.html', 'left');
  await title('left', 'C.html');
  await title('right', 'A.html');
  await page.screenshot({ path: path.join(evidence, 'initial-left-split.png') });
  assert.equal(await page.locator('.active-column').getAttribute('data-pane'), 'left');
  assert.deepEqual((await data('A.html')).annotations, before);
  assert.equal(await fs.readFile(path.join(workspace, 'C.html'), 'utf8'), sources.get('C.html'));
  await page.getByLabel('关闭左栏文档', { exact: true }).click();
  await wait(
    async () => (await page.locator('.document-frame').count()) === 1,
    'single after first left drop',
  );
  await ready();
  assert.ok((await page.locator('iframe').getAttribute('src')).includes('A.html'));
  await dragFile('B.html');
  await page.getByLabel('关闭左栏文档', { exact: true }).click();
  await wait(async () => (await page.locator('.document-frame').count()) === 1, 'close left');
  await ready();
  assert.ok((await page.locator('iframe').getAttribute('src')).includes('B.html'));
  await dragFile('A.html');
  await title('left', 'B.html');
  await title('right', 'A.html');
  const rightFrame = await frame('right');
  await rightFrame.evaluate(() => (window.frameIdentity = 'A-survives'));
  await dragFile('C.html', 'left');
  await title('left', 'C.html');
  await title('right', 'A.html');
  assert.equal(await rightFrame.evaluate(() => window.frameIdentity), 'A-survives');
  await dragFile('A.html', 'left');
  await title('left', 'C.html');
  await title('right', 'A.html');
  assert.equal(await page.locator('.active-column').getAttribute('data-pane'), 'right');
  console.log(
    'PASS: real workspace drag opens/switches split, cancel does nothing, duplicate focuses existing pane, each X closes its own document',
  );

  await (await frame('left')).evaluate(() => scrollTo(0, 500));
  await (await frame('right')).evaluate(() => scrollTo(0, 1000));
  await wait(
    async () => (await data('C.html')).scroll > 450 && (await data('A.html')).scroll > 950,
    'separate scroll',
  );
  await page.screenshot({ path: path.join(evidence, 'split-desktop.png') });
  await wait(
    async () =>
      (await index()).session.split?.left === 'C.html' &&
      (await index()).session.split?.right === 'A.html',
    'session saved',
  );
  await app.close();
  await start();
  await title('left', 'C.html');
  await title('right', 'A.html');
  assert.deepEqual((await data('A.html')).annotations, before);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  assert.ok(await page.getByLabel('关闭左栏文档', { exact: true }).isVisible());
  assert.ok(await page.getByLabel('关闭右栏文档', { exact: true }).isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(evidence, 'split-compact.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('<html><body>尚未保存的源码</body></html>');
  await page.keyboard.press('Tab');
  assert.ok(await page.locator('.cm-content').textContent());
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await activeTool('选择文字');
  await ready();
  // Closing right after typing saves the edit instead of asking to discard it.
  await page.getByLabel('关闭右栏文档', { exact: true }).click();
  await wait(
    async () => (await page.locator('.document-frame').count()) === 1,
    'close after auto-save',
  );
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.ok((await fs.readFile(path.join(workspace, 'A.html'), 'utf8')).includes('尚未保存的源码'));
  assert.deepEqual((await data('A.html')).annotations, before);
  // Existing tree-to-folder drag continues to move files, not open split readers.
  const src = page.locator('.tree-row[data-file-path="B.html"]');
  await src.dragTo(page.locator('.tree-row[data-file-path="文件夹"]'));
  await wait(
    async () => (await page.locator('.tree-row[data-file-path="文件夹/B.html"]').count()) === 1,
    'tree move',
  );
  assert.equal(await page.locator('.document-frame').count(), 1);
  assert.equal(
    await fs.readFile(path.join(workspace, '文件夹/B.html'), 'utf8'),
    sources.get('B.html'),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: independent scroll and restart, source/input keyboard behavior, auto-save before close, existing tree move, no page errors',
  );
} catch (e) {
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  console.error('QA files:', temp, e);
  await app?.evaluate(({ app }) => app.exit(1)).catch(() => {});
  throw e;
} finally {
  await app?.close().catch(() => {});
}
