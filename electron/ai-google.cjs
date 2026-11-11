// Google subscriptions through the official Antigravity CLI's ACP server. Folio owns the
// conversation UI and its document tools. Google's process handles Google sign-in.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { createToolServer } = require('./ai-acp-tools.cjs');
const { binary, found, install, supported } = require('./ai-google-install.cjs');
const { transcript, unseenTail, seen, stale } = require('./ai-codex.cjs');
const { levelFor } = require('./ai-providers.cjs');

const authMethod = 'oauth-personal';
const stopped = () => new DOMException('已停止', 'AbortError');
const needsLogin = (e) =>
  /authentication required|unauthenticated|invalid_grant|sign.in required/i.test(e.message);
const webTools = ['search_web', 'read_url_content'];

function friendly(e) {
  if (e.name === 'AbortError') return e;
  const detail = e.message || '';
  if (/usage limit|quota|rate.limit|resource.exhausted|\b429\b/i.test(detail))
    return Error('Google 套餐额度已达上限，请稍后再试或切换模型');
  if (needsLogin(e)) return Error('请在 AI 设置中登录 Google 账号后重试');
  return Object.assign(
    Error(detail ? `Google：${detail.slice(0, 280)}` : 'Google 请求失败，请重试'),
    { code: e.code },
  );
}

async function googleEnvironment(resolveProxy) {
  const env = { ...process.env };
  // Python prefers proxy environment variables over the system proxy settings.
  // Keep Electron's HTTPS route for Google when adding a localhost exception.
  if (
    resolveProxy &&
    !Object.keys(env).some((key) => /^(https?|all)_proxy$/i.test(key) && env[key])
  ) {
    const route = await resolveProxy('https://cloudcode-pa.googleapis.com/').catch(() => '');
    const [type, address] = route.split(';', 1)[0].trim().split(/\s+/);
    const scheme = {
      PROXY: 'http',
      HTTP: 'http',
      HTTPS: 'https',
      SOCKS: 'socks4',
      SOCKS4: 'socks4',
      SOCKS5: 'socks5h',
    }[type];
    if (scheme && address) env.https_proxy = env.HTTPS_PROXY = `${scheme}://${address}`;
  }
  const existing = (env.no_proxy ?? env.NO_PROXY ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  env.no_proxy = env.NO_PROXY = [...new Set([...existing, 'localhost', '127.0.0.1', '::1'])].join(
    ',',
  );
  return env;
}

class Connection {
  constructor(home, cwd, version, env) {
    const args = [
      'acp',
      '--process-per-session',
      `--gemini-dir=${path.join(home, 'profile')}`,
      '--app-data-dir=antigravity-acp',
      '--disable-telemetry',
    ];
    this.child = spawn(binary(home), args, {
      cwd,
      // Google's CLI reads the existing Folio profile itself; Folio never handles tokens.
      env: {
        ...env,
        GEMINI_HOME: path.join(home, 'profile'),
        AGY_ACP_FORCE_FILE_STORAGE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.pending = new Map();
    this.turns = new Map();
    this.conversations = new Map();
    this.opened = 0;
    this.inUse = 0;
    this.nextId = 0;
    this.child.stderr.resume();
    this.child.stdin.on('error', (e) => this.end(e));
    this.child.on('error', (e) => this.end(e));
    this.child.on('close', () => this.end(Error('Google 登录组件已退出，请重试')));
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.receive(message);
    });
    this.ready = this.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'folio', title: '页间 Folio', version },
    }).then((info) => {
      if (
        info.agentInfo?.name !== 'Antigravity ACP Server' ||
        !info.authMethods?.some((m) => m.id === authMethod)
      )
        throw Error('请安装支持 Google 账号登录的 Antigravity ACP 组件');
      this.canClose = !!info.agentCapabilities?.sessionCapabilities?.close;
    });
  }
  send(message) {
    if (this.error) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  call(method, params, ms = 45_000) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer =
        ms &&
        setTimeout(() => {
          this.pending.delete(id);
          reject(Error('Google 长时间没有响应，请重试'));
        }, ms);
      this.pending.set(id, (error, result) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      });
      this.send({ id, method, params });
    });
  }
  receive(m) {
    if (!m.method) {
      const done = this.pending.get(m.id);
      this.pending.delete(m.id);
      done?.(
        m.error ? Object.assign(Error(m.error.message), { code: m.error.code }) : null,
        m.result,
      );
    } else if (m.method === 'session/update') {
      this.turns.get(m.params.sessionId)?.update(m.params.update);
    } else if (m.id !== undefined) {
      if (m.method === 'session/request_permission') {
        const turn = this.turns.get(m.params.sessionId);
        const call = m.params.toolCall;
        const mcp = call?._meta?.mcp;
        const own =
          mcp?.server === 'folio' && turn?.session.tools.some((tool) => tool.name === mcp.tool);
        const name = call?.title?.replace(/^Run (\w+)\?$/, '$1');
        const web = turn?.session.web && webTools.includes(name);
        const option = m.params.options?.find(
          (o) => o.kind === (own || web ? 'allow_once' : 'reject_once'),
        );
        this.send({
          id: m.id,
          result: {
            outcome: option
              ? { outcome: 'selected', optionId: option.optionId }
              : { outcome: 'cancelled' },
          },
        });
      } else {
        this.send({ id: m.id, error: { code: -32601, message: 'Not supported by Folio' } });
      }
    }
  }
  end(error) {
    if (this.error) return;
    this.error = error;
    for (const done of this.pending.values()) done(error);
    this.pending.clear();
  }
  close() {
    this.end(stopped());
    this.child.stdin.end();
    // EOF lets the server shut down its own companion process.
    const timer = setTimeout(() => this.child.kill(), 3000);
    timer.unref();
    this.child.once('close', () => clearTimeout(timer));
  }
}

