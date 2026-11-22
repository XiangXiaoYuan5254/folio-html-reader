import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { makeDocx } = createRequire(import.meta.url)('./docx-fixture.cjs');

// Code, plain text, CSV and Word open as pages of their own, read and annotated like HTML.
const root = path.resolve('.');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-file-types-')));
const project = path.join(temp, '资料');
const evidence = process.env.FOLIO_QA_DIR;
const python =
  'def greet(name):\n    """问候\n    一个人"""\n\n    return f"你好，{name}"  # 注释\n';
await fs.mkdir(path.join(project, 'src'), { recursive: true });
await fs.writeFile(path.join(project, 'src/greet.py'), python);
await fs.writeFile(path.join(project, '数据.csv'), '城市,人口\n"北京,中国",2189\n上海,2487\n');
// A .txt saved by Chinese Windows: GB18030 with CRLF.
await fs.writeFile(
  path.join(project, '小说.txt'),
  Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0d, 0x0a, 0xd5, 0xfd, 0xce, 0xc4]),
);
await fs.writeFile(path.join(project, '报告.docx'), await makeDocx());
await fs.writeFile(path.join(temp, '旧稿.doc'), 'x');

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
const tree = () => win.getByRole('navigation', { name: '项目文件' });
const doc = () => win.frameLocator('.document-frame');
async function open(name) {
  await tree().getByRole('button', { name, exact: true }).click();
  await waitFor(
    async () =>
      (await win.getByRole('tab', { name, exact: true }).getAttribute('aria-selected')) === 'true',
    `${name} tab`,
  );
  await waitFor(
    async () =>
      (await win.locator('.document-frame').getAttribute('src')).includes(encodeURIComponent(name)),
    `${name} frame`,
  );
  await doc().locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  await win.locator('.reader-loading').waitFor({ state: 'hidden' });
  if (evidence) await win.screenshot({ path: path.join(evidence, `${name}.png`) });
}
async function annotations(relative) {
  const index = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/workspace.json'), 'utf8'),
  );
  // A document's data is kept beside it.
  const dir = path.join(project, path.dirname(relative), '.html-reader/documents');
  const data = JSON.parse(
    await fs.readFile(path.join(dir, index.files[relative].id + '.json'), 'utf8'),
  );
  return data.annotations;
}
// Drags across an element of the page, in window coordinates.
async function dragAcross(locator) {
  const local = await locator.evaluate((e) => e.getBoundingClientRect().toJSON());
  const frame = await win.locator('.document-frame').boundingBox();
  const scale = await win
    .locator('.document-frame')
    .evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
  const y = frame.y + (local.y + local.height / 2) * scale;
  await win.mouse.move(frame.x + (local.x + 2) * scale, y);
  await win.mouse.down();
  await win.mouse.move(frame.x + (local.x + local.width - 2) * scale, y, { steps: 10 });
  await win.mouse.up();
}
try {
  if (evidence) await fs.mkdir(evidence, { recursive: true });
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await win.waitForSelector('.document-frame');

  // Code: highlighted, every line numbered in the margin, the text itself unchanged.
  if (!(await tree().getByRole('button', { name: 'greet.py', exact: true }).isVisible()))
    await tree().getByRole('button', { name: 'src', exact: true }).click();
  await open('greet.py');
  const code = doc().locator('pre.code');
  assert.equal(await code.locator('.l').count(), 5);
  assert.ok((await code.locator('.hljs-keyword').count()) >= 2, 'highlighted');
  assert.equal(await code.innerText(), python, 'line numbers stay out of the text');
  assert.equal(
    await code
      .locator('.l')
      .nth(4)
      .evaluate((l) => getComputedStyle(l, '::before').content),
    'counter(line)',
  );
  assert.match(await doc().locator('header').innerText(), /Python · 5 行/);
  assert.equal(await win.getByRole('button', { name: '源码', exact: true }).isDisabled(), true);
  console.log('PASS: code opens highlighted, with line numbers');

  // It is annotated like any page: a highlight made on a line is kept.
  await win.getByLabel('高亮', { exact: true }).click();
  await dragAcross(code.locator('.l').first());
  await waitFor(
    async () =>
      (await annotations('src/greet.py')).some(
        (a) => a.type === 'highlight' && a.quote?.exact.includes('greet'),
      ),
    'highlight saved',
  );
  await win.getByLabel('选择文字', { exact: true }).click();
  console.log('PASS: a line of code can be highlighted');

  // CSV is a table, quotes and all.
  await open('数据.csv');
  assert.deepEqual(await doc().locator('th').allInnerTexts(), ['城市', '人口']);
  assert.equal(await doc().locator('td').first().innerText(), '北京,中国');
  console.log('PASS: CSV opens as a table');

  // A GB18030 .txt reads as text, not mojibake.
  await open('小说.txt');
  assert.equal(await doc().locator('pre.text').innerText(), '第一章\n正文');
  console.log('PASS: a GB18030 text file reads correctly');

  // Word: structure kept, the centred title still centred.
  await open('报告.docx');
  const title = doc().locator('h1.title');
  assert.equal(await title.innerText(), '年度报告');
  assert.equal(await title.evaluate((h) => getComputedStyle(h).textAlign), 'center');
  assert.equal(await doc().locator('strong').innerText(), '重点');
  assert.equal(await doc().locator('td').nth(2).innerText(), '页间');
  assert.equal(await win.getByRole('button', { name: '源码', exact: true }).isDisabled(), true);
  const files = await tree().innerText();
  assert.ok(files.includes('报告.docx') && files.includes('数据.csv'), 'listed in the tree');
  console.log('PASS: a Word document opens with its structure');

  // An old .doc says how to open it.
  await app.evaluate(
    ({ app }, file) => app.emit('open-file', { preventDefault() {} }, file),
    path.join(temp, '旧稿.doc'),
  );
  await win.getByRole('alert').waitFor();
  assert.match(await win.getByRole('alert').innerText(), /另存为 \.docx/);
  assert.deepEqual(errors, []);
  console.log('FILE TYPES E2E PASS');
} catch (error) {
  console.error('FILE TYPES E2E FAILED:', error);
  console.error('ERRORS:', errors);
  if (win && evidence) await win.screenshot({ path: path.join(evidence, 'failure.png') });
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
