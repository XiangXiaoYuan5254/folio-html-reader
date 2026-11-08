const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { buildSync } = require('esbuild');
const providers = require('../electron/ai-providers.cjs');
const { createAi } = require('../electron/ai.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');

// The TypeScript helpers shared with the reader, bundled for Node.
function load(entry) {
  const out = buildSync({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
  }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', out)(module, module.exports, require);
  return module.exports;
}
const { findQuote } = load('src/ai/quote-match.ts');
const { applyReply, parseEdits } = load('src/ai/edits.ts');
const { diffLines, hunks } = load('src/ai/diff.ts');
const { documentContext, chunkDocument, estimateTokens } = load('src/ai/context.ts');

// A minimal OpenAI-compatible server that streams whatever the test queues.
async function mockServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    requests.push(request);
    await handler(request, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}
const provider = (url, extra = {}) => ({
  id: 'p1',
  preset: 'deepseek',
  kind: 'openai',
  name: 'Mock',
  baseUrl: url,
  model: 'mock-model',
  context: 128000,
  thinking: 'auto',
  ...extra,
});

test('OpenAI-compatible streaming: text, reasoning, tool calls and usage', async () => {
  const server = await mockServer((req, res) =>
    sse(res, [
      { choices: [{ delta: { reasoning_content: '先想一想。' } }] },
      { choices: [{ delta: { content: '你好，' } }] },
      { choices: [{ delta: { content: '世界' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'search', arguments: '{"que' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"注意力"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      {
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100 },
      },
    ]),
  );
  try {
    const deltas = [];
    const result = await providers.streamChat({
      provider: provider(server.url),
      key: 'test-key',
      fetch,
      onDelta: (d) => deltas.push(d),
      request: {
        system: '系统',
        messages: [{ role: 'user', content: '问题' }],
        tools: [{ name: 'search', description: '', parameters: { type: 'object' } }],
      },
    });
    assert.equal(result.text, '你好，世界');
    assert.equal(result.reasoning, '先想一想。');
    assert.deepEqual(result.toolCalls, [
      { id: 'call_1', name: 'search', input: { query: '注意力' } },
    ]);
    assert.deepEqual(result.usage, { input: 120, output: 30, cached: 100 });
    assert.equal(result.stopReason, 'tool_calls');
    assert.ok(deltas.some((d) => d.text === '世界'));
    const sent = server.requests[0];
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer test-key');
    assert.equal(sent.body.model, 'mock-model');
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.messages[0], { role: 'system', content: '系统' });
    // With no level picked, the request says the model's default.
    assert.deepEqual(sent.body.thinking, { type: 'enabled' });
    assert.equal(sent.body.reasoning_effort, 'high');
    assert.equal(sent.body.tools[0].function.name, 'search');
  } finally {
    await server.close();
  }
});

test('HTTP errors become readable messages; rate limits are retried', async () => {
  let calls = 0;
  const server = await mockServer((req, res) => {
    calls++;
    if (req.headers.authorization !== 'Bearer good') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
    }
    if (calls < 4) {
      res.writeHead(429);
      return res.end('{"error":{"message":"slow down"}}');
    }
    sse(res, [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]);
  });
  try {
    await assert.rejects(
      providers.streamChat({
        provider: provider(server.url),
        key: 'bad',
        fetch,
        onDelta() {},
        request: { messages: [{ role: 'user', content: 'hi' }] },
      }),
      /API Key 无效.*Authentication Fails/,
    );
    const result = await providers.streamChat({
      provider: provider(server.url),
      key: 'good',
      fetch,
      onDelta() {},
      request: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(result.text, 'OK');
    assert.equal(calls, 4);
  } finally {
    await server.close();
  }
});

test('message conversion keeps tool turns and DeepSeek reasoning', () => {
  const messages = [
    { role: 'user', content: '找一下' },
    {
      role: 'assistant',
      content: '',
      reasoning: '需要搜索',
      toolCalls: [{ id: 'a', name: 'search', input: { query: 'x' } }],
    },
    { role: 'tool', toolCallId: 'a', content: '结果 A' },
    { role: 'assistant', content: '完成', toolCalls: [{ id: 'b', name: 'open', input: {} }] },
    { role: 'tool', toolCallId: 'b', content: '1' },
    { role: 'tool', toolCallId: 'c', content: '2', isError: true },
  ];
  const openai = providers.toOpenAIMessages('', messages, { echo: true, tools: [{}] });
  assert.equal(openai[1].content, null);
  assert.equal(openai[1].reasoning_content, '需要搜索');
  assert.equal(openai[1].tool_calls[0].function.arguments, '{"query":"x"}');
  assert.deepEqual(openai[2], { role: 'tool', tool_call_id: 'a', content: '结果 A' });
  // Without tools, reasoning is not sent back.
  assert.equal(
    providers.toOpenAIMessages('', messages, { echo: true })[1].reasoning_content,
    undefined,
  );
  const claude = providers.toAnthropicMessages(messages);
  assert.equal(claude.at(-1).role, 'user');
  assert.equal(claude.at(-1).content.length, 2, 'results of one turn share a message');
  assert.equal(claude.at(-1).content[1].is_error, true);
  assert.equal(claude[1].content[0].type, 'tool_use');
});

test('reasoning levels follow each service and model', () => {
  const p = (preset, effort = '', model = '', use) => ({ preset, effort, model, use });
  // Every request says its level: the one picked, else the model's default.
  assert.deepEqual(providers.effortParams(p('deepseek')), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  assert.deepEqual(providers.effortParams(p('deepseek', 'off')), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(providers.effortParams(p('deepseek', 'high')), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  assert.deepEqual(providers.effortParams(p('zhipu', 'on', 'glm-4.6')), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(providers.effortParams(p('zhipu', 'high', 'glm-5.2')), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  // A model that always thinks takes the level alone, and can't be turned off.
  assert.deepEqual(providers.effortParams(p('zhipu', 'low', 'glm-5.3-flash')), {
    reasoning_effort: 'low',
  });
  assert.deepEqual(providers.effortParams(p('zhipu', 'off', 'glm-5.3-flash')), {
    reasoning_effort: 'low',
  });
  assert.deepEqual(providers.effortParams(p('moonshot', 'low', 'kimi-k3')), {
    reasoning_effort: 'low',
  });
  assert.deepEqual(providers.effortParams(p('moonshot', 'low', 'kimi-k2.7-code')), {});
  assert.deepEqual(providers.effortParams(p('qwen', '', 'qwen3.8-flash')), {
    enable_thinking: true,
    reasoning_effort: 'high',
  });
  assert.deepEqual(providers.effortParams(p('qwen', '', 'qwen-plus')), { enable_thinking: false });
  assert.deepEqual(providers.effortParams(p('qwen', 'on', 'qwen3.7-plus')), {
    enable_thinking: true,
  });
  assert.deepEqual(providers.effortParams(p('qwen', 'medium', 'qwen3.8-flash')), {
    enable_thinking: true,
    reasoning_effort: 'medium',
  });
  assert.deepEqual(providers.effortParams(p('doubao', 'off', 'doubao-seed-2-1-turbo-260628')), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(providers.effortParams(p('xiaomi', '', 'mimo-v2.6-flash')), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(providers.effortParams(p('xiaomi', 'high', 'mimo-v2.6-pro')), {
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(providers.effortParams(p('xiaomi', 'off', 'mimo-v2.6-pro')), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(providers.effortParams(p('openai', 'high', 'gpt-4o')), {});
  assert.deepEqual(providers.effortParams(p('openai', 'high', 'gpt-5.5')), {
    reasoning_effort: 'high',
  });
  // A level the model doesn't have becomes the nearest it has; a model with none gets none.
  assert.deepEqual(providers.effortParams(p('openai', 'max', 'gpt-5.5')), {
    reasoning_effort: 'high',
  });
  assert.deepEqual(providers.effortParams(p('moonshot', 'high')), {});
  // With none picked, a part of the app starts at its own level.
  assert.deepEqual(providers.effortParams(p('zhipu', '', 'glm-5.3-flash', 'board')), {
    reasoning_effort: 'low',
  });
  assert.deepEqual(providers.effortParams(p('deepseek', '', 'deepseek-flash', 'translate')), {
    thinking: { type: 'disabled' },
  });
});

test('a level the model lacks becomes the nearest; parts start at their own', () => {
  const { levelFor } = providers;
  const glm = ['low', 'high', 'max'];
  const seed = ['off', 'low', 'medium', 'high'];
  const onOff = ['off', 'on'];
  // Picked: kept, or the nearest, thinking or not as picked, the higher of two as near.
  assert.equal(levelFor(glm, 'max', 'high', 'chat'), 'high');
  assert.equal(levelFor(seed, 'high', 'max', 'chat'), 'high');
  assert.equal(levelFor(glm, 'max', 'medium', 'chat'), 'high');
  assert.equal(levelFor(glm, 'max', 'off', 'chat'), 'low');
  assert.equal(levelFor(onOff, 'off', 'max', 'chat'), 'on');
  assert.equal(levelFor(onOff, 'off', 'low', 'board'), 'on');
  // None picked: chat at the default, translation at the least, explanations and the
  // whiteboard at the least that still thinks.
  assert.equal(levelFor(glm, 'max', '', 'chat'), 'max');
  assert.equal(levelFor(seed, 'high', '', 'translate'), 'off');
  assert.equal(levelFor(glm, 'max', '', 'translate'), 'low');
  assert.equal(levelFor(seed, 'high', '', 'board'), 'low');
  assert.equal(levelFor(['off', 'high', 'max'], 'max', '', 'explain'), 'high');
  assert.equal(levelFor(onOff, 'on', '', 'board'), 'off');
  assert.equal(levelFor([], '', 'high', 'chat'), '');
});

test('Qwen, Doubao and MiMo lists keep chat models, Qwen and Doubao only usable ones', async () => {
  // Each key is a preset, and gets that platform's list.
  const catalog = {
    qwen: [
      { id: 'qwen3.8-flash' },
      { id: 'qwen3.8-plus' },
      { id: 'qwen3.8-max-0902' },
      { id: 'qwen3.8-27b' },
      { id: 'qwen3-tts-flash' },
      { id: 'qwen3.7-max-preview' },
      { id: 'deepseek-v3.2' },
      { id: 'deepseek-v4-pro-0813' },
      { id: 'deepseek-v4-flash-0731' },
      { id: 'MiniMax/speech-2.8-hd' },
      { id: 'kimi-not-activated' },
      { id: 'glm-other-parameter-error' },
      { id: 'deepseek-r1-distill-qwen-7b' },
      { id: 'kimi-k3' },
      { id: 'wan2.6-t2i' },
    ],
    doubao: [
      { id: 'doubao-seed-open', domain: 'VLM' },
      { id: 'doubao-seed-closed', domain: 'LLM' },
      { id: 'doubao-seed-old', domain: 'LLM', status: 'Shutdown' },
      { id: 'doubao-seedream-5-0', domain: 'ImageGeneration' },
      { id: 'deepseek-v3-2-251201', domain: 'LLM' },
      { id: 'glm-5-3-flash-260828', domain: 'LLM' },
    ],
    xiaomi: [{ id: 'mimo-v2.6-pro' }, { id: 'mimo-v2.5-tts-voiceclone' }, { id: 'mimo-v2.5-asr' }],
  };
  const usable = [
    'qwen3.8-flash',
    'deepseek-v3.2',
    'deepseek-v4-pro-0813',
    'deepseek-v4-flash-0731',
    'doubao-seed-open',
    'deepseek-v3-2-251201',
  ];
  const server = await mockServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      if (usable.includes(req.body.model))
        return sse(res, [{ choices: [{ delta: { content: '1' } }] }]);
      if (req.body.model === 'qwen3.8-plus') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            error: { code: 'Model.AccessDenied', message: 'Model access denied.' },
          }),
        );
      }
      if (
        req.body.model === 'kimi-not-activated' ||
        req.body.model === 'glm-other-parameter-error'
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            error: {
              code: 'invalid_parameter_error',
              message:
                req.body.model === 'kimi-not-activated'
                  ? 'The product is not activated, please confirm that you have activated products and try again after activation.'
                  : 'Invalid max_tokens parameter',
            },
          }),
        );
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'ModelNotOpen', message: '未开通' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: catalog[req.headers.authorization.replace('Bearer ', '')] }));
  });
  try {
    const list = async (preset) =>
      (
        await providers.listModels({
          provider: provider(server.url, { preset }),
          key: preset,
          fetch,
        })
      ).map((m) => m.id);
    assert.deepEqual(await list('qwen'), [
      'deepseek-v3.2',
      'deepseek-v4-flash-0731',
      'deepseek-v4-pro-0813',
      'qwen3.8-flash',
    ]);
    assert.deepEqual(await list('doubao'), ['deepseek-v3-2-251201', 'doubao-seed-open']);
    assert.ok((await list('xiaomi')).includes('mimo-v2.6-pro'));
    assert.ok(!(await list('xiaomi')).some((id) => /tts|asr/.test(id)));
    assert.deepEqual(
      server.requests
        .filter((r) => r.body)
        .map((r) => r.body.model)
        .sort(),
      [
        'deepseek-v3-2-251201',
        'deepseek-v3.2',
        'deepseek-v4-flash-0731',
        'deepseek-v4-pro-0813',
        'doubao-seed-closed',
        'doubao-seed-open',
        'glm-5-3-flash-260828',
        'glm-other-parameter-error',
        'kimi-k3',
        'kimi-not-activated',
        'qwen3.8-flash',
        'qwen3.8-max-0902',
        'qwen3.8-plus',
      ],
    );
  } finally {
    await server.close();
  }
});

test('Qwen probes inspect streamed errors, reject unverified access and cancel after a reply', async () => {
  const cases = {
    'kimi-stream-error': [
      200,
      { error: { code: 'invalid_parameter_error', message: 'The product is not activated.' } },
    ],
    'qwen-quota-empty': [403, { error: { code: 'AllocationQuota.FreeTierOnly' } }],
    'deepseek-quota-empty': [403, { error: { code: 'insufficient_quota' } }],
    'qwen-rate-limited': [429, { error: { code: 'rate_limit_exceeded' } }],
    'qwen-unknown-parameter': [
      400,
      { error: { code: 'invalid_parameter_error', message: 'Invalid max_tokens' } },
    ],
    'qwen-json-error': [200, { error: { code: 'invalid_parameter_error' } }, 'json'],
    'qwen-json-ok': [200, { choices: [{ message: { content: '1' } }] }, 'json'],
    'qwen-empty': [200, null],
    'qwen-network': null,
    'qwen-thinking': [200, { choices: [{ delta: { reasoning_content: '1' } }] }],
  };
  const cancelled = new Set();
  const fakeFetch = async (url, init) => {
    if (url.endsWith('/models'))
      return Response.json({ data: Object.keys(cases).map((id) => ({ id })) });
    const model = JSON.parse(init.body).model;
    const entry = cases[model];
    if (!entry) throw new TypeError('Connection lost');
    const [status, value, format] = entry;
    if (status !== 200 || format === 'json') return Response.json(value, { status });
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          // A role-only delta is not proof of access; an error can follow it.
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'),
          );
          const event = value ? `data: ${JSON.stringify(value)}\n\n` : 'data: [DONE]\n\n';
          controller.enqueue(encoder.encode(event.slice(0, 12)));
          controller.enqueue(encoder.encode(event.slice(12)));
          // Leave it open to ensure probing stops at the first real answer/error.
        },
        cancel() {
          cancelled.add(model);
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const list = await providers.listModels({
    provider: provider('https://mock.invalid/v1', { preset: 'qwen' }),
    key: 'test',
    fetch: fakeFetch,
  });
  assert.deepEqual(
    list.map((m) => m.id),
    ['qwen-json-ok', 'qwen-thinking'],
  );
  assert.deepEqual([...cancelled].sort(), ['kimi-stream-error', 'qwen-empty', 'qwen-thinking']);
  const controller = new AbortController();
  await assert.rejects(
    providers.listModels({
      provider: provider('https://mock.invalid/v1', { preset: 'qwen' }),
      key: 'test',
      signal: controller.signal,
      fetch: async (url) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qwen-plus' }] });
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    }),
    { name: 'AbortError' },
  );
});

test('<think> tags from local models become reasoning', () => {
  const split = providers.thinkSplitter();
  const parts = ['<thi', 'nk>推理', '过程</th', 'ink>\n\n答案', '。'].map(split);
  assert.equal(parts.map((p) => p.reasoning).join(''), '推理过程');
  assert.equal(parts.map((p) => p.text).join(''), '答案。');
  const plain = providers.thinkSplitter();
  assert.equal(plain('直接回答').text, '直接回答');
});

test('settings store keeps keys out of the window and encrypted at rest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-'));
  const file = path.join(dir, 'ai.json');
  const ai = createAi({
    file,
    fetch,
    atomicWrite,
    protect: (k) => 'enc:' + Buffer.from(k).reverse().toString('base64'),
    unprotect: (v) => Buffer.from(v.slice(4), 'base64').reverse().toString(),
  });
  const { provider: saved, config } = await ai.saveProvider({
    preset: 'deepseek',
    key: 'sk-secret-1234',
  });
  assert.equal(saved.hasKey, true);
  assert.equal(saved.keyHint, 'sk-…1234');
  assert.equal(saved.model, 'deepseek-flash');
  assert.equal(config.active, saved.id);
  assert.ok(!JSON.stringify(config).includes('sk-secret'));
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('sk-secret'), 'key is not stored in plain text');
  // Updating other fields keeps the key.
  await ai.saveProvider({ id: saved.id, model: 'deepseek-v4-pro' });
  const server = await mockServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-secret-1234');
    sse(res, [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]);
  });
  try {
    await ai.saveProvider({ id: saved.id, baseUrl: server.url });
    const events = [];
    const result = await ai.chat(
      { requestId: 'r1', messages: [{ role: 'user', content: 'hi' }] },
      (e) => events.push(e),
    );
    assert.equal(result.text, 'OK');
    assert.equal(result.model, 'deepseek-v4-pro');
    assert.deepEqual(events, [{ type: 'ai-delta', requestId: 'r1', text: 'OK' }]);
    const tested = await ai.test({ id: saved.id });
    assert.equal(tested.ok, true);
  } finally {
    await server.close();
  }
  await assert.rejects(ai.saveProvider({ preset: 'custom', baseUrl: 'file:///etc' }), /http/);
  await ai.setPrefs({ consented: [saved.id], disabledRoots: ['/a'], language: 'zh' });
  assert.deepEqual((await ai.config()).prefs, {
    consented: [saved.id],
    disabledRoots: ['/a'],
    language: 'zh',
  });
  await ai.removeProvider({ id: saved.id });
  assert.equal((await ai.config()).providers.length, 0);
});