const variants = (option) => (option?.options || []).flatMap((o) => o.options || [o]);
const config = (session, category) =>
  session.configOptions?.find((o) => o.category === category || o.id === category);
const thinking = (session) => config(session, 'thought_level') || config(session, 'thinking_level');
const folioLevel = (value) => (value === 'extra_high' ? 'xhigh' : value);
const tierOf = (response) => response?._meta?.antigravity?.tier?.name || '';

function modelOptions(session) {
  const model = config(session, 'model');
  const effort = thinking(session);
  const choices = variants(model).length
    ? variants(model)
    : (session.models?.availableModels || []).map((m) => ({ value: m.modelId }));
  const levels = variants(effort)
    .map((v) => folioLevel(v.value))
    .filter(Boolean);
  const defaultModel = model?.currentValue || session.models?.currentModelId;
  return choices
    .filter((m) => typeof m.value === 'string' && m.value)
    .map(({ value }) => ({
      id: value,
      efforts: levels,
      defaultEffort: folioLevel(effort?.currentValue || ''),
    }))
    .sort((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel));
}

function promptBlocks(messages) {
  const images = messages.flatMap((m) => (m.role === 'user' ? m.images || [] : []));
  return [
    ...images.map((url) => {
      const [, mimeType, data] = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(url);
      return { type: 'image', mimeType, data };
    }),
    { type: 'text', text: transcript(messages) },
  ];
}

