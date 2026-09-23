import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-text-width-'));
const project = path.join(temp, '文本框项目');
await fs.mkdir(project, { recursive: true });
await fs.writeFile(
  path.join(project, '文本框.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>文本框</title><style>body{margin:0;padding:40px;height:1400px;font:18px system-ui}</style></head><body><h1>文本框宽度</h1></body></html>`,
);
let app, page;
const consoleErrors = [];
async function start() {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
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
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
  const f = page.frameLocator('.document-frame');
  await f.locator('h1').waitFor();
  return f;
}
async function stop() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await closed;
  app = null;
}
async function waitFor(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
async function framePoint(x, y) {
  const b = await page.locator('.document-frame').boundingBox();
  const s = await page
    .locator('.document-frame')
    .evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
  return { x: b.x + x * s, y: b.y + y * s };
}
// Creates a text box at page point (x, y), types into it and returns its card.
async function addText(f, x, y, text) {
  const cards = f.getByRole('group', { name: '页面文本注释', exact: true });
  const before = await cards.count();
  await page.getByLabel('文本注释', { exact: true }).click();
  const p = await framePoint(x, y);
  await page.mouse.click(p.x, p.y);
  await waitFor(async () => (await cards.count()) === before + 1, 'text box created');
  const card = cards.nth(before);
  await card.getByLabel('文本注释内容', { exact: true }).fill(text);
  return card;
}
const width = (card) => card.evaluate((e) => e.getBoundingClientRect().width);
try {
  let f = await start();
  const first = await addText(f, 80, 200, '第一个');
  assert.equal(await width(first), 160, 'default width');

  // Drag the handle far left: the box stops at the 60px minimum.
  await first.hover();
  const handle = await first.getByLabel('调整文本宽度', { exact: true }).boundingBox();
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 200, from.y, { steps: 10 });
  await page.mouse.up();
  await waitFor(async () => (await width(first)) === 60, 'resized to minimum');

  const second = await addText(f, 80, 420, '第二个');
  assert.equal(await width(second), 60, 'new box reuses last width');

  await stop();
  f = await start();
  const third = await addText(f, 80, 640, '重启后');
  assert.equal(await width(third), 60, 'width remembered after restart');
  assert.deepEqual(consoleErrors, []);
  console.log('TEXT WIDTH E2E PASS');
} catch (error) {
  console.error('TEXT WIDTH E2E FAILED:', error);
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
