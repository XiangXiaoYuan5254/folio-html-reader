// Browser plugin not available in this task: use the real Electron app with
// native input and isolated copies. No personal PDF is committed to the repo.
import { _electron as electron } from 'playwright';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pdf-qa-'));
const workspace = path.join(temp, '阅读项目');
const evidence = process.env.FOLIO_QA_DIR || '/tmp/folio-pdf-qa';
await fs.mkdir(workspace);
await fs.mkdir(evidence, { recursive: true });
const fixture = await PDFDocument.create();
const font = await fixture.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 3; i++) {
  const p = fixture.addPage(i === 1 ? [500, 700] : [600, 800]);
  if (i === 1) p.setRotation(degrees(90));
  if (i < 2) {
    p.drawText(`PDF reading page ${i + 1}`, { x: 65, y: 710 - i * 100, size: 25, font });
    p.drawText('Select this sentence to highlight and take notes.', {
      x: 65,
      y: 650 - i * 100,
      size: 17,
      font,
    });
    p.drawText('A second line keeps its original page geometry.', {
      x: 65,
      y: 610 - i * 100,
      size: 17,
      font,
    });
  } else p.drawRectangle({ x: 65, y: 540, width: 400, height: 120, color: rgb(0.88, 0.93, 0.95) });
}
const original = Buffer.from(await fixture.save());
await fs.writeFile(path.join(workspace, '00_PDF.pdf'), original);
await fs.writeFile(
  path.join(workspace, '对照.html'),
  '<!doctype html><html><meta charset="utf-8"><body style="padding:35px;font:20px/1.8 system-ui"><h1>HTML 与 PDF 双栏阅读</h1><p>两篇文档独立缩放、批注和保存。</p></body></html>',
);
await fs.writeFile(path.join(workspace, '损坏.pdf'), 'Not a PDF');
await fs.copyFile(path.join(root, 'tests/fixtures/password.pdf'), path.join(workspace, '加密.pdf'));
if (process.env.FOLIO_TEST_PDF)
  await fs.copyFile(process.env.FOLIO_TEST_PDF, path.join(workspace, '真实资料.pdf'));
