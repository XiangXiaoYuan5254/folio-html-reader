// ChatGPT accounts through the Codex app server installed on this computer (it ships with
// the ChatGPT desktop app and the Codex CLI). The app server is OpenAI's supported way for
// other products to use a Codex login: it signs in, runs the model and streams events over
// JSON-RPC on stdio. Folio never sees the account's tokens.
//
// Codex's own tools (shell, web search, plugins, MCP servers) are switched off; the model
// only answers, or calls the tools Folio passes in (the project agent's tools), which the
// server hands back as `item/tool/call` requests. Chat alone turns web search back on.
const { spawn } = require('node:child_process');
const { levelFor } = require('./ai-providers.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const disabled = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'goals',
  'skill_search',
  'tool_suggest',
  'view_image',
  'sleep_tool',
  'hooks',
];

class CodexError extends Error {}

// Where Codex usually lives. Apps opened from Finder don't inherit the shell's PATH, so
// common install locations are checked directly.
function candidates() {
  const home = os.homedir();
  const list = [process.env.FOLIO_CODEX_PATH];
  if (process.platform === 'darwin')
    list.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      path.join(
        home,
        'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      ),
      '/Applications/Codex.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(home, '.local/bin/codex'),
    );
  // npm installs Codex on Windows as codex.cmd, which needs a shell and only starts a Node
  // script; the binary that script runs sits in the package's platform dependency.
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const npmBinary = (dir) => {
    const pkg = path.join(dir, 'node_modules/@openai/codex');
    return [
      path.join(
        pkg,
        `node_modules/@openai/codex-win32-${process.arch}/vendor`,
        triple,
        'bin/codex.exe',
      ),
      path.join(pkg, 'vendor', triple, 'bin/codex.exe'),
      path.join(pkg, 'vendor', triple, 'codex/codex.exe'),
    ];
  };
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    list.push(
      path.join(local, 'Programs/ChatGPT/resources/codex-cli/codex.exe'),
      path.join(local, 'Programs/Codex/codex.exe'),
      ...npmBinary(path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'npm')),
    );
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (process.platform !== 'win32') list.push(path.join(dir, 'codex'));
    else list.push(path.join(dir, 'codex.exe'), ...npmBinary(dir));
  }
  return list.filter(Boolean);
}
function findCodex() {
  for (const file of candidates()) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

// One long-lived app server per app session, restarted if it exits.
class Server {
  constructor(bin, version) {
    this.bin = bin;
    this.version = version;
    this.nextId = 1;
    this.pending = new Map();
    this.threads = new Map();
    this.listeners = new Set();
    this.rateLimits = null;
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-codex-'));
  }
  async start() {
    // Newer or older Codex versions may not know every feature name; fall back gracefully.
    for (const flags of [disabled, ['shell_tool', 'unified_exec'], []]) {
      try {
        await this.spawn(flags);
        return;
      } catch (e) {
        this.child?.kill();
        this.child = null;
        if (!flags.length) throw e;
      }
    }
  }
  spawn(flags) {
    const args = [
      'app-server',
      ...flags.flatMap((f) => ['--disable', f]),
      '-c',
      'mcp_servers={}',
      '-c',
      'web_search="disabled"',
    ];
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    let buffer = '';
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
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.stdin.on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      const error = new CodexError(
        `Codex 意外退出${stderr.trim() ? `：${stderr.trim().split('\n').at(-1).slice(0, 200)}` : ''}`,
      );
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      for (const thread of this.threads.values()) thread.fail(error);
      this.threads.clear();
    });
    return this.call(
      'initialize',
      {
        clientInfo: { name: 'folio', title: '页间 Folio', version: this.version },
        capabilities: { experimentalApi: true },
      },
      15_000,
    ).then(() => this.send({ method: 'initialized', params: {} }));
  }
  send(message) {
    if (!this.child) throw new CodexError('Codex 没有运行');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params, ms = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError(`Codex 没有响应（${method}）`));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ method, id, params });
      } catch (e) {
        this.pending.get(id)?.reject(e);
      }
    });
  }
  receive(m) {
    if (m.id !== undefined && !m.method) {
      const waiting = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) waiting?.reject(new CodexError(m.error.message || 'Codex 请求失败'));
      else waiting?.resolve(m.result);
      return;
    }
    if (m.method === 'account/rateLimits/updated') this.rateLimits = m.params?.rateLimits || null;
    for (const listener of this.listeners) listener(m);
    const threadId = m.params?.threadId;
    const thread = threadId && this.threads.get(threadId);
    if (thread) thread.handle(m);
    // A server request nobody claims (e.g. an approval) is declined so the turn can go on.
    else if (m.id !== undefined && m.method)
      this.send({ id: m.id, error: { code: -32601, message: 'Not supported by Folio' } });
  }
}

