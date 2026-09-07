const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const moduleContext = { exports: {} };
vm.runInNewContext(
  buildSync({
    entryPoints: ['src/reader/ink.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  }).outputFiles[0].text,
  { module: moduleContext, exports: moduleContext.exports },
);
const { erasePaths, inkPaths, smoothPoints } = moduleContext.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const p = (x, y = 0) => ({ x, y });

test('smoothed pen keeps endpoints and stays editable by the partial eraser', () => {
  const raw = [p(0), p(30, 60), p(60)];
  const smooth = plain(smoothPoints(raw));
  assert.deepEqual(smooth[0], raw[0]);
  assert.deepEqual(smooth.at(-1), raw.at(-1));
  assert.ok(Math.max(...smooth.map((p) => p.y)) <= 30.01);
  const cut = plain(erasePaths([smooth], p(30, -100), p(30, 100), 4));
  assert.equal(cut.length, 2);
  assert.deepEqual(cut[0][0], raw[0]);
  assert.deepEqual(cut[1].at(-1), raw.at(-1));
  assert.deepEqual(raw, [p(0), p(30, 60), p(60)]);
  assert.equal(smoothPoints(raw.slice(0, 1)).length, 1);
});

test('a circular eraser cuts only the middle of a sparse long stroke', () => {
  const original = [[p(0), p(100)]];
  const result = plain(erasePaths(original, p(50), p(50), 10));
  assert.deepEqual(result, [
    [p(0), p(40)],
    [p(60), p(100)],
  ]);
  assert.deepEqual(original, [[p(0), p(100)]]);
});
test('fast diagonal and perpendicular eraser drags leave no sampling gaps', () => {
  const result = plain(erasePaths([[p(0), p(100)]], p(50, -500), p(50, 500), 5));
  assert.equal(result.length, 2);
  assert.ok(Math.abs(result[0][1].x - 45) < 1e-8);
  assert.ok(Math.abs(result[1][0].x - 55) < 1e-8);
  const diagonal = plain(erasePaths([[p(0), p(100)]], p(0, -50), p(100, 50), 5));
  assert.equal(diagonal.length, 2);
  assert.ok(diagonal[0].at(-1).x < 43 && diagonal[1][0].x > 57);
});
test('no-hit erasing retains references; full erasing removes dots and segments', () => {
  const paths = [[p(0), p(10)], [p(20)]];
  assert.equal(erasePaths(paths, p(90), p(100), 5), paths);
  assert.deepEqual(plain(erasePaths(paths, p(-10), p(30), 4)), []);
});
test('erasing repeatedly never joins fragments back across an erased gap', () => {
  const first = erasePaths([[p(0), p(50), p(100)]], p(50), p(50), 10);
  const second = plain(erasePaths(first, p(20), p(20), 5));
  assert.deepEqual(second, [
    [p(0), p(15)],
    [p(25), p(40)],
    [p(60), p(100)],
  ]);
});
test('legacy rectangles and arrowheads are editable ink without changing saved originals', () => {
  const rect = { type: 'rectangle', points: [p(0), p(100, 60)] };
  const paths = inkPaths(rect);
  assert.equal(paths[0].length, 5);
  assert.ok(erasePaths(paths, p(50, -10), p(50, 70), 5).length >= 2);
  const arrow = inkPaths({ type: 'arrow', points: [p(0), p(100)] });
  assert.equal(arrow.length, 2);
  assert.equal(arrow[1].length, 3);
  assert.deepEqual(rect.points, [p(0), p(100, 60)]);
});
