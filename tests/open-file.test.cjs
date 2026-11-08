const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { projectFor } = require('../electron/open-file.cjs');
async function tree(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-open-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of [
    '当前/章节/a.html',
    '论文/精读/b.HTM',
    '散落/c.html',
    '当前/.html-reader/d.html',
  ])
    await fs
      .mkdir(path.dirname(path.join(root, file)), { recursive: true })
      .then(() => fs.writeFile(path.join(root, file), '<h1>x</h1>'));
  return root;
}
test('访达打开的文件优先留在当前项目', async (t) => {
  const root = await tree(t);
  const current = path.join(root, '当前');
  assert.deepEqual(await projectFor(path.join(current, '章节/a.html'), current, [root]), {
    root: current,
    relative: '章节/a.html',
  });
});
test('不在当前项目时，选包含它的最内层最近项目，否则用文件所在文件夹', async (t) => {
  const root = await tree(t);
  const recent = [root, path.join(root, '论文'), '/不存在的项目'];
  assert.deepEqual(await projectFor(path.join(root, '论文/精读/b.HTM'), null, recent), {
    root: path.join(root, '论文'),
    relative: '精读/b.HTM',
  });
  assert.deepEqual(await projectFor(path.join(root, '散落/c.html'), path.join(root, '当前'), []), {
    root: path.join(root, '散落'),
    relative: 'c.html',
  });
});
test('隐藏文件夹里的文件不算在项目内，不支持的文件被拒绝', async (t) => {
  const root = await tree(t);
  const current = path.join(root, '当前');
  const hidden = path.join(current, '.html-reader/d.html');
  assert.deepEqual(await projectFor(hidden, current, []), {
    root: path.dirname(hidden),
    relative: 'd.html',
  });
  await fs.writeFile(path.join(root, 'notes.txt'), 'x');
  await assert.rejects(
    projectFor(path.join(root, 'notes.txt'), current, []),
    /只能打开 HTML、PDF、Markdown 或图片/,
  );
});
test('通过符号链接打开时按真实路径归属项目', async (t) => {
  const root = await tree(t);
  const link = path.join(root, '快捷方式.html');
  await fs.symlink(path.join(root, '当前/章节/a.html'), link);
  assert.deepEqual(await projectFor(link, path.join(root, '当前'), []), {
    root: path.join(root, '当前'),
    relative: '章节/a.html',
  });
});
test('命令行参数只取出能打开的文档，并按工作目录解析相对路径', () => {
  const { filesFromArgv } = require('../electron/open-file.cjs');
  const cwd = path.resolve('/工作目录');
  assert.deepEqual(
    filesFromArgv(
      [
        '页间.exe',
        '--allow-file-access-from-files',
        '.',
        '笔记.HTML',
        path.resolve('/资料/论文.pdf'),
        '读书笔记.md',
        '截图.JPG',
        'x.txt',
      ],
      cwd,
    ),
    [
      path.join(cwd, '笔记.HTML'),
      path.resolve('/资料/论文.pdf'),
      path.join(cwd, '读书笔记.md'),
      path.join(cwd, '截图.JPG'),
    ],
  );
  assert.deepEqual(filesFromArgv([path.resolve('/资料/a.html')], cwd), []);
});
test('Markdown 和图片也能从访达打开', async (t) => {
  const root = await tree(t);
  for (const name of ['笔记.md', '图.webp']) {
    await fs.writeFile(path.join(root, '当前', name), 'x');
    assert.deepEqual(await projectFor(path.join(root, '当前', name), path.join(root, '当前'), []), {
      root: path.join(root, '当前'),
      relative: name,
    });
  }
});
