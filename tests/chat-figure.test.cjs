// ```plot blocks in AI replies worked out into shapes, and drawings left out of plain text.
// ```svg blocks need a DOM and are covered by tests/chat-figures.e2e.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');

function load(file) {
  const source = buildSync({
    entryPoints: [path.join(__dirname, '../src/ai', file)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  const compiled = { exports: {} };
  new Function('module', 'exports', 'require', source)(compiled, compiled.exports, require);
  return compiled.exports;
}
const { chatFigure } = load('chat-figure.ts');
const { plainText } = load('plain.ts');

const curves = (fig) => fig.shapes.filter((s) => s.attrs['stroke-width'] === '3');
const areas = (fig) => fig.shapes.filter((s) => s.attrs['fill-opacity'] === '0.2');
const texts = (fig) => fig.shapes.filter((s) => s.tag === 'text').map((s) => s.text);

test('an integral picture: axes, the curve, and the shaded region under it', () => {
  const fig = chatFigure('plot', 'axes -1 3 -1 5\nplot x^2\narea x^2 | 0 2\ntext 1.4 0.6 | S');
  assert.deepEqual(fig.errors, []);
  assert.deepEqual(fig.box, [0, 0, 420, 300]);
  assert.equal(curves(fig).length, 1);
  assert.equal(areas(fig).length, 1);
  assert.match(areas(fig)[0].attrs.d, /Z$/);
  // The region is drawn before, so under, the curve.
  assert.ok(fig.shapes.indexOf(areas(fig)[0]) < fig.shapes.indexOf(curves(fig)[0]));
  assert.ok(texts(fig).includes('S'));
  assert.ok(texts(fig).includes('x') && texts(fig).includes('y'), 'axis names');
});

test('curves get colors of their own, and a color word at the end of a line wins', () => {
  const fig = chatFigure('plot', 'axes -3 3 -2 9\ny = x^2\nplot 2x + 1\nplot sin(x) green');
  const strokes = curves(fig).map((s) => s.attrs.stroke);
  assert.deepEqual(strokes, ['var(--board-blue)', 'var(--board-red)', 'var(--board-green)']);
});

test('the area between two curves', () => {
  const fig = chatFigure('plot', 'axes 0 1.2 0 1.2 equal\nplot x\nplot x^2\narea x, x^2 | 0 1');
  assert.deepEqual(fig.errors, []);
  assert.equal(areas(fig).length, 1);
  // equal axes: a square region gives a square-ish canvas, not the default 300 high.
  assert.ok(fig.box[3] > 300);
});

test('without axes, room is made for what is drawn', () => {
  const fig = chatFigure('plot', 'plot x^2\narea x^2 | 0 2');
  assert.deepEqual(fig.errors, []);
  assert.equal(curves(fig).length, 1);
  assert.equal(areas(fig).length, 1);
  // Tick labels show the y axis reaching past 4 = 2² and x reaching past 2.
  const numbers = texts(fig).map(Number).filter(Number.isFinite);
  assert.ok(Math.max(...numbers) >= 4);
});

test('a bad line is reported by number and the rest is still drawn', () => {
  const fig = chatFigure('plot', 'axes -2 2 -2 2\nplot x^2 +\nplot x');
  assert.equal(curves(fig).length, 1);
  assert.equal(fig.errors.length, 1);
  assert.match(fig.errors[0], /^第 2 行：/);
});

test('nothing drawable gives no shapes, so the code is shown instead', () => {
  const fig = chatFigure('plot', 'plot foo(x)');
  assert.equal(fig.shapes.length, 0);
  assert.equal(fig.errors.length, 1);
});

test('while a block is written, its last line waits until it is complete', () => {
  const partial = chatFigure('plot', 'axes -2 2 -2 2\nplot x\nplot x^', true);
  assert.deepEqual(partial.errors, []);
  assert.equal(curves(partial).length, 1);
});

test('space curves get space axes', () => {
  const fig = chatFigure('plot', 'curve3d cos(t), sin(t), t/4 | t 0 12.6');
  assert.deepEqual(fig.errors, []);
  assert.ok(texts(fig).includes('z'));
});

test('plain text has a mark where a drawing was, and keeps other code', () => {
  const text = [
    '三角形如下：',
    '```svg',
    '<svg viewBox="0 0 100 100"><polygon points="10,90 50,10 90,90"/></svg>',
    '```',
    '积分：',
    '```plot',
    'plot x^2',
    '```',
    '```js',
    'let a = 1;',
    '```',
  ].join('\n');
  const plain = plainText(text);
  assert.ok(!plain.includes('polygon') && !plain.includes('plot x^2'));
  assert.equal(plain.match(/［图］/g).length, 2);
  assert.ok(plain.includes('let a = 1;'));
  // A drawing still being written is left out too.
  assert.equal(plainText('看图：\n```plot\nplot x^2'), '看图：\n［图］');
});
