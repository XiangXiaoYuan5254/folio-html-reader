const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { streamChat } = require('../electron/ai-providers.cjs');
const { createAi } = require('../electron/ai.cjs');
const { createAiLog } = require('../electron/ai-log.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');

const provider = {
  preset: 'zhipu',
  kind: 'openai',
  name: '模拟服务',
  baseUrl: 'https://example.invalid/v1',
  model: 'glm-5.3-flashx',
  effort: 'high',
};
const event = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const textEvent = (text) => event({ choices: [{ delta: { content: text } }] });
const finish = (reason = 'stop') => event({ choices: [{ delta: {}, finish_reason: reason }] });
const done = 'data: [DONE]\n\n';
function ask(body, options = {}) {
  const entries = [];
  const deltas = [];
  let calls = 0;
  const result = streamChat({
    provider,
    key: 'private-api-key',
    request: { messages: [{ role: 'user', content: 'private-prompt' }], ...options.request },
    signal: options.signal,
    onDelta: (d) => {
      deltas.push(d);
      options.onDelta?.(d);
    },
    onDiagnostic: (d) => {
      entries.push(d);
      return options.onDiagnostic?.(d);
    },
    fetch: async (...args) => {
      calls++;
      return options.fetch
        ? options.fetch(...args)
        : new Response(body, {
            headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'server-123' },
          });
    },
  });
  return { result, entries, deltas, calls: () => calls };
}

test('EOF without either completion signal fails, preserves deltas and never resends a partial answer', async () => {
  const run = ask(textEvent('先检查服务的'));
  await assert.rejects(run.result, { code: 'INCOMPLETE_STREAM' });
  assert.deepEqual(run.deltas, [{ text: '先检查服务的' }]);
  assert.equal(run.calls(), 1);
  const log = run.entries[0];
  assert.equal(log.end, 'incomplete');
  assert.equal(log.eof, true);
  assert.equal(log.done, false);
  assert.equal(log.finishReason, '');
  assert.equal(log.serverRequestId, 'server-123');
  assert.equal(log.textChars, 6);
  assert.equal(log.maxTokens, null);
});

test('completion markers, length limits and a final event without a newline are kept', async (t) => {
  for (const [name, suffix, reason, sawDone] of [
    ['both markers', finish() + done, 'stop', true],
    ['DONE only', done, '', true],
    ['finish only without newline', finish().trimEnd(), 'stop', false],
    ['DONE without newline', done.trimEnd(), '', true],
    ['length', finish('length') + done, 'max_tokens', true],
    ['filter', finish('content_filter') + done, 'refusal', true],
  ])
    await t.test(name, async () => {
      const run = ask(textEvent('完整回答。') + suffix, { request: { maxTokens: 4096 } });
      const result = await run.result;
      assert.equal(result.text, '完整回答。');
      assert.equal(result.stopReason, reason);
      assert.equal(run.entries[0].end, 'complete');
      assert.equal(run.entries[0].done, sawDone);
      assert.equal(run.entries[0].maxTokens, 4096);
      if (reason === 'max_tokens') assert.equal(run.entries[0].finishReason, 'length');
    });
});

test('UTF-8 and CRLF split across bytes, multiline events, final content and usage survive', async () => {
  const raw =
    ': keepalive\r\n\r\n' +
    textEvent('你好🙂').replaceAll('\n', '\r\n') +
    'data: {"id":"response-123",\r\ndata: "request_id":"request-456",' +
    '"choices":[{"delta":{"content":"最后一句。"},"finish_reason":"stop"}],' +
    '"usage":{"prompt_tokens":10,"completion_tokens":5}}';
  const bytes = new TextEncoder().encode(raw);
  let i = 0;
  const run = ask(
    new ReadableStream({
      pull(c) {
        if (i < bytes.length) c.enqueue(bytes.slice(i, ++i));
        else c.close();
      },
    }),
  );
  const result = await run.result;
  assert.equal(result.text, '你好🙂最后一句。');
  assert.equal(result.stopReason, 'stop');
  assert.equal(run.entries[0].bytes, bytes.length);
  assert.equal(run.entries[0].responseId, 'response-123');
  assert.equal(run.entries[0].responseRequestId, 'request-456');
  assert.equal(run.entries[0].outputTokens, 5);
});

test('malformed events cannot silently lose content, even with a completion marker', async (t) => {
  for (const suffix of [
    'data: {"choices":',
    'data: invalid\n\n' + finish() + done,
    'data: null\n\n' + done,
  ]) {
    await t.test(suffix, async () => {
      const run = ask(textEvent('已收到的文字') + suffix);
      await assert.rejects(run.result, { code: 'INVALID_STREAM_DATA' });
      assert.equal(run.entries[0].end, 'invalid_data');
      assert.equal(run.entries[0].invalidEvents, 1);
      assert.equal(run.calls(), 1);
    });
  }
});

