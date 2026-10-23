const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSpeechLog } = require('../electron/speech-log.cjs');

test('speech logs serialize concurrent writes and exclude request bodies, keys and audio', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-speech-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs/speech.jsonl');
  const log = createSpeechLog(file);
  await Promise.all(
    Array.from({ length: 20 }, (_, attempt) =>
      log({
        event: 'retry',
        attempt,
        status: 429,
        code: 'HTTP_ERROR',
        textHash: 'abc',
        text: 'private text',
        key: 'secret-key',
        pcm: 'audio-bytes',
        headers: { Authorization: 'secret' },
      }),
    ),
  );
  const raw = await fs.readFile(file, 'utf8');
  const entries = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    entries.map((e) => e.attempt),
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert.equal(entries[0].status, 429);
  assert.ok(entries.every((e) => !Number.isNaN(Date.parse(e.time))));
  assert.doesNotMatch(raw, /private text|secret|audio-bytes|Authorization/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('speech logs rotate and a write failure cannot fail synthesis', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-speech-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'speech.jsonl');
  const log = createSpeechLog(file, 100);
  for (let i = 0; i < 12; i++) await log({ event: 'failed', attempt: i, message: '错误' });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['speech.jsonl', 'speech.jsonl.1']);
  assert.ok((await fs.stat(file)).size < 250);
  assert.ok((await fs.stat(`${file}.1`)).size < 250);
  t.mock.method(console, 'error', () => {});
  await createSpeechLog(path.join(file, 'cannot-write'))({ event: 'failed' });
  assert.equal(console.error.mock.callCount(), 1);
});
