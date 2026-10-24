const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const edge = require('../electron/edge-voice.cjs');
const { clientToken, generateToken } = require('../electron/edge-token.cjs');
const { createAi } = require('../electron/ai.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');

const voice = 'zh-CN-XiaoxiaoNeural';
function socket() {
  let instance;
  class Socket extends EventEmitter {
    sent = [];
    closed = false;
    terminated = false;
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      instance = this;
      queueMicrotask(() => this.emit('open'));
    }
    send(data, callback) {
      this.sent.push(data);
      callback?.();
    }
    close() {
      this.closed = true;
    }
    terminate() {
      this.terminated = true;
    }
  }
  return {
    Socket,
    get instance() {
      return instance;
    },
  };
}
function frame(audio) {
  const headers = Buffer.from('X-RequestId:example\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(headers.length);
  return Buffer.concat([length, headers, audio]);
}

test('Edge v2 tokens match the captured browser token and independent reference vectors', () => {
  // Browser capture: rany2/edge-tts#490, 2026-10-13 10:40 UTC. The other
  // vectors were checked against edge-tts 7.3.1, independent of this JS port.
  const vectors = [
    [
      1791887999.999,
      'DAAEAD2FD5438630-897933E9C951AADAA0A792FFD23FBB12339BBBBA71EA7BF84FFA0C777C3C9550',
    ],
    [
      1791888000,
      '492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876',
    ],
    [
      1791888299.999,
      '492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876',
    ],
    [
      1791888300,
      '6D26B5F5B70269AD-280E82E1BBE24E4E8866E3502EB6277B9436F61ABDC1C224518A038BBD7BBDAD',
    ],
    [
      2147483648,
      '96AE288915A09C99-EB52B45DB68387A1383783E40D42BBBD69D4DCCDF2540629BD4E7FB2E3287822',
    ],
  ];
  for (const [seconds, expected] of vectors) assert.equal(generateToken(seconds), expected);
  for (const seconds of [NaN, Infinity, -Infinity])
    assert.throws(() => generateToken(seconds), TypeError);
});

test('Edge connects to the read-aloud endpoint with v2 authentication and a fresh connection id', async (t) => {
  t.mock.method(Date, 'now', () => 1791888000000);
  const ids = new Set();
  for (let i = 0; i < 2; i++) {
    const fake = socket();
    const pending = edge.readAudio({ text: '你好。', voice, Socket: fake.Socket });
    const { url } = fake.instance;
    assert.equal(url.origin, 'wss://speech.platform.bing.com');
    assert.equal(url.pathname, '/consumer/speech/synthesize/readaloud/edge/v1');
    assert.equal(url.searchParams.get('TrustedClientToken'), clientToken);
    assert.equal(url.searchParams.get('Sec-MS-GEC-Version'), '2-143.0.3650.75');
    assert.equal(url.searchParams.get('Sec-MS-GEC'), generateToken(1791888000));
    assert.equal(url.searchParams.has('Ocp-Apim-Subscription-Key'), false);
    const id = url.searchParams.get('ConnectionId');
    assert.match(id, /^[a-f0-9]{32}$/);
    ids.add(id);
    fake.instance.emit('message', frame(Buffer.from([1, 2])), true);
    fake.instance.emit('message', Buffer.from('Path:turn.end\r\n\r\n'), false);
    await pending;
  }
  assert.equal(ids.size, 2);
});

test('Edge preserves literal text and joins binary audio only after turn.end', async () => {
  const fake = socket();
  const pending = edge.readAudio({ text: '原文：A < B & "你好"。', voice, Socket: fake.Socket });
  await Promise.resolve();
  const ws = fake.instance;
  assert.match(ws.sent[1], /原文：A &lt; B &amp; &quot;你好&quot;。/);
  assert.match(ws.sent[1], /name="zh-CN-XiaoxiaoNeural"/);
  ws.emit('message', frame(Buffer.from([1, 2])), true);
  ws.emit('message', frame(Buffer.from([3, 4])), true);
  ws.emit('message', Buffer.from('Path:turn.end\r\n\r\n'), false);
  assert.deepEqual(await pending, Buffer.from([1, 2, 3, 4]));
  assert.equal(ws.closed, true);
});

test('Edge rejects partial, empty and malformed audio instead of playing it', async () => {
  for (const kind of ['partial', 'empty', 'malformed']) {
    const fake = socket();
    const pending = edge.readAudio({ text: '你好。', voice, Socket: fake.Socket });
    const rejected = assert.rejects(pending, /中断|没有返回声音|不完整/);
    if (kind === 'partial') {
      fake.instance.emit('message', frame(Buffer.from([1, 2])), true);
      fake.instance.emit('close');
    } else if (kind === 'empty') {
      fake.instance.emit('message', Buffer.from('Path:turn.end\r\n\r\n'), false);
    } else fake.instance.emit('message', Buffer.from([0, 40, 1]), true);
    await rejected;
  }
});

test('Edge cancellation closes the connection and removes the abort listener', async () => {
  const fake = socket();
  const controller = new AbortController();
  const pending = edge.readAudio({
    text: '你好。',
    voice,
    Socket: fake.Socket,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /取消|超时/);
  assert.equal(fake.instance.terminated, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const never = class {
    constructor() {
      throw Error('should not connect');
    }
  };
  await assert.rejects(
    edge.readAudio({ text: '你好。', voice, Socket: never, signal: controller.signal }),
    /取消|超时/,
  );
  await assert.rejects(
    edge.readAudio({ text: '你好。', voice: 'invalid" voice', Socket: never }),
    /没有这个声音/,
  );
});

test('Edge reports service refusal and network failure', async () => {
  const fake = socket();
  const pending = edge.readAudio({ text: '你好。', voice, Socket: fake.Socket });
  fake.instance.emit(
    'unexpected-response',
    {},
    { statusCode: 429, headers: { 'retry-after': '2' }, resume() {} },
  );
  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retry, true);
    assert.equal(error.retryAfterMs, 2000);
    assert.equal(error.stage, 'connect');
    return true;
  });
  assert.equal(fake.instance.terminated, true);
  const another = socket();
  const failed = edge.readAudio({ text: '你好。', voice, Socket: another.Socket });
  another.instance.emit('error', Object.assign(Error('network'), { code: 'ECONNRESET' }));
  await assert.rejects(failed, { code: 'ECONNRESET', retry: true });
});

