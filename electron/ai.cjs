// AI settings and requests. Keys never leave the main process: the window gets a masked
// hint, and requests are made here with the key attached.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const {
  presets,
  presetFor,
  streamChat,
  listModels,
  modelLevels,
  readBalance,
  AiError,
} = require('./ai-providers.cjs');
const codex = require('./ai-codex.cjs');
const kimi = require('./ai-kimi.cjs');
const speechServices = require('./cloud-voice.cjs');

const efforts = ['', 'off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Parts of the app that can have their own model; chat is the active service itself.
const uses = ['explain', 'translate', 'board', 'edit'];
const clean = (value, max = 300) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
function number(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : 0;
}

// `protect`/`unprotect` encrypt stored keys where the system allows it without prompts.
// `kimiHome` is where the Kimi Code CLI keeps 页间's sign-in and sessions.
function createAi({
  file,
  kimiHome,
  protect,
  unprotect,
  fetch,
  atomicWrite,
  version = '',
  openUrl,
}) {
  let cache = null;
  const running = new Map();
  async function read() {
    if (cache) return cache;
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      cache = value?.version === 1 ? value : null;
    } catch {}
    cache ||= { version: 1, providers: [], active: '', prefs: {} };
    cache.providers = Array.isArray(cache.providers) ? cache.providers : [];
    // Codex was once named “ChatGPT（通过 Codex）”; keep saved services in step with it.
    for (const p of cache.providers) if (p?.name === 'ChatGPT（通过 Codex）') p.name = 'Codex';
    cache.prefs = cache.prefs && typeof cache.prefs === 'object' ? cache.prefs : {};
    cache.uses = cache.uses && typeof cache.uses === 'object' ? cache.uses : {};
    cache.speech = cache.speech && typeof cache.speech === 'object' ? cache.speech : {};
    return cache;
  }
  async function write(next) {
    cache = next;
    await atomicWrite(file, JSON.stringify(next, null, 2));
    await fs.chmod(file, 0o600).catch(() => {});
  }
  function keyOf(stored) {
    if (!stored?.key) return '';
    try {
      return unprotect(stored.key);
    } catch {
      return '';
    }
  }
  function view(p) {
    const { key, ...rest } = p;
    return { ...rest, hasKey: !!key };
  }
  // A part's own choice, while its service is still there.
  function choiceFor(c, use) {
    const choice = uses.includes(use) ? c.uses[use] : null;
    return choice && c.providers.some((p) => p.id === choice.provider) ? choice : null;
  }
  async function config() {
    const c = await read();
    return {
      providers: c.providers.map(view),
      active: c.providers.some((p) => p.id === c.active) ? c.active : c.providers[0]?.id || '',
      uses: Object.fromEntries(
        uses.filter((use) => choiceFor(c, use)).map((use) => [use, c.uses[use]]),
      ),
      prefs: c.prefs,
      presets,
      speech: speechServices.services.map((service) => {
        const { shares, ...s } = service;
        const own = c.speech[s.id];
        const shared = !own?.key && sharedKey(c, service);
        return {
          ...s,
          hasKey: !!own?.key || !!shared,
          keyHint: own?.key ? own.keyHint : '',
          shared: shared ? shared.name : '',
        };
      }),
    };
  }
  // The AI service whose key a speech service can use too, when it has none of its own.
  function sharedKey(c, service) {
    return (
      (service.shares && c.providers.find((p) => p.preset === service.shares && p.key)) || null
    );
  }
  async function saveSpeechKey({ service, key }) {
    const c = await read();
    if (!speechServices.serviceFor(service)) throw new AiError('没有这个语音服务');
    key = typeof key === 'string' ? key.trim() : '';
    if (key.length > 4096 || /\s/.test(key)) throw new AiError('API Key 格式不正确');
    const speech = { ...c.speech };
    if (key)
      speech[service] = { key: protect(key), keyHint: `${key.slice(0, 3)}…${key.slice(-4)}` };
    else delete speech[service];
    await write({ ...c, speech });
    return config();
  }
  // A speech service's key and the host it goes to; `draft` is one the settings are trying.
  async function speechAccess(service, draft = '') {
    const c = await read();
    const own = c.speech[service.id];
    const shared = !own?.key && sharedKey(c, service);
    // A shared Qwen key belongs to its region's endpoint.
    const region = shared && /^https:\/\/(dashscope[\w-]*\.aliyuncs\.com)\//.exec(shared.baseUrl);
    return {
      key: draft || keyOf(own) || keyOf(shared),
      host: (!draft && !own?.key && region?.[1]) || 'dashscope.aliyuncs.com',
    };
  }
  // Says a sentence in a speech service's voice; the settings form may try a key not saved.
  async function speak({ voice, text, key }) {
    const { service, voice: id } = speechServices.parseVoice(voice);
    const draft = typeof key === 'string' ? key.trim() : '';
    return speechServices.synthesize({
      fetch,
      service,
      voice: id,
      ...(await speechAccess(service, draft)),
      text: clean(text, 2000),
    });
  }
  // For writing down what the student says with a speech service.
  async function hearingKey(id) {
    const service = speechServices.serviceFor(id);
    if (!service?.hears) throw new AiError('这个语音服务不能识别语音');
    const access = await speechAccess(service);
    if (!access.key)
      throw new AiError(`还没有填 ${service.name} 的 API Key：请在 AI 设置 › 语音服务里填写`);
    return access;
  }
  // Fields from the settings form, checked as if they came from anywhere.
  function sanitize(input, previous) {
    const preset = presetFor(clean(input.preset) || previous?.preset);
    const baseUrl =
      preset.kind === 'codex' || preset.kind === 'kimi'
        ? ''
        : clean(input.baseUrl ?? previous?.baseUrl ?? preset.baseUrl, 500);
    if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl))
      throw new AiError('接口地址需以 http:// 或 https:// 开头');
    return {
      id: previous?.id || crypto.randomUUID(),
      preset: preset.id,
      kind: preset.kind,
      name: clean(input.name ?? previous?.name, 60) || preset.name,
      baseUrl,
      model: clean(input.model ?? previous?.model ?? preset.model, 200),
      context: number(input.context ?? previous?.context, 4_000, 10_000_000) || preset.context,
      maxOutput: number(input.maxOutput ?? previous?.maxOutput, 256, 1_000_000),
      // The reasoning level; empty leaves it to the service. Older settings had on/off.
      effort: efforts.includes(input.effort)
        ? input.effort
        : (previous?.effort ?? (previous?.thinking === 'off' ? preset.efforts?.[0] || '' : '')),
      keyHint: previous?.keyHint || '',
      key: previous?.key || '',
      vision: previous?.vision || {},
    };
  }
  async function saveProvider(input) {
    const c = await read();
    const previous = c.providers.find((p) => p.id === input?.id);
    const next = sanitize(input || {}, previous);
    if (typeof input?.key === 'string') {
      const key = input.key.trim();
      if (key.length > 4096 || /\s/.test(key)) throw new AiError('API Key 格式不正确');
      next.key = key ? protect(key) : '';
      next.keyHint = key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '';
    }
    const providers = previous
      ? c.providers.map((p) => (p.id === next.id ? next : p))
      : [...c.providers, next];
    await write({ ...c, providers, active: c.active || next.id });
    return { provider: view(next), config: await config() };
  }
  async function removeProvider({ id }) {
    const c = await read();
    const providers = c.providers.filter((p) => p.id !== id);
    // Parts that used it go back to following chat.
    const kept = Object.fromEntries(Object.entries(c.uses).filter(([, u]) => u?.provider !== id));
    await write({
      ...c,
      providers,
      uses: kept,
      active: c.active === id ? providers[0]?.id || '' : c.active,
    });
    return config();
  }
  async function setActive({ id, model }) {
    const c = await read();
    if (!c.providers.some((p) => p.id === id)) throw new AiError('找不到这个 AI 服务');
    const providers =
      typeof model === 'string' && model.trim()
        ? c.providers.map((p) => (p.id === id ? { ...p, model: clean(model, 200) } : p))
        : c.providers;
    await write({ ...c, providers, active: id });
    return config();
  }
  // Gives one part of the app its own service, model and level, or (`follow`) lets it use
  // chat's again.
  async function setUse({ use, provider, model, effort, follow }) {
    const c = await read();
    if (!uses.includes(use)) throw new AiError('无效的功能');
    const next = { ...c.uses };
    if (follow) delete next[use];
    else {
      const stored = c.providers.find((p) => p.id === provider);
      if (!stored) throw new AiError('找不到这个 AI 服务');
      next[use] = {
        provider: stored.id,
        model: clean(model, 200) || stored.model,
        effort: efforts.includes(effort) ? effort : '',
      };
    }
    await write({ ...c, uses: next });
    return config();
  }
  // Whether a model takes images, as learned from sending it some.
  async function rememberVision(id, model, sees) {
    const c = await read();
    const stored = c.providers.find((p) => p.id === id);
    if (!stored || !model || stored.vision?.[model] === sees) return;
    const vision = { ...stored.vision, [model]: sees };
    await write({ ...c, providers: c.providers.map((p) => (p.id === id ? { ...p, vision } : p)) });
  }
  // Small per-user preferences: consent to send documents, projects with AI turned off.
  async function setPrefs(patch) {
    const c = await read();
    const prefs = { ...c.prefs };
    if (Array.isArray(patch?.consented))
      prefs.consented = [...new Set(patch.consented.map((s) => clean(s, 80)).filter(Boolean))];
    if (Array.isArray(patch?.disabledRoots))
      prefs.disabledRoots = [
        ...new Set(patch.disabledRoots.map((s) => clean(s, 4096)).filter(Boolean)),
      ].slice(0, 200);
    if (['auto', 'zh', 'en'].includes(patch?.language)) prefs.language = patch.language;
    if (typeof patch?.profile === 'string') prefs.profile = clean(patch.profile, 2000);
    await write({ ...c, prefs });
    return config();
  }
  // Resolves the provider for a request; a draft from the settings form may carry a new key.
  async function resolve({ id, draft, key }) {
    const c = await read();
    const stored = c.providers.find((p) => p.id === (id || c.active)) || c.providers[0];
    if (!stored && !draft) throw new AiError('请先在 AI 设置中添加一个服务');
    const provider = draft ? { ...sanitize(draft, stored), id: stored?.id || '' } : stored;
    return { provider, key: typeof key === 'string' && key.trim() ? key.trim() : keyOf(stored) };
  }
  // Chat requests go to the provider's protocol; ChatGPT plans go through Codex, Kimi
  // memberships through the Kimi Code CLI.
  function stream({ provider, key, request, signal, onDelta }) {
    if (provider.kind === 'codex')
      return codex.streamCodex({ provider, request, signal, onDelta, version });
    if (provider.kind === 'kimi')
      return kimi.streamKimi({ provider, request, signal, onDelta, home: kimiHome, version });
    return streamChat({ provider, key, request, signal, onDelta, fetch });
  }
  async function models(payload) {
    const { provider, key } = await resolve(payload || {});
    if (provider.kind === 'codex') return codex.listModels(version);
    if (provider.kind === 'kimi') return kimi.listModels(kimiHome);
    const preset = presetFor(provider.preset);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      return (await listModels({ provider, key, fetch, signal: controller.signal })).map((m) => {
        const { efforts, effort } = modelLevels(preset, m.id);
        return { ...m, efforts, defaultEffort: effort };
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new AiError('获取模型列表超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  // What's left on a service: money for the services that can tell, or how much of a
  // ChatGPT plan's or a Kimi membership's usage windows is used.
  async function balance(payload) {
    const { provider, key } = await resolve(payload || {});
    if (provider.kind === 'codex') return codex.limits(version);
    if (provider.kind === 'kimi') return kimi.limits(kimiHome, fetch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      return await readBalance({ provider, key, fetch, signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new AiError('查询余额超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  async function test(payload) {
    const { provider, key } = await resolve(payload || {});
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const result = await stream({
        provider,
        key,
        signal: controller.signal,
        onDelta: () => {},
        request: {
          messages: [{ role: 'user', content: '这是连接测试，请只回复“OK”。' }],
        },
      });
      return { ok: true, ms: Date.now() - started, reply: result.text.trim().slice(0, 80) };
    } catch (e) {
      if (e.name === 'AbortError') throw new AiError('连接超时，请检查网络或接口地址');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  // Only pictures the renderer encoded: base64 data: URLs of common image types.
  function withValidImages(m) {
    if (!Array.isArray(m?.images)) return m;
    const images = m.images
      .filter(
        (url) =>
          typeof url === 'string' &&
          url.length < 12_000_000 &&
          /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url),
      )
      .slice(0, 24);
    return { ...m, images };
  }
  // Streams deltas through `emit` and resolves with the complete reply.
  async function chat(payload, emit) {
    const requestId = clean(payload?.requestId, 80);
    if (!requestId) throw new AiError('无效的请求');
    // The part of the app asking picks the service; without a choice of its own, chat's.
    const choice = choiceFor(await read(), payload.use);
    const resolved = await resolve({ id: choice?.provider });
    const { key } = resolved;
    // A part following chat uses chat's level.
    const provider = choice
      ? {
          ...resolved.provider,
          model: choice.model || resolved.provider.model,
          effort: choice.effort,
          use: payload.use,
        }
      : resolved.provider;
    const request = {
      system: typeof payload.system === 'string' ? payload.system : '',
      messages: Array.isArray(payload.messages) ? payload.messages.map(withValidImages) : [],
      tools: Array.isArray(payload.tools) ? payload.tools : undefined,
      json: !!payload.json,
      // Web search, which only Codex has; asked for by chat.
      web: !!payload.web,
      maxTokens: number(payload.maxTokens, 1_000, 200_000),
    };
    const controller = new AbortController();
    running.set(requestId, controller);
    try {
      const result = await stream({
        provider,
        key,
        request,
        signal: controller.signal,
        onDelta: (delta) => emit({ type: 'ai-delta', requestId, ...delta }),
      });
      // A model that answered pictures takes them; one that turned them away doesn't, and
      // the next question holds pictures back and says why.
      if (request.messages.some((m) => m.images?.length))
        await rememberVision(provider.id, provider.model, true).catch(() => {});
      return { ...result, provider: provider.name, model: provider.model };
    } catch (e) {
      if (e.name === 'AbortError' || controller.signal.aborted) return { stopped: true };
      if (e.noImages) await rememberVision(provider.id, provider.model, false).catch(() => {});
      throw e;
    } finally {
      running.delete(requestId);
    }
  }
  function cancel({ requestId }) {
    running.get(requestId)?.abort();
    return true;
  }
  function cancelAll() {
    for (const controller of running.values()) controller.abort();
  }
  function shutdown() {
    cancelAll();
    codex.stop();
    kimi.stop();
  }
  const codexStatus = () => codex.status(version);
  const codexLogin = () => codex.login(version, openUrl);
  const codexVoice = (payload, emit) => codex.voice(version, payload, emit);
  const kimiStatus = () => kimi.status(kimiHome, version, fetch);
  const kimiLogin = () => kimi.login(kimiHome, version, fetch);
  const kimiLogout = () => kimi.logout(kimiHome, version, fetch);
  return {
    config,
    saveProvider,
    removeProvider,
    setActive,
    setUse,
    setPrefs,
    models,
    balance,
    test,
    chat,
    cancel,
    cancelAll,
    shutdown,
    codexStatus,
    codexLogin,
    codexVoice,
    kimiStatus,
    kimiLogin,
    kimiLogout,
    saveSpeechKey,
    speak,
    hearingKey,
  };
}
module.exports = { createAi };