let app, page;
const errors = [];
const warnings = [];
async function wait(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error('Timeout: ' + label);
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
  page.setDefaultTimeout(18000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.locator('iframe').first().waitFor();
}
async function frame(side = 'left') {
  const iframe = page.locator(`[data-pane=${side}] iframe`);
  const src = await iframe.getAttribute('src');
  await wait(() => page.frames().some((f) => f.url() === src), 'frame navigation');
  return page.frames().find((f) => f.url() === src);
}
async function ready(side = 'left') {
  const f = await frame(side);
  await f.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  await f.locator('.pdf-page[data-rendered=true]').first().waitFor();
  return f;
}
async function data(name = '00_PDF.pdf') {
  const index = JSON.parse(await fs.readFile(path.join(workspace, '.html-reader/workspace.json')));
  return JSON.parse(
    await fs.readFile(
      path.join(workspace, '.html-reader/documents', index.files[name].id + '.json'),
    ),
  );
}
async function point(f, x, y, side = 'left', pageNo = 1) {
  const rect = await f
    .locator(`#pdf-page-${pageNo}`)
    .evaluate((e) => e.getBoundingClientRect().toJSON());
  const iframe = page.locator(`[data-pane=${side}] iframe`),
    b = await iframe.boundingBox();
  const scale = await iframe.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
  return { x: b.x + (rect.left + x) * scale, y: b.y + (rect.top + y) * scale };
}
async function clickIn(locator) {
  const rect = await locator.evaluate((e) => e.getBoundingClientRect().toJSON());
  const iframe = page.locator('[data-pane=left] iframe'),
    b = await iframe.boundingBox();
  const scale = await iframe.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
  await page.mouse.click(
    b.x + (rect.left + rect.width / 2) * scale,
    b.y + (rect.top + rect.height / 2) * scale,
  );
}
async function stroke(a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 18 });
  await page.mouse.up();
}
async function open(name) {
  await page.locator('.tree-item').filter({ hasText: name }).click();
  await wait(
    async () =>
      (await page.locator('[data-pane=left] iframe').getAttribute('src')).includes(
        encodeURIComponent(name),
      ),
    'open ' + name,
  );
  return frame();
}
async function pageNumber(n, side = 'left') {
  const input = page.locator(`[data-pane=${side}]`).getByLabel('PDF 页码', { exact: true });
  await input.fill(String(n));
  await input.press('Enter');
  await wait(async () => (await input.inputValue()) === String(n), 'page number');
}
try {
  await start();
  let f = await ready();
  assert.equal(await page.title(), '页间 · Folio');
  assert.equal(await f.locator('.pdf-page').count(), 3);
  assert.ok(await page.getByRole('button', { name: '源码', exact: true }).isDisabled());
  const isolation = await f.evaluate(() => {
    let blocked = false;
    try {
      void parent.document.body;
    } catch {
      blocked = true;
    }
    return { blocked, bridge: typeof window.folio };
  });
  assert.deepEqual(isolation, { blocked: true, bridge: 'undefined' });
  await page.getByLabel('收起批注栏', { exact: true }).click();
  await page.waitForTimeout(200);
  const text = f.locator('.textLayer span').filter({ hasText: 'Select this sentence' }).first();
  await text.waitFor();
  const rb = await text.evaluate((e) => e.getBoundingClientRect().toJSON());
  const ibox = await page.locator('[data-pane=left] iframe').boundingBox();
  const rs = await page
    .locator('[data-pane=left] iframe')
    .evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
  await stroke(
    { x: ibox.x + (rb.left + 1) * rs, y: ibox.y + (rb.top + rb.height / 2) * rs },
    { x: ibox.x + (rb.right - 1) * rs, y: ibox.y + (rb.top + rb.height / 2) * rs },
  );
  await page.locator('.selection-toolbar').waitFor();
  await page
    .locator('.selection-toolbar')
    .getByRole('button', { name: '高亮', exact: true })
    .click();
  await wait(
    async () => (await data()).annotations.some((a) => a.type === 'highlight'),
    'PDF highlight',
  );
  const highlight = (await data()).annotations.find((a) => a.type === 'highlight');
  assert.ok(highlight.quote.pdfRects.length && highlight.quote.pdfRects.every((r) => r.page === 1));
  assert.equal(await page.locator('.inspector').isVisible(), false);
  assert.equal(
    await f.getByRole('group', { name: '批注笔记编辑', exact: true }).isVisible(),
    false,
  );
  const h = highlight.quote.pdfRects[0];
  const hp = await point(f, h.left + h.width / 2, h.top + h.height / 2);
  await page.mouse.click(hp.x, hp.y);
  await clickIn(f.getByRole('button', { name: '添加笔记', exact: true }));
  await f.getByLabel('批注笔记内容').fill('PDF 原文高亮笔记');
  await clickIn(f.getByRole('button', { name: '完成笔记', exact: true }));
  await wait(
    async () => (await data()).annotations.find((a) => a.id === highlight.id).note.includes('PDF'),
    'highlight note',
  );
  await page.getByLabel('画笔', { exact: true }).click();
  await stroke(await point(f, 80, 300), await point(f, 350, 340));
  await wait(async () => (await data()).annotations.some((a) => a.type === 'pen'), 'PDF pen');
  const pen = (await data()).annotations.find((a) => a.type === 'pen');
  assert.equal(pen.anchor.selector, '#pdf-page-1');
  assert.equal(await f.locator('[data-selection-outline]').count(), 0);
  await page.getByLabel('橡皮擦', { exact: true }).click();
  await stroke(await point(f, 210, 290), await point(f, 210, 360));
  await wait(
    async () => (await data()).annotations.find((a) => a.id === pen.id)?.paths?.length === 2,
    'partial PDF eraser',
  );
  await page.getByLabel('撤销批注', { exact: true }).click();
  await wait(
    async () => !(await data()).annotations.find((a) => a.id === pen.id)?.paths,
    'PDF eraser undo',
  );
  await page.getByLabel('笔触与橡皮擦大小', { exact: true }).click();
  await page.getByRole('radio', { name: '笔画擦除', exact: true }).click();
  await stroke(await point(f, 210, 290), await point(f, 210, 360));
  await wait(
    async () => !(await data()).annotations.some((a) => a.id === pen.id),
    'whole PDF eraser',
  );
  await page.getByLabel('撤销批注', { exact: true }).click();
  await page.getByLabel('便签', { exact: true }).click();
  const sp = await point(f, 90, 390);
  await page.mouse.click(sp.x, sp.y);
  await f.getByLabel('页面便签内容').fill('PDF 页面便签，缩放后位置仍在原页。');
  await page.keyboard.press('Tab');
  await page.getByLabel('文本注释', { exact: true }).click();
  const tp = await point(f, 450, 390);
  await page.mouse.click(tp.x, tp.y);
  await f.getByLabel('文本注释内容').fill('页面文字');
  await page.keyboard.press('Escape');
  await wait(async () => (await data()).annotations.length === 4, 'all PDF annotation types');
  await page.getByLabel('阅读缩放', { exact: true }).selectOption('1.5');
  await page.waitForTimeout(400);
  const mark = await f
    .locator(`rect[data-annotation-id="${highlight.id}"]`)
    .first()
    .evaluate((e) => e.getBoundingClientRect().toJSON());
  const pageRect = await f
    .locator('#pdf-page-1')
    .evaluate((e) => e.getBoundingClientRect().toJSON());
  assert.ok(
    Math.abs(mark.left - pageRect.left - h.left) < 1 &&
      Math.abs(mark.top - pageRect.top - h.top) < 1,
    'highlight stays at page-local coordinates',
  );
  await page.getByLabel('阅读缩放', { exact: true }).selectOption('0');
  await pageNumber(2);
  await wait(
    async () => (await f.locator('#pdf-page-2').getAttribute('data-rendered')) === 'true',
    'rotated page',
  );
  const secondSize = await f
    .locator('#pdf-page-2')
    .evaluate((e) => ({ w: e.offsetWidth, h: e.offsetHeight }));
  assert.ok(secondSize.w > secondSize.h, 'rotation is respected');
  const rotatedText = await f
    .locator('#pdf-page-2 .textLayer span')
    .first()
    .evaluate((e) => e.getBoundingClientRect().toJSON());
  assert.ok(rotatedText.height > rotatedText.width, 'text layer rotates together with page pixels');
  await pageNumber(3);
  await page.waitForTimeout(250);
  await wait(
    async () => (await page.locator('.pdf-page-hint').getAttribute('title')).includes('无可选文字'),
    'image-only/blank-page guidance',
  );
  await page.getByLabel('便签', { exact: true }).click();
  const np = await point(f, 90, 95, 'left', 3);
  await page.mouse.click(np.x, np.y);
  await f.getByLabel('页面便签内容').last().fill('无文字页面也能批注');
  await page.keyboard.press('Escape');
  await pageNumber(1);
  await page.getByLabel('显示或隐藏批注栏', { exact: true }).click();
  await page.locator(`[data-annotation="${highlight.id}"] .annotation-quote`).click();
  await f.locator('[data-selection-outline]').waitFor();
  await page.screenshot({ path: path.join(evidence, 'pdf-annotations.png') });
  console.log(
    'PASS: PDF rendering/text selection, page-local highlight notes, pen, both erasers, sticky/text, page jump, rotation, blank pages, locator and source protection',
  );
  await page.getByLabel('收起批注栏', { exact: true }).click();
  await page.getByLabel('选择文字', { exact: true }).click();
  await f.evaluate(() => {
    const start = document.querySelector('#pdf-page-1 .textLayer span').firstChild;
    const end = [...document.querySelectorAll('#pdf-page-2 .textLayer span')].at(-1).firstChild;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page
    .locator('.selection-toolbar')
    .getByRole('button', { name: '高亮', exact: true })
    .click();
  await wait(async () => (await data()).annotations.length === 6, 'cross-page highlight');
  const cross = (await data()).annotations.at(-1).quote.pdfRects;
  assert.deepEqual([...new Set(cross.map((r) => r.page))], [1, 2]);
  assert.ok(
    cross.every((r) => Math.min(r.width, r.height) < 60),
    'cross-page highlights cover text, not container boxes',
  );
  await page.getByLabel('撤销批注', { exact: true }).click();
  await page.getByLabel('查找文内文字', { exact: true }).click();
  await page.getByLabel('查找文内文字输入', { exact: true }).fill('PDF reading page 2');
  await page.getByLabel('查找文内文字输入', { exact: true }).press('Enter');
  await wait(
    async () => (await f.evaluate(() => getSelection()?.toString())).includes('PDF reading page 2'),
    'off-screen PDF text search',
  );
  await page.getByLabel('关闭查找', { exact: true }).click();
  await pageNumber(1);
  console.log('PASS: cross-page text geometry and off-screen text search');
  const src = await page.locator('.tree-row[data-file-path="对照.html"]').boundingBox();
  const dest = await page.locator('.document-workbench').boundingBox();
  await page.mouse.move(src.x + 65, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 95, src.y + src.height / 2 + 5, { steps: 5 });
  await page.mouse.move(dest.x + dest.width * 0.8, dest.y + 180, { steps: 22 });
  await page.mouse.move(dest.x + dest.width * 0.8 + 1, dest.y + 181);
  await page.locator('.reading-drop-preview.hovered').waitFor();
  await page.mouse.up();
  await wait(async () => (await page.locator('iframe').count()) === 2, 'mixed split');
  const html = await frame('right');
  await html.locator('h1').waitFor();
  assert.equal(await html.locator('h1').innerText(), 'HTML 与 PDF 双栏阅读');
  const ib = await page.locator('[data-pane=left] iframe').boundingBox();
  await page.mouse.move(ib.x + 130, ib.y + 200);
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('ControlOrMeta');
  await wait(async () => (await data()).zoom > 0, 'PDF wheel zoom');
  const savedZoom = (await data()).zoom;
  await page.screenshot({ path: path.join(evidence, 'pdf-html-split.png') });
  const snapshot = (await data()).annotations;
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await closed;
  await start();
  f = await ready();
  await wait(async () => (await page.locator('iframe').count()) === 2, 'restored PDF/HTML split');
  assert.deepEqual((await data()).annotations, snapshot);
  assert.equal((await data()).zoom, savedZoom);
  assert.deepEqual(await fs.readFile(path.join(workspace, '00_PDF.pdf')), original);
  await page.getByRole('button', { name: '退出双栏', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(evidence, 'pdf-narrow.png') });
  console.log(
    'PASS: PDF/HTML drag-to-split, Cmd+wheel, restart restores annotations/scale and original PDF bytes unchanged, 900px window',
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  f = await open('加密.pdf');
  await f.getByLabel('PDF 密码').fill('incorrect');
  await f.getByRole('button', { name: '打开 PDF', exact: true }).click();
  await f.getByText('密码不正确，请重新输入。').waitFor();
  await f.getByLabel('PDF 密码').fill('folio-test');
  await f.getByRole('button', { name: '打开 PDF', exact: true }).click();
  await ready();
  f = await open('损坏.pdf');
  await f.getByText('无法打开此 PDF', { exact: false }).waitFor();
  if (process.env.FOLIO_TEST_PDF) {
    f = await open('真实资料.pdf');
    await ready();
    await f.locator('.textLayer span').first().waitFor();
    await page.waitForTimeout(200);
    const line = await f.locator('#pdf-page-1 .textLayer span').evaluateAll((spans) => {
      const e = spans.find((s) => {
        const r = s.getBoundingClientRect();
        return r.width > 100 && r.height < 70 && r.top > 0 && r.bottom < innerHeight;
      });
      return e?.getBoundingClientRect().toJSON();
    });
    assert.ok(line, 'real PDF has a visible selectable text line');
    const iframe = page.locator('[data-pane=left] iframe'),
      box = await iframe.boundingBox();
    const scale = await iframe.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
    await stroke(
      { x: box.x + (line.left + 3) * scale, y: box.y + (line.top + line.height / 2) * scale },
      { x: box.x + (line.right - 3) * scale, y: box.y + (line.top + line.height / 2) * scale },
    );
    await page
      .locator('.selection-toolbar')
      .getByRole('button', { name: '高亮', exact: true })
      .click();
    await wait(
      async () => (await data('真实资料.pdf')).annotations.length === 1,
      'real PDF native selection to saved highlight',
    );
    await page.screenshot({ path: path.join(evidence, 'real-pdf.png') });
    const count = await f.locator('.pdf-page').count();
    await pageNumber(count);
    await f.locator(`#pdf-page-${count}[data-rendered=true]`).waitFor();
    assert.ok(
      (await f.locator('.pdf-canvas canvas').count()) <= 6,
      'distant pages render with a bounded canvas cache',
    );
    console.log(
      'PASS: user-provided PDF rendered from an isolated copy:',
      await f.locator('.pdf-page').count(),
      'pages',
    );
  }
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some((m) => m.includes('fake worker')), 'PDF decoding uses a real worker');
  console.log('PASS: password/retry, malformed file error, no app errors, real PDF worker');
} catch (e) {
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  console.error('PDF QA:', temp, e, { errors, warnings });
  throw e;
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