let server = null;
async function getServer(version) {
  if (server?.child) return server;
  const bin = findCodex();
  if (!bin)
    throw new CodexError(
      '没有找到 Codex。请安装 ChatGPT 桌面版（其中包含 Codex）或 Codex 命令行工具，登录后再试。',
    );
  server = new Server(bin, version);
  await server.start();
  return server;
}

function usageWindow(w) {
  if (!w || typeof w.usedPercent !== 'number') return null;
  return {
    usedPercent: w.usedPercent,
    windowMins: w.windowDurationMins || 0,
    resetsAt: w.resetsAt ? w.resetsAt * 1000 : 0,
  };
}
const quota = (rateLimits) => usageWindow(rateLimits?.primary);

// How much of each of the plan's usage windows is used (five hours and a week), read
// without starting a turn.
async function limits(version) {
  const s = await getServer(version);
  const result = await s.call('account/rateLimits/read', { excludeResetCreditDetails: true });
  if (result?.rateLimits) s.rateLimits = result.rateLimits;
  const windows = [result?.rateLimits?.primary, result?.rateLimits?.secondary]
    .map(usageWindow)
    .filter(Boolean);
  if (!windows.length) throw new CodexError('Codex 没有返回套餐额度');
  return { kind: 'plan', windows };
}

async function status(version) {
  const bin = findCodex();
  if (!bin) return { found: false };
  try {
    const s = await getServer(version);
    const result = await s.call('account/read', { refreshToken: false });
    const account = result?.account || null;
    const plan = account && (await limits(version).catch(() => null));
    return {
      found: true,
      path: bin,
      account: account
        ? { type: account.type, plan: account.planType || '', email: account.email || '' }
        : null,
      windows: plan?.windows || [],
    };
  } catch (e) {
    return { found: true, path: bin, account: null, error: e.message };
  }
}

// Opens ChatGPT's sign-in page; resolves once Codex reports the login finished.
async function login(version, openUrl) {
  const s = await getServer(version);
  const result = await s.call('account/login/start', { type: 'chatgpt' });
  if (!result?.authUrl) throw new CodexError('Codex 没有返回登录地址');
  await openUrl(result.authUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.listeners.delete(listener);
      reject(new CodexError('登录超时，请重试'));
    }, 10 * 60_000);
    const listener = (m) => {
      if (m.method !== 'account/login/completed') return;
      if (result.loginId && m.params?.loginId && m.params.loginId !== result.loginId) return;
      clearTimeout(timer);
      s.listeners.delete(listener);
      if (m.params?.success) resolve();
      else reject(new CodexError(m.params?.error || '登录没有完成'));
    };
    s.listeners.add(listener);
  });
  return status(version);
}

// Each model's levels as last listed, so a request says the level the menu shows.
let listed = [];
async function listModels(version) {
  const s = await getServer(version);
  const result = await s.call('model/list', {});
  const models = (result?.data || []).filter((m) => !m.hidden);
  models.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  listed = models.map((m) => ({
    id: m.id,
    efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter(Boolean),
    defaultEffort: m.defaultReasoningEffort || '',
    images: (m.inputModalities || ['text', 'image']).includes('image'),
  }));
  return listed;
}