test('picked models are listed without asking the service; settings still get everything', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-'));
  const server = await mockServer((req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ data: [{ id: 'qwen-plus' }, { id: 'glm-5' }, { id: 'deepseek-v4-pro' }] }),
      );
    } else sse(res, [{ choices: [{ delta: { content: '1' }, finish_reason: 'stop' }] }]);
  });
  try {
    const ai = createAi({
      file: path.join(dir, 'ai.json'),
      fetch,
      atomicWrite,
      protect: (k) => k,
      unprotect: (v) => v,
    });
    const { provider: saved } = await ai.saveProvider({
      preset: 'qwen',
      baseUrl: server.url,
      key: 'sk-q',
      model: 'qwen-plus',
      picks: ['deepseek-v4-pro', ' deepseek-v4-pro', '', 'deepseek-v4-flash'],
    });
    assert.deepEqual(saved.picks, ['deepseek-v4-flash', 'deepseek-v4-pro']);
    // Other fields saved later keep the picks.
    await ai.saveProvider({ id: saved.id, name: '千问' });
    await ai.setUse({ use: 'translate', provider: saved.id, model: 'qwen-flash' });
    const picked = await ai.models({ id: saved.id });
    assert.deepEqual(
      picked.map((m) => m.id),
      ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen-flash', 'qwen-plus'],
      'the picks, with the models in use',
    );
    assert.ok(picked.every((m) => Array.isArray(m.efforts)));
    assert.equal(server.requests.length, 0, 'no list and no trial calls');
    const all = await ai.models({ id: saved.id, all: true });
    assert.deepEqual(
      all.map((m) => m.id),
      ['deepseek-v4-pro', 'glm-5', 'qwen-plus'],
    );
    assert.ok(server.requests.length > 1, 'the whole list is asked for and tried');
    // No picks: the whole list again.
    await ai.saveProvider({ id: saved.id, picks: [] });
    assert.deepEqual(
      (await ai.models({ id: saved.id })).map((m) => m.id),
      ['deepseek-v4-pro', 'glm-5', 'qwen-plus'],
    );
  } finally {
    await server.close();
  }
});

