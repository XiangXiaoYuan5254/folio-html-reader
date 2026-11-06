// End-to-end test of the packaged Windows app, run on a Windows machine (see
// .github/workflows/windows.yml). FOLIO_EXE points at the installed Folio.exe;
// desktop screenshots, which include the native caption buttons, go to FOLIO_EVIDENCE.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows only');
  process.exit(0);
}
const exe = process.env.FOLIO_EXE || path.resolve('release/win-unpacked/Folio.exe');
const evidence = process.env.FOLIO_EVIDENCE || path.join(os.tmpdir(), 'folio-windows-evidence');
await fs.mkdir(evidence, { recursive: true });
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-win-')));
const userData = path.join(temp, 'user data');
const project = path.join(temp, '阅读 项目');
const elsewhere = path.join(temp, '别处');
const incoming = path.join(temp, '待导入');
const page = (title, body = '') =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title><link rel="stylesheet" href="样式/主题.css"></head><body><h1>${title}</h1><p id="text">页间在 Windows 上阅读本地网页，这一段文字用来测试高亮批注。</p>${body}</body></html>`;
await fs.mkdir(path.join(project, '章节', '样式'), { recursive: true });
await fs.mkdir(elsewhere, { recursive: true });
await fs.mkdir(path.join(incoming, '资料 夹'), { recursive: true });
await fs.writeFile(path.join(project, '首页.html'), page('首页'));
await fs.writeFile(path.join(project, '章节', '第二章.html'), page('第二章'));
await fs.writeFile(path.join(project, '章节', '样式', '主题.css'), 'h1{color:rgb(40, 123, 113)}');
await fs.writeFile(path.join(elsewhere, '外部 文章.html'), page('外部文章'));
await fs.writeFile(path.join(incoming, '粘贴一.html'), page('粘贴一'));
await fs.writeFile(path.join(incoming, '资料 夹', '内页.html'), page('内页'));

const execFileP = promisify(execFile);
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const powershell = (script) =>
  execFileP('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]);
// Playwright only captures the page; the caption buttons are native, so shoot the desktop.
const desktopShot = (name) =>
  powershell(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save(${quote(path.join(evidence, name))}, [System.Drawing.Imaging.ImageFormat]::Png)`);
// The color of one screen pixel, as #rrggbb.
async function pixel(x, y) {
  const { stdout } = await powershell(`Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1, 1
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen(${Math.round(x)}, ${Math.round(y)}, 0, 0, $bmp.Size)
$c = $bmp.GetPixel(0, 0)
'#{0:x2}{1:x2}{2:x2}' -f $c.R, $c.G, $c.B`);
  return stdout.trim();
}
// The background of the native minimize button, which the theme colors.
async function captionColor() {
  const b = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds(),
  );
  return pixel(b.x + b.width - 120, b.y + 4);
}
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('Timeout: ' + label);
}

let app, win;
const errors = [];
const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined, FOLIO_USER_DATA: userData };
async function launch(args = []) {
  app = await electron.launch({ executablePath: exe, args, env });
  win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  win.on('pageerror', (e) => errors.push(e.message));
  // Fit the window on the runner's small screen, so the caption buttons are visible.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
}
async function quit() {
  await app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
    .catch(() => {});
  await app.close().catch(() => {});
  app = null;
}
const tree = () => win.getByRole('navigation', { name: '项目文件' });
const activeTab = async () =>
  (await win.locator('[role="tab"][aria-selected="true"]').innerText()).trim();
const heading = () => win.frameLocator('.document-frame').locator('h1').innerText();
async function openFromTree(name) {
  await tree().getByRole('button', { name, exact: true }).click();
  await waitFor(async () => (await activeTab()) === name, `tab ${name}`);
}
// Document coordinates -> window coordinates (the reader frame is CSS-scaled).
async function screenBox(locator) {
  const local = await locator.evaluate((e) => e.getBoundingClientRect().toJSON());
  const frame = win.locator('.document-frame');
  const parent = await frame.boundingBox();
  const scale = await frame.evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
  return {
    x: parent.x + local.x * scale,
    y: parent.y + local.y * scale,
    width: local.width * scale,
    height: local.height * scale,
  };
}
async function annotationFiles(dir) {
  const docs = path.join(dir, '.html-reader', 'documents');
  const names = await fs.readdir(docs).catch(() => []);
  return Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => JSON.parse(await fs.readFile(path.join(docs, n), 'utf8'))),
  );
}

