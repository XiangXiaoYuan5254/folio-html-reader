import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-tabs-'));
const project = path.join(temp, '标签项目');
const name = (i) => `文档${String(i).padStart(2, '0')}.html`;
await fs.mkdir(path.join(project, '.html-reader'), { recursive: true });
for (let i = 1; i <= 25; i++)
  await fs.writeFile(
    path.join(project, name(i)),
    `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${i}</title></head><body><h1>第 ${i} 篇</h1></body></html>`,
  );
// A session saved before the tab limit existed: 24 tabs, split on two early ones.
const legacy = Array.from({ length: 24 }, (_, i) => name(i + 2));
await fs.writeFile(
  path.join(project, '.html-reader/workspace.json'),
  JSON.stringify({
    version: 1,
    files: {},
    session: { paths: legacy, active: name(3), split: { left: name(2), right: name(3) } },
  }),
);
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
async function tabs() {
  return page.getByRole('tablist', { name: '打开的文档' }).getByRole('tab').allInnerTexts();
}
async function session() {
  const index = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/workspace.json'), 'utf8'),
  );
  return index.session;
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

  // Restoring keeps the active and split documents plus the 18 most recently opened tabs.
  const restored = [name(2), name(3), ...Array.from({ length: 18 }, (_, i) => name(i + 8))];
  await waitFor(async () => (await tabs()).length === 20, 'restored 20 tabs');
  assert.deepEqual(
    (await tabs()).map((t) => t.trim()),
    restored,
  );
  await waitFor(async () => (await session()).paths.length === 20, 'trimmed session saved');

  // 文档08 is viewed again, so the next tab to close is 文档09. 文档02 is the least
  // recently viewed, but it stays because the left split pane shows it.
  await page.getByRole('tab', { name: name(8), exact: true }).click();
  await page
    .getByRole('navigation', { name: '项目文件' })
    .getByRole('button', { name: name(1), exact: true })
    .click();
  await waitFor(async () => (await tabs()).map((t) => t.trim()).includes(name(1)), 'opened 01');
  const after = (await tabs()).map((t) => t.trim());
  assert.equal(after.length, 20);
  assert.ok(!after.includes(name(9)), '文档09 should be closed');
  for (const kept of [name(1), name(2), name(3), name(8)]) assert.ok(after.includes(kept), kept);
  await waitFor(
    async () => JSON.stringify((await session()).paths) === JSON.stringify(after),
    'session saved after eviction',
  );
  assert.equal(await page.getByRole('alert').count(), 0, 'no error toast');
  assert.deepEqual(consoleErrors, []);
  console.log('TABS E2E PASS');
} catch (error) {
  console.error('TABS E2E FAILED:', error);
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