test('stopping a request resolves as stopped', async () => {
  const server = await mockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '慢' } }] })}\n\n`);
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-'));
  const ai = createAi({
    file: path.join(dir, 'ai.json'),
    fetch,
    atomicWrite,
    protect: (k) => 'txt:' + k,
    unprotect: (v) => v.slice(4),
  });
  try {
    await ai.saveProvider({ preset: 'custom', baseUrl: server.url, model: 'm', key: 'k' });
    const pending = ai.chat({ requestId: 'slow', messages: [{ role: 'user', content: 'x' }] }, () =>
      ai.cancel({ requestId: 'slow' }),
    );
    assert.deepEqual(await pending, { stopped: true });
  } finally {
    await server.close();
  }
});

test('thinking that stops is asked again beside it, and the first to answer is kept', async () => {
  const stalled = (signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('已停止'), { name: 'AbortError' })),
      ),
    );
  const later = (ms) => new Promise((r) => setTimeout(r, ms));
  // The first asking thinks and then stops for good; the second answers.
  let signals = [];
  let deltas = [];
  let result = await providers.resendingStuck(
    async ({ signal, onDelta }) => {
      const n = signals.push(signal);
      onDelta({ reasoning: `想${n}` });
      if (n === 1) return stalled(signal);
      onDelta({ text: '讲' });
      return { text: '讲', n };
    },
    { onDelta: (d) => deltas.push(d) },
    50,
  );
  assert.equal(result.n, 2);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(deltas, [
    { reasoning: '想1' },
    { resent: true },
    { reasoning: '想2' },
    { text: '讲' },
  ]);
  // One only slow goes on beside the second and is kept when it answers first.
  signals = [];
  deltas = [];
  result = await providers.resendingStuck(
    async ({ signal, onDelta }) => {
      const n = signals.push(signal);
      onDelta({ reasoning: `想${n}` });
      if (n === 2) return stalled(signal);
      await later(1400);
      onDelta({ text: '讲' });
      return { text: '讲', n };
    },
    { onDelta: (d) => deltas.push(d) },
    50,
  );
  assert.equal(result.n, 1);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(deltas.at(-1), { text: '讲' });
  // Nothing comes while a model thinks without showing it: that is not a stall.
  let asked = 0;
  await providers.resendingStuck(
    async ({ onDelta }) => {
      asked++;
      await later(1400);
      onDelta({ text: '讲' });
      return { text: '讲' };
    },
    { onDelta: () => {} },
    50,
  );
  assert.equal(asked, 1);

  // Only services whose thinking comes word by word are watched.
  const server = await mockServer((req, res) =>
    sse(res, [{ choices: [{ delta: { content: '好' } }] }]),
  );
  try {
    for (const [preset, watched] of [
      ['deepseek', true],
      ['openai', false],
    ]) {
      const seen = [];
      await providers.streamChat({
        provider: provider(server.url, { preset }),
        key: 'test-key',
        fetch,
        onDelta: (d) => seen.push(d),
        request: { messages: [{ role: 'user', content: '问题' }], resend: true },
      });
      assert.equal(seen[0].watch === 30_000, watched);
    }
  } finally {
    await server.close();
  }
});

test('quotes are found despite spacing, width, hyphenation and small slips', () => {
  const html = '第一段。Transformer 模型完全基于注意力机制，\n  摒弃了循环和卷积。第二段继续。';
  const found = findQuote(html, 'Transformer模型完全基于注意力机制， 摒弃了循环和卷积');
  assert.equal(
    html.slice(found.start, found.end),
    'Transformer 模型完全基于注意力机制，\n  摒弃了循环和卷积',
  );
  // PDF text loses the space between lines and keeps end-of-line hyphens.
  const pdf =
    'We propose a new simple network architecture, the Trans-former, based solelyon attention mechanisms.';
  const hit = findQuote(pdf, 'the Transformer, based solely on attention mechanisms');
  assert.equal(
    pdf.slice(hit.start, hit.end),
    'the Trans-former, based solelyon attention mechanisms',
  );
  assert.ok(findQuote('他说“你好”。', '他说"你好"'));
  assert.ok(findQuote('ＡＢＣ全角', 'ABC全角'));
  // One wrong word in the middle of a long quote still lands on the sentence.
  const long = '实验表明，在同样的训练预算下，这种结构在翻译任务上取得了明显更好的效果。';
  const slip = findQuote(
    long,
    '实验表明，在相同的训练预算下，这种结构在翻译任务上取得了明显更好的效果',
  );
  assert.ok(slip && slip.start === 0);
  assert.equal(findQuote(long, '完全不存在的一句话，用来确认不会误匹配'), null);
  const trimmed = findQuote(long, '…这种结构在翻译任务上…');
  assert.equal(long.slice(trimmed.start, trimmed.end), '这种结构在翻译任务上');
});

test('search/replace edits apply exactly, tolerate indentation, and report misses', () => {
  const source = '<html>\n  <body>\n    <h1>标题</h1>\n    <p>正文</p>\n  </body>\n</html>\n';
  const reply = [
    '把标题改成红色。',
    '<<<<<<< SEARCH',
    '<h1>标题</h1>',
    '=======',
    '<h1 style="color:red">标题</h1>',
    '>>>>>>> REPLACE',
    '<<<<<<< SEARCH',
    '<p>正文</p>',
    '</body>',
    '=======',
    '<p>正文</p>',
    '<p>新段落</p>',
    '</body>',
    '>>>>>>> REPLACE',
    '<<<<<<< SEARCH',
    '<footer>不存在</footer>',
    '=======',
    '',
    '>>>>>>> REPLACE',
  ].join('\n');
  const result = applyReply(source, reply);
  assert.equal(result.applied, 2);
  assert.equal(result.failed.length, 1);
  assert.ok(result.source.includes('<h1 style="color:red">标题</h1>'));
  assert.ok(result.source.includes('<p>新段落</p>'));
  assert.equal(result.explanation, '把标题改成红色。');
  const full = parseEdits('整页重写：\n```html\n<!doctype html><html><body>新</body></html>\n```');
  assert.ok(full.full.includes('<body>新</body>'));
  assert.equal(applyReply(source, '我不确定你想改什么').applied, 0);
});

test('Markdown 修改：查找替换照常，整篇重写时文件里的代码块不会截断它', () => {
  const source = '# 笔记\n\n第一段\n\n```js\nx = 1\n```\n';
  const edited = applyReply(
    source,
    '<<<<<<< SEARCH\n第一段\n=======\n第一段，补充一句。\n>>>>>>> REPLACE\n加了一句。',
    'markdown',
  );
  assert.equal(edited.source, '# 笔记\n\n第一段，补充一句。\n\n```js\nx = 1\n```\n');
  const whole = '# 新笔记\n\n```js\ny = 2\n```\n\n结尾\n';
  for (const fence of ['```', '````']) {
    const r = applyReply(
      source,
      `整篇重写：\n${fence}markdown\n${whole}${fence}\n改了标题。`,
      'markdown',
    );
    assert.equal(r.source, whole);
    assert.equal(r.explanation, '整篇重写：\n\n改了标题。');
  }
  // A code block that only shows Markdown is not taken for the whole file.
  assert.equal(applyReply(source, '比如：\n```\n- 列表\n```', 'markdown').applied, 0);
});

