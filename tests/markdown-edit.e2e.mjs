import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Markdown has 源码 like HTML: a Markdown editor beside a live preview, saved with backups,
// and a block picked in the preview found in the source.
const root = path.resolve('.');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-markdown-')));
const project = path.join(temp, '笔记项目');
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, '笔记.md'), '# 笔记\n\n第一段正文。\n');
await fs.writeFile(path.join(project, '图.png'), 'x');
let app, win;
const errors = [];
async function waitFor(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
const frames = () => win.frameLocator('.document-frame');
const onDisk = () => fs.readFile(path.join(project, '笔记.md'), 'utf8');
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
  win = await app.firstWindow();
  win.setDefaultTimeout(12000);
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.document-frame');
  await waitFor(async () => (await frames().locator('h1').innerText()) === '笔记', 'opened');

  // 源码 opens the Markdown in the editor, with the preview beside it.
  const sourceButton = win.getByRole('button', { name: '源码', exact: true });
  assert.equal(await sourceButton.isDisabled(), false);
  await sourceButton.click();
  await win.locator('.cm-content').waitFor();
  assert.equal(await win.locator('.source-hint').innerText(), 'Markdown 源码');
  const lines = await win.locator('.cm-line').allTextContents();
  assert.deepEqual(lines.slice(0, 3), ['# 笔记', '', '第一段正文。']);
  console.log('PASS: 源码 opens a Markdown file in the editor');

  // Typing updates the preview and, with autosave on, the file, keeping a backup.
  await win.locator('.cm-content').click();
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await win.keyboard.type('\n## 新增一节\n\n新的段落。');
  await waitFor(
    async () => (await frames().locator('h2').innerText()) === '新增一节',
    'preview shows the new heading',
  );
  await waitFor(async () => (await onDisk()).includes('## 新增一节\n\n新的段落。'), 'saved');
  const backupRoot = path.join(project, '.html-reader', 'backups');
  const [dir] = await fs.readdir(backupRoot);
  const backups = await fs.readdir(path.join(backupRoot, dir));
  assert.ok(backups.length >= 1 && backups.every((n) => n.endsWith('.md')), backups.join());
  assert.equal(
    await fs.readFile(path.join(backupRoot, dir, backups[0]), 'utf8'),
    '# 笔记\n\n第一段正文。\n',
  );
  console.log('PASS: edits show in the preview and save with a .md backup');

  // 定位元素: picking the heading in the preview selects its line in the source.
  await win.getByRole('button', { name: '定位元素' }).click();
  await frames().locator('h2').click();
  await waitFor(
    () => win.evaluate(() => document.getSelection()?.toString() === '## 新增一节'),
    'picked block selected in the source',
  );
  console.log('PASS: a block picked in the preview is found in the Markdown');

  // Back in 阅读 the saved change is there; pictures still have no source.
  await win.getByRole('button', { name: '阅读', exact: true }).click();
  await waitFor(
    async () => (await frames().locator('h2').innerText()) === '新增一节',
    'reading shows the edit',
  );
  await win.getByRole('navigation', { name: '项目文件' }).getByText('图.png').click();
  await waitFor(() => sourceButton.isDisabled(), '图片没有源码');
  assert.deepEqual(errors, []);
  console.log('MARKDOWN EDIT E2E PASS');
} catch (error) {
  console.error('MARKDOWN EDIT E2E FAILED:', error);
  console.error('ERRORS:', errors);
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