class Turn {
  constructor(server, session) {
    this.server = server;
    this.session = session;
    this.calls = [];
    this.text = '';
    this.reasoning = '';
    this.done = null;
    this.hasProgress = false;
  }
  update(update) {
    const chunk = update.content?.type === 'text' ? update.content.text : '';
    const field =
      update.sessionUpdate === 'agent_message_chunk'
        ? 'text'
        : update.sessionUpdate === 'agent_thought_chunk'
          ? 'reasoning'
          : '';
    if (field && chunk) {
      this[field] += chunk;
      this.progress();
      this.waiter?.onDelta({ [field]: chunk });
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      this.progress();
    }
  }
  progress() {
    this.hasProgress = true;
    this.waiter?.touch();
  }
  toolCall({ name, input }, respond) {
    if (this.done || !this.session.tools.some((t) => t.name === name))
      return respond({ content: '这个工具不可用。', isError: true });
    this.calls.push({ call: { id: `google-${randomUUID()}`, name, input }, respond });
    this.waiter?.onDelta({ tool: name });
    this.progress();
    this.waiter?.tools();
  }
  answer(messages) {
    clearTimeout(this.toolTimeout);
    const results = new Map(
      messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]),
    );
    for (const { call, respond } of this.calls.splice(0))
      respond(results.get(call.id) || { content: '没有执行这个工具。', isError: true });
  }
  result(stopReason, usage = null) {
    const tools = stopReason === 'tool_use';
    const result = {
      text: this.text,
      reasoning: this.reasoning,
      stopReason,
      usage,
      toolCalls: tools ? this.calls.map((c) => c.call) : [],
      raw: tools ? { googleSession: this.session.id } : undefined,
    };
    this.text = '';
    this.reasoning = '';
    return result;
  }
  finish(error, response) {
    if (this.done) return;
    this.done = { error, response };
    this.answer([]);
    this.waiter?.finish();
  }
  cancel(error) {
    this.server.send({ method: 'session/cancel', params: { sessionId: this.session.id } });
    this.answer([]);
    this.finish(error);
  }
  next(onDelta, signal) {
    return new Promise((resolve, reject) => {
      let idle, gather;
      const abort = () => this.cancel(stopped());
      const settle = (fn) => {
        clearTimeout(idle);
        clearTimeout(gather);
        signal?.removeEventListener('abort', abort);
        this.waiter = null;
        fn();
      };
      const touch = () => {
        clearTimeout(idle);
        const ms = this.hasProgress ? 5 * 60_000 : 90_000;
        const message = this.hasProgress
          ? '回复中断，长时间没有新内容。请重试'
          : '90 秒内没有收到回复，请稍后重试';
        idle = setTimeout(
          () =>
            this.cancel(
              Object.assign(Error(message), {
                code: this.hasProgress ? 'GOOGLE_STREAM_IDLE' : 'GOOGLE_NO_RESPONSE',
              }),
            ),
          ms,
        );
      };
      this.waiter = {
        onDelta,
        touch,
        tools: () => {
          clearTimeout(gather);
          gather = setTimeout(
            () =>
              settle(() => {
                // Folio may be waiting for a tool confirmation. End an abandoned turn
                // so it cannot keep the localhost request open indefinitely.
                this.toolTimeout = setTimeout(() => {
                  this.cancel(Error('工具没有返回结果，Google 对话已停止'));
                  this.server.turns.delete(this.session.id);
                }, 15 * 60_000);
                this.toolTimeout.unref();
                resolve(this.result('tool_use'));
              }),
            150,
          );
        },
        finish: () =>
          settle(() => {
            const { error, response } = this.done;
            const reason = response?.stopReason;
            if (error || reason === 'cancelled') reject(error || stopped());
            else if (reason === 'refusal' && !this.text) reject(Error('Google 拒绝回答这个请求'));
            else if (!this.text && !this.hadTools && reason !== 'max_tokens')
              reject(Error('Google 没有返回回答'));
            else {
              const u = response?.usage;
              resolve(
                this.result(
                  reason === 'max_tokens' ? 'max_tokens' : 'stop',
                  u
                    ? {
                        input: u.inputTokens || 0,
                        output: u.outputTokens || 0,
                        cached: u.cachedReadTokens || 0,
                      }
                    : null,
                ),
              );
            }
          }),
      };
      signal?.addEventListener('abort', abort, { once: true });
      touch();
      if (this.done) this.waiter.finish();
      else if (signal?.aborted) abort();
      else if (this.calls.length) this.waiter.tools();
    });
  }
}