test('line diff marks additions and removals with folded context', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 5', 'line five').replace('line 20\n', '') + '\nline 30';
  const lines = diffLines(before, after);
  assert.deepEqual(
    lines.filter((l) => l.type !== 'same').map((l) => `${l.type}:${l.text}`),
    ['del:line 5', 'add:line five', 'del:line 20', 'add:line 30'],
  );
  const groups = hunks(lines, 2);
  assert.equal(groups.length, 3);
  assert.ok(groups[1].skippedBefore > 0);
  assert.deepEqual(diffLines('a', 'a'), [{ type: 'same', text: 'a', a: 1, b: 1 }]);
});

test('long documents are cut to the sections that match the question', () => {
  const pages = Array.from({ length: 60 }, (_, i) =>
    i === 41
      ? '这一页专门讨论位置编码与正弦函数的关系。'.repeat(20)
      : `第 ${i + 1} 页的普通内容。`.repeat(60),
  );
  const doc = { path: 'a.pdf', kind: 'pdf', title: 'A', text: pages.join('\n\n'), pages };
  assert.ok(estimateTokens(doc.text) > 20_000);
  const context = documentContext(doc, 8_000, '位置编码是怎么做的？');
  assert.equal(context.partial, true);
  assert.ok(context.text.includes('位置编码与正弦函数'));
  assert.ok(context.text.includes('[第 1 页]'), 'keeps the beginning');
  assert.ok(estimateTokens(context.text) < 9_000);
  const whole = documentContext({ ...doc, pages: pages.slice(0, 2), text: '' }, 100_000);
  assert.equal(whole.partial, false);
  const chunks = chunkDocument(doc, 3_000);
  assert.ok(chunks.length > 5 && chunks.every((c) => c.label.startsWith('第')));
});

test('Claude streaming through the Anthropic SDK: thinking, text, tool use, fallbacks', async () => {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '想一想' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '先搜索。' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"query":"位置编码"}' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 42, cache_read_input_tokens: 5 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  const server = await mockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [name, data] of events)
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  try {
    const deltas = [];
    const result = await providers.streamChat({
      provider: provider(server.url.replace(/\/v1$/, ''), {
        preset: 'anthropic',
        kind: 'anthropic',
        model: 'claude-opus-5',
      }),
      key: 'test-key',
      fetch,
      onDelta: (d) => deltas.push(d),
      request: {
        system: '系统说明',
        messages: [{ role: 'user', content: '问题' }],
        tools: [
          { name: 'search', description: '搜索', parameters: { type: 'object', properties: {} } },
        ],
      },
    });
    assert.equal(result.text, '先搜索。');
    assert.equal(result.reasoning, '想一想');
    assert.deepEqual(result.toolCalls, [
      { id: 'tu_1', name: 'search', input: { query: '位置编码' } },
    ]);
    assert.equal(result.stopReason, 'tool_use');
    assert.equal(result.raw[0].type, 'thinking', 'thinking blocks kept to send back');
    assert.ok(deltas.some((d) => d.tool === 'search'));
    const sent = server.requests[0];
    assert.equal(sent.url.split('?')[0], '/v1/messages');
    assert.equal(sent.headers['x-api-key'], 'test-key');
    assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(sent.body.fallbacks, 'default');
    assert.equal(sent.body.system, '系统说明');
    assert.deepEqual(sent.body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(sent.body.output_config, { effort: 'high' });
    assert.equal(sent.body.tools[0].input_schema.type, 'object');
  } finally {
    await server.close();
  }
});

// Chat asks with `web`; each service searches its own way, and others get nothing extra.
const webAsk = async (server, extra, request = {}) => {
  const deltas = [];
  const result = await providers.streamChat({
    provider: provider(server.url, extra),
    key: 'k',
    fetch,
    onDelta: (d) => deltas.push(d),
    request: { system: '系统', messages: [{ role: 'user', content: '问' }], web: true, ...request },
  });
  return { result, deltas, searches: deltas.filter((d) => d.search).map((d) => d.search) };
};

