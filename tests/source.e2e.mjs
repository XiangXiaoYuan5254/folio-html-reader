import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-source-'));
const project = path.join(temp, '源码项目');
await fs.mkdir(project, { recursive: true });
const filler = Array.from({ length: 80 }, (_, i) => `<p>填充段落 ${i + 1}</p>`).join('\n');
await fs.writeFile(
  path.join(project, '源码.html'),
  [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="UTF-8"><title>源码</title>',
    '<style>body{margin:0;padding:40px;font:18px system-ui}.card{padding:20px;border:1px solid #ccd}</style></head>',
    '<body>',
    '<h1 id="title">源码定位</h1>',
    '<section class="card"><p>第一段 <a href="#x" id="link">一个链接</a></p></section>',
    filler,
    '<div class="card" id="far">远处的元素</div>',
    '</body>',
    '</html>',
  ].join('\n'),
);
const originalSource = await fs.readFile(path.join(project, '源码.html'), 'utf8');
let app, page;
const consoleErrors = [];
async function waitFor(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
const inspectTag = () =>
  page
    .locator('.cm-inspect-tag')
    .allInnerTexts()
    .then((t) => t.join(''));
async function hover(f, selector) {
  const el = f.locator(selector);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 4 });
  return box;
}
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: path.join(temp, 'user-data'),
      FOLIO_WORKSPACE: project,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.waitForSelector('.document-frame');
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.locator('.cm-content').waitFor();
  // Source mode previews the draft with source offsets on every element.
  await waitFor(
    async () => (await page.locator('.document-frame').getAttribute('src')).includes('preview'),
    'source preview',
  );
  const f = page.frameLocator('.document-frame');
  await f.locator('h1[data-folio-src]').waitFor();
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });

  // A selection on the cursor's own line stays visible.
  const word = page.locator('.cm-line', { hasText: '源码定位' });
  const wb = await word.boundingBox();
  await page.mouse.dblclick(wb.x + 60, wb.y + wb.height / 2);
  await page.locator('.cm-selectionBackground').first().waitFor();
  const colors = await page.evaluate(() => ({
    line: getComputedStyle(document.querySelector('.cm-activeLine')).backgroundColor,
    selection: getComputedStyle(document.querySelector('.cm-selectionBackground')).backgroundColor,
  }));
  assert.match(colors.line, /rgba\(.*, 0\.0\d+\)/, 'active line is translucent');
  assert.equal(colors.selection, 'rgb(191, 224, 216)', 'focused selection color');
  console.log('PASS: selection visible on the active line');

  // Right click in the editor offers the edit commands.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.folioContextMenu = this.items.map((i) => i.label);
    };
  });
  await page.mouse.click(wb.x + 60, wb.y + wb.height / 2, { button: 'right' });
  await waitFor(
    () => app.evaluate(() => Array.isArray(globalThis.folioContextMenu)),
    'context menu',
  );
  assert.deepEqual((await app.evaluate(() => globalThis.folioContextMenu)).filter(Boolean), [
    '剪切',
    '拷贝',
    '粘贴',
    '全选',
  ]);
  console.log('PASS: right-click edit menu');

  // ⌘F (menu 查找) searches the code instead of leaving source mode.
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const find = Menu.getApplicationMenu()
      .items.flatMap((m) => m.submenu?.items || [])
      .find((i) => i.label === '查找');
    find.click(undefined, w, w.webContents);
  });
  await page.locator('.cm-search').waitFor();
  assert.equal(await page.locator('.cm-editor').count(), 1);
  assert.equal(await page.locator('.find-bar').count(), 0);
  assert.equal(
    await page.locator('.cm-search input[name=search]').getAttribute('placeholder'),
    '查找',
  );
  await page.keyboard.press('Escape');
  await page.locator('.cm-search').waitFor({ state: 'detached' });
  console.log('PASS: find opens the source search panel');

  // Pick mode: hovering the preview highlights the element's code, clicking selects it.
  const inspect = page.getByRole('button', { name: '定位元素', exact: true });
  await inspect.click();
  await f.locator('folio-inspector').waitFor({ state: 'attached' });
  await hover(f, '#title');
  await waitFor(async () => (await inspectTag()).startsWith('<h1 id="title">'), 'h1 highlighted');
  await hover(f, '#far');
  await waitFor(
    async () => (await inspectTag()).startsWith('<div class="card" id="far">'),
    'far element highlighted',
  );
  // The editor scrolls on its next frame.
  await waitFor(async () => {
    const tag = await page.locator('.cm-inspect-tag').first().boundingBox();
    const editor = await page.locator('.cm-scroller').boundingBox();
    return tag.y >= editor.y && tag.y + tag.height <= editor.y + editor.height;
  }, 'editor scrolled to the far element');
  const frameUrl = await page.locator('.document-frame').getAttribute('src');
  const link = await hover(f, '#link');
  await waitFor(async () => (await inspectTag()).startsWith('<a href="#x"'), 'link highlighted');
  await page.mouse.click(link.x + 8, link.y + link.height / 2);
  await waitFor(
    async () =>
      (await page.evaluate(() => window.getSelection().toString())) === '<a href="#x" id="link">',
    'link tag selected in editor',
  );
  assert.equal(await inspect.getAttribute('aria-pressed'), 'false');
  await f.locator('folio-inspector').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.cm-inspect-tag').count(), 0);
  assert.equal(
    await f.locator('html').evaluate(() => location.hash),
    '',
    'clicking in pick mode does not follow the link',
  );
  assert.equal(await page.locator('.document-frame').getAttribute('src'), frameUrl);

  // Esc leaves pick mode.
  await inspect.click();
  await f.locator('folio-inspector').waitFor({ state: 'attached' });
  await page.keyboard.press('Escape');
  await f.locator('folio-inspector').waitFor({ state: 'detached' });
  console.log('PASS: pick element locates and selects its source');

  // Auto-save is on by default and writes each edit straight away, with no status churn.
  const file = path.join(project, '源码.html');
  const status = page.locator('.editor-pane .pane-caption span');
  const frameSrc = () => page.locator('.document-frame').getAttribute('src');
  const title = page.locator('.cm-line', { hasText: '源码定位' });
  const tb = await title.boundingBox();
  await page.mouse.click(tb.x + tb.width - 4, tb.y + tb.height / 2);
  await page.keyboard.press('End');
  const beforeEdit = await frameSrc();
  await page.keyboard.insertText('<!-- 自动保存 -->');
  await waitFor(
    async () => (await fs.readFile(file, 'utf8')).includes('<!-- 自动保存 -->'),
    'saved at once',
    1000,
  );
  assert.equal(await status.innerText(), '');
  assert.equal(await page.locator('.dirty-dot').count(), 0);
  // The preview follows the edit once; the save itself doesn't reload it again.
  await waitFor(async () => (await frameSrc()) !== beforeEdit, 'preview follows edit');
  const afterEdit = await frameSrc();
  await page.waitForTimeout(1500);
  assert.equal(await frameSrc(), afterEdit);

  // A file changed by another program is never overwritten: auto-save pauses instead.
  const external = (await fs.readFile(file, 'utf8')) + '\n<!-- 外部修改 -->';
  await fs.writeFile(file, external);
  await page.keyboard.insertText('<!-- 本地草稿 -->');
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /自动保存失败.*外部程序/);
  await waitFor(async () => (await status.innerText()).includes('自动保存已暂停'), 'paused');
  assert.equal(await page.locator('.dirty-dot').count(), 1);
  await page.keyboard.insertText('<!-- 继续输入 -->');
  await page.waitForTimeout(1000);
  assert.equal(await fs.readFile(file, 'utf8'), external);
  await page.getByLabel('关闭提示', { exact: true }).click();
  await page.getByLabel('重新载入文件', { exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.cm-content').innerText()).includes('外部修改'),
    'reloaded',
  );
  assert.equal(await status.innerText(), '');
  console.log('PASS: auto-save writes each edit at once and pauses on external changes');

  // Turned off, edits wait for 保存; turning it back on saves them.
  const toggle = page.getByRole('button', { name: '自动保存', exact: true });
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('folio.autosave')), 'off');
  const line = await page.locator('.cm-line', { hasText: '源码定位' }).boundingBox();
  await page.mouse.click(line.x + line.width - 4, line.y + line.height / 2);
  await page.keyboard.press('End');
  await page.keyboard.insertText('<!-- 手动 -->');
  await page.waitForTimeout(800);
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('<!-- 手动 -->'));
  assert.equal(await status.innerText(), '未保存');
  assert.equal(await page.locator('.dirty-dot').count(), 1);
  await page.getByRole('button', { name: /^保存/ }).click();
  await waitFor(
    async () => (await fs.readFile(file, 'utf8')).includes('<!-- 手动 -->'),
    'manual save',
  );
  await waitFor(async () => (await status.innerText()) === '已保存', 'saved label');
  await page.keyboard.insertText('<!-- 开启时补存 -->');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await waitFor(
    async () => (await fs.readFile(file, 'utf8')).includes('<!-- 开启时补存 -->'),
    'saved when turned on',
  );
  assert.equal(await page.getByRole('button', { name: /^保存/ }).count(), 0);
  console.log('PASS: auto-save toggle');

  // History: the first save kept the original file; restoring it backs up what it replaces.
  const openHistory = async () => {
    await page.getByRole('button', { name: '历史版本', exact: true }).click();
    await page.getByRole('dialog', { name: '历史版本' }).waitFor();
    await page.locator('.history-list [role=group]').first().waitFor();
    return page.getByRole('option');
  };
  const options = await openHistory();
  assert.equal(await options.count(), 2, 'current file plus one backup');
  assert.equal(await options.first().getAttribute('aria-selected'), 'true');
  const restoreButton = page.getByRole('button', { name: '恢复此版本' });
  assert.ok(await restoreButton.isDisabled(), 'the current file cannot be restored');
  await page.keyboard.press('ArrowDown');
  assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
  const historyFrame = page.frameLocator('.history-frame');
  await waitFor(
    async () =>
      (await historyFrame
        .locator('#title')
        .innerText()
        .catch(() => '')) === '源码定位',
    'backup preview',
  );
  await page.getByRole('radio', { name: '源码' }).click();
  assert.equal(await page.locator('.history-source').innerText(), originalSource);
  await restoreButton.click();
  await page.getByRole('dialog', { name: '历史版本' }).waitFor({ state: 'detached' });
  await page.getByRole('status').filter({ hasText: '已恢复到' }).waitFor();
  assert.equal(await fs.readFile(file, 'utf8'), originalSource);
  await waitFor(
    async () => !(await page.locator('.cm-content').innerText()).includes('开启时补存'),
    'editor shows the restored text',
  );
  const edited = await fs.readFile(file, 'utf8');
  await openHistory();
  assert.equal(await options.count(), 3);
  assert.equal(await options.nth(1).locator('em').innerText(), '恢复前');
  await options.nth(1).click();
  await page.getByRole('radio', { name: '源码' }).click();
  await waitFor(
    async () => (await page.locator('.history-source').innerText()).includes('开启时补存'),
    'pre-restore backup holds the replaced text',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '历史版本' }).waitFor({ state: 'detached' });
  assert.equal(await fs.readFile(file, 'utf8'), edited);
  console.log('PASS: history lists, previews and restores backups');
  assert.deepEqual(consoleErrors, []);
  console.log('SOURCE E2E PASS');
} catch (error) {
  console.error('SOURCE E2E FAILED:', error);
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
