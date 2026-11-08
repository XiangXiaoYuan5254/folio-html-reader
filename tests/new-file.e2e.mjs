// New files in the real Electron app: the dialog suggests a name not yet taken, and a name
// that is taken gets a number instead of an error, with a notice saying which.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-new-file-'));
const project = path.join(temp, '项目');
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, '未命名.html'), '<h1>原来的</h1>');

let app;
const errors = [];
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
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.document-frame');
  // The + in the tab strip asks which kind of file to make.
  const newFile = async (kind) => {
    await page.getByRole('button', { name: '新建文档', exact: true }).click();
    await page.getByRole('menuitem', { name: kind, exact: true }).click();
  };
  const dialog = page.getByRole('dialog', { name: '新建 HTML 文档' });
  const name = dialog.getByLabel('新建 HTML 文档');

  // The suggested name is free.
  await newFile('新建 HTML');
  assert.equal(await name.inputValue(), '未命名2.html');

  // A taken name typed in: created with a number, and the notice says so.
  await name.fill('未命名.html');
  await dialog.getByRole('button', { name: '创建' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page
    .getByRole('status')
    .filter({ hasText: '已有同名文件「未命名.html」，已创建为「未命名2.html」' })
    .waitFor();
  await page.getByRole('tab', { name: '未命名2.html', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, '未命名.html'), 'utf8'), '<h1>原来的</h1>');
  assert.ok((await fs.readFile(path.join(project, '未命名2.html'), 'utf8')).includes('新文档'));

  // The next suggestion moves on; a taken numbered name goes on from its number.
  await newFile('新建 HTML');
  assert.equal(await name.inputValue(), '未命名3.html');
  await name.fill('未命名2.html');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: '已有同名文件「未命名2.html」，已创建为「未命名3.html」' })
    .waitFor();
  await page.getByRole('tab', { name: '未命名3.html', exact: true }).waitFor();
  await newFile('新建 HTML');
  assert.equal(await name.inputValue(), '未命名4.html');
  await dialog.getByRole('button', { name: '取消' }).first().click();

  // Markdown: a free .md name, a heading to start from, opened in a tab.
  await newFile('新建 Markdown');
  const mdDialog = page.getByRole('dialog', { name: '新建 Markdown 文档' });
  assert.equal(await mdDialog.getByLabel('新建 Markdown 文档').inputValue(), '未命名.md');
  await mdDialog.getByRole('button', { name: '创建' }).click();
  await page.getByRole('tab', { name: '未命名.md', exact: true }).waitFor();
  assert.equal(
    await fs.readFile(path.join(project, '未命名.md'), 'utf8'),
    '# 新文档\n\n从这里开始记录你的想法。\n',
  );
  await page.frameLocator('.document-frame').locator('h1', { hasText: '新文档' }).waitFor();
  // The file tree's + offers it too.
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建 Markdown', exact: true }).click();
  assert.equal(await mdDialog.getByLabel('新建 Markdown 文档').inputValue(), '未命名2.md');
  await mdDialog.getByRole('button', { name: '取消' }).first().click();
  console.log('PASS: Markdown files can be made from the + buttons');

  assert.deepEqual(errors, []);
  console.log('PASS: new files take a free name and say so when the one typed was taken');
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