test('read failures, silence and cancellation have distinct diagnostics and release the stream', async (t) => {
  for (const mode of ['read', 'idle', 'abort'])
    await t.test(mode, async () => {
      const controller = new AbortController();
      let sent = false;
      let cancelled = false;
      const body = new ReadableStream(
        {
          pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(new TextEncoder().encode(textEvent('收到了一半')));
            } else if (mode === 'read')
              c.error(Object.assign(new Error('private-network-details'), { code: 'ECONNRESET' }));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const run = ask(body, {
        signal: controller.signal,
        request: { idleMs: 15 },
        onDelta: () => {
          if (mode === 'abort') controller.abort();
        },
      });
      await assert.rejects(
        run.result,
        mode === 'abort'
          ? { name: 'AbortError' }
          : {
              code: mode === 'read' ? 'ECONNRESET' : 'STREAM_IDLE_TIMEOUT',
            },
      );
      assert.equal(run.calls(), 1);
      assert.equal(
        run.entries[0].end,
        { read: 'stream_error', idle: 'idle_timeout', abort: 'aborted' }[mode],
      );
      assert.equal(run.deltas[0].text, '收到了一半');
      assert.doesNotMatch(JSON.stringify(run.entries), /private-network-details/);
      if (mode !== 'read') assert.equal(cancelled, true);
    });
});

test('service-reported errors are distinct from a normal completion', async () => {
  const run = ask(
    textEvent('部分答案') + event({ error: { code: 1301, message: 'private-error-text' } }),
  );
  await assert.rejects(run.result, { code: 'PROVIDER_STREAM_ERROR' });
  assert.equal(run.entries[0].end, 'provider_error');
  assert.equal(run.entries[0].providerCode, '1301');
  assert.doesNotMatch(JSON.stringify(run.entries), /private-error-text/);
  const reported = ask(textEvent('部分答案') + finish('network_error') + done);
  await assert.rejects(reported.result, { code: 'PROVIDER_STREAM_ERROR' });
  assert.equal(reported.entries[0].finishReason, 'network_error');
});

test('HTTP retries and parameter fallbacks retain a separate diagnostic per attempt', async () => {
  let calls = 0;
  const run = ask('', {
    request: { maxTokens: 64000 },
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response('private gateway body', { status: 502 });
      if (calls === 2) return new Response('max_tokens exceeds maximum', { status: 400 });
      return new Response(textEvent('成功') + finish() + done);
    },
  });
  assert.equal((await run.result).text, '成功');
  assert.equal(run.entries.length, 3);
  assert.equal(new Set(run.entries.map((e) => e.attempt)).size, 3);
  assert.equal(run.entries.find((e) => e.status === 502).end, 'http_error');
  assert.equal(run.entries.find((e) => e.status === 400).end, 'fallback');
  assert.equal(run.entries.find((e) => e.status === 200).maxTokens, null);
  assert.doesNotMatch(JSON.stringify(run.entries), /private gateway body/);
});

test('logging failures cannot fail a successful answer', async () => {
  const run = ask(textEvent('成功') + finish() + done, {
    onDiagnostic: async () => {
      throw Error('disk full');
    },
  });
  assert.equal((await run.result).text, '成功');
});

test('chat correlates attempt logs and final request status without storing content or credentials', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-diagnostic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs/ai.jsonl');
  let body = textEvent('private-answer');
  const ai = createAi({
    file: path.join(dir, 'ai.json'),
    atomicWrite,
    protect: (k) => k,
    unprotect: (k) => k,
    fetch: async () => new Response(body),
    diagnosticLog: createAiLog(file),
    version: 'test-version',
  });
  await ai.saveProvider({ ...provider, key: 'private-api-key' });
  const deltas = [];
  await assert.rejects(
    ai.chat(
      { requestId: 'local-request-1', messages: [{ role: 'user', content: 'private-prompt' }] },
      (d) => deltas.push(d),
    ),
    { code: 'INCOMPLETE_STREAM' },
  );
  assert.equal(deltas[0].text, 'private-answer');
  body += finish('length') + done;
  await ai.chat({ requestId: 'local-request-2', messages: [] }, () => {});
  const raw = await fs.readFile(file, 'utf8');
  const entries = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    entries.map((e) => [e.request, e.event, e.end]),
    [
      ['local-request-1', 'stream-end', 'incomplete'],
      ['local-request-1', 'request-end', 'error'],
      ['local-request-2', 'stream-end', 'complete'],
      ['local-request-2', 'request-end', 'complete'],
    ],
  );
  assert.equal(entries[2].finishReason, 'length');
  assert.equal(entries[3].finishReason, 'max_tokens');
  assert.ok(entries.every((e) => e.model === provider.model && e.version === 'test-version'));
  assert.doesNotMatch(raw, /private-answer|private-prompt|private-api-key/);
});
