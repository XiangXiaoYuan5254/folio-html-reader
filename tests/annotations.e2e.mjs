import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-interactions-'));
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
    ...(process.env.FOLIO_TEST_EXECUTABLE
      ? { executablePath: process.env.FOLIO_TEST_EXECUTABLE, args: [] }
      : { args: [root] }),
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
  if (label === '画笔')
    await f.evaluate(() => {
      window.penCursorSamples = [];
      window.samplePenCursor = true;
      const sample = () => {
        window.penCursorSamples.push({
          extraDot:
            getComputedStyle(document.querySelector('[data-folio-cursor]')).display !== 'none',
          native: getComputedStyle(document.querySelector('[data-folio-ui=overlay]')).cursor,
        });
        if (window.samplePenCursor) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(
      box.x + from[0] + ((to[0] - from[0]) * i) / 10,
      box.y + from[1] + ((to[1] - from[1]) * i) / 10,
    );
  await page.mouse.up();
  await noLocator(f, 'completed stroke does not enable sidebar locator');
  if (label === '画笔') {
    const samples = await f.evaluate(() => {
      window.samplePenCursor = false;
      return window.penCursorSamples;
    });
    assert.ok(samples.length > 0);
    assert.ok(
      samples.every((s) => !s.extraDot && s.native.includes('data:image/svg+xml')),
      'moving and drawing use one native pen cursor without a trailing dot',
    );
  }
}

async function noLocator(f, label) {
  await f.locator('[data-selection-outline]').waitFor({ state: 'hidden' });
  // Keep observing through the create event, React sync, and subsequent paints.
  // An immediate assertion after pointerup missed the original regression.
  const appeared = await f.evaluate(
    () =>
      new Promise((resolve) => {
        let seen = !!document.querySelector('[data-selection-outline]');
        const observer = new MutationObserver(() => {
          seen ||= !!document.querySelector('[data-selection-outline]');
        });
        observer.observe(document.querySelector('[data-folio-ui=overlay]'), {
          childList: true,
          subtree: true,
        });
        setTimeout(() => {
          observer.disconnect();
          resolve(seen);
        }, 300);
      }),
  );
  assert.equal(appeared, false, label);
}

const sampleName = '00_批注测试.html';
async function framePoint(f, x, y) {
  const b = await page.locator('.document-frame').boundingBox();
  const s = await page
    .locator('.document-frame')
    .evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
  return { x: b.x + x * s, y: b.y + y * s };
}
async function moveMouse(from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}
try {
  await start();
  assert.equal(await page.title(), '页间 · Folio');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  let f = await openFile(sampleName);
  await page.getByLabel('收起批注栏', { exact: true }).click();
  assert.equal(await page.locator('.inspector').isVisible(), false);
  for (const label of [
    '选择文字',
    '高亮',
    '下划线',
    '文本注释',
    '便签',
    '激光笔',
    '画笔',
    '箭头',
    '矩形',
    '橡皮擦',
  ]) {
    await page.getByLabel(label, { exact: true }).hover();
    const tip = page.getByRole('tooltip');
    await tip.waitFor();
    assert.ok((await tip.innerText()).startsWith(label), label + ' Chinese tooltip');
  }
  console.log('PASS: every annotation tool has a visible Chinese name and instruction');

  await page.getByLabel('便签', { exact: true }).click();
  const location = await framePoint(f, 510, 280);
  await page.mouse.click(location.x, location.y);
  const card = f.getByRole('group', { name: '页面便签', exact: true });
  await card.waitFor();
  const editor = card.getByLabel('页面便签内容', { exact: true });
  assert.equal(
    await editor.evaluate((e) => e.getRootNode().activeElement === e),
    true,
    'new sticky auto focuses',
  );
  // Native typing, without filling/focusing again, catches focus being stolen by React sync.
  await page.keyboard.insertText('直接在这里写下我的想法。');
  await page.keyboard.type(' 1234567890', { delay: 25 });
  const noteText = await editor.inputValue();
  assert.equal(noteText, '直接在这里写下我的想法。 1234567890');
  await page.keyboard.press('ControlOrMeta+z');
  assert.notEqual(
    await editor.inputValue(),
    noteText,
    'text undo edits the note, not the annotation list',
  );
  await page.keyboard.press('ControlOrMeta+Shift+z');
  assert.equal(await editor.inputValue(), noteText);
  await waitFor(
    async () => (await safeData(sampleName))?.data.annotations[0]?.note === noteText,
    'sticky typing saved',
  );
  assert.equal(await page.locator('.inspector').isVisible(), false);
  await noLocator(f, 'creating and typing a sticky note does not show a locator');
  let sticky = (await dataFor(sampleName)).data.annotations[0];
  const stickyId = sticky.id,
    startPosition = sticky.points[0];
  let head = await screenBox(card.locator('.head'));
  await moveMouse({ x: head.x + 50, y: head.y + 18 }, { x: head.x - 100, y: head.y + 72 });
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations[0]?.points[0].x < startPosition.x - 80,
    'sticky drag saved',
  );
  sticky = (await dataFor(sampleName)).data.annotations[0];
  const movedPosition = sticky.points[0];
  const resize = await screenBox(card.getByLabel('调整便签大小', { exact: true }));
  await moveMouse({ x: resize.x + 10, y: resize.y + 10 }, { x: resize.x + 70, y: resize.y + 65 });
  await waitFor(
    async () => (await safeData(sampleName))?.data.annotations[0]?.size.width > 350,
    'sticky resize saved',
  );
  const resized = (await dataFor(sampleName)).data.annotations[0].size;
  await card.getByLabel('收起便签', { exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await f.getByLabel('展开便签', { exact: true }).click();
  await card.waitFor();
  assert.equal(await editor.inputValue(), noteText);
  assert.equal(await page.locator('.inspector').isVisible(), false);
  console.log(
    'PASS: in-page sticky creation, uninterrupted typing, drag, resize, collapse and reopen',
  );
  await page.screenshot({ path: path.join(evidence, 'sticky-notes.png') });

  // Highlight first, then explicitly click it to attach a note in the page.
  assert.equal(await page.getByLabel('原文笔记', { exact: true }).count(), 0);
  await card.getByLabel('收起便签', { exact: true }).click();
  await page.getByLabel('高亮', { exact: true }).click();
  let target = await screenBox(f.locator('#target'));
  await moveMouse(
    { x: target.x + 1, y: target.y + target.height / 2 },
    { x: target.x + target.width - 1, y: target.y + target.height / 2 },
  );
  const popup = f.getByRole('group', { name: '批注笔记编辑', exact: true });
  await waitFor(
    async () => (await safeData(sampleName))?.data.annotations.some((a) => a.type === 'highlight'),
    'highlight saved',
  );
  assert.equal(await popup.isVisible(), false, 'highlight creation leaves the popup closed');
  await noLocator(f, 'creating a highlight does not show a locator');
  await page.mouse.click(target.x + 40, target.y + target.height / 2);
  await popup.waitFor();
  await popup.getByLabel('添加笔记', { exact: true }).click();
  await page.keyboard.insertText('这条笔记属于高亮的原文。');
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations
        .find((a) => a.type === 'highlight')
        ?.note.includes('高亮的原文'),
    'highlight note persisted',
  );
  assert.equal(await page.locator('.inspector').isVisible(), false);
  await popup.getByLabel('完成笔记', { exact: true }).click();
  await noLocator(f, 'editing a highlight note on the page does not show a locator');
  const indicator = f.getByLabel('查看批注笔记', { exact: true });
  await indicator.waitFor();
  await page.mouse.move(target.x + 40, target.y + target.height / 2);
  const preview = f.getByRole('button', { name: '批注笔记预览，点击编辑', exact: true });
  await preview.waitFor();
  assert.equal(await preview.locator('.preview-text').innerText(), '这条笔记属于高亮的原文。');
  assert.equal(await indicator.getAttribute('data-previewing'), 'true');
  // The preview sits below the text and stays while the pointer is on it; moving away hides it.
  await page.mouse.move(target.x + 40, target.y - 80);
  await preview.waitFor({ state: 'hidden' });
  assert.equal(await indicator.getAttribute('data-previewing'), 'false');
  await page.getByLabel('选择文字', { exact: true }).click();
  await page.mouse.click(target.x + 40, target.y + target.height / 2);
  await popup.waitFor();
  await popup.getByLabel('编辑笔记', { exact: true }).click();
  assert.equal(
    await popup.getByLabel('批注笔记内容', { exact: true }).inputValue(),
    '这条笔记属于高亮的原文。',
  );
  await popup.getByLabel('完成笔记', { exact: true }).click();
  console.log(
    'PASS: unified highlight notes, explicit click to edit, note indicator and hover preview without the sidebar',
  );

  await page.getByLabel('珊瑚色', { exact: true }).click();
  await lineDraw('画笔', [35, 80], [600, 80]);
  await lineDraw('画笔', [35, 120], [600, 120]);
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations.filter((a) => a.type === 'pen').length === 2,
    'two strokes saved',
  );
  assert.equal(await page.locator('.inspector').isVisible(), false);
  const beforeErase = (await dataFor(sampleName)).data.annotations.filter((a) => a.type === 'pen');
  await page.getByLabel('显示或隐藏批注栏', { exact: true }).click();
  const selectedPen = page.locator(`[data-annotation="${beforeErase[0].id}"]`);
  await selectedPen.getByRole('button', { name: '定位画笔批注', exact: true }).click();
  await f.locator(`[data-selection-outline="${beforeErase[0].id}"]`).waitFor();
  assert.ok((await selectedPen.getAttribute('class')).includes('selected'));
  await page.getByLabel('收起批注栏', { exact: true }).click();
  await page.getByLabel('橡皮擦', { exact: true }).click();
  const box = await screenBox(f.locator('#draw-area'));
  // A fast single move across both long strokes must cut both, not delete either.
  await page.mouse.move(box.x + 300, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 145);
  await page.mouse.up();
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations
        .filter((a) => a.type === 'pen')
        .every((a) => a.paths?.length === 2),
    'both strokes partially erased',
  );
  const erasedInk = (await dataFor(sampleName)).data.annotations.filter((a) => a.type === 'pen');
  assert.equal(erasedInk.length, 2);
  for (let i = 0; i < erasedInk.length; i++) {
    assert.equal(erasedInk[i].id, beforeErase[i].id);
    assert.equal(erasedInk[i].paths[0][0].x, beforeErase[i].points[0].x);
    assert.equal(erasedInk[i].paths[1].at(-1).x, beforeErase[i].points.at(-1).x);
  }
  await page.screenshot({ path: path.join(evidence, 'partial-eraser.png') });
  await page.keyboard.press('ControlOrMeta+z');
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations
        .filter((a) => a.type === 'pen')
        .every((a) => !a.paths),
    'one undo restores both strokes',
  );
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations
        .filter((a) => a.type === 'pen')
        .every((a) => a.paths?.length === 2),
    'redo restores erased fragments',
  );
  console.log(
    'PASS: fast drag cuts only touched ink on two strokes; one undo/redo preserves identities',
  );

  // Screen feedback has the selected physical size and old strokes retain their widths.
  await page.getByLabel('笔触与橡皮擦大小', { exact: true }).click();
  await page.getByLabel('橡皮擦大小', { exact: true }).focus();
  await page.keyboard.press('End');
  await page.getByLabel('画笔粗细', { exact: true }).focus();
  await page.keyboard.press('End');
  await page.getByLabel('笔触与橡皮擦大小', { exact: true }).click();
  await page.mouse.move(box.x + 450, box.y + 65);
  await waitFor(
    async () => (await f.locator('[data-folio-cursor]').getAttribute('r')) === '32',
    '64 px eraser cursor',
  );
  await page.getByLabel('画笔', { exact: true }).click();
  await moveMouse({ x: box.x + 360, y: box.y + 40 }, { x: box.x + 510, y: box.y + 40 });
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations.filter((a) => a.type === 'pen').at(-1)
        ?.strokeWidth === 12,
    'new pen width saved',
  );
  const widths = (await dataFor(sampleName)).data.annotations
    .filter((a) => a.type === 'pen')
    .map((a) => a.strokeWidth);
  assert.deepEqual(widths, [2.5, 2.5, 12]);
  await page.keyboard.down('e');
  await page.mouse.move(box.x + 430, box.y + 15);
  await waitFor(
    async () => (await f.locator('[data-folio-cursor]').getAttribute('r')) === '32',
    'hold E temporarily erases',
  );
  await page.mouse.down();
  await page.mouse.move(box.x + 430, box.y + 58);
  await page.mouse.up();
  await page.keyboard.up('e');
  await page.mouse.move(box.x + 500, box.y + 65);
  await f.locator('[data-folio-cursor]').waitFor({ state: 'hidden' });
  await waitFor(
    async () =>
      (
        await f.locator('[data-folio-ui=overlay]').evaluate((e) => getComputedStyle(e).cursor)
      ).includes('data:image/svg+xml'),
    'release E restores the single native pen cursor',
  );
  await waitFor(
    async () =>
      (await safeData(sampleName))?.data.annotations.filter((a) => a.type === 'pen').at(-1)?.paths
        ?.length === 2,
    'temporary eraser saved',
  );
  const inkAfterTemporaryErase = (await dataFor(sampleName)).data.annotations.filter(
    (a) => a.type === 'pen',
  );
  console.log(
    'PASS: visible tool-size settings, immutable existing stroke widths, hold-E temporary eraser',
  );

  // Delete is distinct from collapse and remains undoable with all geometry/content.
  await page.getByLabel('选择文字', { exact: true }).click();
  await f.locator(`[data-note-pin="${stickyId}"]`).click();
  await card.getByLabel('删除便签', { exact: true }).click();
  await waitFor(
    async () => !(await safeData(sampleName))?.data.annotations.some((a) => a.id === stickyId),
    'sticky deletion',
  );
  await page.getByLabel('撤销批注', { exact: true }).click();
  await card.waitFor();
  assert.equal(await editor.inputValue(), noteText);
  await waitFor(
    async () => (await safeData(sampleName))?.data.annotations.some((a) => a.id === stickyId),
    'sticky undo persisted',
  );
  await page.getByLabel('关闭 ' + sampleName, { exact: true }).click();
  await openFile(sampleName);
  f = await rendered();
  await f.getByRole('group', { name: '页面便签', exact: true }).waitFor();
  let restored = (await dataFor(sampleName)).data.annotations.find((a) => a.id === stickyId);
  assert.equal(restored.note, noteText);
  assert.deepEqual(restored.points[0], movedPosition);
  assert.deepEqual(restored.size, resized);
  await app.close();
  await start();
  f = await openFile(sampleName);
  assert.equal(
    await page.locator('.inspector').isVisible(),
    false,
    'closed inspector remembered after app restart',
  );
  assert.equal(
    await f
      .getByRole('group', { name: '页面便签', exact: true })
      .getByLabel('页面便签内容')
      .inputValue(),
    noteText,
  );
  assert.deepEqual(
    (await dataFor(sampleName)).data.annotations.filter((a) => a.type === 'pen'),
    inkAfterTemporaryErase,
  );
  console.log(
    'PASS: deletion undo, document reopen and application restart retain notes, positions, sizes, erased fragments and hidden inspector',
  );

  await noLocator(f, 'restarting does not restore the sidebar locator');
  await page.getByLabel('文本注释', { exact: true }).click();
  const textLocation = await framePoint(f, 100, 500);
  await page.mouse.click(textLocation.x, textLocation.y);
  const textCard = f.getByRole('group', { name: '页面文本注释', exact: true });
  const textEditor = textCard.getByLabel('文本注释内容', { exact: true });
  await textEditor.fill('这条文字只在列表定位时显示虚线');
  await noLocator(f, 'creating and editing page text does not show a locator');
  await page.getByLabel('显示或隐藏批注栏', { exact: true }).click();
  await page.getByRole('button', { name: '查看页面中的文本注释', exact: true }).click();
  await f.locator('[data-selection-outline]').waitFor();
  await textEditor.click();
  await textEditor.fill('继续编辑也不显示虚线');
  await noLocator(f, 'editing page text clears a previous sidebar locator');
  await page.getByLabel('显示或隐藏文件树', { exact: true }).click();
  await noLocator(f, 'later layout sync does not re-enable the locator');
  await textCard.hover();
  await textCard.getByLabel('删除文本注释', { exact: true }).click();
  await page.getByLabel('显示或隐藏文件树', { exact: true }).click();
  await page.getByLabel('收起批注栏', { exact: true }).click();
  console.log(
    'PASS: only explicit sidebar navigation enables the dashed locator; drawing, highlights, sticky notes, page text editing and later sync stay clear',
  );

  const legacy = sampleFiles.find((name) => name.startsWith('55_L1_')) || '03_内嵌便签示例.html';
  f = await openFile(legacy);
  assert.ok((await f.locator('.sticky').count()) >= 7, 'existing embedded sticky notes render');
  assert.ok((await f.locator('body').innerText()).includes('结论'));
  await page.getByLabel('便签', { exact: true }).click();
  const onLegacy = await framePoint(f, 40, 160);
  await page.mouse.click(onLegacy.x, onLegacy.y);
  await f.getByRole('group', { name: '页面便签', exact: true }).waitFor();
  await page.keyboard.insertText('我理解的批注：想法直接留在页面上，阅读不被侧栏打断。');
  await waitFor(
    async () => (await safeData(legacy))?.data.annotations[0]?.note.includes('不被侧栏打断'),
    'new note on legacy HTML saved',
  );
  await page.screenshot({ path: path.join(evidence, 'legacy-sticky.png') });
  console.log('PASS: HTML retains its embedded notes and accepts new page notes');
  await page.getByLabel('橡皮擦', { exact: true }).hover();
  await page.getByRole('tooltip').waitFor();
  await page.screenshot({ path: path.join(evidence, 'chinese-tooltip.png') });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 700),
  );
  await page.getByLabel('橡皮擦', { exact: true }).click();
  assert.equal(
    await page.locator('.reader-toolbar').evaluate((e) => e.clientWidth >= e.scrollWidth),
    true,
  );
  await page.getByLabel('显示或隐藏批注栏', { exact: true }).click();
  assert.equal(
    await page.locator('.reader-toolbar').evaluate((e) => e.clientWidth >= e.scrollWidth),
    true,
    'tools fit at 900px with inspector',
  );
  await page.getByLabel('收起批注栏', { exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'interactions-compact.png') });
  assert.equal(await page.locator('.inspector').isVisible(), false);
  const errors = consoleErrors.filter(
    (s) =>
      !s.includes('Failed to load resource') &&
      !s.includes('404') &&
      !s.includes('ERR_FILE_NOT_FOUND'),
  );
  assert.deepEqual(errors, []);
  console.log(
    'INTERACTIONS PASS: app identity, rendered content, no overlay or app errors, desktop + 900px, all requested interaction paths',
  );
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(evidence, 'interaction-failure.png') }).catch(() => {});
  console.error(error);
  console.error(consoleErrors);
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