try {
  // First launch: the bundled samples are copied into the user's data folder.
  await launch();
  await waitFor(
    async () => (await tree().innerText()).includes('01_欢迎使用页间.html'),
    'sample project',
  );
  const samples = path.join(userData, '示例文档');
  assert.ok((await fs.readdir(samples)).includes('01_欢迎使用页间.html'));
  console.log('PASS: first launch copies the sample documents');

  // Windows chrome: caption buttons overlay the title bar and the page leaves room for them.
  const ui = await win.evaluate(() => {
    const overlay = navigator.windowControlsOverlay;
    const area = overlay?.getTitlebarAreaRect();
    return {
      platform: document.documentElement.dataset.platform,
      overlay: overlay?.visible,
      areaRight: area ? area.x + area.width : null,
      tabsRight: document.querySelector('.document-tab-row').getBoundingClientRect().right,
      brandLeft: document.querySelector('.brand').getBoundingClientRect().left,
      openKey: document.querySelector('.open-folder kbd')?.textContent,
      font: getComputedStyle(document.body).fontFamily,
    };
  });
  assert.equal(ui.platform, 'win32');
  assert.equal(ui.overlay, true, 'window controls overlay visible');
  assert.ok(
    ui.tabsRight <= ui.areaRight,
    `document tabs clear of caption buttons: ${JSON.stringify(ui)}`,
  );
  assert.ok(ui.brandLeft < 50, 'brand sits on the left on Windows');
  assert.equal(ui.openKey, 'Ctrl+O');
  assert.match(ui.font, /Microsoft YaHei/);
  assert.deepEqual(
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label)),
    ['文件', '编辑', '显示'],
  );
  await desktopShot('01-first-launch.png');
  console.log('PASS: caption buttons, Ctrl labels, Chinese UI font, Windows menu');

  // Reading, a CSS-relative asset, a highlight saved next to the document.
  await openFromTree('02_阅读与批注练习.html');
  await win.frameLocator('.document-frame').locator('h1').first().waitFor();
  await openFromTree('01_欢迎使用页间.html');
  await win.getByLabel('高亮', { exact: true }).click();
  const para = await screenBox(win.frameLocator('.document-frame').locator('p').first());
  await win.mouse.move(para.x + 2, para.y + 8);
  await win.mouse.down();
  await win.mouse.move(para.x + Math.min(para.width - 4, 260), para.y + 8, { steps: 12 });
  await win.mouse.up();
  await waitFor(
    async () => (await annotationFiles(samples)).some((d) => d.annotations.length > 0),
    'highlight saved in .html-reader',
  );
  console.log('PASS: highlight saved next to the document');

  // Ctrl + wheel zooms the document.
  const zoomBefore = await win.getByLabel('阅读缩放').inputValue();
  const frameBox = await win.locator('.document-frame').boundingBox();
  await win.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
  await win.keyboard.down('Control');
  for (let i = 0; i < 4; i++) await win.mouse.wheel(0, -120);
  await win.keyboard.up('Control');
  await waitFor(
    async () => (await win.getByLabel('阅读缩放').inputValue()) !== zoomBefore,
    'Ctrl + wheel zoom',
  );
  console.log('PASS: Ctrl + wheel zooms the document');

  // Opening a file from Explorer while the app runs starts a second instance with the
  // path; it hands the file over and exits.
  const second = spawn(exe, [path.join(elsewhere, '外部 文章.html')], { env });
  const exitCode = await new Promise((resolve) => second.on('exit', resolve));
  assert.equal(exitCode, 0, 'second instance exits');
  await waitFor(async () => (await activeTab()) === '外部 文章.html', 'handed-over file opens');
  await waitFor(async () => (await heading()) === '外部文章', 'handed-over file shown');
  assert.ok(!(await tree().innerText()).includes('01_欢迎使用页间.html'), 'switched project');
  console.log('PASS: "Open with" while running hands the file to the open window');

  // Files copied in Explorer paste into the project, including a folder.
  await powershell(
    `Set-Clipboard -Path ${quote(path.join(incoming, '粘贴一.html'))}, ${quote(path.join(incoming, '资料 夹'))}`,
  );
  // Empty space at the bottom of the tree; the whiteboard shelf sits right under it.
  const treeBox = await win.locator('.file-tree').boundingBox();
  await win.locator('.file-tree').click({ position: { x: 20, y: treeBox.height - 12 } });
  await win.keyboard.press('Control+V');
  await waitFor(
    async () => (await win.locator('.toast').innerText()).includes('已复制 2 个项目'),
    'paste notice',
  );
  assert.ok((await fs.readdir(elsewhere)).includes('粘贴一.html'));
  assert.ok((await fs.readdir(path.join(elsewhere, '资料 夹'))).includes('内页.html'));
  console.log('PASS: files copied in Explorer paste into the project');

  // Text pastes once into a text field (the page and the menu shortcut must not both paste).
  await powershell(`Set-Clipboard -Value ${quote('粘贴文本')}`);
  const search = win.locator('.tree-search input');
  await search.click();
  await win.keyboard.press('Control+V');
  await waitFor(async () => (await search.inputValue()) === '粘贴文本', 'text pasted');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await search.inputValue(), '粘贴文本', 'pasted exactly once');
  await search.fill('');
  console.log('PASS: Ctrl+V pastes text once');

  // Moving a document keeps its notes; the index uses "/" paths.
  const token = (await win.evaluate(() => window.folio.invoke('workspace'))).token;
  await win.evaluate(
    ([token]) => window.folio.invoke('create', { path: '新文件夹', kind: 'folder' }, token),
    [token],
  );
  await win.evaluate(
    ([token]) =>
      window.folio.invoke('move', { from: '粘贴一.html', to: '新文件夹/粘贴一.html' }, token),
    [token],
  );
  await tree().getByRole('button', { name: '新文件夹', exact: true }).waitFor();
  assert.ok((await fs.readdir(path.join(elsewhere, '新文件夹'))).includes('粘贴一.html'));
  const index = JSON.parse(
    await fs.readFile(path.join(elsewhere, '.html-reader', 'workspace.json'), 'utf8'),
  );
  assert.ok(
    Object.keys(index.files).every((k) => !k.includes('\\')),
    `index keys use "/": ${Object.keys(index.files)}`,
  );
  console.log('PASS: create folder and move keep "/" paths in the index');

  // Focus mode goes full screen.
  await openFromTree('外部 文章.html');
  await tree().getByRole('button', { name: '外部 文章.html', exact: true }).focus();
  await win.keyboard.press('Control+Shift+F');
  await waitFor(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
    'full screen',
  );
  await new Promise((r) => setTimeout(r, 800));
  await desktopShot('02-focus-mode.png');
  await win.keyboard.press('Escape');
  await waitFor(
    async () =>
      !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())),
    'leave full screen',
  );
  console.log('PASS: Ctrl+Shift+F focus mode enters and leaves full screen');
  await desktopShot('03-reading.png');

  // Every theme is free to pick. The native caption buttons take the colors the page gives
  // them, so the night theme's dark title bar recolors them.
  assert.equal(await captionColor(), '#ffffff', 'light caption buttons');
  await win.getByLabel('界面主题', { exact: true }).click();
  await win
    .getByRole('dialog', { name: '界面主题' })
    .getByLabel(/^夜读：/)
    .click();
  await waitFor(async () => (await captionColor()) === '#15191f', 'dark caption buttons');
  await win.keyboard.press('Escape');
  await desktopShot('04-dark-theme.png');
  console.log('PASS: picking a dark theme recolors the caption buttons');
  await quit();

  // Double-clicking a file when the app is closed starts it in that file's folder.
  await launch([path.join(project, '章节', '第二章.html')]);
  await waitFor(async () => (await activeTab()) === '第二章.html', 'cold-start file tab');
  await waitFor(async () => (await heading()) === '第二章', 'cold-start file shown');
  assert.equal(
    await win
      .frameLocator('.document-frame')
      .locator('h1')
      .evaluate((e) => getComputedStyle(e).color),
    'rgb(40, 123, 113)',
    'relative stylesheet in a subfolder loads',
  );
  console.log('PASS: opening a file starts the app in its folder, relative CSS loads');
  assert.equal(await captionColor(), '#15191f', 'the night theme after a restart');
  console.log('PASS: the chosen theme comes back after a restart');

  assert.deepEqual(errors, []);
  console.log('WINDOWS E2E PASS');
} catch (error) {
  console.error('WINDOWS E2E FAILED:', error);
  console.error('PAGE ERRORS:', errors);
  if (win) await win.screenshot({ path: path.join(evidence, 'failure-page.png') }).catch(() => {});
  await desktopShot('failure-desktop.png').catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await quit();
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