// Earlier turns, flattened into the one input a new Codex turn takes. Pictures travel as
// separate inputs, in order; the text says which message each one came with.
function transcript(messages) {
  const shown = messages.filter((m) => m.role !== 'assistant' || m.content);
  let count = 0;
  const said = (m) => {
    if (!m.images?.length) return m.content;
    const numbers = m.images.map(() => ++count);
    return `（附图 ${numbers.join('、')}）\n${m.content}`;
  };
  if (shown.length === 1 && shown[0].role === 'user') return said(shown[0]);
  const last = shown.at(-1);
  const earlier = (last?.role === 'user' ? shown.slice(0, -1) : shown).map((m) =>
    m.role === 'user'
      ? `【用户】\n${said(m)}`
      : m.role === 'assistant'
        ? `【助手】\n${m.content}`
        : `【工具结果】\n${m.content}`,
  );
  return `以下是之前的对话：\n\n${earlier.join('\n\n')}\n\n---\n\n${last?.role === 'user' ? said(last) : '请继续。'}`;
}
const turnInput = (messages) => [
  ...messages.flatMap((m) =>
    m.role === 'user' ? (m.images || []).map((url) => ({ type: 'image', url })) : [],
  ),
  { type: 'text', text: transcript(messages) },
];
function friendly(message) {
  if (/usage limit|rate limit|quota/i.test(message))
    return `ChatGPT 套餐中的 Codex 额度已用完，请稍后再试（${message.slice(0, 160)}）`;
  if (/unauthorized|not logged in|login|401/i.test(message))
    return '需要在 AI 设置中重新用 ChatGPT 登录 Codex';
  return `Codex：${message.slice(0, 300)}`;
}

// A conversation's live thread. A turn that stops to call Folio's tools stays open; the
// next request, carrying the tool results, answers those calls and keeps streaming.
class Thread {
  constructor(s, id) {
    this.s = s;
    this.id = id;
    this.turnId = '';
    this.calls = [];
    this.waiting = null;
    this.total = { input: 0, output: 0, cached: 0 };
    this.reported = { input: 0, output: 0, cached: 0 };
    this.text = '';
    this.reasoning = '';
    this.touched = Date.now();
  }
  // Collects events until the turn finishes or asks for tools.
  next(onDelta, signal, idleMs) {
    return new Promise((resolve, reject) => {
      let idle;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => this.fail(new CodexError('Codex 长时间没有响应，已停止')), idleMs);
      };
      let gather = null;
      const abort = () => {
        this.s
          .call('turn/interrupt', { threadId: this.id, turnId: this.turnId }, 10_000)
          .catch(() => {});
        this.fail(Object.assign(new Error('已停止'), { name: 'AbortError' }));
      };
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
    });
  }
  result(stopReason) {
    const usage = {
      input: this.total.input - this.reported.input,
      output: this.total.output - this.reported.output,
      cached: this.total.cached - this.reported.cached,
    };
    this.reported = { ...this.total };
    const out = {
      text: this.text,
      reasoning: this.reasoning,
      toolCalls: stopReason === 'tool_use' ? this.calls.map((c) => c.call) : [],
      stopReason,
      usage,
      raw: stopReason === 'tool_use' ? { codexThread: this.id } : undefined,
      quota: quota(this.s.rateLimits),
    };
    this.text = '';
    this.reasoning = '';
    return out;
  }
  handle(m) {
    const w = this.waiting;
    this.touched = Date.now();
    w?.touch();
    switch (m.method) {
      case 'turn/started':
        this.turnId = m.params?.turn?.id || this.turnId;
        break;
      case 'item/agentMessage/delta':
        this.text += m.params.delta || '';
        w?.onDelta({ text: m.params.delta || '' });
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.reasoning += m.params.delta || '';
        w?.onDelta({ reasoning: m.params.delta || '' });
        break;
      // A web search the model chose to run (chat only): shown as a step, by its query.
      case 'item/started':
      case 'item/completed': {
        const item = m.params?.item;
        if (item?.type !== 'webSearch') break;
        const a = item.action || {};
        const what = a.type === 'openPage' ? a.url : item.query || a.query || a.queries?.[0];
        const title = `${a.type === 'openPage' ? '打开网页' : '联网搜索'}${what ? `：${what}` : ''}`;
        w?.onDelta({ search: { id: item.id, title, done: m.method === 'item/completed' } });
        break;
      }
      case 'item/tool/call': {
        const p = m.params || {};
        this.calls.push({
          requestId: m.id,
          call: { id: p.callId, name: p.tool, input: p.arguments ?? {} },
        });
        w?.onDelta({ tool: p.tool });
        w?.toolCall();
        break;
      }
      case 'thread/tokenUsage/updated': {
        const t = m.params?.tokenUsage?.total;
        if (t)
          this.total = {
            input: t.inputTokens || 0,
            output: (t.outputTokens || 0) + (t.reasoningOutputTokens || 0),
            cached: t.cachedInputTokens || 0,
          };
        break;
      }
      case 'error':
        if (!m.params?.willRetry)
          this.fail(
            new CodexError(friendly(m.params?.error?.message || m.params?.message || '出错了')),
          );
        break;
      case 'turn/completed': {
        const turn = m.params?.turn || {};
        if (turn.error?.message) this.fail(new CodexError(friendly(turn.error.message)));
        else w?.done(turn.status === 'completed' ? 'stop' : turn.status || 'stop');
        this.close();
        break;
      }
      default:
        // Anything else asking for an answer (approvals, user input) is declined.
        if (m.id !== undefined && m.method)
          this.s.send({ id: m.id, error: { code: -32601, message: 'Not supported by Folio' } });
    }
  }
  answer(results) {
    const calls = this.calls;
    this.calls = [];
    for (const c of calls) {
      const r = results.get(c.call.id);
      this.s.send({
        id: c.requestId,
        result: {
          success: !!r && !r.isError,
          contentItems: [{ type: 'inputText', text: r ? r.content : '没有执行这个工具。' }],
        },
      });
    }
  }
  fail(e) {
    this.waiting?.fail(e);
    this.close();
  }
  close() {
    this.s.threads.delete(this.id);
  }
}

