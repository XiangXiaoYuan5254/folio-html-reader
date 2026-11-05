// 设置 › 项目存储 in the real Electron app: what Folio keeps in the project by kind, deleting
// whiteboards picked from the list, clearing old backups while each document keeps its
// newest one, and clearing what a deleted file left behind.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-storage-'));
const project = path.join(temp, '项目');
const meta = path.join(project, '.html-reader');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-storage-qa');
await fs.mkdir(path.join(meta, 'boards', 'sounds', 'board-old0001'), { recursive: true });
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(project, '01_文档.html'), '<h1>文档</h1>');
// The project knows 01_文档.html, and 删掉的.html, deleted since: its notes, conversation and
// backup are left, with a picture no note shows.
const live = crypto.randomUUID();
const gone = crypto.randomUUID();
await fs.mkdir(path.join(meta, 'documents'), { recursive: true });
await fs.mkdir(path.join(meta, 'ai'), { recursive: true });
await fs.mkdir(path.join(meta, 'note-images'), { recursive: true });
await fs.mkdir(path.join(meta, 'backups', gone), { recursive: true });
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
await fs.writeFile(
  path.join(meta, 'workspace.json'),
  JSON.stringify({
    version: 1,
    files: {
      '01_文档.html': { id: live, hash: sha('<h1>文档</h1>'), storage: 'adjacent' },
      '删掉的.html': { id: gone, hash: sha('<h1>删掉的</h1>'), storage: 'adjacent' },
    },
  }),
);
await fs.writeFile(
  path.join(meta, 'documents', `${gone}.json`),
  JSON.stringify({ version: 1, annotations: [], note: '旧笔记', scroll: 0, zoom: 0 }),
);
await fs.writeFile(
  path.join(meta, 'ai', `${gone}.json`),
  JSON.stringify({ version: 1, threads: [] }),
);
await fs.writeFile(
  path.join(meta, 'backups', gone, `${Date.now()}-abcdef12.html`),
  'x'.repeat(3000),
);
await fs.writeFile(path.join(meta, 'note-images', 'stray-1.png'), Buffer.alloc(5000));
const DAY = 86_400_000;
const now = Date.now();
// Two boards: one not changed for 200 days, with a sentence of sound; one from today.
const entry = (id, title, updatedAt) => ({
  id,
  title,
  source: '01_文档.html',
  kind: 'explain',
  createdAt: updatedAt,
  updatedAt,
  questions: 0,
});
const boards = [
  entry('board-new0001', '今天的白板', now),
  entry('board-old0001', '很久以前的白板', now - 200 * DAY),
];
await fs.writeFile(path.join(meta, 'boards', 'index.json'), JSON.stringify(boards));
for (const b of boards)
  await fs.writeFile(
    path.join(meta, 'boards', `${b.id}.json`),
    JSON.stringify({
      version: 1,
      id: b.id,
      pad: 'x'.repeat(b.id.includes('old') ? 300_000 : 2_000),
    }),
  );
await fs.writeFile(
  path.join(meta, 'boards', 'sounds', 'board-old0001', `${'a'.repeat(16)}.ogg`),
  Buffer.alloc(200_000),
);
// One document's backups: newest, 3 days and 10 days old.
const backupDir = path.join(meta, 'backups', live);
await fs.mkdir(backupDir, { recursive: true });
const backup = (age) => `${now - age}-abcdef12.html`;
for (const [age, size] of [
  [0, 1_000],
  [3 * DAY, 50_000],
  [10 * DAY, 120_000],
])
  await fs.writeFile(path.join(backupDir, backup(age)), 'x'.repeat(size));