const cloud = require('../electron/cloud-voice.cjs');
const speak = (extra = {}) =>
  cloud.synthesize({
    service: cloud.serviceFor('edge'),
    voice,
    text: '保留当前句。',
    ...extra,
  });

test('Edge retries a transient failure and records recovery with the same request context', async (t) => {
  const events = [];
  let attempts = 0;
  t.mock.method(edge, 'synthesize', async () => {
    if (++attempts === 1)
      throw Object.assign(Error('connection reset'), {
        retry: true,
        code: 'ECONNRESET',
        stage: 'receive',
      });
    return { pcm: Buffer.from([1, 0]), rate: 24000 };
  });
  const sound = await speak({
    context: { request: 'req-1', board: 'board-1', textHash: 'text-1' },
    log: (event) => events.push(event),
  });
  assert.equal(sound.rate, 24000);
  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map((e) => e.event),
    ['start', 'retry', 'start', 'success'],
  );
  assert.equal(events[1].retryMs, 1000);
  assert.equal(events[1].code, 'ECONNRESET');
  assert.ok(events.every((e) => e.request === 'req-1' && e.board === 'board-1'));
  assert.equal(events.at(-1).attempt, 2);
});

test('Edge stops after three attempts, preserving the final failure instead of returning silence', async (t) => {
  const events = [];
  let attempts = 0;
  t.mock.method(edge, 'synthesize', async () => {
    attempts++;
    throw Object.assign(Error('超时'), { retry: true, code: 'ETIMEDOUT' });
  });
  await assert.rejects(speak({ log: (event) => events.push(event) }), { code: 'ETIMEDOUT' });
  assert.equal(attempts, 3);
  assert.deepEqual(
    events.filter((e) => e.event === 'retry').map((e) => e.retryMs),
    [1000, 2000],
  );
  assert.equal(events.at(-1).event, 'failed');
  assert.equal(events.at(-1).attempt, 3);
});

