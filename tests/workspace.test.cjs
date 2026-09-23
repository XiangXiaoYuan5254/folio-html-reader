const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Workspace } = require('../electron/workspace.cjs');
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '示例.html'), '<h1>原文</h1><p>这里是批注对象。</p>');
  const w = new Workspace();
  await w.open(root);
  return { w, root };
}
test('批注、笔记和阅读位置在重启后恢复', async (t) => {
  const { w, root } = await setup(t);
  const d = await w.document('示例.html');
  const data = {
    ...d.data,
    note: '持久笔记',
    annotations: [{ id: 'a', type: 'highlight', note: '想法', quote: { exact: '原文' } }],
    scroll: 812,
    zoom: 0.75,
  };
  await w.saveData({ id: d.id, data });
  const fresh = new Workspace();
  await fresh.open(root);
  const again = await fresh.document('示例.html');
  assert.equal(again.id, d.id);
  assert.deepEqual(again.data, data);
  assert.equal(await fs.readFile(path.join(root, '示例.html'), 'utf8'), d.source);
});
test('源码保存保留原始备份（10 分钟内不重复），并阻止覆盖外部修改', async (t) => {
  const { w, root } = await setup(t);
  const d = await w.document('示例.html');
  const result = await w.saveSource({
    path: d.path,
    source: '<h1>编辑后</h1>',
    version: d.version,
  });
  assert.notEqual(result.version, d.version);
  const backups = await fs.readdir(path.join(root, '.html-reader', 'backups', d.id));
  assert.equal(backups.length, 1);
  assert.equal(
    await fs.readFile(path.join(root, '.html-reader', 'backups', d.id, backups[0]), 'utf8'),
    d.source,
  );
  // Auto-save writes again within minutes without piling up backups.
  const again = await w.saveSource({
    path: d.path,
    source: '<h1>再次编辑</h1>',
    version: result.version,
  });
  assert.equal((await fs.readdir(path.join(root, '.html-reader', 'backups', d.id))).length, 1);
  await fs.writeFile(path.join(root, d.path), '外部修改');
  await assert.rejects(
    w.saveSource({ path: d.path, source: '不能覆盖', version: again.version }),
    /外部程序/,
  );
  assert.equal(await fs.readFile(path.join(root, d.path), 'utf8'), '外部修改');
});
test('移动目录与文档保留稳定身份和笔记，不覆盖已存在目标', async (t) => {
  const { w, root } = await setup(t);
  const d = await w.document('示例.html');
  await w.saveData({ id: d.id, data: { ...d.data, note: '不能丢' } });
  await w.create({ path: '论文', kind: 'folder' });
  await w.move({ from: '示例.html', to: '论文/改名.html' });
  await w.saveSession({ paths: ['论文/改名.html'], active: '论文/改名.html' });
  await w.move({ from: '论文', to: '归档' });
  const moved = await w.document('归档/改名.html');
  assert.equal(moved.id, d.id);
  assert.equal(moved.data.note, '不能丢');
  const reopened = await new Workspace().open(root);
  assert.deepEqual(reopened.session, { paths: ['归档/改名.html'], active: '归档/改名.html' });
  await w.create({ path: '已存在.html', kind: 'file' });
  await assert.rejects(w.move({ from: moved.path, to: '已存在.html' }), /已存在/);
});

