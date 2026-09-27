const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const backups = require('../electron/backups.cjs');
const { Workspace } = require('../electron/workspace.cjs');
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const entry = (time, size = 100) => ({
  name: `${time}-0000abcd.html`,
  time,
  size,
  restore: false,
});
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-backups-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '示例.html'), '<h1>原文</h1>');
  const w = new Workspace();
  await w.open(root);
  const d = await w.document('示例.html');
  return { w, root, d, dir: path.join(root, '.html-reader', 'backups', d.id) };
}
test('保留策略：2 小时内全留，之后每小时、每天各留最早一份，30 天后删除', () => {
  const now = new Date(2026, 8, 24, 18, 0).getTime();
  const recent = [5, 25, 45, 65, 100].map((m) => entry(now - m * minute));
  // Two backups in the same hour, 5 hours ago: the earlier one is kept.
  const hourA = entry(now - 5 * hour - 40 * minute);
  const hourB = entry(now - 5 * hour - 10 * minute);
  // Two backups on the same day, 3 days ago: the earlier one is kept.
  const dayA = entry(new Date(2026, 8, 21, 9, 0).getTime());
  const dayB = entry(new Date(2026, 8, 21, 16, 0).getTime());
  const old = entry(now - 31 * day);
  const drop = backups.expired([...recent, hourA, hourB, dayA, dayB, old], now);
  assert.deepEqual(drop.map((e) => e.name).sort(), [hourB, dayB, old].map((e) => e.name).sort());
});
test('每篇文档的备份超过大小上限时先删最旧的，但至少保留最新一份', () => {
  const now = Date.now();
  const mb = 1024 * 1024;
  const newest = entry(now - 1 * minute, 150 * mb);
  const middle = entry(now - 20 * minute, 40 * mb);
  const oldest = entry(now - 40 * minute, 40 * mb);
  assert.deepEqual(backups.expired([oldest, middle, newest], now), [oldest]);
  assert.deepEqual(backups.expired([entry(now, 500 * mb)], now), []);
});
test('保存时按间隔备份并自动清理过期备份', async (t) => {
  const { w, d, dir } = await setup(t);
  await fs.mkdir(dir, { recursive: true });
  const stale = `${Date.now() - 40 * day}-0000abcd.html`;
  await fs.writeFile(path.join(dir, stale), '很久以前');
  await w.saveSource({ path: d.path, source: '<h1>一</h1>', version: d.version });
  const names = await fs.readdir(dir);
  assert.equal(names.length, 1, 'the stale backup is removed');
  assert.equal(await fs.readFile(path.join(dir, names[0]), 'utf8'), '<h1>原文</h1>');
});
test('打开项目时清理所有文档的过期备份', async (t) => {
  const { root, dir } = await setup(t);
  const orphan = path.join(root, '.html-reader', 'backups', 'deleted-document');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(orphan, { recursive: true });
  const fresh = `${Date.now() - minute}-0000abcd.html`;
  await fs.writeFile(path.join(dir, fresh), '新');
  await fs.writeFile(path.join(dir, `${Date.now() - 45 * day}-0000abcd.html`), '旧');
  await fs.writeFile(path.join(orphan, `${Date.now() - 60 * day}-0000abcd.html`), '旧');
  await backups.pruneAll(path.join(root, '.html-reader', 'backups'));
  assert.deepEqual(await fs.readdir(dir), [fresh]);
  assert.deepEqual(await fs.readdir(orphan), []);
});
test('列出、读取并恢复历史版本；恢复前备份当前内容', async (t) => {
  const { w, root, d } = await setup(t);
  const saved = await w.saveSource({ path: d.path, source: '<h1>改坏了</h1>', version: d.version });
  const [original] = await w.backups({ path: d.path });
  assert.equal(original.restore, false);
  assert.equal(await w.backup({ path: d.path, name: original.name }), '<h1>原文</h1>');
  const restored = await w.restoreBackup({
    path: d.path,
    name: original.name,
    version: saved.version,
  });
  assert.equal(restored.source, '<h1>原文</h1>');
  assert.equal(await fs.readFile(path.join(root, d.path), 'utf8'), '<h1>原文</h1>');
  const list = await w.backups({ path: d.path });
  assert.equal(list.length, 2);
  assert.equal(list[0].restore, true, 'newest backup holds what the restore replaced');
  assert.equal(await w.backup({ path: d.path, name: list[0].name }), '<h1>改坏了</h1>');
  // Restoring the same version again changes nothing and adds no backup.
  await w.restoreBackup({ path: d.path, name: original.name, version: restored.version });
  assert.equal((await w.backups({ path: d.path })).length, 2);
  // The restored file saves normally afterwards.
  await w.saveSource({ path: d.path, source: '<h1>继续</h1>', version: restored.version });
});
test('恢复拒绝外部修改过的文件和非法的备份名称', async (t) => {
  const { w, root, d } = await setup(t);
  await w.saveSource({ path: d.path, source: '<h1>新</h1>', version: d.version });
  const [original] = await w.backups({ path: d.path });
  await fs.writeFile(path.join(root, d.path), '外部修改');
  await assert.rejects(
    w.restoreBackup({ path: d.path, name: original.name, version: d.version }),
    /外部程序/,
  );
  assert.equal(await fs.readFile(path.join(root, d.path), 'utf8'), '外部修改');
  for (const name of ['../workspace.json', '../../示例.html', 'x.html', original.name + '/..'])
    await assert.rejects(w.backup({ path: d.path, name }), /无效的历史版本/);
  await assert.rejects(w.backups({ path: '.html-reader/workspace.json' }), /无效的 HTML/);
});