async function streamCodex({ provider, request, signal, onDelta, version }) {
  const s = await getServer(version);
  const messages = request.messages || [];
  // Continuing a turn that stopped for tools: the last assistant message names its thread.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const live = lastAssistant?.raw?.codexThread && s.threads.get(lastAssistant.raw.codexThread);
  const idleMs = 180_000;
  // Turns left waiting on tool results (an agent run that was abandoned) are closed.
  for (const t of s.threads.values())
    if (t !== live && !t.waiting && Date.now() - t.touched > 15 * 60_000) {
      s.call('turn/interrupt', { threadId: t.id, turnId: t.turnId }, 10_000).catch(() => {});
      t.close();
    }
  if (live && messages.at(-1)?.role === 'tool') {
    live.touched = Date.now();
    const after = messages.slice(messages.lastIndexOf(lastAssistant) + 1);
    const results = new Map(after.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]));
    const pending = live.next(onDelta, signal, idleMs);
    live.answer(results);
    return pending;
  }
  const started = await s.call('thread/start', {
    cwd: s.cwd,
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    ...(provider.model ? { model: provider.model } : {}),
    baseInstructions:
      request.system ||
      '你是「页间」阅读器里的助手。回答用户关于文档的问题。用简体中文，使用 Markdown。',
    developerInstructions:
      '你在一个阅读器应用里运行，不能执行命令，也不能读写文件。只根据对话中提供的内容和可用的工具工作。' +
      (request.web
        ? '\n\n你可以联网搜索，但只在需要时才搜：问题涉及最新的信息（新闻、版本、价格、近期发生的事），或者要核实你没把握的具体事实（数字、日期、出处）。关于文档本身的问题，直接根据文档回答，不要搜索。用了搜索结果时，注明来源。'
        : ''),
    // Codex's own web search, for chat only; everything else stays offline.
    ...(request.web ? { config: { web_search: 'live' } } : {}),
    ...(request.tools?.length
      ? {
          dynamicTools: request.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        }
      : {}),
    serviceName: 'folio',
  });
  const threadId = started?.thread?.id;
  if (!threadId) throw new CodexError('Codex 没有创建对话');
  const thread = new Thread(s, threadId);
  s.threads.set(threadId, thread);
  const pending = thread.next(onDelta, signal, idleMs);
  // The level as electron/ai-providers.cjs works it out. No model is Codex's default one,
  // listed first.
  const list = listed.length ? listed : await listModels(version).catch(() => []);
  const model = list.find((m) => m.id === (provider.model || list[0]?.id));
  const effort = model
    ? levelFor(model.efforts, model.defaultEffort, provider.effort, provider.use)
    : /^(minimal|low|medium|high|xhigh|max)$/.test(provider.effort || '')
      ? provider.effort
      : '';
  try {
    const turn = await s.call('turn/start', {
      threadId,
      input: turnInput(messages),
      ...(effort ? { effort } : {}),
      summary: 'auto',
    });
    thread.turnId = turn?.turn?.id || thread.turnId;
  } catch (e) {
    thread.fail(new CodexError(friendly(e.message)));
  }
  return pending;
}

