// Kimi Code memberships through the Kimi Code CLI installed on this computer. Kimi lets only
// coding agents use a membership, so 页间 doesn't call Kimi Code's API with a key: the CLI
// runs as an ACP server (Agent Client Protocol, the way editors such as Zed use it), signs in
// with the Kimi account and runs the model, streaming JSON-RPC on stdio.
//
// The CLI keeps its data in a home of 页间's own (KIMI_CODE_HOME), apart from ~/.kimi-code:
// its own sign-in, and sessions that don't show among the user's coding sessions. There an
// agent file stands in for Kimi's coding agent: 页间's instructions, and no tools but the ones
// 页间 passes in (the project agent's), so the CLI's shell, files and web stay off. Those
// tools are an MCP server in this process; a call waits for the next request, which carries
// the results, as with Codex.
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { levelFor } = require('./ai-providers.cjs');
const { transcript } = require('./ai-codex.cjs');

class KimiError extends Error {}

// Where the CLI usually lives: its installer's folder, then Homebrew's and the PATH. Apps
// opened from Finder don't inherit the shell's PATH.
function candidates() {
  const exe = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  const list = [process.env.FOLIO_KIMI_PATH, path.join(os.homedir(), '.kimi-code/bin', exe)];
  if (process.platform === 'darwin') list.push('/opt/homebrew/bin/kimi', '/usr/local/bin/kimi');
  for (const dir of (process.env.PATH || '').split(path.delimiter))
    if (dir) list.push(path.join(dir, exe));
  return list.filter(Boolean);
}
function findKimi() {
  for (const file of candidates()) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}
const notFound = () =>
  new KimiError('没有找到 Kimi Code CLI。请按 Kimi Code 官网的说明安装，登录后再试。');

// 页间's instructions in place of Kimi's coding agent, and only 页间's own tools.
const agentFile = `---
name: agent
description: 页间阅读器里的助手
override: true
tools: mcp__folio__*
subagents: []
---
你是「页间」阅读器里的助手。你在一个阅读器应用里运行，不能执行命令，也不能读写文件。只根据对话中提供的内容和可用的工具工作。
`;
function prepare(home) {
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents/agent.md'), agentFile);
  // Signing in goes to kimi.com or kimi.ai, as the user's own CLI was installed from.
  const region = path.join(home, 'region');
  if (!fs.existsSync(region))
    try {
      fs.copyFileSync(path.join(os.homedir(), '.kimi-code/region'), region);
    } catch {}
}
function cliEnv(home, bin) {
  return {
    ...process.env,
    KIMI_CODE_HOME: home,
    // The project agent's changes wait for the user to approve them.
    KIMI_MCP_TOOL_TIMEOUT_MS: String(60 * 60_000),
    KIMI_DISABLE_TELEMETRY: '1',
    // An npm install is a Node script; Node sits beside it, off the PATH Finder gives apps.
    PATH: [path.dirname(bin), process.env.PATH].filter(Boolean).join(path.delimiter),
  };
}
function run(home, args) {
  const bin = findKimi();
  if (!bin) return Promise.reject(notFound());
  prepare(home);
  return new Promise((resolve, reject) =>
    execFile(
      bin,
      args,
      { env: cliEnv(home, bin), cwd: path.join(home, 'work'), windowsHide: true, timeout: 30_000 },
      (e, stdout, stderr) =>
        e
          ? reject(
              new KimiError(
                `Kimi Code：${String(stderr || e.message)
                  .trim()
                  .slice(0, 300)}`,
              ),
            )
          : resolve(stdout),
    ),
  );
}

