// The interface's own font and size (设置 › 外观与阅读), in the real Electron app: the size
// zooms the interface but not the document, a font from the computer replaces the theme's,
// both are kept after a restart, and one click brings the defaults back.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ui-type-'));
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-ui-type-qa');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(
  path.join(project, '01_文档.html'),
  '<!doctype html><html><head><meta charset="utf-8"><style>h1{font:40px/1.2 Georgia,serif;margin:20px}</style></head><body><h1>文档标题</h1><p>一段文字。</p></body></html>',
);

let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_MEMBER: '1',
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.document-frame');
}
async function waitFor(fn, label, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
const zoomFactor = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
const bodyFont = () => page.evaluate(() => getComputedStyle(document.body).fontFamily);
const heading = () => page.frameLocator('.document-frame').locator('h1');
// How tall the document's heading shows, in the window's own pixels: its height in the
// document, times the frame's scale, times the window's zoom. (Its width follows the reading
// column, which a bigger interface leaves narrower.)
async function headingOnScreen() {
  const height = await heading().evaluate((e) => e.getBoundingClientRect().height);
  const scale = await page
    .locator('.document-frame')
    .evaluate((f) => f.getBoundingClientRect().height / f.clientHeight);
  return height * scale * (await zoomFactor());
}
const settings = () => page.getByRole('dialog', { name: '设置', exact: true });
async function openSettings() {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await settings().getByRole('heading', { name: '外观与阅读', exact: true }).waitFor();
}
try {
  await launch();
  await heading().waitFor();
  assert.equal(await zoomFactor(), 1);
  const themeFont = await bodyFont();
  const before = await headingOnScreen();

  // A bigger interface; the document stays the size it was.
  await openSettings();
  await settings().getByLabel('界面大小').selectOption('1.25');
  await waitFor(async () => (await zoomFactor()) === 1.25, 'window zoomed');
  await waitFor(
    async () => Math.abs((await headingOnScreen()) - before) < 1,
    'document keeps its size',
  );

  // A font from this computer.
  await settings().getByRole('button', { name: '界面字体' }).click();
  const fonts = settings().getByRole('listbox', { name: '这台电脑上的字体' });
  await settings().getByLabel('搜索字体').fill('Courier New');
  await fonts.getByRole('option', { name: 'Courier New' }).first().click();
  await waitFor(async () => (await bodyFont()).startsWith('"Courier New"'), 'interface font');
  // The list stays open while used, and closes on a click anywhere else.
  await settings().getByLabel('搜索字体').click();
  assert.ok(await fonts.isVisible());
  await settings().getByRole('heading', { name: '外观与阅读', exact: true }).click();
  await fonts.waitFor({ state: 'hidden' });
  assert.equal(
    await heading().evaluate((e) => getComputedStyle(e).fontFamily),
    'Georgia, serif',
    "the document's own font stays",
  );
  // The window as it shows: Playwright's own screenshot crops a zoomed window.
  const shot = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
  );
  await fs.writeFile(path.join(evidence, 'ui-type-settings.png'), Buffer.from(shot, 'base64'));

  // Kept after a restart.
  await app.close();
  await launch();
  assert.equal(await zoomFactor(), 1.25);
  await waitFor(async () => (await bodyFont()).startsWith('"Courier New"'), 'font kept');
  await heading().waitFor();
  await waitFor(
    async () => Math.abs((await headingOnScreen()) - before) < 1,
    'document size kept after restart',
  );

  // Back to the defaults.
  await openSettings();
  await settings().getByRole('button', { name: '恢复默认字体和大小' }).click();
  await waitFor(async () => (await zoomFactor()) === 1, 'zoom back to 100%');
  assert.equal(await bodyFont(), themeFont);
  assert.deepEqual(errors, []);
  console.log('PASS: interface font and size apply, leave the document alone, and are kept');
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