// The whiteboard teacher in one of ChatGPT's voices: a Codex realtime session, which a
// ChatGPT login can open only over WebRTC. The window holds the connection, plays the voice
// and gives it the microphone; this starts the session with the window's offer and passes
// on what the voice is to say or know. Its notifications reach the window through `emit`
// as { type: 'codex-voice', id, event }.
//
// What the teacher teaches comes from the board's model. When the voice asks Codex to look
// into a question itself (a delegation, which runs a Codex turn on the session's thread),
// that turn is stopped at once and the window is told: the answer comes from the board.
const voices = new Map();
const clip = (v, max) => String(v ?? '').slice(0, max);
async function voice(version, payload, emit) {
  const s = await getServer(version);
  const id = clip(payload?.id, 100);
  switch (payload?.type) {
    case 'voices': {
      const result = await s.call('thread/realtime/listVoices', {}, 15_000);
      // The voices a session over WebRTC accepts.
      return result?.voices?.v1 || [];
    }
    case 'start': {
      const started = await s.call('thread/start', {
        cwd: s.cwd,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        serviceName: 'folio',
      });
      const threadId = started?.thread?.id;
      if (!threadId) throw new CodexError('Codex 没有创建语音会话');
      let answer;
      const sdp = new Promise((resolve, reject) => (answer = { resolve, reject }));
      const listener = (m) => {
        if (m.params?.threadId !== threadId) return;
        if (m.method === 'turn/started') {
          s.call('turn/interrupt', { threadId, turnId: m.params.turn?.id }, 10_000).catch(() => {});
          emit({ type: 'codex-voice', id: threadId, event: { type: 'delegated' } });
          return;
        }
        if (!m.method?.startsWith('thread/realtime/')) return;
        const kind = m.method.slice('thread/realtime/'.length);
        if (kind === 'sdp') return answer.resolve(m.params.sdp);
        if (kind === 'error' || kind === 'closed') {
          const message = m.params.message || m.params.reason || '';
          answer.reject(new CodexError(friendly(message || '语音会话没有打开')));
          emit({ type: 'codex-voice', id: threadId, event: { type: kind, message } });
          if (kind === 'closed') {
            s.listeners.delete(listener);
            voices.delete(threadId);
          }
        }
      };
      s.listeners.add(listener);
      voices.set(threadId, () => s.listeners.delete(listener));
      const timer = setTimeout(
        () => answer.reject(new CodexError('Codex 语音会话没有响应')),
        20_000,
      );
      // What was said before, when a session takes over from one that ended.
      const history = (Array.isArray(payload.history) ? payload.history : [])
        .filter((h) => ['user', 'assistant', 'developer'].includes(h?.role) && h.text)
        .slice(-40)
        .map((h) => ({ role: h.role, text: clip(h.text, 600) }));
      try {
        await s.call('thread/realtime/start', {
          threadId,
          outputModality: 'audio',
          version: 'v3',
          voice: clip(payload.voice || 'cove', 40),
          transport: { type: 'webrtc', sdp: clip(payload.sdp, 20_000) },
          includeStartupContext: false,
          prompt: clip(payload.prompt, 4000),
          ...(history.length ? { initialItems: history } : {}),
        });
        return { id: threadId, sdp: await sdp };
      } catch (e) {
        voices.get(threadId)?.();
        voices.delete(threadId);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    // What the voice should know, from the board: talking points, what was drawn, what the
    // student did. Not said to the student as it is.
    case 'tell':
      await s.call('thread/realtime/appendText', {
        threadId: id,
        role: 'developer',
        text: clip(payload.text, 4000),
      });
      return true;
    case 'stop':
      voices.get(id)?.();
      voices.delete(id);
      await s.call('thread/realtime/stop', { threadId: id }, 10_000).catch(() => {});
      return true;
    default:
      throw new CodexError('未知的语音操作');
  }
}

function stop() {
  server?.child?.kill();
  server = null;
  voices.clear();
}

module.exports = {
  findCodex,
  status,
  login,
  limits,
  listModels,
  streamCodex,
  voice,
  stop,
  CodexError,
  transcript,
  turnInput,
};