test('拖拽移动拒绝根目录和子目录循环；冲突时保留两个文件及批注', async (t) => {
  const { w, root } = await setup(t);
  const original = await w.document('示例.html');
  await w.saveData({ id: original.id, data: { ...original.data, note: '原批注' } });
  await w.create({ path: '归档', kind: 'folder' });
  await w.create({ path: '归档/子目录', kind: 'folder' });
  await w.create({ path: '归档/示例.html', kind: 'file' });
  const other = await w.document('归档/示例.html');
  await assert.rejects(w.move({ from: '示例.html', to: '归档/示例.html' }), /已存在/);
  await assert.rejects(w.move({ from: '归档', to: '归档/子目录/归档' }), /子文件夹/);
  await assert.rejects(w.move({ from: '.', to: '根目录副本' }), /根目录/);
  assert.equal((await w.document('示例.html')).data.note, '原批注');
  assert.equal((await w.document('归档/示例.html')).id, other.id);
  assert.equal(await fs.readFile(path.join(root, '示例.html'), 'utf8'), original.source);
});
test('恢复外部重命名文件的批注', async (t) => {
  const { w, root } = await setup(t);
  const d = await w.document('示例.html');
  await w.saveData({ id: d.id, data: { ...d.data, note: '外部移动' } });
  await fs.rename(path.join(root, '示例.html'), path.join(root, '外部改名.html'));
  const renamed = await w.document('外部改名.html');
  assert.equal(renamed.id, d.id);
  assert.equal(renamed.data.note, '外部移动');
});
test('双栏会话在重启和目录移动后保留两篇文档，退出后清除布局', async (t) => {
  const { w, root } = await setup(t);
  await w.create({ path: '论文', kind: 'folder' });
  await w.create({ path: '论文/对照.html', kind: 'file' });
  await w.saveSession({
    paths: ['示例.html', '论文/对照.html'],
    active: '论文/对照.html',
    split: { left: '示例.html', right: '论文/对照.html' },
  });
  await w.move({ from: '论文', to: '归档' });
  const reopened = await new Workspace().open(root);
  assert.deepEqual(reopened.session, {
    paths: ['示例.html', '归档/对照.html'],
    active: '归档/对照.html',
    split: { left: '示例.html', right: '归档/对照.html' },
  });
  await w.saveSession({ paths: ['示例.html', '归档/对照.html'], active: '示例.html' });
  assert.equal((await new Workspace().open(root)).session.split, undefined);
  await w.saveSession({
    paths: ['示例.html'],
    active: '示例.html',
    split: { left: '示例.html', right: '不存在.html' },
  });
  assert.equal((await new Workspace().open(root)).session.split, undefined);
});
test('打开文档过多时明确提示，而不是报无效会话', async (t) => {
  const { w } = await setup(t);
  const paths = Array.from({ length: 101 }, (_, i) => `文档${i}.html`);
  await assert.rejects(w.saveSession({ paths, active: paths[0] }), /打开的文档过多/);
  await assert.rejects(w.saveSession({ paths: ['笔记.md'], active: '' }), /无效的阅读会话/);
});
test('阻止路径穿越、隐藏数据访问和外部符号链接', async (t) => {
  const { w, root } = await setup(t);
  await assert.rejects(w.document('../outside.html'), /项目内/);
  await assert.rejects(w.asset('.html-reader/workspace.json'), /内部文件/);
  await fs.symlink(os.tmpdir(), path.join(root, '外部链接'));
  await assert.rejects(w.resolve('外部链接'), /项目外/);
  await w.document('示例.html');
  await fs.symlink(path.join(root, '.html-reader'), path.join(root, '内部链接'));
  await assert.rejects(w.asset('内部链接/workspace.json'), /内部链接/);
});
test('并发批注写入按顺序完成，损坏数据不被静默重置', async (t) => {
  const { w, root } = await setup(t);
  const d = await w.document('示例.html');
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      w.saveData({ id: d.id, data: { ...d.data, note: `版本 ${i}` } }),
    ),
  );
  assert.equal((await w.document(d.path)).data.note, '版本 14');
  const file = path.join(root, '.html-reader', 'documents', d.id + '.json');
  await fs.writeFile(file, '{broken');
  await assert.rejects(w.document(d.path), /批注文件损坏/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});
test('删除使用可恢复的废纸篓操作并保留关联', async (t) => {
  const { w, root } = await setup(t);
  const d = await w.document('示例.html');
  await w.saveData({ id: d.id, data: { ...d.data, note: '可恢复' } });
  const trash = path.join(root, '.trash-test');
  await w.trash({ path: d.path }, (file) => fs.rename(file, trash));
  assert.equal((await w.summary()).tree.length, 0);
  await fs.rename(trash, path.join(root, d.path));
  assert.equal((await w.document(d.path)).data.note, '可恢复');
  await assert.rejects(
    w.trash({ path: '' }, () => {}),
    /根目录/,
  );
});

test('阅读会话持久化；拒绝恶意文档 ID，且失败不会切换项目', async (t) => {
  const { w, root } = await setup(t);
  await w.document('示例.html');
  await w.saveSession({ paths: ['示例.html'], active: '示例.html' });
  const fresh = new Workspace();
  const info = await fresh.open(root);
  assert.equal(info.session.active, '示例.html');
  const bad = path.join(root, '无效项目');
  await fs.mkdir(path.join(bad, '.html-reader'), { recursive: true });
  await fs.writeFile(
    path.join(bad, '.html-reader/workspace.json'),
    JSON.stringify({
      version: 1,
      files: { 'x.html': { id: '../../outside', hash: 'a'.repeat(64) } },
    }),
  );
  await assert.rejects(w.open(bad), /格式/);
  assert.equal(w.root, await fs.realpath(root));
});