function createGoogle({ home, version, fetch, resolveProxy, atomicWrite }) {
  const cwd = path.join(home, 'work');
  const profile = path.join(home, 'profile', 'antigravity-acp');
  const catalogFile = path.join(home, 'models.json');
  const hasLogin = () =>
    fs.access(path.join(profile, 'acp_token.json')).then(
      () => true,
      () => false,
    );
  const toolServer = createToolServer();
  let server, starting, refreshing, login, installing;

  function stop() {
    server?.close();
    server = undefined;
    toolServer.stop();
  }
  async function connection() {
    if (server?.retired) {
      // Retire only this connection. Other active turns may still finish on it.
      const previous = server;
      server = undefined;
      if (!previous.inUse && !previous.turns.size) previous.close();
    }
    if (server?.error || (server?.opened >= 24 && !server.inUse && !server.turns.size)) stop();
    if (server) return server;
    starting ||= (async () => {
      // An explicit chat or sign-in may upgrade the component. Opening the app
      // or its settings still only reads local state.
      if (!(await found(home))) await installComponent();
      await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
      const next = new Connection(home, cwd, version, await googleEnvironment(resolveProxy));
      try {
        await next.ready;
      } catch (e) {
        next.close();
        throw e;
      }
      return (server = next);
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function newSession(s, request) {
    const session = { route: randomUUID(), tools: request.tools || [], web: !!request.web };
    session.toolCall = (...args) => {
      const turn = s.turns.get(session.id);
      if (turn) turn.toolCall(...args);
      else args[1]({ content: '对话已经结束。', isError: true });
    };
    try {
      const mcpServers = await toolServer.connect(session, version);
      const system = [
        '你是页间 Folio 的阅读助手。用用户提供的文档和页间提供的工具回答。',
        request.system,
        request.json ? '请只输出请求要求的 JSON。' : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      session.info = await s.call('session/new', {
        cwd,
        mcpServers,
        _meta: {
          antigravity: {
            enabledTools: session.web ? webTools : [],
            eagerMcpServers: mcpServers.length ? ['folio'] : [],
            systemPrompt: { append: system },
          },
        },
      });
      session.id = session.info.sessionId;
      if (!session.id) throw Error('没有创建 Google 对话');
      s.opened++;
      return session;
    } catch (e) {
      toolServer.disconnect(session.route);
      throw e;
    }
  }
  async function cachedCatalog() {
    try {
      const saved = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
      if (Array.isArray(saved.models)) return saved;
    } catch {}
    return { models: [], plan: '' };
  }
  async function rememberCatalog(info, plan = '') {
    const catalog = { models: modelOptions(info), plan: tierOf(info) || plan };
    if (catalog.models.length)
      await atomicWrite(catalogFile, JSON.stringify(catalog)).catch(() => {});
    return catalog;
  }
  async function refreshCatalog(plan) {
    if (!(await hasLogin())) throw Error('Authentication required');
    refreshing ||= (async () => {
      const s = await connection();
      s.inUse++;
      try {
        const session = await newSession(s, {});
        try {
          return await rememberCatalog(session.info, plan);
        } finally {
          forget(s, session);
        }
      } finally {
        s.inUse--;
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  // Opening settings only checks Google's local sign-in marker. The next
  // explicit request lets Google validate or refresh its own credentials.
  async function status() {
    const installed = await found(home);
    const base = { found: installed, supported, signedIn: false };
    if (!installed || !(await hasLogin())) return base;
    return { ...base, signedIn: true, plan: (await cachedCatalog()).plan };
  }
  function signIn() {
    login ||= (async () => {
      const s = await connection();
      s.inUse++;
      try {
        const auth = await s.call('authenticate', { methodId: authMethod }, 5 * 60_000);
        try {
          await refreshCatalog(tierOf(auth));
          return await status();
        } catch (e) {
          return { ...(await status()), error: friendly(e).message };
        }
      } finally {
        s.inUse--;
      }
    })()
      .catch((e) => {
        stop();
        throw friendly(e);
      })
      .finally(() => {
        login = undefined;
      });
    return login;
  }
  async function signOut() {
    const s = await connection();
    s.inUse++;
    try {
      await s.call('logout', {});
    } finally {
      s.inUse--;
    }
    stop();
    await refreshing?.catch(() => {});
    await fs.rm(catalogFile, { force: true });
    return status();
  }

  function forget(s, session) {
    toolServer.disconnect(session.route);
    for (const [key, kept] of s.conversations) if (kept === session) s.conversations.delete(key);
    if (!session.closed && s.canClose) {
      session.closed = true;
      // Dropping just our reference leaves the official worker and its upstream
      // request alive. Close the ACP session as well, including after a cancel.
      void s.call('session/close', { sessionId: session.id }, 10_000).catch(() => {});
    }
  }

  async function streamOnce({ provider, request, signal, onDelta }) {
    if (!(await hasLogin())) throw friendly(Error('Authentication required'));
    const s = await connection();
    s.inUse++;
    let turn;
    try {
      signal?.throwIfAborted();
      const messages = request.messages || [];
      if (!messages.length) throw Error('请先输入问题');
      const lastAssistant = messages.findLast((m) => m.role === 'assistant');
      const live = s.turns.get(lastAssistant?.raw?.googleSession);
      if (live && messages.at(-1)?.role === 'tool') {
        turn = live;
        turn.hadTools = true;
        turn.answer(messages.slice(messages.lastIndexOf(lastAssistant) + 1));
      } else {
        const key = request.session || '';
        const shape = JSON.stringify([
          provider.model,
          request.system,
          request.tools,
          request.web,
          request.json,
        ]);
        for (const staleKey of stale(s.conversations)) {
          const session = s.conversations.get(staleKey);
          if (!s.turns.has(session.id)) forget(s, session);
        }
        const kept = s.conversations.get(key);
        const busy = kept && s.turns.has(kept.id);
        const tail = kept && !busy && kept.shape === shape && unseenTail(kept, messages);
        const session = tail ? kept : await newSession(s, request);
        // Older installations may only have the saved model. Populate their
        // list from the first conversation they open with Google.
        if (!tail && !(await cachedCatalog()).models.length) await rememberCatalog(session.info);
        turn = new Turn(s, session);
        s.turns.set(session.id, turn);
        if (kept && !busy && !tail) forget(s, kept);
        if (key && !busy) {
          session.shape = shape;
          seen(session, messages);
          s.conversations.set(key, session);
        }
        const change = async (option, value) => {
          if (option && value && value !== option.currentValue) {
            const reply = await s.call('session/set_config_option', {
              sessionId: session.id,
              configId: option.id,
              value,
            });
            if (reply?.configOptions) session.info.configOptions = reply.configOptions;
          }
        };
        const model = config(session.info, 'model');
        await change(model, provider.model);
        const effort = thinking(session.info);
        if (effort) {
          const values = variants(effort).map((v) => v.value);
          const selected = levelFor(
            values.map(folioLevel),
            folioLevel(effort.currentValue),
            provider.effort,
            provider.use,
          );
          await change(
            effort,
            values.find((value) => folioLevel(value) === selected),
          );
        }
        signal?.throwIfAborted();
        s.call(
          'session/prompt',
          { sessionId: session.id, prompt: promptBlocks(tail || messages) },
          0,
        ).then(
          (result) => turn.finish(null, result),
          (e) => turn.finish(e),
        );
      }
      const result = await turn.next(onDelta, signal);
      if (result.stopReason !== 'tool_use') {
        s.turns.delete(turn.session.id);
        if (![...s.conversations.values()].includes(turn.session)) forget(s, turn.session);
      }
      return result;
    } catch (e) {
      if (e.code === 'GOOGLE_NO_RESPONSE' || e.code === 'GOOGLE_STREAM_IDLE') s.retired = true;
      if (turn) {
        s.turns.delete(turn.session.id);
        forget(s, turn.session);
      }
      throw friendly(e);
    } finally {
      s.inUse--;
      if (s.retired && !s.inUse && !s.turns.size) {
        if (server === s) server = undefined;
        s.close();
      }
    }
  }

  async function stream(options) {
    try {
      return await streamOnce(options);
    } catch (e) {
      // No text, thinking, or tool activity means nothing has been presented or
      // executed. Retry once on a fresh connection, keeping the chosen model
      // and effort. A partial reply or tool continuation must never be replayed.
      if (e.code !== 'GOOGLE_NO_RESPONSE' || options.signal?.aborted) throw e;
      await options.onDiagnostic?.({ event: 'google-reconnect', reason: 'no-first-response' });
      return streamOnce(options);
    }
  }

  function installComponent() {
    installing ||= install(home, fetch).finally(() => {
      installing = undefined;
    });
    return installing;
  }

  return {
    status,
    signIn,
    signOut,
    stop,
    stream,
    install: installComponent,
    listModels: async (refresh) => {
      try {
        if (refresh) return (await refreshCatalog()).models;
        return (await hasLogin()) ? (await cachedCatalog()).models : [];
      } catch (e) {
        throw friendly(e);
      }
    },
  };
}

module.exports = { createGoogle };