test('web search in chat: Qwen, MiMo, OpenRouter search themselves', async () => {
  // Cited pages, and OpenRouter's record of what it searched for.
  const server = await mockServer((req, res) =>
    sse(res, [
      { id: 'c1', choices: [{ delta: { content: '晴。' } }] },
      {
        id: 'c1',
        choices: [
          {
            delta: {
              annotations: [
                { type: 'url_citation', url_citation: { url: 'https://a.cn' } },
                { type: 'url_citation', url_citation: { url: 'https://a.cn' } },
                { type: 'url_citation', url_citation: { url: 'https://b.cn' } },
              ],
              ...(req.body.tools?.[0]?.type === 'openrouter:web_search' && {
                reasoning_details: [
                  {
                    type: 'reasoning.server_tool_call',
                    tool_name: 'openrouter:web_search',
                    tool_call_id: 'ws1',
                    arguments: '{"query":"上海天气"}',
                  },
                ],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      },
    ]),
  );
  try {
    await webAsk(server, { preset: 'qwen' });
    assert.equal(server.requests[0].body.enable_search, true);
    assert.equal(server.requests[0].body.tools, undefined);
    assert.match(server.requests[0].body.messages[0].content, /^系统\n\n你可以联网搜索/);
    const mimo = await webAsk(server, { preset: 'xiaomi' });
    assert.deepEqual(server.requests[1].body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(mimo.searches, [{ id: 'c1', title: '联网搜索：找到 2 个网页', done: true }]);
    const or = await webAsk(server, { preset: 'openrouter' });
    assert.deepEqual(server.requests[2].body.tools, [{ type: 'openrouter:web_search' }]);
    assert.deepEqual(or.searches, [{ id: 'ws1', title: '联网搜索：上海天气', done: true }]);
    // No web asked for, or a service without it: the request goes out as before.
    await webAsk(server, { preset: 'xiaomi' }, { web: false });
    await webAsk(server, { preset: 'siliconflow' });
    for (const r of server.requests.slice(3)) {
      assert.equal(r.body.tools, undefined);
      assert.equal(r.body.messages[0].content, '系统');
    }
  } finally {
    await server.close();
  }
});

test("web search in chat: a model the service can't search with answers anyway", async () => {
  const server = await mockServer((req, res) => {
    if (server.requests.length === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model does not support tool web_search' } }));
    } else sse(res, [{ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }]);
  });
  try {
    const { result } = await webAsk(server, { preset: 'xiaomi' });
    assert.equal(result.text, '好');
    assert.equal(server.requests[1].body.tools, undefined);
    // Nor do models that take no tools, where the app runs the searches.
    server.requests.length = 0;
    const kimi = await webAsk(server, { preset: 'moonshot' });
    assert.equal(kimi.result.text, '好');
    assert.equal(server.requests[1].body.tools, undefined);
    assert.equal(server.requests[1].body.messages[0].content, '系统');
  } finally {
    await server.close();
  }
});

test("web search in chat: Kimi's searches run here and the reply goes on", async () => {
  let round = 0;
  const call = (index, id, name, input) => ({
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id, type: 'function', function: { name, arguments: JSON.stringify(input) } },
          ],
        },
      },
    ],
  });
  const json = (res, value) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const server = await mockServer((req, res) => {
    if (req.url === '/v1/tools/search')
      return json(res, {
        search_results: [
          { title: '天气', url: 'https://w.cn', site_name: '天气网', snippet: '晴' },
        ],
      });
    if (req.url === '/v1/tools/fetch') return json(res, { markdown: '# 正文' });
    round++;
    if (round === 1)
      return sse(res, [
        { choices: [{ delta: { reasoning_content: '想', content: '我查一下。' } }] },
        call(0, 's1', 'web_search', { query: '上海天气' }),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    if (round === 2)
      // A page to open and one of the caller's own tools, in one step.
      return sse(res, [
        call(0, 'f1', 'web_fetch', { url: 'https://w.cn' }),
        call(1, 'r1', 'read_document', { path: 'a.html' }),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    return sse(res, [{ choices: [{ delta: { content: '晴。' }, finish_reason: 'stop' }] }]);
  });
  try {
    const tools = [{ name: 'read_document', description: '读', parameters: { type: 'object' } }];
    const first = await webAsk(server, { preset: 'moonshot' }, { tools });
    assert.equal(first.result.text, '我查一下。');
    assert.deepEqual(first.result.toolCalls, [
      { id: 'r1', name: 'read_document', input: { path: 'a.html' } },
    ]);
    assert.deepEqual(
      first.searches.map((s) => [s.title, s.done]),
      [
        ['联网搜索：上海天气', false],
        ['联网搜索：上海天气', true],
        ['打开网页：https://w.cn', false],
        ['打开网页：https://w.cn', true],
      ],
    );
    const search = server.requests.find((r) => r.url === '/v1/tools/search');
    assert.deepEqual(search.body, { text_query: '上海天气', limit: 8 });
    assert.equal(search.headers.authorization, 'Bearer k');
    const chats = () => server.requests.filter((r) => r.url === '/v1/chat/completions');
    assert.deepEqual(
      chats()[0].body.tools.map((t) => t.function.name),
      ['read_document', 'web_search', 'web_fetch'],
    );
    const second = chats()[1].body.messages;
    assert.equal(second.at(-2).reasoning_content, '想');
    assert.match(second.at(-1).content, /^1\. 天气\nhttps:\/\/w\.cn\n天气网\n晴$/);
    // The caller answers its own tool; the next request carries the turn's searches.
    const after = await webAsk(
      server,
      { preset: 'moonshot' },
      {
        tools,
        messages: [
          { role: 'user', content: '问' },
          { role: 'assistant', ...first.result, content: first.result.text },
          { role: 'tool', toolCallId: 'r1', content: '文档' },
        ],
      },
    );
    assert.deepEqual(
      chats()[2].body.messages.map(
        (m) => `${m.role}:${m.tool_call_id || (m.tool_calls || []).map((c) => c.id).join(',')}`,
      ),
      ['system:', 'user:', 'assistant:s1', 'tool:s1', 'assistant:f1,r1', 'tool:f1', 'tool:r1'],
    );
    assert.equal(after.result.text, '晴。');
  } finally {
    await server.close();
  }
});

test("web search in chat: GLM searches and reads pages through Zhipu's own APIs", async () => {
  const server = await mockServer((req, res) => {
    const json = (value) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/v1/web_search')
      return json({
        search_result: [
          { title: '论文', link: 'https://p.cn', media: '新智元', content: '被引 18 万次' },
        ],
      });
    if (req.url === '/v1/reader') return json({ reader_result: { content: '页面正文' } });
    if (server.requests.filter((r) => r.url === '/v1/chat/completions').length > 1)
      return sse(res, [
        { choices: [{ delta: { content: '约 18 万次。' }, finish_reason: 'stop' }] },
      ]);
    sse(res, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 's1',
                  function: { name: 'web_search', arguments: '{"query":"引用"}' },
                },
                {
                  index: 1,
                  id: 'f1',
                  function: { name: 'web_fetch', arguments: '{"url":"https://p.cn"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
  });
  try {
    const { result, searches } = await webAsk(server, { preset: 'zhipu' });
    assert.equal(result.text, '约 18 万次。');
    assert.deepEqual(
      searches.filter((s) => s.done).map((s) => s.title),
      ['联网搜索：引用', '打开网页：https://p.cn'],
    );
    const body = (url) => server.requests.find((r) => r.url === url).body;
    assert.deepEqual(body('/v1/web_search'), {
      search_query: '引用',
      search_engine: 'search_pro',
      search_intent: false,
      count: 8,
    });
    assert.deepEqual(body('/v1/reader'), { url: 'https://p.cn' });
    const second = server.requests.filter((r) => r.url === '/v1/chat/completions')[1].body;
    assert.deepEqual(
      second.messages.slice(-2).map((m) => m.content),
      ['1. 论文\nhttps://p.cn\n新智元\n被引 18 万次', '页面正文'],
    );
    // GLM's own built-in search isn't asked for.
    assert.ok(second.tools.every((t) => t.type === 'function'));
  } finally {
    await server.close();
  }
});

test("web search in chat: Claude's server tools, shown as steps; a paused turn goes on", async () => {
  const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const start = (id) =>
    ev('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
  const text = (index, t) =>
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index, delta: { type: 'text_delta', text: t } }) +
    ev('content_block_stop', { index });
  const end = (reason) =>
    ev('message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: 5 } }) +
    ev('message_stop');
  const server = await mockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (server.requests.length > 1) return res.end(start('m2') + text(0, '晴。') + end('end_turn'));
    res.end(
      start('m1') +
        text(0, '我查一下。') +
        ev('content_block_start', {
          index: 1,
          content_block: { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} },
        }) +
        ev('content_block_delta', {
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"query":"上海天气"}' },
        }) +
        ev('content_block_stop', { index: 1 }) +
        ev('content_block_start', {
          index: 2,
          content_block: { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
        }) +
        ev('content_block_stop', { index: 2 }) +
        end('pause_turn'),
    );
  });
  try {
    const { result, deltas, searches } = await webAsk(
      { url: server.url.replace(/\/v1$/, '') },
      { preset: 'anthropic', kind: 'anthropic', model: 'claude-opus-5' },
    );
    // What it writes after the search starts a new paragraph, as it streams and in the reply.
    assert.equal(result.text, '我查一下。\n\n晴。');
    assert.equal(deltas.map((d) => d.text || '').join(''), result.text);
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(
      searches.map((s) => [s.id, s.title, s.done]),
      [
        ['srv1', '联网搜索：上海天气', false],
        ['srv1', '联网搜索：上海天气', true],
      ],
    );
    const [one, two] = server.requests.map((r) => r.body);
    assert.deepEqual(one.tools, [
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'web_fetch_20260209', name: 'web_fetch' },
    ]);
    assert.match(one.system, /^系统\n\n你可以联网搜索/);
    assert.deepEqual(
      two.messages[1].content.map((b) => b.type),
      ['text', 'server_tool_use', 'web_search_tool_result'],
    );
    assert.deepEqual(two.messages[1].content[1].input, { query: '上海天气' });
  } finally {
    await server.close();
  }
});

test('web search in chat: DeepSeek goes through its Anthropic-compatible API', async () => {
  const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const server = await mockServer((req, res) => {
    if (req.url.endsWith('/chat/completions'))
      return sse(res, [{ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }]);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      ev('message_start', {
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }) +
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '晴。' } }) +
        ev('content_block_stop', { index: 0 }) +
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) +
        ev('message_stop'),
    );
  });
  // DeepSeek's own address, answered by the mock.
  const mock = new URL(server.url).origin;
  const ask = (extra, request = {}) =>
    providers.streamChat({
      provider: provider('https://api.deepseek.com', { preset: 'deepseek', ...extra }),
      key: 'k',
      fetch: (url, init) => fetch(String(url).replace('https://api.deepseek.com', mock), init),
      onDelta: () => {},
      request: {
        system: '系统',
        messages: [{ role: 'user', content: '问' }],
        web: true,
        ...request,
      },
    });
  try {
    const deepseek = { model: 'deepseek-flash' };
    const result = await ask(deepseek);
    assert.equal(result.text, '晴。');
    const sent = server.requests[0];
    assert.equal(sent.url.split('?')[0], '/anthropic/v1/messages');
    assert.equal(sent.headers['x-api-key'], 'k');
    assert.deepEqual(sent.body.tools, [{ type: 'web_search_20250305', name: 'web_search' }]);
    assert.match(sent.body.system, /^系统\n\n你可以联网搜索/);
    // DeepSeek's own level, with its thinking switched on, or off.
    assert.deepEqual(sent.body.thinking, { type: 'enabled' });
    assert.deepEqual(sent.body.output_config, { effort: 'high' });
    await ask({ ...deepseek, effort: 'off' });
    assert.deepEqual(server.requests[1].body.thinking, { type: 'disabled' });
    assert.equal(server.requests[1].body.output_config, undefined);
    // Without the web, or at another address (a proxy), its own API as before.
    await ask(deepseek, { web: false });
    assert.equal(server.requests[2].url, '/chat/completions');
    await webAsk(server, { preset: 'deepseek' });
    assert.equal(server.requests[3].url, '/v1/chat/completions');
    assert.equal(server.requests[3].body.tools, undefined);
  } finally {
    await server.close();
  }
});

