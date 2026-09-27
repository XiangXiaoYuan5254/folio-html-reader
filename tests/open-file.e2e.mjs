import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-open-file-')));
const projectA = path.join(temp, '项目甲');
const elsewhere = path.join(temp, '别处');
const page = (title) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
await fs.mkdir(path.join(projectA, '章节'), { recursive: true });
await fs.mkdir(elsewhere, { recursive: true });
await fs.writeFile(path.join(projectA, '首页.html'), page('首页'));
await fs.writeFile(path.join(projectA, '章节/第二章.html'), page('第二章'));
await fs.writeFile(path.join(elsewhere, '外部文章.html'), page('外部文章'));
await fs.writeFile(path.join(elsewhere, '说明.txt'), '不是 HTML');
let app, win;
const consoleErrors = [];
async function waitFor(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
// What macOS does for Finder's "Open With" while the app is running.
const openFromFinder = (file) =>
  app.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), file);
const activeTab = () => win.locator('[role="tab"][aria-selected="true"]').innerText();
const heading = () => win.frameLocator('.document-frame').locator('h1').innerText();
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      FOLIO_USER_DATA: path.join(temp, 'user-data'),
      FOLIO_WORKSPACE: projectA,
    },
  });
  win = await app.firstWindow();
  win.setDefaultTimeout(12000);
  win.on('pageerror', (e) => consoleErrors.push(e.message));
  await win.waitForSelector('.document-frame');

  // A file inside the open project opens as a tab in it.
  await openFromFinder(path.join(projectA, '章节/第二章.html'));
  await waitFor(async () => (await activeTab()).trim() === '第二章.html', 'tab in current project');
  await waitFor(async () => (await heading()) === '第二章', 'document shown');
  console.log('PASS: file in the current project opens as a tab');

  // A file elsewhere switches to its folder as the project.
  await openFromFinder(path.join(elsewhere, '外部文章.html'));
  await waitFor(async () => (await activeTab()).trim() === '外部文章.html', 'tab in new project');
  await waitFor(async () => (await heading()) === '外部文章', 'external document shown');
  const tree = await win.getByRole('navigation', { name: '项目文件' }).innerText();
  assert.ok(tree.includes('外部文章.html') && !tree.includes('首页.html'), 'switched project');
  console.log('PASS: file elsewhere opens its folder as the project');

  // Other file types are refused with a message.
  await openFromFinder(path.join(elsewhere, '说明.txt'));
  await win.getByRole('alert').waitFor();
  assert.match(await win.getByRole('alert').innerText(), /只能打开 HTML 或 PDF/);
  assert.deepEqual(consoleErrors, []);
  console.log('OPEN FILE E2E PASS');
} catch (error) {
  console.error('OPEN FILE E2E FAILED:', error);
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
