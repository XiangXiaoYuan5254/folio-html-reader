const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  kindOf,
  renderMarkdownPage,
  renderImagePage,
  renderPage,
} = require('../electron/formats.cjs');
const { renderCodePage } = require('../electron/code-page.cjs');
const { renderWordPage } = require('../electron/word-page.cjs');
const { makeDocx } = require('./docx-fixture.cjs');
test('按扩展名认出各类文档，其余是普通文件', () => {
  const kinds = {
    'a.HTM': 'html',
    'b.pdf': 'pdf',
    'c.Markdown': 'markdown',
    'd.md': 'markdown',
    'e.jpeg': 'image',
    'f.SVG': 'image',
    '报告.DOCX': 'word',
    'g.txt': 'code',
    'src/main.py': 'code',
    'data.csv': 'code',
    Makefile: 'code',
    LICENSE: 'code',
    'h.mdx': null,
    md: null,
    '旧稿.doc': null,
    'x.zip': null,
    '.env': null,
  };
  assert.deepEqual(Object.fromEntries(Object.keys(kinds).map((p) => [p, kindOf(p)])), kinds);
});
test('代码页：按语言高亮，跨行的字符串每行各自闭合，行号不在正文里', () => {
  const page = renderCodePage(
    Buffer.from('def f(x):\n    """多行\n    说明"""\n\n    return x < 1  # 注释\n'),
    'a.py',
    'python',
  );
  assert.match(page, /<title>a\.py<\/title>/);
  assert.match(page, /Python · 5 行/);
  const lines = [...page.matchAll(/<span class="l">([\s\S]*?)\n<\/span>/g)].map((m) => m[1]);
  assert.equal(lines.length, 5);
  assert.match(lines[1], /<span class="hljs-string">&quot;&quot;&quot;多行<\/span>$/);
  assert.match(lines[2], /^<span class="hljs-string">    说明&quot;&quot;&quot;<\/span>$/);
  assert.equal(lines[3], '');
  assert.match(lines[4], /x &lt; <span class="hljs-number">1<\/span>/);
  assert.match(page, /counter\(line\)/);
});
test('文本页：GB18030 和 UTF-16 也能读出，.txt 按段落显示，二进制文件不显示', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a, 0x3c, 0x62, 0x3e]);
  const txt = renderCodePage(gbk, '小说.txt', 'text');
  assert.match(txt, /<pre class="text">中文\n&lt;b&gt;<\/pre>/);
  assert.doesNotMatch(txt, /class="l"/);
  const utf16 = Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);
  assert.match(renderCodePage(utf16, 'a.log', 'plain'), /<span class="l">中文\n<\/span>/);
  assert.match(renderCodePage(Buffer.from([1, 0, 2]), 'v.ts', 'typescript'), /不是文本文件/);
  assert.match(renderCodePage(Buffer.from(''), 'e.py', 'python'), /是空文件/);
});
test('CSV 页是一张表：引号里的逗号、引号和换行原样保留，第一行是表头', () => {
  const page = renderCodePage(
    Buffer.from('名称,说明\n"甲,乙","说 ""好""\n第二行"\n丙\n'),
    'a.csv',
    'csv',
  );
  assert.match(page, /<thead><tr><th>名称<\/th><th>说明<\/th><\/tr><\/thead>/);
  assert.match(page, /<td>甲,乙<\/td><td>说 "好"\n第二行<\/td>/);
  assert.match(page, /<tr><td>丙<\/td><td><\/td><\/tr>/);
  assert.match(page, /CSV · 2 行/);
  assert.match(
    renderCodePage(Buffer.from('a\tb\n1\t2\n'), 'a.tsv', 'tsv'),
    /<td>1<\/td><td>2<\/td>/,
  );
});
test('Word 页：标题、加粗、表格照常显示，居中和右对齐的段落保留对齐', async () => {
  const page = await renderWordPage(await makeDocx(), '报告.docx');
  assert.match(page, /<title>年度报告<\/title>/);
  assert.match(page, /<h1 class="title center">年度报告<\/h1>/);
  assert.match(page, /<h1>一、背景<\/h1>/);
  assert.match(page, /今年的<strong>重点<\/strong>是阅读。/);
  assert.match(page, /<td><p>页间<\/p><\/td><td><p>80%<\/p><\/td>/);
  assert.match(page, /<p class="right">2026 年 11 月<\/p>/);
  await assert.rejects(renderWordPage(Buffer.from('不是 zip'), '坏.docx'), /无法读取「坏\.docx」/);
});
test('renderPage 按文件类型选出页面', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-formats-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.py'), 'x = 1\n');
  await fs.writeFile(path.join(dir, 'b.docx'), await makeDocx());
  await fs.writeFile(path.join(dir, 'c.html'), '<p>原样</p>');
  assert.match(await renderPage('src/a.py', path.join(dir, 'a.py')), /data-folio-format="code"/);
  assert.match(await renderPage('b.docx', path.join(dir, 'b.docx')), /data-folio-format="word"/);
  assert.equal(await renderPage('c.html', path.join(dir, 'c.html')), '<p>原样</p>');
});
test('Markdown 页：去掉 front matter，标题取第一个一级标题，表格、任务列表和内嵌 HTML 照常显示', () => {
  const page = renderMarkdownPage(
    [
      '---',
      'title: 不显示',
      '---',
      '# 读书 <笔记> & 想法',
      '',
      '| 列 | 值 |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '- [ ] 待读',
      '- [x] 已读',
      '',
      '<mark>原样</mark> ![图](images/a%20b.png)',
    ].join('\n'),
    '笔记.md',
  );
  assert.match(page, /<title>读书 &lt;笔记&gt; &amp; 想法<\/title>/);
  assert.doesNotMatch(page, /不显示/);
  assert.match(page, /<table>/);
  assert.match(page, /<li class="task"><input type="checkbox" disabled> 待读/);
  assert.match(page, /<li class="task"><input type="checkbox" disabled checked> 已读/);
  assert.match(page, /<mark>原样<\/mark>/);
  assert.match(page, /<img src="images\/a%20b.png" alt="图">/);
  assert.match(renderMarkdownPage('只有正文', '笔记.md'), /<title>笔记\.md<\/title>/);
});
test('图片页按相对地址引用图片，文件名里的特殊字符被转义', () => {
  const page = renderImagePage('图集/封面 "1"#.svg');
  assert.match(
    page,
    /<img src="%E5%B0%81%E9%9D%A2%20%221%22%23\.svg" alt="封面 &quot;1&quot;#\.svg" class="vector">/,
  );
  assert.match(page, /<title>封面 &quot;1&quot;#\.svg<\/title>/);
});

test('源码预览里每个块记着它在 Markdown 原文中的起点，front matter 也算在内', () => {
  const source = '---\na: 1\n---\n# 标题\n\n段落\n\n- [ ] 待办\n- 普通\n\n```js\nx\n```\n';
  const page = renderMarkdownPage(source, 'a.md', { offsets: true });
  const starts = [...page.matchAll(/<(\w+)[^>]*data-folio-src="(\d+)"/g)].map(
    (m) => `${m[1]}:${source.slice(Number(m[2])).split('\n')[0]}`,
  );
  assert.deepEqual(starts, [
    'h1:# 标题',
    'p:段落',
    'ul:- [ ] 待办',
    'li:- [ ] 待办',
    'li:- 普通',
    'code:```js',
  ]);
  assert.match(page, /<li class="task" data-folio-src="\d+"><input type="checkbox" disabled> 待办/);
  assert.doesNotMatch(renderMarkdownPage(source, 'a.md'), /data-folio-src/);
});
test('很大的文本文件只读开头，在换行处截断，并说明只显示了一部分', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-formats-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // 9 MB of lines of 一 (3 bytes each in UTF-8), past the 8 MB read.
  const line = '一'.repeat(100000) + '\n';
  await fs.writeFile(path.join(dir, 'big.log'), line.repeat(31));
  const page = await renderPage('big.log', path.join(dir, 'big.log'));
  assert.match(page, /文件较大，只显示了前 \d+ 行/);
  assert.doesNotMatch(page, /�/);
  assert.ok(page.length < 3 * 1024 * 1024);
});
