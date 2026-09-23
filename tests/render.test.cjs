const { test } = require('node:test');
const assert = require('node:assert/strict');
const { markSourceOffsets } = require('../electron/render.cjs');
function offsets(source) {
  return [...markSourceOffsets(source).matchAll(/<([\w-]+) data-folio-src="(\d+)"/g)].map(
    ([, name, at]) => [name, Number(at)],
  );
}
test('预览为每个开始标签标注源码位置', () => {
  const source =
    '<!doctype html><html><body><h1 class="a>b">标题</h1><img src=x /><p>段落</p></body></html>';
  for (const [name, at] of offsets(source))
    assert.equal(source.slice(at, at + name.length + 1), '<' + name);
  assert.deepEqual(
    offsets(source).map(([name]) => name),
    ['html', 'body', 'h1', 'img', 'p'],
  );
  assert.match(markSourceOffsets(source), /<img data-folio-src="\d+" src=x \/>/);
});
test('脚本、样式和注释里的尖括号不被标注', () => {
  const source =
    '<div><script>if (a<b) x("<p>")</script><style>a>b{}</style><!-- <span> --><textarea><i></textarea><em>ok</em></div>';
  assert.deepEqual(
    offsets(source).map(([name]) => name),
    ['div', 'script', 'style', 'textarea', 'em'],
  );
});