// The CLI's ACP server, one per app session, restarted if it exits.
class Server {
  constructor(bin, home, version) {
    this.bin = bin;
    this.home = home;
    this.version = version;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    // What the CLI last logged going wrong: a failed turn ends without saying why.
    this.lastError = null;
    this.queue = Promise.resolve();
  }
  // Sessions are created and deleted one at a time: one created while another is being
  // deleted fails.
  serial(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  start() {
    prepare(this.home);
    const child = spawn(this.bin, ['acp'], {
      cwd: path.join(this.home, 'work'),
      env: cliEnv(this.home, this.bin),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    let buffer = '';
    let errors = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        this.receive(message);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
      errors += chunk;
      let newline;
      while ((newline = errors.indexOf('\n')) !== -1) {
        const line = errors.slice(0, newline);
        errors = errors.slice(newline + 1);
        try {
          const log = JSON.parse(line);
          if (log.level === 'error' || log.level === 'warn')
            this.lastError = { at: Date.now(), message: String(log.error || log.msg || '') };
        } catch {}
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      const last = stderr.trim().split('\n').at(-1) || '';
      const error = new KimiError(`Kimi Code 意外退出${last ? `：${last.slice(0, 200)}` : ''}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      for (const session of this.sessions.values()) session.fail(error);
      this.sessions.clear();
    });
    return this.call(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'folio', title: '页间 Folio', version: this.version },
      },
      30_000,
    ).then((result) => {
      // The Python Kimi CLI before it has an ACP mode too, without the agent file.
      if (result?.agentInfo?.name !== 'Kimi Code CLI')
        throw new KimiError(
          '找到的是旧版 Kimi CLI，它已不再维护。请按 Kimi Code 官网的说明安装新版 Kimi Code CLI。',
        );
    });
  }
  send(message) {
    if (!this.child) throw new KimiError('Kimi Code 没有运行');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  // `ms` 0 waits as long as it takes (a turn ends when it ends).
  call(method, params, ms = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        ms && setTimeout(() => fail(new KimiError(`Kimi Code 没有响应（${method}）`)), ms);
      const fail = (e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      };
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: fail,
      });
      try {
        this.send({ method, id, params });
      } catch (e) {
        fail(e);
      }
    });
  }
  receive(m) {
    if (m.id !== undefined && !m.method) {
      const waiting = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error)
        waiting?.reject(
          Object.assign(new KimiError(m.error.message || 'Kimi Code 请求失败'), {
            code: m.error.code,
          }),
        );
      else waiting?.resolve(m.result);
      return;
    }
    if (m.method === 'session/update') {
      this.sessions.get(m.params?.sessionId)?.handle(m.params.update || {});
      return;
    }
    if (m.id === undefined) return;
    // 页间's own tools go ahead; anything else the CLI asks to do is turned down.
    if (m.method === 'session/request_permission') {
      const ours = String(m.params?.toolCall?.title || '').startsWith('mcp__folio__');
      const option = (m.params?.options || []).find(
        (o) => o.kind === (ours ? 'allow_once' : 'reject_once'),
      );
      this.send({
        id: m.id,
        result: {
          outcome: option
            ? { outcome: 'selected', optionId: option.optionId }
            : { outcome: 'cancelled' },
        },
      });
      return;
    }
    this.send({ id: m.id, error: { code: -32601, message: 'Not supported by Folio' } });
  }
}

let server = null;
let starting = null;
function getServer(home, version) {
  if (server?.child) return Promise.resolve(server);
  if (starting) return starting;
  const bin = findKimi();
  if (!bin) return Promise.reject(notFound());
  const next = new Server(bin, home, version);
  starting = next
    .start()
    .then(() => (server = next))
    .catch((e) => {
      next.child?.kill();
      throw e;
    })
    .finally(() => (starting = null));
  return starting;
}
function restart() {
  server?.child?.kill();
  server = null;
}

// The account's models as the CLI lists them, each with its levels and whether it takes
// pictures; the CLI's default first. Requests pick a model by the CLI's name for it.
let listed = [];
async function account(home) {
  const value = JSON.parse(await run(home, ['provider', 'list', '--json']));
  const provider = value?.providers?.['managed:kimi-code'];
  let fallback = '';
  try {
    fallback =
      /^default_model\s*=\s*"([^"]+)"/m.exec(
        fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
      )?.[1] || '';
  } catch {}
  const models = Object.entries(value?.models || {})
    .filter(([, m]) => m?.provider === 'managed:kimi-code' && m.model)
    .map(([alias, m]) => {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      const graded = Array.isArray(m.supportEfforts) ? m.supportEfforts : [];
      // An always-thinking model can't be switched off; one without grades is just on.
      const switchable = caps.includes('thinking') && !caps.includes('always_thinking');
      const efforts = [
        ...(switchable ? ['off'] : []),
        ...(graded.length ? graded : switchable ? ['on'] : []),
      ];
      return {
        id: m.model,
        alias,
        efforts,
        defaultEffort:
          m.defaultEffort ||
          (graded.length ? graded[Math.floor(graded.length / 2)] : efforts.at(-1) || ''),
        images: caps.includes('image_in'),
      };
    })
    .sort((a, b) => (b.alias === fallback) - (a.alias === fallback));
  return { signedIn: !!provider?.oauth, models };
}
async function listModels(home) {
  const { signedIn, models } = await account(home);
  if (!signedIn) throw new KimiError('请先在 AI 设置中登录 Kimi Code');
  listed = models;
  return models.map(({ alias, ...m }) => m);
}

// What the CLI's own web service says about the account: Kimi's usage and profile want a
// fresh sign-in, which only the CLI renews. The service runs for the one question.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
async function askService(home, fetch, paths) {
  const bin = findKimi();
  if (!bin) throw notFound();
  prepare(home);
  const child = spawn(bin, ['web', '--no-open', '--port', String(await freePort())], {
    cwd: path.join(home, 'work'),
    env: cliEnv(home, bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new KimiError('Kimi Code 没有响应')), 30_000);
      const seen = (d) => {
        output += d;
        const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
        if (port) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${port}`);
        }
      };
      child.stdout.on('data', seen);
      child.stderr.on('data', seen);
      const failed = (why) => {
        clearTimeout(timer);
        reject(new KimiError(`Kimi Code 没有启动：${why}`));
      };
      child.on('error', (e) => failed(e.message));
      child.on('exit', () => failed(output.trim().split('\n').at(-1) || ''));
    });
    // The service's own key, kept beside it in 页间's home.
    const token = fs.readFileSync(path.join(home, 'server.token'), 'utf8').trim();
    return await Promise.all(
      paths.map(async (p) => {
        const response = await fetch(origin + p, { headers: { Authorization: `Bearer ${token}` } });
        const value = await response.json().catch(() => null);
        if (value?.code !== 0) throw new KimiError(`Kimi Code：${value?.msg || response.status}`);
        if (value.data?.kind !== 'ok')
          throw new KimiError(friendly(value.data?.message || String(value.data?.status || '')));
        return value.data;
      }),
    );
  } finally {
    child.kill();
  }
}

