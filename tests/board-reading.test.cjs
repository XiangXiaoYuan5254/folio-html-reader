const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = buildSync({
  entryPoints: [path.join(__dirname, '../src/ai/board-reading.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text;
const compiled = { exports: {} };
new Function('module', 'exports', 'require', source)(compiled, compiled.exports, require);
const { splitReadingText, prepareBoardReading } = compiled.exports;
const options = (messages, extra = {}) => ({
  provider: { context: 128000, maxOutput: 0 },
  system: '白板老师',
  messages,
  question: '请说明最后一章的结论和具体数字。',
  signal: new AbortController().signal,
  progress: () => {},
  read: async () => ({ text: '阅读笔记', stopReason: 'stop' }),
  ...extra,
});
const body = (request) =>
  request.messages[0].content.split('<reading_part>\n')[1].split('\n</reading_part>')[0];

test('splitting preserves all characters, whitespace and order, even without line breaks', () => {
  for (const text of ['\n\n 开头 😀' + '中文🧑‍💻'.repeat(10000) + '\n 结尾\n', 'x'.repeat(100000)]) {
    const parts = splitReadingText(text, 1000);
    assert.ok(parts.length > 1);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every((s) => !/[\uD800-\uDBFF]$/.test(s)));
  }
});

test('ordinary documents beyond the old 24000-character cutoff pass through unchanged', async () => {
  const messages = [{ role: 'user', content: '字'.repeat(30000) + '全文末尾' }];
  const prepared = await prepareBoardReading(
    options(messages, { read: () => assert.fail('unnecessary summary') }),
  );
  assert.equal(prepared, messages);
});

test('long sources are read in full and source messages are never replaced with summaries', async () => {
  const content = '开头\n' + '原'.repeat(200000) + '\n最终数值 427';
  const messages = [{ role: 'user', content }];
  const chunks = [];
  const progress = [];
  const prepared = await prepareBoardReading(
    options(messages, {
      progress: (p) => progress.push(p),
      read: async (request) => {
        const part = body(request).replace(/^第 .*? 段：\n/, '');
        chunks.push(part);
        return { text: part.includes('427') ? '最终数值 427' : '其他章节', stopReason: 'stop' };
      },
    }),
  );
  assert.equal(chunks.join(''), content);
  assert.match(prepared[0].content, /最终数值 427/);
  assert.equal(messages[0].content, content);
  assert.equal(progress.length, chunks.length);
});

test('all scanned pages are processed in bounded batches, including after page 24', async () => {
  const images = Array.from({ length: 31 }, (_, n) => `page-${n + 1}`);
  const seen = [];
  await prepareBoardReading(
    options([{ role: 'user', content: '扫描书', images }], {
      read: async (request) => {
        const pageImages = request.messages[0].images || [];
        assert.ok(pageImages.length <= 6);
        seen.push(...pageImages);
        return { text: '扫描页笔记', stopReason: 'stop' };
      },
    }),
  );
  assert.deepEqual(seen, images);
});

test('large collections of notes are merged in additional rounds without dropping the tail', async () => {
  let count = 0;
  let merges = 0;
  const seenNotes = [];
  const prepared = await prepareBoardReading(
    options([{ role: 'user', content: '字'.repeat(230000) }], {
      read: async (request) => {
        const part = body(request);
        if (part.startsWith('第 ')) {
          const n = ++count;
          return { text: `NOTE_${n} ` + '记'.repeat(8000), stopReason: 'stop' };
        }
        merges++;
        seenNotes.push(...(part.match(/NOTE_\d+/g) || []));
        return { text: (part.match(/NOTE_\d+/g) || []).join(' '), stopReason: 'stop' };
      },
    }),
  );
  assert.ok(merges > 1);
  assert.deepEqual(
    seenNotes,
    Array.from({ length: count }, (_, i) => `NOTE_${i + 1}`),
  );
  assert.match(prepared[0].content, new RegExp(`NOTE_${count}`));
});

test('failed, incomplete or cancelled parts do not produce a successful final request', async () => {
  const messages = [{ role: 'user', content: '字'.repeat(100000) }];
  for (const result of [
    { text: '', stopReason: 'stop' },
    { text: '只读了一半', stopReason: 'length' },
  ]) {
    await assert.rejects(
      prepareBoardReading(options(messages, { read: async () => result })),
      /未完整处理/,
    );
  }
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(
    prepareBoardReading(
      options(messages, {
        signal: controller.signal,
        read: async () => {
          count++;
          controller.abort();
          return { text: '部分结果', stopReason: 'stop' };
        },
      }),
    ),
    { name: 'AbortError' },
  );
  assert.equal(count, 1);
  assert.equal(messages[0].content.length, 100000);
});