// A stand-in for `codex app-server`: the same JSON-RPC lines, scripted replies.
const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const threads = {};
let buffer = '';
process.stdin.on('data', (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(m) + '\\n');
    if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
    if (m.method === 'account/read')
      out({ id: m.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
    if (m.method === 'model/list')
      out({
        id: m.id,
        result: {
          data: [
            { id: 'hidden', hidden: true },
            { id: 'gpt-b' },
            {
              id: 'gpt-a',
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
              defaultReasoningEffort: 'medium',
            },
          ],
        },
      });
    if (m.method === 'thread/start') {
      const id = 't' + (Object.keys(threads).length + 1);
      threads[id] = m.params;
      out({ id: m.id, result: { thread: { id } } });
    }
    if (m.method === 'turn/start') {
      const t = m.params.threadId;
      out({ id: m.id, result: { turn: { id: 'turn-' + t } } });
      const done = (text) => {
        for (const part of text.match(/.{1,3}/gu)) out({ method: 'item/agentMessage/delta', params: { threadId: t, turnId: 'turn-' + t, itemId: 'i', delta: part } });
        out({ method: 'thread/tokenUsage/updated', params: { threadId: t, turnId: 'turn-' + t, tokenUsage: { total: { inputTokens: 900, outputTokens: 20, cachedInputTokens: 100, reasoningOutputTokens: 5, totalTokens: 925 } } } });
        out({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1790000000 } } } });
        out({ method: 'turn/completed', params: { threadId: t, turn: { id: 'turn-' + t, status: 'completed', items: [] } } });
      };
      if (threads[t].dynamicTools) {
        out({ id: 9001, method: 'item/tool/call', params: { threadId: t, turnId: 'turn-' + t, callId: 'c1', tool: threads[t].dynamicTools[0].name, arguments: { path: 'a.html' } } });
        threads[t].finish = done;
      } else done('你好，世界');
    }
    if (m.id === 9001 && m.result) threads.t2.finish('读到了：' + m.result.contentItems[0].text);
  }
});
`;

test(
  'ChatGPT through Codex: handshake, streaming, tool calls answered mid-turn',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-codex-'));
    const bin = path.join(dir, 'codex');
    const log = path.join(dir, 'log.jsonl');
    await fs.writeFile(bin, fakeCodex, { mode: 0o755 });
    process.env.FOLIO_CODEX_PATH = bin;
    process.env.FAKE_CODEX_LOG = log;
    const codex = require('../electron/ai-codex.cjs');
    try {
      const status = await codex.status('1.0');
      assert.deepEqual(status.account, { type: 'chatgpt', plan: 'plus', email: '' });
      assert.deepEqual(
        (await codex.listModels('1.0')).map((m) => m.id),
        ['gpt-a', 'gpt-b'],
      );
      const deltas = [];
      const provider = { kind: 'codex', model: 'gpt-a', thinking: 'auto', effort: 'high' };
      const answer = await codex.streamCodex({
        provider,
        version: '1.0',
        onDelta: (d) => deltas.push(d),
        request: {
          system: '阅读助手说明',
          messages: [{ role: 'user', content: '你好' }],
        },
      });
      assert.equal(answer.text, '你好，世界');
      assert.equal(deltas.map((d) => d.text).join(''), '你好，世界');
      assert.deepEqual(answer.usage, { input: 900, output: 25, cached: 100 });
      assert.equal(answer.quota.usedPercent, 3);
      const tools = [
        { name: 'read_document', description: '读取', parameters: { type: 'object' } },
      ];
      const wire = [{ role: 'user', content: '读一下 a.html' }];
      const step = await codex.streamCodex({
        provider,
        version: '1.0',
        onDelta() {},
        request: { system: 's', messages: wire, tools },
      });
      assert.equal(step.stopReason, 'tool_use');
      assert.deepEqual(step.toolCalls, [
        { id: 'c1', name: 'read_document', input: { path: 'a.html' } },
      ]);
      wire.push({ role: 'assistant', content: '', toolCalls: step.toolCalls, raw: step.raw });
      wire.push({ role: 'tool', toolCallId: 'c1', content: '正文 A' });
      const end = await codex.streamCodex({
        provider,
        version: '1.0',
        onDelta() {},
        request: { system: 's', messages: wire, tools },
      });
      assert.equal(end.text, '读到了：正文 A');
      assert.equal(end.stopReason, 'stop');
      const lines = (await fs.readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const args = lines[0];
      assert.ok(args.includes('app-server'));
      for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins'])
        assert.ok(args.join(' ').includes(`--disable ${feature}`), feature);
      assert.ok(args.includes('mcp_servers={}'));
      const init = lines.find((m) => m.method === 'initialize');
      assert.equal(init.params.clientInfo.name, 'folio');
      const start = lines.find((m) => m.method === 'thread/start');
      assert.equal(start.params.baseInstructions, '阅读助手说明');
      assert.equal(start.params.sandbox, 'read-only');
      assert.equal(start.params.approvalPolicy, 'never');
      assert.equal(start.params.ephemeral, true);
      // The level picked, as picked.
      assert.equal(lines.find((m) => m.method === 'turn/start').params.effort, 'high');
      const toolStart = lines.filter((m) => m.method === 'thread/start')[1];
      assert.equal(toolStart.params.dynamicTools[0].name, 'read_document');
      const reply = lines.find((m) => m.id === 9001);
      assert.deepEqual(reply.result, {
        success: true,
        contentItems: [{ type: 'inputText', text: '正文 A' }],
      });
    } finally {
      codex.stop();
      delete process.env.FOLIO_CODEX_PATH;
    }
  },
);

test('earlier turns are flattened for a new Codex thread', () => {
  const { transcript } = require('../electron/ai-codex.cjs');
  assert.equal(transcript([{ role: 'user', content: '只有一句' }]), '只有一句');
  const text = transcript([
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]);
  assert.match(text, /【用户】\n第一问[\s\S]*【助手】\n第一答[\s\S]*---\n\n第二问$/);
});

test('replies saved on highlights lose their Markdown marks', () => {
  const { plainText } = load('src/ai/plain.ts');
  assert.equal(
    plainText(
      '### 要点\n\n**注意力**让每个词参考 *全句*，见 `QKV`。\n\n- 第一条<cite>原文</cite>\n- [链接](https://a.b)',
    ),
    '要点\n\n注意力让每个词参考 全句，见 QKV。\n\n• 第一条「原文」\n• 链接',
  );
});

test('pictures go to each service in its own format', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const jpeg = 'data:image/jpeg;base64,/9j/4AAQ';
  const messages = [
    { role: 'user', content: '这张图是什么？', images: [png, jpeg] },
    { role: 'assistant', content: '一张图表' },
    { role: 'user', content: '再看看' },
  ];
  const openai = providers.toOpenAIMessages('', messages, {});
  assert.deepEqual(openai[0].content, [
    { type: 'image_url', image_url: { url: png } },
    { type: 'image_url', image_url: { url: jpeg } },
    { type: 'text', text: '这张图是什么？' },
  ]);
  assert.equal(openai[2].content, '再看看', 'text-only turns stay plain strings');
  const claude = providers.toAnthropicMessages(messages);
  assert.deepEqual(claude[0].content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
  });
  assert.equal(claude[0].content[1].source.media_type, 'image/jpeg');
  assert.deepEqual(claude[0].content[2], { type: 'text', text: '这张图是什么？' });
  const { transcript, turnInput } = require('../electron/ai-codex.cjs');
  const input = turnInput([
    ...messages,
    { role: 'assistant', content: '好' },
    { role: 'user', content: '第三张', images: [png] },
  ]);
  assert.deepEqual(
    input.slice(0, 3),
    [png, jpeg, png].map((url) => ({ type: 'image', url })),
  );
  assert.match(
    input[3].text,
    /【用户】\n（附图 1、2）\n这张图是什么？[\s\S]*---\n\n（附图 3）\n第三张$/,
  );
  assert.equal(transcript([{ role: 'user', content: '看图', images: [png] }]), '（附图 1）\n看图');

  // A service that can't read pictures says so in words.
  const server = await mockServer((_, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'image_url is not supported by this model' } }));
  });
  try {
    await assert.rejects(
      providers.streamChat({
        provider: provider(server.url, { preset: 'custom' }),
        key: 'k',
        request: { messages: [messages[0]] },
        onDelta: () => {},
        fetch,
      }),
      /mock-model 不能看图/,
    );
  } finally {
    await server.close();
  }
});

test('which models can look at pictures', () => {
  const { seesImages } = load('src/ai/images.ts');
  const p = (preset, kind, model) => ({ preset, kind, model });
  assert.equal(seesImages(p('deepseek', 'openai', 'deepseek-v4-pro')), false);
  assert.equal(seesImages(p('qwen', 'openai', 'qwen-plus')), false);
  assert.equal(seesImages(p('qwen', 'openai', 'qwen-vl-max')), true);
  assert.equal(seesImages(p('openai', 'openai', 'gpt-4o')), true);
  assert.equal(seesImages(p('openai', 'openai', 'o3-mini')), false);
  assert.equal(seesImages(p('zhipu', 'openai', 'glm-4.5v')), true);
  assert.equal(seesImages(p('zhipu', 'openai', 'glm-4.6')), false);
  assert.equal(seesImages(p('zhipu', 'openai', 'glm-5.3')), false);
  assert.equal(seesImages(p('zhipu', 'openai', 'glm-5.3-flash')), true);
  assert.equal(seesImages(p('zhipu', 'openai', 'glm-5.3-flashx')), true);
  assert.equal(seesImages(p('zhipu', 'openai', 'glm-5v-turbo')), true);
  assert.equal(seesImages(p('xiaomi', 'openai', 'mimo-v2.6-flash')), true);
  assert.equal(seesImages(p('xiaomi', 'openai', 'mimo-v2.5-pro')), undefined);
  assert.equal(seesImages(p('ollama', 'openai', 'qwen2.5vl:7b')), true);
  assert.equal(seesImages(p('openrouter', 'openai', 'anthropic/claude-sonnet-4')), true);
  assert.equal(seesImages(p('anthropic', 'anthropic', 'claude-opus-5')), true);
  assert.equal(seesImages(p('custom', 'openai', 'my-model')), undefined);
  // What a service reports about a model wins.
  assert.equal(
    seesImages(p('codex', 'codex', 'gpt-x'), [{ id: 'gpt-x', efforts: [], images: false }]),
    false,
  );
});

test('pictures are held back only from a model known not to take them', async () => {
  const { seesImages, refusesImages } = load('src/ai/images.ts');
  const listed = [{ id: 'glm-4.6', efforts: [], images: true }];
  const zhipu = { preset: 'zhipu', kind: 'openai', model: 'glm-4.6' };
  // A name's guess draws the menu's icon but never stops a picture.
  assert.equal(refusesImages(zhipu), false);
  assert.equal(seesImages(zhipu, listed), true);
  assert.equal(refusesImages(zhipu, [{ ...listed[0], images: false }]), true);
  // The reader's setting, or a refusal remembered there, beats the list.
  const set = { ...zhipu, vision: { 'glm-4.6': false } };
  assert.equal(seesImages(set, listed), false);
  assert.equal(refusesImages(set, listed), true);
  assert.equal(refusesImages({ ...zhipu, vision: { 'glm-4.6': true } }), false);

  // Model lists that say which models take images.
  const lists = {
    '/v1/models': {
      data: [
        { id: 'a/text', architecture: { input_modalities: ['text'] } },
        { id: 'b/eyes', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'kimi-k3', supports_image_in: true },
        { id: 'plain' },
      ],
    },
    '/api/v0/models': { data: [{ id: 'plain', type: 'vlm' }] },
  };
  const server = await mockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/show')
      return res.end(
        JSON.stringify({
          capabilities: req.body.model === 'kimi-k3' ? ['completion'] : ['completion', 'vision'],
        }),
      );
    res.end(JSON.stringify(lists[req.url] || {}));
  });
  try {
    const list = (preset) =>
      providers.listModels({ provider: provider(server.url, { preset }), key: 'k', fetch });
    assert.deepEqual(await list('openrouter'), [
      { id: 'a/text', images: false },
      { id: 'b/eyes', images: true },
      { id: 'kimi-k3', images: true },
      { id: 'plain' },
    ]);
    assert.deepEqual(
      (await list('lmstudio')).find((m) => m.id === 'plain'),
      { id: 'plain', images: true },
    );
    const ollama = await list('ollama');
    assert.equal(ollama.find((m) => m.id === 'kimi-k3').images, false);
    assert.equal(ollama.find((m) => m.id === 'plain').images, true);
  } finally {
    await server.close();
  }

  // Sending pictures teaches whether a model takes them.
  let refuse = true;
  const service = await mockServer((req, res) => {
    if (!refuse) return sse(res, [{ choices: [{ delta: { content: '一张图' } }] }]);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'image input is not supported' } }));
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-'));
  const ai = createAi({
    file: path.join(dir, 'ai.json'),
    fetch,
    atomicWrite,
    protect: (k) => 'txt:' + k,
    unprotect: (v) => v.slice(4),
  });
  try {
    const { provider: saved } = await ai.saveProvider({
      preset: 'zhipu',
      baseUrl: service.url,
      model: 'glm-x',
      key: 'k',
    });
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const ask = () =>
      ai.chat(
        { requestId: 'r', messages: [{ role: 'user', content: '看', images: [png] }] },
        () => {},
      );
    await assert.rejects(ask(), /glm-x 不能看图/);
    assert.deepEqual((await ai.config()).providers[0].vision, { 'glm-x': false });
    await ai.saveProvider({ id: saved.id, name: '改名' });
    assert.deepEqual((await ai.config()).providers[0].vision, { 'glm-x': false });
    refuse = false;
    await ai.setActive({ id: saved.id, model: 'glm-y' });
    await ask();
    assert.deepEqual((await ai.config()).providers[0].vision, { 'glm-x': false, 'glm-y': true });
  } finally {
    await service.close();
  }
});

// A stand-in for the Kimi Code CLI: `kimi acp` speaks the same ACP lines with scripted
// replies, and calls 页间's tools over MCP the way the CLI does; `kimi provider list` lists
// the account.
const fakeKimi = `#!/usr/bin/env node
const fs = require('node:fs');
const log = (m) => fs.appendFileSync(process.env.FAKE_KIMI_LOG, JSON.stringify(m) + '\\n');
const args = process.argv.slice(2);
log({ args, home: process.env.KIMI_CODE_HOME });
// The CLI's web service: the account's usage and profile, behind the service's own key.
if (args[0] === 'web') {
  fs.writeFileSync(process.env.KIMI_CODE_HOME + '/server.token', 'svc');
  require('node:http').createServer((req, res) => {
    log({ web: req.url, auth: req.headers.authorization });
    const data = req.url.includes('usage')
      ? { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.045, resetAt: '2026-10-04T10:39:40Z' }, limit7d: { usedRatio: 0.009 } }, extraUsage: null } }
      : { kind: 'ok', userInfo: { nickname: '登月者', userLevelName: 'Moderato' } };
    res.end(JSON.stringify({ code: 0, msg: 'success', data }));
  }).listen(Number(args[3]), '127.0.0.1', () => console.log('  Local:    http://127.0.0.1:' + args[3] + '/#token=svc'));
  return;
}
if (args[0] === 'provider') {
  process.stdout.write(JSON.stringify({
    providers: { 'managed:kimi-code': { baseUrl: process.env.FAKE_KIMI_BASE, oauth: { key: 'oauth/kimi-code' } } },
    models: {
      'kimi-code/kimi-for-coding': { provider: 'managed:kimi-code', model: 'kimi-for-coding', capabilities: ['thinking', 'always_thinking', 'image_in'], supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
      'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3', capabilities: ['thinking', 'always_thinking', 'image_in'], supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      'kimi-code/fast': { provider: 'managed:kimi-code', model: 'fast', capabilities: ['thinking'] },
    },
  }));
  process.exit(0);
}
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const sessions = {};
const waiting = {};
let next = 1;
const say = (sessionId, kind, text) => out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } } });
async function mcp(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }) });
  const body = await response.text();
  return JSON.parse(response.headers.get('content-type').includes('event-stream') ? /^data: (.*)$/m.exec(body)[1] : body).result;
}
let buffer = '';
process.stdin.on('data', async (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    log(m);
    if (m.id !== undefined && !m.method) { waiting[m.id]?.(m.result); continue; }
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '9.9.9' } } });
    if (m.method === 'session/list') out({ id: m.id, result: { sessions: [] } });
    if (m.method === 'session/new') {
      const id = 's' + (Object.keys(sessions).length + 1);
      sessions[id] = m.params;
      const server = m.params.mcpServers[0];
      if (server) {
        await mcp(server.url, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'kimi' } });
        sessions[id].tools = (await mcp(server.url, 'tools/list', {})).tools;
      }
      out({ id: m.id, result: { sessionId: id, configOptions: [{ id: 'model', currentValue: 'kimi-code/kimi-for-coding' }] } });
    }
    if (m.method === 'session/set_config_option' || m.method === 'session/delete') out({ id: m.id, result: {} });
    if (m.method === 'session/prompt') {
      const id = m.params.sessionId;
      const tool = sessions[id].tools?.[0];
      if (!tool) {
        say(id, 'agent_thought_chunk', '想一想');
        for (const part of ['你好', '，世界']) say(id, 'agent_message_chunk', part);
        out({ id: m.id, result: { stopReason: 'end_turn' } });
        continue;
      }
      // The CLI's own tool is turned down, 页间's goes ahead.
      const ask = (title, n) => new Promise((resolve) => { waiting[n] = resolve; out({ id: n, method: 'session/request_permission', params: { sessionId: id, toolCall: { title }, options: [{ optionId: 'approve_once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } }); });
      await ask('Bash', 9001);
      await ask('mcp__folio__' + tool.name, 9002);
      say(id, 'agent_message_chunk', '我读一下。');
      const result = await mcp(sessions[id].mcpServers[0].url, 'tools/call', { name: tool.name, arguments: { path: 'a.html' } });
      say(id, 'agent_message_chunk', '读到了：' + result.content[0].text);
      out({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  }
});
`;

test(
  'Kimi membership through the Kimi Code CLI: models, streaming, 页间 tools over MCP',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-kimi-'));
    const bin = path.join(dir, 'kimi');
    const log = path.join(dir, 'log.jsonl');
    const home = path.join(dir, 'home');
    await fs.writeFile(bin, fakeKimi, { mode: 0o755 });
    process.env.FOLIO_KIMI_PATH = bin;
    process.env.FAKE_KIMI_LOG = log;
    const kimi = require('../electron/ai-kimi.cjs');
    try {
      const models = await kimi.listModels(home);
      assert.deepEqual(
        models.map((m) => [m.id, m.efforts.join(' '), m.defaultEffort]),
        [
          ['kimi-for-coding', 'low high max', 'max'],
          ['k3', 'low high max', 'high'],
          ['fast', 'off on', 'on'],
        ],
      );
      const agent = await fs.readFile(path.join(home, 'agents/agent.md'), 'utf8');
      assert.match(agent, /override: true/);
      assert.match(agent, /tools: mcp__folio__\*/);
      const deltas = [];
      const provider = { kind: 'kimi', model: 'k3', effort: 'low' };
      const answer = await kimi.streamKimi({
        provider,
        home,
        version: '1.0',
        onDelta: (d) => deltas.push(d),
        request: { system: '阅读助手说明', messages: [{ role: 'user', content: '你好' }] },
      });
      assert.equal(answer.text, '你好，世界');
      assert.equal(answer.reasoning, '想一想');
      assert.equal(deltas.map((d) => d.text || '').join(''), '你好，世界');
      const tools = [
        { name: 'read_document', description: '读取', parameters: { type: 'object' } },
      ];
      const wire = [{ role: 'user', content: '读一下 a.html' }];
      const step = await kimi.streamKimi({
        provider,
        home,
        version: '1.0',
        onDelta() {},
        request: { messages: wire, tools },
      });
      assert.equal(step.stopReason, 'tool_use');
      assert.equal(step.text, '我读一下。');
      assert.deepEqual(
        step.toolCalls.map((c) => [c.name, c.input]),
        [['read_document', { path: 'a.html' }]],
      );
      wire.push({
        role: 'assistant',
        content: step.text,
        toolCalls: step.toolCalls,
        raw: step.raw,
      });
      wire.push({ role: 'tool', toolCallId: step.toolCalls[0].id, content: '正文 A' });
      const end = await kimi.streamKimi({
        provider,
        home,
        version: '1.0',
        onDelta() {},
        request: { messages: wire, tools },
      });
      assert.equal(end.text, '读到了：正文 A');
      assert.equal(end.stopReason, 'stop');
      // A finished session is deleted after its answer returns, so wait for the last delete.
      let lines = [];
      for (let i = 0; i < 50; i++) {
        lines = (await fs.readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        if (lines.filter((m) => m.method === 'session/delete').length >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(lines.some((l) => l.args?.[0] === 'acp' && l.home === home));
      assert.equal(lines.find((m) => m.method === 'initialize').params.clientInfo.name, 'folio');
      const prompt = lines.find((m) => m.method === 'session/prompt').params.prompt;
      assert.match(prompt.at(-1).text, /^阅读助手说明\n\n---\n\n你好$/);
      // The model by the CLI's name for it, and the level picked.
      const set = lines.filter((m) => m.method === 'session/set_config_option');
      assert.deepEqual(set[0].params, {
        sessionId: 's1',
        configId: 'model',
        value: 'kimi-code/k3',
      });
      assert.deepEqual(set[1].params, { sessionId: 's1', configId: 'thinking', value: 'low' });
      assert.deepEqual(
        lines.filter((m) => m.method === 'session/new').map((m) => m.params.mcpServers.length),
        [0, 1],
      );
      assert.deepEqual(lines.find((m) => m.id === 9001).result.outcome.optionId, 'reject');
      assert.deepEqual(lines.find((m) => m.id === 9002).result.outcome.optionId, 'approve_once');
      // Finished sessions are deleted.
      assert.deepEqual(
        lines.filter((m) => m.method === 'session/delete').map((m) => m.params.sessionId),
        ['s1', 's2'],
      );
      // The membership, as the CLI's own service tells it.
      const status = await kimi.status(home, '1.0', fetch);
      assert.deepEqual(status.account, { name: '登月者', level: 'Moderato' });
      assert.deepEqual(status.windows, [
        { usedPercent: 5, windowMins: 300, resetsAt: Date.parse('2026-10-04T10:39:40Z') },
        { usedPercent: 1, windowMins: 10_080, resetsAt: 0 },
      ]);
      assert.equal((await kimi.limits(home, fetch)).windows.length, 2);
      const asked = (await fs.readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((l) => l.web);
      assert.ok(asked.length >= 3 && asked.every((l) => l.auth === 'Bearer svc'));
    } finally {
      kimi.stop();
      delete process.env.FOLIO_KIMI_PATH;
    }
  },
);

test('Kimi membership windows and messages', () => {
  const { usageWindows, friendly } = require('../electron/ai-kimi.cjs');
  assert.deepEqual(
    usageWindows({
      usages: {
        limit5h: { usedRatio: 0.125, resetAt: '2026-10-04T10:39:39Z' },
        limit7d: { usedRatio: 0 },
        monthTotal: { usedRatio: 1.2 },
      },
    }),
    [
      { usedPercent: 13, windowMins: 300, resetsAt: Date.parse('2026-10-04T10:39:39Z') },
      { usedPercent: 0, windowMins: 10_080, resetsAt: 0 },
      { usedPercent: 100, windowMins: 43_200, resetsAt: 0 },
    ],
  );
  assert.deepEqual(usageWindows({ usages: {} }), []);
  assert.match(
    friendly(
      'Authentication required: 403 Your current subscription does not have access to Kimi Code right now.',
    ),
    /没有 Kimi Code 会员/,
  );
  assert.match(
    friendly(
      'Authentication required: 401 Your current subscription does not have access to kimi-for-coding-highspeed.',
    ),
    /用不了这个模型/,
  );
  assert.equal(friendly('Authentication required'), '需要在 AI 设置中重新登录 Kimi Code');
});