// How much of the membership's windows is used: five hours, a week and, where the plan has
// one, a month.
const windowMins = { limit5h: 300, limit7d: 10_080, monthTotal: 43_200 };
function usageWindows(quota) {
  const pools = quota?.usages && typeof quota.usages === 'object' ? quota.usages : {};
  return Object.entries(windowMins)
    .filter(([key]) => Number.isFinite(pools[key]?.usedRatio))
    .map(([key, mins]) => ({
      usedPercent: Math.round(Math.min(1, Math.max(0, pools[key].usedRatio)) * 100),
      windowMins: mins,
      resetsAt: Date.parse(pools[key].resetAt || '') || 0,
    }));
}
function plan(usage) {
  const windows = usageWindows(usage.quota);
  if (!windows.length) throw new KimiError('这个 Kimi 账号没有 Kimi Code 会员额度');
  return { kind: 'plan', windows };
}
async function limits(home, fetch) {
  const [usage] = await askService(home, fetch, ['/api/v1/oauth/usage']);
  return plan(usage);
}

async function status(home, version, fetch) {
  const bin = findKimi();
  if (!bin) return { found: false };
  try {
    await getServer(home, version);
    const { signedIn } = await account(home);
    if (!signedIn) return { found: true, path: bin, signedIn };
    const [usage, profile] = await askService(home, fetch, [
      '/api/v1/oauth/usage',
      '/api/v1/oauth/userinfo',
    ]);
    const user = profile.userInfo || {};
    const found = {
      found: true,
      path: bin,
      signedIn,
      account: { name: String(user.nickname || ''), level: String(user.userLevelName || '') },
    };
    // An account without a membership has no windows; that is said too.
    try {
      return { ...found, windows: plan(usage).windows };
    } catch (e) {
      return { ...found, windows: [], error: e.message };
    }
  } catch (e) {
    return { found: true, path: bin, signedIn: false, error: e.message };
  }
}