test('cancellation during backoff prevents another request and is logged as cancellation', async (t) => {
  let cancelled = false;
  let attempts = 0;
  const events = [];
  t.mock.method(edge, 'synthesize', async () => {
    attempts++;
    throw Object.assign(Error('network'), { retry: true });
  });
  const result = await speak({
    stale: () => cancelled,
    log: (event) => {
      events.push(event);
      if (event.event === 'retry') cancelled = true;
    },
  });
  assert.equal(result, null);
  assert.equal(attempts, 1);
  assert.equal(events.at(-1).event, 'cancelled');
});

test('non-retryable refusals and long server cooldowns are not retried', async (t) => {
  for (const error of [
    Object.assign(Error('403'), { status: 403, retry: false }),
    Object.assign(Error('429'), { status: 429, retry: true, retryAfterMs: 60000 }),
  ]) {
    let attempts = 0;
    t.mock.method(edge, 'synthesize', async () => {
      attempts++;
      throw error;
    });
    await assert.rejects(speak(), error);
    assert.equal(attempts, 1);
  }
});

test('Edge MP3 decodes to non-silent mono PCM for both existing players', async () => {
  const audio = await fs.readFile(path.join(__dirname, 'fixtures/edge-voice.mp3'));
  const sound = await edge.decodeAudio(audio);
  assert.equal(sound.rate, 24000);
  assert.ok(sound.pcm.length > 24000, 'at least half a second');
  assert.equal(sound.pcm.length % 2, 0);
  assert.ok(sound.pcm.some((v) => v !== 0));
  await assert.rejects(edge.decodeAudio(Buffer.from('not audio')), /无法播放/);
});

test('Edge is available without a key, and never receives another service key', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-edge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ai = createAi({
    file: path.join(dir, 'ai.json'),
    fetch,
    atomicWrite,
    protect: (v) => v,
    unprotect: (v) => v,
  });
  const service = (await ai.config()).speech.find((s) => s.id === 'edge');
  assert.equal(service.free, true);
  assert.equal(service.hasKey, false);
  assert.ok(service.voices.some((v) => v.id === voice));
  await assert.rejects(ai.saveSpeechKey({ service: 'edge', key: 'unneeded' }), /无需 API Key/);
  let called = 0;
  t.mock.method(edge, 'synthesize', async (options) => {
    called++;
    assert.equal(options.key, undefined);
    assert.equal(options.voice, voice);
    assert.equal(options.text, '你好。');
    return { pcm: Buffer.from([1, 0]), rate: 24000 };
  });
  const sound = await ai.speak({
    voice: `cloud:edge:${voice}`,
    text: '你好。',
    key: 'must-not-send',
  });
  assert.equal(sound.rate, 24000);
  assert.equal(called, 1);
  // Stale work is dropped before networking, even with no key.
  assert.equal(
    await ai.speak(
      { voice: `cloud:edge:${voice}`, text: '你好。', key: 'must-not-send' },
      () => true,
    ),
    null,
  );
  assert.equal(called, 1);
  await assert.rejects(ai.speak({ voice: 'cloud:edge:unknown', text: '你好。' }), /没有这个声音/);
  await assert.rejects(ai.speak({ voice: 'cloud:qwen:Cherry', text: '你好。' }), /API Key/);
});

test('hushing an in-flight Edge request cancels it and discards the result', async (t) => {
  let stale = false;
  let cancelled = false;
  t.mock.method(
    edge,
    'synthesize',
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(Error('cancelled'));
          },
          { once: true },
        );
        stale = true;
      }),
  );
  const cloud = require('../electron/cloud-voice.cjs');
  const result = await cloud.synthesize({
    service: cloud.serviceFor('edge'),
    voice,
    text: '你好。',
    stale: () => stale,
  });
  assert.equal(result, null);
  assert.equal(cancelled, true);
});
