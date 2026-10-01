import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-e2e-'));
const samples = path.join(temp, '阅读项目');
const evidence = process.env.FOLIO_QA_DIR || '/tmp/folio-qa';
await fs.mkdir(evidence, { recursive: true });
await fs.mkdir(samples, { recursive: true });
const sampleSource = process.env.FOLIO_TEST_SAMPLES || path.join(root, 'samples');
const sampleFiles = (await fs.readdir(sampleSource)).filter((file) => file.endsWith('.html'));
for (const file of sampleFiles) {
  if (file.endsWith('.html'))
    await fs.copyFile(path.join(sampleSource, file), path.join(samples, file));
}
const quote = '阅读理解与批注定位可以一起工作。';
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>批注回归测试</title><link rel="stylesheet" href="assets/style.css"><script src="assets/local.js"></script><style>body{font:18px/1.9 system-ui;padding:40px 60px;color:#253342;margin:0}h1{font-size:36px}#target{white-space:nowrap}#draw-area{height:150px;border:1px dashed #ccdcd5;border-radius:8px;margin:32px 0;padding:20px}p{margin:20px 0}</style></head><body><h1>阅读是一场对话</h1><p id="quote">我们相信，<span id="target">${quote}</span> 让每一次思考留下痕迹。</p><div id="draw-area">画笔测试区域</div>${Array.from({ length: 45 }, (_, i) => `<h2 id="section-${i}">第 ${i + 1} 节 · 阅读与思考</h2><p>这里是第 ${i + 1} 段。用上下文记录文本位置，翻阅、重排和修改正文之后，笔记仍与内容保持关联。</p>`).join('')}</body></html>`;
await fs.writeFile(path.join(samples, '00_批注测试.html'), fixture);
await fs.mkdir(path.join(samples, 'assets'));
await fs.writeFile(path.join(samples, 'assets/style.css'), '#target{color:rgb(40,123,113)}');
await fs.writeFile(path.join(samples, 'assets/local.js'), 'window.localAssetLoaded=true;');
let app, page;
const consoleErrors = [];
async function start() {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: path.join(temp, 'user-data'),
      FOLIO_WORKSPACE: samples,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.waitForSelector('.document-frame');
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
}
async function frame() {
  return await page.locator('.document-frame').contentFrame();
}
async function rendered() {
  const src = await page.locator('.document-frame').getAttribute('src');
  let f;
  await waitFor(async () => {
    f = page.frames().find((x) => x.url() === src);
    return !!f;
  }, 'frame navigation');
  await f.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
  return f;
}
async function openFile(name) {
  await page
    .getByRole('navigation', { name: '项目文件' })
    .getByRole('button', { name, exact: true })
    .click();
  await waitFor(
    async () =>
      (await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected')) === 'true',
    'tab selected',
  );
  await waitFor(
    async () =>
      (await page.locator('.document-frame').getAttribute('src')).includes(
        encodeURIComponent(name),
      ),
    'frame src updated',
  );
  return rendered();
}
async function waitFor(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
async function dataFor(relative) {
  const index = JSON.parse(
    await fs.readFile(path.join(samples, '.html-reader/workspace.json'), 'utf8'),
  );
  const id = index.files[relative].id;
  const data = JSON.parse(
    await fs.readFile(path.join(samples, '.html-reader/documents', id + '.json'), 'utf8'),
  );
  return { id, data };
}
async function safeData(relative) {
  try {
    return await dataFor(relative);
  } catch {
    return null;
  }
}
// Playwright's child-frame bounding boxes do not apply the iframe's CSS scale.
// Convert document coordinates to actual window coordinates before native mouse input.
async function screenBox(locator) {
  const local = await locator.evaluate((e) => e.getBoundingClientRect().toJSON());
  const parent = await page.locator('.document-frame').boundingBox();
  const scale = await page
    .locator('.document-frame')
    .evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
  return {
    x: parent.x + local.x * scale,
    y: parent.y + local.y * scale,
    width: local.width * scale,
    height: local.height * scale,
  };
}
async function lineDraw(label, from, to) {
  await page.getByLabel(label, { exact: true }).click();
  const f = await rendered();
  const box = await screenBox(f.locator('#draw-area'));
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(
      box.x + from[0] + ((to[0] - from[0]) * i) / 10,
      box.y + from[1] + ((to[1] - from[1]) * i) / 10,
    );
  await page.mouse.up();
}
async function replaceSource(text) {
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Meta+A');
  // Auto-save (on by default) writes the edit straight away.
  await page.keyboard.insertText(text);
}
try {
  await start();
  console.log('PASS: packaged-renderer startup, real desktop window');
  assert.equal(await page.title(), '页间 · Folio');
  assert.ok((await page.locator('body').innerText()).includes('工作空间'));
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  for (const name of sampleFiles) {
    const f = await openFile(name);
    assert.ok(await f.locator('h1').count());
    assert.ok((await f.locator('body').innerText()).length > 200);
    if (name === '58_RaR.html') {
      try {
        await f.waitForSelector('mjx-container', { timeout: 25000 });
        console.log('PASS: MathJax formulas render');
      } catch {
        throw Error('MathJax formulas did not render');
      }
    }
  }
  console.log('PASS: bundled HTML documents preserve their original content and layouts');
  await page.screenshot({ path: path.join(evidence, 'desktop.png') });
  let f = await openFile('00_批注测试.html');
  assert.equal(await f.evaluate(() => window.localAssetLoaded), true);
  assert.equal(
    await f.locator('#target').evaluate((e) => getComputedStyle(e).color),
    'rgb(40, 123, 113)',
  );
  assert.deepEqual(
    await f.evaluate(() => {
      let parentBlocked = false;
      try {
        void parent.folio;
      } catch {
        parentBlocked = true;
      }
      return { nativeBridge: typeof window.folio, parentBlocked };
    }),
    { nativeBridge: 'undefined', parentBlocked: true },
  );
  console.log('PASS: relative CSS / JavaScript assets and isolated document sandbox');
  await f.evaluate(() =>
    document.addEventListener(
      'mouseup',
      () => (window.actualSelection = window.getSelection()?.toString()),
      true,
    ),
  );
  await page.getByLabel('高亮', { exact: true }).click();
  await page.getByLabel('显示或隐藏批注栏', { exact: true }).click();
  const target = await screenBox(f.locator('#target'));
  await page.mouse.move(target.x + 1, target.y + target.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 1, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.locator('.annotation-card').waitFor({ state: 'attached' });
  assert.equal(
    await page.locator('.inspector').isVisible(),
    false,
    'annotation must not open inspector',
  );
  await page.getByLabel('显示或隐藏批注栏', { exact: true }).click();
  const actualSelection = await f.evaluate(() => window.actualSelection);
  assert.ok(actualSelection.includes(quote));
  assert.equal(await page.locator('.annotation-quote').innerText(), actualSelection);
  await page.locator('.annotation-card').getByRole('button', { name: '写想法' }).click();
  await page.getByLabel('批注内容', { exact: true }).fill('测试：高亮应跟随原文，关闭后仍能恢复。');
  await waitFor(
    async () => (await safeData('00_批注测试.html'))?.data.annotations[0]?.note.includes('恢复'),
    'highlight persisted',
  );
  console.log('PASS: mouse-selected text -> anchored highlight -> annotation note persisted');
  for (const [label, type] of [['下划线', 'underline']]) {
    await page.getByLabel(label, { exact: true }).click();
    const b = await screenBox(f.locator('h1'));
    await page.mouse.move(b.x + 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 180, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    await waitFor(async () => (await page.locator('.annotation-card').count()) === 2, label);
    await waitFor(
      async () => (await safeData('00_批注测试.html'))?.data.annotations.at(-1)?.type === type,
      'typed annotation',
    );
    // The list is in reading order, so the heading's underline comes first.
    await page
      .locator('.annotation-card', { hasText: label })
      .getByLabel('删除批注', { exact: true })
      .click();
    await waitFor(
      async () => (await page.locator('.annotation-card').count()) === 1,
      'delete annotation',
    );
  }
  console.log('PASS: underline and annotation deletion');

  await page.getByLabel('珊瑚色', { exact: true }).click();
  await lineDraw('画笔', [40, 65], [280, 85]);
  await waitFor(async () => (await page.locator('.annotation-card').count()) === 2, 'pen');
  await page.getByLabel('蓝色', { exact: true }).click();
  await lineDraw('箭头', [330, 100], [460, 55]);
  await waitFor(async () => (await page.locator('.annotation-card').count()) === 3, 'arrow');
  await lineDraw('矩形', [80, 40], [220, 110]);
  await waitFor(async () => (await page.locator('.annotation-card').count()) === 4, 'rectangle');
  await page.getByLabel('撤销批注', { exact: true }).click();
  assert.equal(await page.locator('.annotation-card').count(), 3);
  await page.getByLabel('重做批注', { exact: true }).click();
  assert.equal(await page.locator('.annotation-card').count(), 4);

  await page.getByLabel('橡皮擦', { exact: true }).click();
  const eraseBox = await screenBox(f.locator('[data-folio-ui="overlay"] path').first());
  await page.mouse.click(eraseBox.x + eraseBox.width / 2, eraseBox.y + eraseBox.height / 2);
  await waitFor(
    async () =>
      (await safeData('00_批注测试.html'))?.data.annotations.find((a) => a.type === 'pen')?.paths
        ?.length === 2,
    'partial erasing splits ink',
  );
  assert.equal(await page.locator('.annotation-card').count(), 4);
  await page.getByLabel('撤销批注', { exact: true }).click();
  assert.equal(await page.locator('.annotation-card').count(), 4);
  await waitFor(
    async () =>
      !(await safeData('00_批注测试.html'))?.data.annotations.find((a) => a.type === 'pen')?.paths,
    'undo restores complete ink',
  );
  console.log('PASS: eraser removes only a stroke fragment and undo restores it');
  await page.getByLabel('阅读缩放', { exact: true }).selectOption('0.75');
  f = await rendered();
  await waitFor(
    async () => (await f.locator('[data-folio-ui="overlay"] path').count()) === 2,
    'restored SVG paths rendered',
  );
  assert.ok((await f.locator('[data-folio-ui="overlay"] rect').count()) >= 2);
  await page.getByLabel('选择文字', { exact: true }).click();
  await page.getByRole('button', { name: '笔记', exact: true }).click();
  await page
    .getByLabel('文档笔记', { exact: true })
    .fill('# 核心想法\n\n把阅读、批注和修改保存在同一个项目里。');
  await waitFor(
    async () => (await safeData('00_批注测试.html'))?.data.note.includes('核心想法'),
    'document note persisted',
  );
  console.log('PASS: pen, arrow, rectangle, undo/redo, zoom, document note');
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('button', { name: '第 10 节 · 阅读与思考', exact: true }).click();
  await waitFor(async () => (await f.evaluate(() => scrollY)) > 1500, 'outline scroll');
  await waitFor(
    async () => (await safeData('00_批注测试.html'))?.data.scroll > 1500,
    'scroll saved',
  );
  const saved = await dataFor('00_批注测试.html');
  await page.getByLabel('关闭 00_批注测试.html', { exact: true }).click();
  await openFile('00_批注测试.html');
  f = await rendered();
  await waitFor(
    async () => Math.abs((await f.evaluate(() => scrollY)) - saved.data.scroll) < 10,
    'scroll restored',
  );
  await page.getByRole('button', { name: /^批注/, exact: false }).first().click();
  assert.equal(await page.locator('.annotation-card').count(), 4);
  await page.locator('.annotation-quote').click();
  await waitFor(async () => (await f.evaluate(() => scrollY)) < 10, 'jump to annotation');
  console.log('PASS: table of contents, scroll persistence, close/reopen, annotation jump');
  await page.screenshot({ path: path.join(evidence, 'annotations.png') });
  const modified = fixture.replace(
    '<h1>阅读是一场对话</h1>',
    '<h1>阅读是一场持续的对话</h1><p>插入一段新内容，检查原有批注的定位。</p>',
  );
  await replaceSource(modified);
  await waitFor(
    async () => (await fs.readFile(path.join(samples, '00_批注测试.html'), 'utf8')) === modified,
    'source saved',
  );
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  f = await rendered();
  assert.equal(await f.locator('h1').innerText(), '阅读是一场持续的对话');
  await waitFor(
    async () =>
      (await f.locator('[data-folio-ui="overlay"] rect[data-annotation-id]').count()) >= 2,
    'highlights repositioned',
  );
  assert.equal(await page.locator('.orphan-warning').count(), 0);
  const currentData = await dataFor('00_批注测试.html');
  assert.ok((await fs.readdir(path.join(samples, '.html-reader/backups', currentData.id))).length);
  console.log(
    'PASS: source editing, live preview, disk save, version backup and quote reattachment',
  );
  await replaceSource(modified.replace(quote, '原文已被删除。'));
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await rendered();
  await page.locator('.orphan-warning').waitFor();
  assert.equal(await page.locator('.annotation-card').count(), 4);
  await page.getByRole('button', { name: '重新关联', exact: true }).click();
  f = await rendered();
  await f.locator('#target').scrollIntoViewIfNeeded();
  const rb = await screenBox(f.locator('#target'));
  await page.mouse.move(rb.x + 1, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width - 1, rb.y + rb.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('button', { name: '关联此批注', exact: true }).click();
  await page.locator('.orphan-warning').waitFor({ state: 'hidden' });
  assert.ok((await page.locator('.annotation-quote').innerText()).includes('原文已被删除'));
  await page.getByLabel('撤销批注', { exact: true }).click();
  await page.locator('.orphan-warning').waitFor();
  console.log('PASS: orphaned annotations can be rebound to new text');

  await replaceSource(modified);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await rendered();
  await page.locator('.orphan-warning').waitFor({ state: 'hidden' });
  console.log('PASS: deleted original marks annotation orphaned without losing notes');
  await page.getByLabel('新建文件夹', { exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('阅读归档');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  // The file menu closes on a click anywhere else, including inside the reader, or Escape.
  const treeMenu = page.locator('.popup-menu');
  const treeRow = page.locator('.tree-row[data-file-path="00_批注测试.html"]');
  await treeRow.click({ button: 'right' });
  await treeMenu.waitFor();
  await (await frame()).locator('h1').click();
  await treeMenu.waitFor({ state: 'detached' });
  await treeRow.click({ button: 'right' });
  await treeMenu.waitFor();
  await page.keyboard.press('Escape');
  await treeMenu.waitFor({ state: 'detached' });
  console.log('PASS: file menu closes on an outside click or Escape');
  await page.getByLabel('00_批注测试.html 的操作', { exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('我的批注.html');
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('我的批注.html 的操作', { exact: true }).click();
  await page.getByRole('menuitem', { name: '移动到…', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('阅读归档/我的批注.html');
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const moved = await dataFor('阅读归档/我的批注.html');
  assert.equal(moved.id, currentData.id);
  assert.equal(moved.data.annotations.length, 4);
  assert.ok(moved.data.note.includes('核心想法'));
  console.log('PASS: create folder, rename and move file preserve annotation identity');
  // Restore relative assets after moving this fixture to keep the source-conflict test focused.
  await fs.cp(path.join(samples, 'assets'), path.join(samples, '阅读归档/assets'), {
    recursive: true,
  });
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText('\n<!-- 本地草稿 -->');
  await waitFor(
    async () =>
      (await fs.readFile(path.join(samples, '阅读归档/我的批注.html'), 'utf8')).includes(
        '本地草稿',
      ),
    'draft auto-saved',
  );
  await fs.writeFile(
    path.join(samples, '阅读归档/我的批注.html'),
    modified + '\n<!-- 外部修改 -->',
  );
  // The next edit tries to save and finds the file changed on disk.
  await page.keyboard.insertText('\n<!-- 继续编辑 -->');
  await page.getByRole('alert').waitFor();
  assert.ok((await page.getByRole('alert').innerText()).includes('外部程序'));
  assert.ok((await editor.innerText()).includes('本地草稿'));
  assert.ok(
    (await fs.readFile(path.join(samples, '阅读归档/我的批注.html'), 'utf8')).includes('外部修改'),
  );
  await page.getByLabel('重新载入文件', { exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('关闭提示', { exact: true }).click();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  console.log('PASS: external-write conflict keeps both disk source and unsaved draft');
  // Ensure durable metadata is flushed before a real window-close cycle.
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.waitForEvent('close');
  await app.close();
  await start();
  await page
    .getByRole('navigation', { name: '项目文件' })
    .getByRole('button', { name: '我的批注.html', exact: true })
    .click();
  await rendered();
  await page.getByRole('button', { name: '笔记', exact: true }).click();
  // A saved note opens rendered: "# 核心想法" shows as a heading.
  assert.equal(
    await page.getByLabel('文档笔记预览', { exact: true }).locator('h3').innerText(),
    '核心想法',
  );
  console.log('PASS: app restart restores saved notes in moved file');

  await page.getByLabel('新建 HTML', { exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('新阅读文档.html');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await waitFor(
    async () =>
      (await page
        .getByRole('tab', { name: '新阅读文档.html', exact: true })
        .getAttribute('aria-selected')) === 'true',
    'created tab',
  );
  f = await rendered();
  assert.equal(await f.locator('h1').innerText(), '新文档');
  console.log('PASS: create HTML file through project tree');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
  );
  await page.getByLabel('显示或隐藏文件树', { exact: true }).click();
  await page.getByRole('navigation', { name: '项目文件' }).waitFor({ state: 'visible' });
  await page.getByLabel('收起文件树', { exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'compact.png') });
  assert.equal(
    await page.locator('.reader-toolbar').evaluate((e) => e.clientWidth >= e.scrollWidth),
    true,
  );
  console.log('PASS: compact 900 × 700 desktop layout and sidebar toggle');
  const appErrors = consoleErrors.filter(
    (s) =>
      !s.includes('ERR_FILE_NOT_FOUND') &&
      !s.includes('404') &&
      !s.includes('Failed to load resource'),
  );
  assert.deepEqual(appErrors, []);
  console.log('PASS: no application JavaScript errors');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].destroy();
  });
  await app.close();
  app = null;
  console.log('E2E PASS. Screenshots: ' + evidence);
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  console.error('E2E FAILED:', error);
  console.error('CONSOLE:', consoleErrors);
  process.exitCode = 1;
} finally {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      .catch(() => {});
    await app.close().catch(() => {});
  }
  await fs.rm(temp, { recursive: true, force: true });
}