// Kimi's device sign-in: the CLI opens Kimi's page in the browser and waits until the user
// approves there. The server restarts afterwards to pick up the account.
async function login(home, version, fetch) {
  const bin = findKimi();
  if (!bin) throw notFound();
  prepare(home);
  await new Promise((resolve, reject) => {
    const child = spawn(bin, ['login'], {
      cwd: path.join(home, 'work'),
      env: cliEnv(home, bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const collect = (d) => (output = (output + d).slice(-2000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('error', (e) => reject(new KimiError(`Kimi Code 没有启动：${e.message}`)));
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const last = output.trim().split('\n').at(-1) || '';
      reject(new KimiError(code === null ? '登录超时，请重试' : last || '登录没有完成'));
    });
  });
  restart();
  return status(home, version, fetch);
}
async function logout(home, version, fetch) {
  const s = await getServer(home, version);
  await s.call('logout', {});
  restart();
  return status(home, version, fetch);
}

// 页间's tools for the sessions that have them, as an MCP server on this computer only. Each
// session has a path of its own, which only the CLI is told. A call is answered as an event
// stream that pings while the user decides, so the CLI doesn't give up on a slow answer.
let mcp = null;
const routes = new Map();
function mcpServer(version) {
  if (mcp) return mcp;
  mcp = new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => void serveMcp(req, res, version));
    httpServer.on('error', reject);
    httpServer.listen(0, '127.0.0.1', () =>
      resolve({ httpServer, url: `http://127.0.0.1:${httpServer.address().port}/mcp/` }),
    );
  });
  mcp.catch(() => (mcp = null));
  return mcp;
}
async function serveMcp(req, res, version) {
  const session = routes.get(String(req.url).replace(/^\/mcp\//, ''));
  if (!session) return void res.writeHead(404).end();
  if (req.method !== 'POST') return void res.writeHead(405).end();
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4_000_000) return void res.writeHead(413).end();
  }
  let m;
  try {
    m = JSON.parse(body);
  } catch {
    return void res.writeHead(400).end();
  }
  // Notifications, such as a call the CLI has stopped waiting for.
  if (m?.id === undefined) return void res.writeHead(202).end();
  const json = (message) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...message }));
  };
  switch (m.method) {
    case 'initialize':
      return json({
        result: {
          protocolVersion: m.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'folio', title: '页间 Folio', version },
        },
      });
    case 'ping':
      return json({ result: {} });
    case 'tools/list':
      return json({
        result: {
          tools: session.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        },
      });
    case 'tools/call': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      const respond = (r) => {
        clearInterval(ping);
        if (res.writableEnded) return;
        const result = { content: [{ type: 'text', text: r.content }], isError: !!r.isError };
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`,
        );
      };
      res.on('close', () => clearInterval(ping));
      session.toolCall(
        { name: String(m.params?.name || ''), input: m.params?.arguments ?? {} },
        respond,
      );
      return;
    }
    default:
      return json({ error: { code: -32601, message: 'Method not found' } });
  }
}

function friendly(message) {
  const detail = String(message || '')
    .replace(/^Authentication required:?\s*/i, '')
    .trim();
  if (!detail) return '需要在 AI 设置中重新登录 Kimi Code';
  const said = detail.slice(0, 200);
  if (/does not have access to Kimi Code/i.test(detail))
    return `这个 Kimi 账号没有 Kimi Code 会员，开通后再试（${said}）`;
  if (/does not have access to/i.test(detail))
    return `你的 Kimi Code 套餐用不了这个模型，请换一个模型（${said}）`;
  if (/rate.?limit|quota|usage limit|exceeded|429/i.test(detail))
    return `Kimi Code 的会员额度已用完，请稍后再试（${said}）`;
  if (/unauthori[sz]ed|log ?in|401|token/i.test(detail))
    return '需要在 AI 设置中重新登录 Kimi Code';
  return `Kimi Code：${detail.slice(0, 300)}`;
}

// A conversation's live session. A turn that stops to call 页间's tools stays open; the next
// request, carrying the tool results, answers those calls and keeps streaming.
class Session {
  constructor(s, tools) {
    this.s = s;
    this.id = '';
    this.tools = tools;
    this.route = crypto.randomUUID();
    this.calls = [];
    this.waiting = null;
    this.text = '';
    this.reasoning = '';
    // Whether the turn has said or done anything yet.
    this.said = false;
    this.started = Date.now();
    this.touched = Date.now();
    this.closed = false;
  }
  // Collects updates until the turn finishes or asks for tools.
  next(onDelta, signal, idleMs) {
    return new Promise((resolve, reject) => {
      // Giving up stops the turn too, so it doesn't go on using the membership.
      const cancel = (e) => {
        try {
          this.s.send({ method: 'session/cancel', params: { sessionId: this.id } });
        } catch {}
        this.fail(e);
      };
      let idle;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => cancel(new KimiError('Kimi Code 长时间没有响应，已停止')),
          idleMs,
        );
      };
      let gather = null;
      const abort = () => cancel(Object.assign(new Error('已停止'), { name: 'AbortError' }));
      signal?.addEventListener('abort', abort, { once: true });
      const settle = (fn) => {
        clearTimeout(idle);
        clearTimeout(gather);
        signal?.removeEventListener('abort', abort);
        this.waiting = null;
        fn();
      };
      this.waiting = {
        onDelta,
        touch,
        // Tool calls in one step arrive together; wait a moment for the rest.
        toolCall: () => {
          clearTimeout(gather);
          gather = setTimeout(() => settle(() => resolve(this.result('tool_use'))), 150);
        },
        done: (reason) => settle(() => resolve(this.result(reason))),
        fail: (e) => settle(() => reject(e)),
      };
      touch();
      // Calls that came while nobody was waiting.
      if (this.calls.length) this.waiting.toolCall();
    });
  }
  result(stopReason) {
    const out = {
      text: this.text,
      reasoning: this.reasoning,
      toolCalls: stopReason === 'tool_use' ? this.calls.map((c) => c.call) : [],
      stopReason,
      usage: null,
      raw: stopReason === 'tool_use' ? { kimiSession: this.id } : undefined,
    };
    this.text = '';
    this.reasoning = '';
    return out;
  }
  handle(update) {
    const w = this.waiting;
    this.touched = Date.now();
    w?.touch();
    const text = update.content?.type === 'text' ? update.content.text || '' : '';
    if (update.sessionUpdate === 'agent_message_chunk' && text) {
      this.text += text;
      this.said = true;
      w?.onDelta({ text });
    } else if (update.sessionUpdate === 'agent_thought_chunk' && text) {
      this.reasoning += text;
      w?.onDelta({ reasoning: text });
    }
  }
  toolCall(call, respond) {
    if (this.closed) return respond({ content: '对话已经结束，没有执行这个工具。', isError: true });
    this.touched = Date.now();
    this.said = true;
    this.calls.push({ respond, call: { id: `kimi-${crypto.randomUUID()}`, ...call } });
    this.waiting?.touch();
    this.waiting?.onDelta({ tool: call.name });
    this.waiting?.toolCall();
  }
  answer(results) {
    const calls = this.calls;
    this.calls = [];
    for (const c of calls) {
      const r = results.get(c.call.id);
      c.respond(r ? r : { content: '没有执行这个工具。', isError: true });
    }
  }
  // The turn is over: what it said, or why it said nothing.
  finish(stopReason) {
    const error = this.s.lastError?.at >= this.started ? this.s.lastError.message : '';
    if (stopReason === 'cancelled')
      this.fail(Object.assign(new Error('已停止'), { name: 'AbortError' }));
    else if (stopReason === 'refusal') this.fail(new KimiError('Kimi Code 拒绝回答这个请求'));
    else if (!this.said)
      this.fail(new KimiError(error ? friendly(error) : 'Kimi Code 没有返回内容'));
    else {
      this.waiting?.done('stop');
      this.close();
    }
  }
  fail(e) {
    this.waiting?.fail(e);
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.answer(new Map());
    routes.delete(this.route);
    if (!this.id) return;
    this.s.sessions.delete(this.id);
    if (this.s.child)
      this.s
        .serial(() => this.s.call('session/delete', { sessionId: this.id }, 30_000))
        .catch(() => {});
  }
}

// Pictures go first, then the conversation as one message, with the request's instructions
// ahead of it: the agent file holds what every request shares.
function promptBlocks(request) {
  const messages = request.messages || [];
  const images = messages
    .flatMap((m) => (m.role === 'user' ? m.images || [] : []))
    .map((url) => /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(url))
    .filter(Boolean)
    .map(([, mimeType, data]) => ({ type: 'image', mimeType, data }));
  const text = transcript(messages);
  return [
    ...images,
    { type: 'text', text: request.system ? `${request.system}\n\n---\n\n${text}` : text },
  ];
}

async function streamKimi({ provider, request, signal, onDelta, home, version }) {
  const s = await getServer(home, version);
  const messages = request.messages || [];
  // Continuing a turn that stopped for tools: the last assistant message names its session.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const live = lastAssistant?.raw?.kimiSession && s.sessions.get(lastAssistant.raw.kimiSession);
  // Thinking counts as a sign of life; only a long silence gives up. The CLI goes quiet while it
  // retries a failed request (up to ten times, waiting up to half a minute between).
  const idleMs = 10 * 60_000;
  // Turns left waiting on tool results (an agent run that was abandoned) are closed.
  for (const t of s.sessions.values())
    if (t !== live && !t.waiting && Date.now() - t.touched > 15 * 60_000) {
      try {
        s.send({ method: 'session/cancel', params: { sessionId: t.id } });
      } catch {}
      t.close();
    }
  if (live && messages.at(-1)?.role === 'tool') {
    live.touched = Date.now();
    const after = messages.slice(messages.lastIndexOf(lastAssistant) + 1);
    const results = new Map(after.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]));
    // Answered first, so the calls aren't taken for new ones; nothing the CLI says can arrive
    // before this returns.
    live.answer(results);
    return live.next(onDelta, signal, idleMs);
  }
  // The CLI connects to 页间's tools while it creates the session.
  const session = new Session(s, request.tools || []);
  const url = session.tools.length ? (await mcpServer(version)).url : '';
  if (url) routes.set(session.route, session);
  let started;
  try {
    started = await s.serial(() =>
      s.call('session/new', {
        cwd: path.join(home, 'work'),
        mcpServers: url
          ? [{ type: 'http', name: 'folio', url: url + session.route, headers: [] }]
          : [],
      }),
    );
    if (!started?.sessionId) throw new KimiError('Kimi Code 没有创建对话');
  } catch (e) {
    session.close();
    throw new KimiError(friendly(e.message));
  }
  const sessionId = started.sessionId;
  session.id = sessionId;
  s.sessions.set(sessionId, session);
  try {
    // The model and level as electron/ai-providers.cjs works it out. No model is the CLI's
    // default one, listed first.
    const list = listed.length
      ? listed
      : await listModels(home)
          .then(() => listed)
          .catch(() => []);
    const model = list.find((m) => m.id === (provider.model || list[0]?.id));
    const alias = model?.alias || provider.model;
    const current = started.configOptions?.find((o) => o.id === 'model')?.currentValue;
    if (alias && alias !== current)
      await s.call('session/set_config_option', { sessionId, configId: 'model', value: alias });
    const effort = model
      ? levelFor(model.efforts, model.defaultEffort, provider.effort, provider.use)
      : '';
    if (effort)
      await s.call('session/set_config_option', { sessionId, configId: 'thinking', value: effort });
  } catch (e) {
    session.close();
    throw new KimiError(friendly(e.message));
  }
  const pending = session.next(onDelta, signal, idleMs);
  session.started = Date.now();
  s.call('session/prompt', { sessionId, prompt: promptBlocks(request) }, 0).then(
    (r) => session.finish(r?.stopReason),
    (e) => session.fail(new KimiError(friendly(e.message))),
  );
  return pending;
}

function stop() {
  for (const session of server?.sessions.values() || []) session.close();
  restart();
  routes.clear();
  mcp?.then(({ httpServer }) => httpServer.close()).catch(() => {});
  mcp = null;
}

module.exports = {
  findKimi,
  status,
  login,
  logout,
  limits,
  listModels,
  streamKimi,
  stop,
  KimiError,
  usageWindows,
  friendly,
};
