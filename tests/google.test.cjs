const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAi } = require('../electron/ai.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');

test(
  'Google account through AI settings, conversation, tools, quota and logout',
  {
    skip: process.platform === 'win32',
    timeout: 15_000,
  },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-google-test-'));
    const bin = path.join(dir, 'acp');
    const started = path.join(dir, 'started');
    const fixture = path.join(__dirname, 'fixtures', 'google-acp.cjs');
    await fs.writeFile(
      bin,
      `#!/bin/sh\nprintf x >> "${started}"\nexec "${process.execPath}" "${fixture}" "$@"\n`,
      {
        mode: 0o700,
      },
    );
    const previous = process.env.FOLIO_GOOGLE_ACP_PATH;
    process.env.FOLIO_GOOGLE_ACP_PATH = bin;
    const openAi = () =>
      createAi({
        file: path.join(dir, 'ai.json'),
        fetch,
        atomicWrite,
        protect: () => assert.fail('Google does not take a key'),
      });
    let ai = openAi();
    let counter = 0;
    const user = (content) => ({ role: 'user', content });
    const ask = (messages, options = {}, onDelta = () => {}) =>
      ai.chat({ requestId: `g-${++counter}`, messages, ...options }, onDelta);
    try {
      assert.equal((await ai.googleStatus()).signedIn, false);
      const state = await ai.googleLogin();
      assert.equal(state.signedIn, true, state.error);
      assert.equal(state.plan, 'Google AI Pro');

      const models = await ai.models({ draft: { preset: 'google' } });
      assert.deepEqual(
        models.map((m) => m.id),
        ['gemini-flash', 'gemini-pro'],
      );
      assert.deepEqual(models[0].efforts, ['low', 'xhigh']);
      const { provider } = await ai.saveProvider({
        preset: 'google',
        model: 'gemini-pro',
        effort: 'xhigh',
      });
      assert.equal(provider.hasKey, false);
      assert.equal(provider.kind, 'google');

      const deltas = [];
      const first = await ask([user('你好')], { session: 'doc-a' }, (d) => deltas.push(d));
      assert.equal(first.text, 'gemini-pro/extra_high 第 1 问：你好');
      assert.equal(deltas[0].reasoning, '思考');
      assert.deepEqual(first.usage, { input: 17, output: 4, cached: 6 });
      const second = await ask(
        [user('你好'), { role: 'assistant', content: first.text }, user('继续')],
        { session: 'doc-a' },
      );
      assert.equal(second.text, 'gemini-pro/extra_high 第 2 问：继续');

      const prompt = user('读一段');
      const partial = await ask([prompt], {
        tools: [{ name: 'read_document', description: '读文档', parameters: { type: 'object' } }],
      });
      assert.equal(partial.stopReason, 'tool_use');
      const [call] = partial.toolCalls;
      assert.deepEqual(call.input, { page: 2 });
      const continued = await ask([
        prompt,
        { role: 'assistant', content: '', raw: partial.raw, toolCalls: partial.toolCalls },
        { role: 'tool', content: '第 2 页正文', toolCallId: call.id },
      ]);
      assert.equal(continued.text, '读到了第 2 页。');

      await assert.rejects(ask([user('额度用尽')]), /套餐额度已达上限/);
      await assert.rejects(ask([user('任务')], { use: 'plugin:daily' }), /选择 API 服务/);
      const pending = ai.chat({ requestId: 'cancel-me', messages: [user('请停止')] }, () => {});
      const timer = setTimeout(() => ai.cancel({ requestId: 'cancel-me' }), 200);
      try {
        assert.deepEqual(await pending, { stopped: true });
      } finally {
        clearTimeout(timer);
      }
      // Usage counters may update while Google still hasn't sent any content.
      // A silent turn must end even while the connection is alive.
      const setTimer = global.setTimeout;
      const fastTimeout = t.mock.method(global, 'setTimeout', (fn, delay, ...args) =>
        setTimer(fn, delay === 90_000 ? 150 : delay, ...args),
      );
      try {
        await assert.rejects(ask([user('请停止')]), /90 秒内没有收到回复/);
        assert.equal(await fs.readFile(started, 'utf8'), 'xx', 'a silent retry reconnects once');
        const recovered = await ask([user('先等待再回复')]);
        assert.match(recovered.text, /^gemini-pro\/extra_high 第 1 问：先等待再回复$/);
        assert.equal(await fs.readFile(started, 'utf8'), 'xxxx');
      } finally {
        fastTimeout.mock.restore();
      }
      const partialTimeout = t.mock.method(global, 'setTimeout', (fn, delay, ...args) =>
        setTimer(fn, delay === 5 * 60_000 ? 150 : delay, ...args),
      );
      try {
        const partialDeltas = [];
        await assert.rejects(
          ask([user('先回复再卡住')], {}, (d) => partialDeltas.push(d)),
          /回复中断/,
        );
        assert.equal(partialDeltas.filter((d) => d.text).length, 1);
        assert.equal(await fs.readFile(started, 'utf8'), 'xxxx', 'partial replies are not retried');
      } finally {
        partialTimeout.mock.restore();
      }
      ai.shutdown();
      ai = openAi();
      assert.equal((await ai.googleStatus()).signedIn, true);
      assert.deepEqual(await ai.models({ id: provider.id }), models);
      assert.equal(await fs.readFile(started, 'utf8'), 'xxxx', 'reopening does not start ACP');
      // An existing install without a saved catalog can still display its selected model.
      await fs.unlink(path.join(dir, 'google', 'models.json'));
      assert.deepEqual(
        (await ai.models({ id: provider.id })).map((m) => m.id),
        ['gemini-pro'],
      );
      assert.equal(await fs.readFile(started, 'utf8'), 'xxxx');
      assert.deepEqual(await ai.models({ id: provider.id, refresh: true }), models);
      assert.equal(await fs.readFile(started, 'utf8'), 'xxxxx', 'explicit refresh starts ACP');
      assert.equal((await ai.googleLogout()).signedIn, false);
      await assert.rejects(ask([user('你好')]), /登录 Google 账号/);
    } finally {
      ai.shutdown();
      if (previous === undefined) delete process.env.FOLIO_GOOGLE_ACP_PATH;
      else process.env.FOLIO_GOOGLE_ACP_PATH = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