test('旧原文笔记合并为高亮，保留所有内容、定位和身份，保存后重启不重复迁移', async (t) => {
  const { w, root } = await setup(t);
  const d = await w.document('示例.html');
  const quote = { exact: '原文', prefix: '', suffix: '这里', start: 0, end: 2 };
  const legacy = {
    ...d.data,
    note: '整篇文档的笔记',
    scroll: 312,
    zoom: 1.25,
    annotations: [
      {
        id: 'old',
        type: 'comment',
        color: '#ed737a',
        createdAt: 123,
        note: '旧笔记内容',
        quote,
        collapsed: false,
      },
      {
        id: 'missing',
        type: 'comment',
        color: '#369b8d',
        createdAt: 124,
        note: '原文消失也不能丢失',
        quote: { ...quote, exact: '被删除的原文' },
        orphan: true,
      },
      {
        id: 'highlight',
        type: 'highlight',
        color: '#edbd39',
        createdAt: 125,
        note: '同一段独立高亮',
        quote,
      },
      {
        id: 'page',
        type: 'comment',
        color: '#edbd39',
        createdAt: 126,
        note: '早期页面批注',
        points: [{ x: 80, y: 200 }],
        size: { width: 250, height: 180 },
      },
      {
        id: 'expanded',
        type: 'comment',
        color: '#edbd39',
        createdAt: 127,
        note: '展开的页面批注',
        points: [{ x: 360, y: 200 }],
        collapsed: false,
      },
    ],
  };
  const file = path.join(root, '.html-reader/documents', d.id + '.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = JSON.stringify(legacy);
  await fs.writeFile(file, original);
  const expected = {
    ...legacy,
    annotations: [
      { ...legacy.annotations[0], type: 'highlight' },
      { ...legacy.annotations[1], type: 'highlight' },
      legacy.annotations[2],
      { ...legacy.annotations[3], type: 'sticky', collapsed: true },
      { ...legacy.annotations[4], type: 'sticky' },
    ],
  };
  const merged = await w.document(d.path);
  assert.deepEqual(merged.data, expected);
  assert.equal(await fs.readFile(file, 'utf8'), original, '读取旧数据不改写原文件');
  await w.saveData({ id: d.id, data: merged.data });
  const fresh = new Workspace();
  await fresh.open(root);
  assert.deepEqual((await fresh.document(d.path)).data, expected);
  // Older callers also pass through the same conversion when saving.
  await fresh.saveData({ id: d.id, data: legacy });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), expected);
  assert.equal(await fs.readFile(path.join(root, d.path), 'utf8'), d.source);
});

test('PDF 二进制保持原样，批注、缩放与混合双栏随移动和重启恢复', async (t) => {
  const { w, root } = await setup(t);
  const bytes = Buffer.from('%PDF-1.7\n\x00\x80\xff binary fixture\n%%EOF', 'binary');
  await fs.writeFile(path.join(root, '资料.PDF'), bytes);
  const info = await w.summary();
  assert.equal(info.tree.find((f) => f.path === '资料.PDF').kind, 'pdf');
  const d = await w.document('资料.PDF');
  assert.equal(d.kind, 'pdf');
  assert.equal(d.source, '');
  assert.equal(d.version, require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  const data = {
    ...d.data,
    zoom: 1.37,
    scroll: 1250,
    note: 'PDF 阅读笔记',
    annotations: [
      {
        id: 'pdf-highlight',
        type: 'highlight',
        color: '#db374d',
        note: '原文笔记',
        quote: {
          exact: 'test',
          prefix: '',
          suffix: '',
          start: 0,
          end: 4,
          pdfRects: [{ page: 2, left: 50, top: 80, width: 100, height: 20 }],
        },
      },
    ],
  };
  await w.saveData({ id: d.id, data });
  await w.saveSession({
    paths: ['示例.html', '资料.PDF'],
    active: '资料.PDF',
    split: { left: '资料.PDF', right: '示例.html' },
  });
  await assert.rejects(
    w.saveSource({ path: '资料.PDF', source: '<h1>Oops</h1>', version: d.version }),
    /HTML/,
  );
  await assert.rejects(w.move({ from: '资料.PDF', to: '资料.html' }), /pdf/);
  await w.create({ path: 'PDF归档', kind: 'folder' });
  await w.move({ from: '资料.PDF', to: 'PDF归档/资料.pdf' });
  const fresh = new Workspace();
  await fresh.open(root);
  const again = await fresh.document('PDF归档/资料.pdf');
  assert.equal(again.id, d.id);
  assert.deepEqual(again.data, data);
  assert.deepEqual(await fs.readFile(path.join(root, 'PDF归档/资料.pdf')), bytes);
  assert.deepEqual((await fresh.summary()).session.split, {
    left: 'PDF归档/资料.pdf',
    right: '示例.html',
  });
});
