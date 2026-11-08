const { test } = require('node:test');
const assert = require('node:assert/strict');
const { kindOf, renderMarkdownPage, renderImagePage } = require('../electron/formats.cjs');
test('按扩展名认出四种文档，其余是普通文件', () => {
  assert.deepEqual(
    ['a.HTM', 'b.pdf', 'c.Markdown', 'd.md', 'e.jpeg', 'f.SVG', 'g.txt', 'h.mdx', 'md'].map(kindOf),
    ['html', 'pdf', 'markdown', 'markdown', 'image', 'image', null, null, null],
  );
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