// What a folder takes on disk, shown as the page shows it.
async function sizeOf(target) {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await fs.readdir(target)) total += await sizeOf(path.join(target, name));
  return total;
}
const kb = (n) => `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
const boardsSize = kb(await sizeOf(path.join(meta, 'boards')));
const backupsSize = kb(await sizeOf(path.join(meta, 'backups')));

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
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '项目存储' })
    .click();
  const storage = settings.getByRole('region', { name: '项目存储' });

  // By kind, the boards first: they are the biggest here.
  const kinds = storage.getByRole('list', { name: '按类别的占用' }).getByRole('listitem');
  await kinds.first().waitFor();
  assert.match(await kinds.first().innerText(), new RegExp(`^白板[\\s\\S]*${boardsSize}$`));
  assert.match(await storage.innerText(), new RegExp(`历史版本备份[^]*?${backupsSize}`));
  const shot = async (name) => {
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
    );
    await fs.writeFile(path.join(evidence, name), Buffer.from(png, 'base64'));
  };
  await shot('storage.png');

  // The board not changed for months, picked and deleted with its sound, after a second click.
  const list = storage.getByRole('group', { name: '项目里的白板' });
  await storage.getByRole('button', { name: '选中 3 个月没改过的（1）' }).click();
  assert.ok(await list.getByRole('checkbox', { name: /很久以前的白板/ }).isChecked());
  assert.ok(!(await list.getByRole('checkbox', { name: /今天的白板/ }).isChecked()));
  await storage.getByRole('button', { name: /删除选中的 1 块/ }).click();
  await storage.getByRole('button', { name: '确认删除这 1 块白板？' }).click();
  await page.getByRole('status').filter({ hasText: '已删除 1 块白板' }).waitFor();
  await list.getByRole('checkbox', { name: /很久以前的白板/ }).waitFor({ state: 'detached' });
  await list.getByRole('checkbox', { name: /今天的白板/ }).waitFor();
  assert.deepEqual((await fs.readdir(path.join(meta, 'boards'))).sort(), [
    'board-new0001.json',
    'index.json',
    'sounds',
  ]);
  assert.deepEqual(await fs.readdir(path.join(meta, 'boards', 'sounds')), []);

  // Backups older than 7 days, then all but the newest.
  await storage.getByRole('button', { name: /清理，可释放 117 KB/ }).click();
  await storage.getByRole('button', { name: /确认清理/ }).click();
  await page.getByRole('status').filter({ hasText: '已清理旧备份，释放 117 KB' }).waitFor();
  assert.deepEqual((await fs.readdir(backupDir)).sort(), [backup(3 * DAY), backup(0)].sort());
  await storage.getByLabel('保留哪些备份').selectOption('0');
  await storage.getByRole('button', { name: /清理，可释放 49 KB/ }).click();
  await storage.getByRole('button', { name: /确认清理/ }).click();
  await page.getByRole('status').filter({ hasText: '已清理旧备份，释放 49 KB' }).waitFor();
  assert.deepEqual(await fs.readdir(backupDir), [backup(0)]);
  await storage.getByRole('button', { name: '没有可清理的备份' }).waitFor();

  // What the deleted file left, and the picture: one click and a second to confirm.
  const left = storage.getByRole('list', { name: '无用数据' });
  assert.match(
    await left.innerText(),
    /批注与笔记[\s\S]*1 份[\s\S]*AI 对话记录[\s\S]*1 份[\s\S]*历史版本备份[\s\S]*1 篇文档[\s\S]*笔记图片[\s\S]*1 张/,
  );
  await storage.getByRole('button', { name: /一键清理，可释放/ }).click();
  await storage.getByRole('button', { name: /确认清理？会释放/ }).click();
  await page.getByRole('status').filter({ hasText: '已清理无用数据' }).waitFor();
  await storage.getByRole('button', { name: '没有无用数据' }).waitFor();
  for (const file of [
    path.join(meta, 'documents', `${gone}.json`),
    path.join(meta, 'ai', `${gone}.json`),
    path.join(meta, 'backups', gone),
    path.join(meta, 'note-images', 'stray-1.png'),
  ])
    assert.equal(await fs.stat(file).catch(() => null), null, file);
  // The document still there keeps its backup.
  assert.deepEqual(await fs.readdir(backupDir), [backup(0)]);

  assert.deepEqual(errors, []);
  console.log('PASS: project storage by kind; old boards, backups and leftovers cleared');
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
