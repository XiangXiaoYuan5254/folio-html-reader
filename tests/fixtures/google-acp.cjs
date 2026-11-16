// An ACP peer for the Google provider integration test. The real peer owns
// the browser flow and credential storage. This stand-in only creates a marker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const profile = path.join(process.env.GEMINI_HOME, 'antigravity-acp');
const login = path.join(profile, 'acp_token.json');
const sessions = new Map();
const prompts = new Map();
let sessionNumber = 0;
const permissions = new Map();
const tier = { antigravity: { tier: { name: 'Google AI Pro' } } };
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const options = (session) => [
  {
    id: 'model',
    category: 'model',
    currentValue: session.model || 'gemini-flash',
    options: [{ group: 'Gemini', options: [{ value: 'gemini-pro' }, { value: 'gemini-flash' }] }],
  },
  {
    id: 'thinking_level',
    category: 'thought_level',
    currentValue: session.thinking_level || 'low',
    options: [{ value: 'low' }, { value: 'extra_high' }],
  },
];
const usage = { inputTokens: 2407, outputTokens: 1532, cachedReadTokens: 24527 };
function update(sessionId, sessionUpdate, text) {
  out({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate, content: { type: 'text', text } } },
  });
}

async function handle({ id, method, params: p, result }) {
  const reply = (value) => out({ id, result: value });
  switch (method) {
    case 'initialize':
      assert(process.argv.includes('acp'));
      assert(process.argv.includes('--process-per-session'));
      assert(process.argv.includes(`--gemini-dir=${process.env.GEMINI_HOME}`));
      assert.equal(p.clientCapabilities.terminal, false);
      assert.equal(process.env.AGY_ACP_FORCE_FILE_STORAGE, '1');
      const noProxy = process.env.no_proxy.split(',');
      for (const address of ['localhost', '127.0.0.1', '::1']) assert(noProxy.includes(address));
      return reply({
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server' },
        agentCapabilities: { sessionCapabilities: { close: {} } },
        authMethods: [{ id: 'oauth-personal' }],
      });
    case 'authenticate':
      assert.equal(p.methodId, 'oauth-personal');
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(login, '{}', { mode: 0o600 });
      return reply({ _meta: tier });
    case 'logout':
      fs.rmSync(login, { force: true });
      return reply({});
    case 'session/new': {
      assert(fs.existsSync(login));
      assert.equal(fs.realpathSync(p.cwd), process.cwd());
      assert(p._meta.antigravity.systemPrompt.append.includes('Folio'));
      assert(
        p._meta.antigravity.enabledTools.every((name) =>
          ['search_web', 'read_url_content'].includes(name),
        ),
      );
      const sessionId = `s-${++sessionNumber}`;
      const session = { mcp: p.mcpServers[0]?.url };
      sessions.set(sessionId, session);
      return reply({ sessionId, configOptions: options(session), _meta: tier });
    }
    case 'session/set_config_option': {
      const session = sessions.get(p.sessionId);
      session[p.configId] = p.value;
      return reply({ configOptions: options(session) });
    }
    case 'session/prompt': {
      const session = sessions.get(p.sessionId);
      const text = p.prompt.at(-1).text;
      if (text === '额度用尽')
        return out({ id, error: { code: -32603, message: 'Usage Limit Reached' } });
      const retryFile = path.join(profile, 'retry');
      const retry = text === '先等待再回复' && !fs.existsSync(retryFile);
      if (retry) fs.writeFileSync(retryFile, '1');
      if (text === '先回复再卡住') update(p.sessionId, 'agent_message_chunk', '已经开始回复');
      if (text === '请停止' || text === '先回复再卡住' || retry) {
        const heartbeat = setInterval(() => {
          out({
            method: 'session/update',
            params: { sessionId: p.sessionId, update: { sessionUpdate: 'usage_update' } },
          });
        }, 20);
        return prompts.set(p.sessionId, { id, heartbeat });
      }
      if (text === '读一段') {
        const permissionId = 'allow-' + p.sessionId;
        const permission = new Promise((resolve) => permissions.set(permissionId, resolve));
        out({
          id: permissionId,
          method: 'session/request_permission',
          params: {
            sessionId: p.sessionId,
            toolCall: {
              title: 'folio_read_document',
              _meta: { mcp: { server: 'folio', tool: 'read_document' } },
            },
            options: [
              { kind: 'allow_once', optionId: 'allow' },
              { kind: 'reject_once', optionId: 'reject' },
            ],
          },
        });
        assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'allow' } });
        const result = await fetch(session.mcp, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'read_document', arguments: { page: 2 } },
          }),
        });
        assert.match(await result.text(), /第 2 页正文/);
        update(p.sessionId, 'agent_message_chunk', '读到了第 2 页。');
      } else {
        session.prompts = (session.prompts || 0) + 1;
        update(p.sessionId, 'agent_thought_chunk', '思考');
        update(
          p.sessionId,
          'agent_message_chunk',
          `${session.model || 'gemini-flash'}/${session.thinking_level || 'low'} 第 ${session.prompts} 问：${text}`,
        );
      }
      return reply({ stopReason: 'end_turn', usage });
    }
    case 'session/cancel': {
      const prompt = prompts.get(p.sessionId);
      if (prompt) {
        clearInterval(prompt.heartbeat);
        prompts.delete(p.sessionId);
        out({ id: prompt.id, result: { stopReason: 'cancelled' } });
      }
      return;
    }
    case 'session/close': {
      const prompt = prompts.get(p.sessionId);
      if (prompt) {
        clearInterval(prompt.heartbeat);
        prompts.delete(p.sessionId);
        out({ id: prompt.id, result: { stopReason: 'cancelled' } });
      }
      sessions.delete(p.sessionId);
      return reply({});
    }
    case undefined:
      return permissions.get(id)?.(result);
    default:
      throw Error('Unexpected ACP method ' + method);
  }
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', (line) => {
  handle(JSON.parse(line)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
});
