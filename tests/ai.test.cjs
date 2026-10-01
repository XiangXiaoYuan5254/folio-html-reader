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
    // 自动 sends no level: the service decides.
    assert.equal(sent.body.thinking, undefined);
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

test('reasoning levels follow each service', () => {
  const p = (preset, effort = '') => ({ preset, effort });
  // Every request uses the level picked, never a lower one; 自动 leaves it to the service.
  assert.deepEqual(providers.effortParams(p('deepseek')), {});
  assert.deepEqual(providers.effortParams(p('deepseek', 'off')), {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(providers.effortParams(p('deepseek', 'high')), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  assert.deepEqual(providers.effortParams(p('zhipu', 'on')), { thinking: { type: 'enabled' } });
  assert.deepEqual(providers.effortParams(p('qwen')), {});
  assert.deepEqual(providers.effortParams(p('qwen', 'on')), { enable_thinking: true });
  assert.deepEqual(providers.effortParams(p('openai')), {});
  assert.deepEqual(providers.effortParams(p('openai', 'high')), { reasoning_effort: 'high' });
  // A level the service doesn't have is ignored.
  assert.deepEqual(providers.effortParams(p('openai', 'max')), {});
  assert.deepEqual(providers.effortParams(p('moonshot', 'high')), {});
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
    assert.equal(sent.body.tools[0].input_schema.type, 'object');
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
      out({ id: m.id, result: { data: [{ id: 'hidden', hidden: true }, { id: 'gpt-b' }, { id: 'gpt-a', isDefault: true }] } });
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
      /mock-model 好像不能看图/,
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
