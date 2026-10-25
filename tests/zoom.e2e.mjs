import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Browser plugin not available: real Electron wheel/keyboard events in an isolated workspace.
const root = path.resolve('.'),
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-zoom-'));
const workspace = path.join(temp, '缩放测试'),
  evidence = process.env.FOLIO_QA_DIR || '/tmp/folio-zoom-qa';
await fs.mkdir(workspace);
await fs.mkdir(evidence, { recursive: true });
for (const name of ['A.html', 'B.html'])
  await fs.writeFile(
    path.join(workspace, name),
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:40px;font:18px/1.8 system-ui;background:#fafbf8;color:#263a3c}p{margin:25px 0}#draw{height:180px;border:1px dashed #b7c9c2;margin:20px 0}main{max-width:1100px;margin:auto}</style></head><body><main><h1>${name} · 自由缩放阅读</h1><div id="draw"></div>${Array.from({ length: 65 }, (_, i) => `<h2>第${i}节 · 阅读与思考</h2><p id="p${i}">${'按住 Command 滚动鼠标滚轮，可以自由调整文章大小，并让指着的文字保持在附近。'.repeat(4)}</p>`).join('')}</main></body></html>`,
  );
let app, page;
const errors = [];
async function wait(fn, label) {
  for (let i = 0; i < 110; i++) {
    try {
      if (await fn()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw Error('Timeout: ' + label);
}
async function ready() {
  await wait(async () => (await page.locator('.reader-loading').count()) === 0, 'ready');
}
async function start() {
  app = await electron.launch({
    ...(process.env.FOLIO_TEST_EXECUTABLE
      ? { executablePath: process.env.FOLIO_TEST_EXECUTABLE, args: [] }
      : { args: [root] }),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: path.join(temp, 'user'),
      FOLIO_WORKSPACE: workspace,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await page.locator('iframe').first().waitFor();
  await ready();
}
async function frame(side = 'left') {
  const url = await page.locator(`[data-pane=${side}] iframe`).getAttribute('src');
  const f = page.frames().find((f) => f.url() === url);
  assert.ok(f);
  await f.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  return f;
}
async function scale(side = 'left') {
  return page
    .locator(`[data-pane=${side}] iframe`)
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
}
async function data(name) {
  const i = JSON.parse(await fs.readFile(path.join(workspace, '.html-reader/workspace.json')));
  return JSON.parse(
    await fs.readFile(path.join(workspace, '.html-reader/documents', i.files[name].id + '.json')),
  );
}
async function point(side = 'left') {
  const b = await page.locator(`[data-pane=${side}] iframe`).boundingBox();
  return { x: b.x + b.width * 0.48, y: b.y + Math.min(270, b.height * 0.45) };
}
async function wheel(delta, side = 'left', cmd = true, at) {
  const p = at || (await point(side));
  await page.mouse.move(p.x, p.y);
  if (cmd) await page.keyboard.down('ControlOrMeta');
  await page.mouse.wheel(0, delta);
  if (cmd) await page.keyboard.up('ControlOrMeta');
}
async function setZoom(value) {
  await page.getByLabel('阅读缩放', { exact: true }).selectOption(String(value));
  await wait(
    async () => (await page.getByLabel('阅读缩放', { exact: true }).inputValue()) === String(value),
    'preset',
  );
  await page.waitForTimeout(120);
}
async function anchor(side) {
  const f = await frame(side),
    p = await point(side),
    s = await scale(side),
    b = await page.locator(`[data-pane=${side}] iframe`).boundingBox();
  await f.evaluate(
    ({ x, y }) => {
      const r = document.caretRangeFromPoint(x, y);
      if (r && r.startContainer.nodeType === Node.TEXT_NODE) {
        const node = r.startContainer,
          start = Math.min(r.startOffset, node.length - 1);
        r.setStart(node, start);
        r.setEnd(node, start + 1);
        window.qaZoomAnchor = r;
      }
    },
    { x: (p.x - b.x) / s, y: (p.y - b.y) / s },
  );
  return f;
}
async function anchorScreen(f, side) {
  const b = await page.locator(`[data-pane=${side}] iframe`).boundingBox(),
    s = await scale(side);
  const r = await f.evaluate(() => window.qaZoomAnchor.getBoundingClientRect().toJSON());
  return { x: b.x + (r.left + r.width / 2) * s, y: b.y + (r.top + r.height / 2) * s };
}
try {
  await start();
  assert.equal(await page.title(), '页间 · Folio');
  assert.equal(page.url(), 'app://ui/index.html');
  await page.getByLabel('收起侧栏', { exact: true }).click();
  // Measure the toolbar once the panel has slid away.
  await page.locator('.inspector').waitFor({ state: 'hidden' });
  let f = await frame();
  await f.evaluate(() => scrollTo(0, 1600));
  await page.waitForTimeout(180);
  const toolbarWidth = await page
    .locator('.reader-toolbar')
    .evaluate((el) => el.getBoundingClientRect().width);
  let initialScroll = await f.evaluate(() => scrollY);
  await wheel(220, 'left', false);
  await wait(
    async () => (await f.evaluate(() => scrollY)) > initialScroll + 60,
    'plain wheel scrolls',
  );
  assert.equal(await scale(), 1);
  // Put a specific character under the cursor, then verify it survives responsive reflow.
  const p = await f.locator('#p4').evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await f.evaluate((y) => scrollTo(0, y - 200), p);
  await page.waitForTimeout(180);
  f = await anchor('left');
  const before = await anchorScreen(f, 'left');
  // Use the actual character center: changing the reader width can put the
  // arbitrary sampling point in line spacing, where element anchoring is correct.
  await wheel(-65, 'left', true, before);
  await wait(async () => (await scale()) > 1.1, 'Cmd wheel enlarges');
  await page.waitForTimeout(180);
  const bigger = await scale();
  const after = await anchorScreen(f, 'left');
  assert.ok(Math.abs(after.y - before.y) < 8, `text anchor vertical drift ${after.y - before.y}`);
  // Responsive HTML wraps words to different horizontal positions. Preserve
  // the anchored reading line and ensure the character remains visible.
  const viewport = await page.locator('[data-pane=left] iframe').boundingBox();
  assert.ok(after.x >= viewport.x && after.x <= viewport.x + viewport.width);

  assert.equal(
    await page.locator('.reader-toolbar').evaluate((el) => el.getBoundingClientRect().width),
    toolbarWidth,
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
    1,
  );
  const display = await page
    .getByLabel('阅读缩放', { exact: true })
    .locator('option:checked')
    .textContent();
  assert.ok(display.endsWith('%'));
  assert.equal(Number.parseFloat(display), Math.round(bigger * 1000) / 10);
  await wheel(45);
  await wait(async () => (await scale()) < bigger, 'Cmd wheel shrinks');
  await wait(async () => (await data('A.html')).zoom === (await scale()), 'custom zoom persisted');
  console.log(
    'PASS: Cmd+native wheel continuously zooms with a stable text anchor, plain wheel scrolls, percentage matches, app chrome stays unchanged',
  );
  await setZoom(1);
  const dragSource = await page.locator('.tree-row[data-file-path="B.html"]').boundingBox();
  const dragTarget = await page.locator('.document-workbench').boundingBox();
  await page.mouse.move(dragSource.x + 65, dragSource.y + dragSource.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragSource.x + 95, dragSource.y + dragSource.height / 2 + 5, { steps: 5 });
  await page.mouse.move(dragTarget.x + dragTarget.width * 0.8, dragTarget.y + 180, { steps: 22 });
  await page.mouse.move(dragTarget.x + dragTarget.width * 0.8 + 1, dragTarget.y + 181);
  await page.locator('.reading-drop-preview.hovered').waitFor();
  await page.mouse.up();
  await ready();
  await wait(async () => (await page.locator('iframe').count()) === 2, 'split');
  const left = await frame('left'),
    right = await frame('right');
  await left.evaluate(() => scrollTo(0, 2000));
  await right.evaluate(() => scrollTo(0, 2500));
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '激活左栏', exact: true }).click();
  const leftScroll = await left.evaluate(() => scrollY),
    leftZoom = await scale('left');
  await wheel(-75, 'right');
  await wait(async () => (await scale('right')) > 1.1, 'hovered inactive pane zooms');
  assert.equal(await page.locator('.active-column').getAttribute('data-pane'), 'right');
  assert.equal(await scale('left'), leftZoom);
  assert.equal(await left.evaluate(() => scrollY), leftScroll);
  // Ordinary wheel still scrolls immediately after releasing Command.
  initialScroll = await right.evaluate(() => scrollY);
  const rightZoom = await scale('right');
  await wheel(180, 'right', false);
  await wait(
    async () => (await right.evaluate(() => scrollY)) > initialScroll + 20,
    'release Command scrolls',
  );
  assert.equal(await scale('right'), rightZoom);
  // High-frequency input is accumulated while the iframe applies the prior zoom.
  const pos = await point('right');
  await page.mouse.move(pos.x, pos.y);
  await page.keyboard.down('ControlOrMeta');
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -8);
  await page.keyboard.up('ControlOrMeta');
  await wait(async () => (await scale('right')) > rightZoom * 1.15, 'trackpad-sized burst');
  await page.waitForTimeout(220);
  await setZoom(4);
  await wheel(-100, 'right');
  await page.waitForTimeout(200);
  assert.equal(await scale('right'), 4);
  await wheel(60, 'right');
  await wait(async () => (await scale('right')) < 4, 'leave upper bound');
  await setZoom(0.25);
  await wheel(100, 'right');
  await page.waitForTimeout(180);
  assert.equal(await scale('right'), 0.25);
  await wheel(-65, 'right');
  await wait(async () => (await scale('right')) > 0.25, 'leave lower bound');
  await setZoom(0);
  assert.equal(await scale('right'), 1);
  assert.equal(
    await page.getByLabel('阅读缩放', { exact: true }).locator('option:checked').textContent(),
    '适合宽度',
  );
  console.log(
    'PASS: zoom targets the hovered pane, independent scroll, rapid small wheel deltas, both bounds, fit-width reset',
  );
  // Draw after zoom: the pointer still maps to the document and saved annotation coordinates.
  await right.evaluate(() => scrollTo(0, 0));
  await page.getByLabel('画笔', { exact: true }).click();
  await wheel(-70, 'right');
  await wait(async () => (await scale('right')) > 1.1, 'pen-mode zoom');
  await page.waitForTimeout(150);
  const rb = await page.locator('[data-pane=right] iframe').boundingBox(),
    rs = await scale('right'),
    dr = await right.locator('#draw').evaluate((el) => el.getBoundingClientRect().toJSON());
  await page.mouse.move(rb.x + (dr.x + 20) * rs, rb.y + (dr.y + 40) * rs);
  await page.mouse.down();
  await page.mouse.move(rb.x + (dr.x + 170) * rs, rb.y + (dr.y + 65) * rs, { steps: 12 });
  await page.mouse.up();
  await wait(
    async () => (await data('B.html')).annotations.some((a) => a.type === 'pen'),
    'drawing after zoom',
  );
  const annotations = (await data('B.html')).annotations;
  assert.equal(await right.locator('[data-selection-outline]').count(), 0);
  await page.screenshot({ path: path.join(evidence, 'split-zoom.png') });
  // Quit while a final wheel zoom can still be in the deferred-save window.
  await wheel(-32, 'right');
  await wait(async () => (await scale('right')) > rs, 'final zoom committed to view');
  const savedRight = await scale('right');
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await closed;
  assert.equal((await data('B.html')).zoom, savedRight);
  assert.deepEqual((await data('B.html')).annotations, annotations);
  await start();
  await ready();
  await wait(async () => (await page.locator('iframe').count()) === 2, 'split restored');
  assert.equal(await scale('right'), savedRight);
  assert.equal(await scale('left'), leftZoom);
  assert.deepEqual((await data('B.html')).annotations, annotations);
  // A fast cached iframe may announce readiness before the host subscribes.
  // Drop the first announcement from each frame to exercise the load handshake.
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const announced = new Set();
    window.addEventListener(
      'message',
      (e) => {
        if (
          e.data?.channel === 'folio-reader-v1' &&
          e.data.type === 'ready' &&
          !announced.has(e.source)
        ) {
          announced.add(e.source);
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  });
  await page.reload();
  await page.locator('iframe').first().waitFor();
  await ready();
  await wait(async () => (await page.locator('iframe').count()) === 2, 'split after missed ready');
  assert.equal(await scale('right'), savedRight);
  assert.equal(await scale('left'), leftZoom);
  const restored = await frame('right');
  await restored
    .locator(`[data-annotation-id="${annotations[0].id}"]`)
    .first()
    .waitFor({ state: 'attached' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: drawing and cursor coordinates after zoom, deferred-save quit/restart restores each pane, annotations preserved, no page errors',
  );
} catch (e) {
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  console.error('QA files:', temp, e);
  await app?.evaluate(({ app }) => app.exit(1)).catch(() => {});
  throw e;
} finally {
  await app?.close().catch(() => {});
}
