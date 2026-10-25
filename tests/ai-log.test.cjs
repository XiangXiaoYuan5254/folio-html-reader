const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAiLog } = require('../electron/ai-log.cjs');

test('AI logs serialize writes, retain boolean/null metadata and exclude content and credentials', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs/ai.jsonl');
  const log = createAiLog(file);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      log({
        event: 'stream-end',
        request: String(i),
        done: false,
        eof: true,
        maxTokens: null,
        text: 'private-content',
        reasoning: 'private-content',
        body: 'private-content',
        messages: ['private-content'],
        chunk: 'private-content',
        message: 'private-content',
        key: 'secret-key',
        headers: { Authorization: 'secret-key' },
        url: 'https://secret-key@example.org',
      }),
    ),
  );
  const raw = await fs.readFile(file, 'utf8');
  const entries = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    entries.map((e) => e.request),
    Array.from({ length: 20 }, (_, i) => String(i)),
  );
  assert.equal(entries[0].done, false);
  assert.equal(entries[0].eof, true);
  assert.equal(entries[0].maxTokens, null);
  assert.ok(entries.every((e) => !Number.isNaN(Date.parse(e.time))));
  assert.doesNotMatch(raw, /private-content|secret-key/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('AI logs rotate, bound field lengths, and recover after a write failure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ai.jsonl');
  const log = createAiLog(file, 100);
  for (let i = 0; i < 10; i++) await log({ event: 'stream-end', responseId: 'a'.repeat(1000) });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['ai.jsonl', 'ai.jsonl.1']);
  assert.ok((await fs.stat(file)).size < 400);
  assert.ok((await fs.stat(`${file}.1`)).size < 400);
  t.mock.method(console, 'error', () => {});
  const blocked = path.join(dir, 'blocked');
  await fs.writeFile(blocked, 'file in the way');
  const recovering = createAiLog(path.join(blocked, 'ai.jsonl'));
  await recovering({ event: 'request-end' });
  assert.equal(console.error.mock.callCount(), 1);
  await fs.rm(blocked);
  await recovering({ event: 'request-end' });
  assert.match(await fs.readFile(path.join(blocked, 'ai.jsonl'), 'utf8'), /request-end/);
});
