// Talks to the AI services people bring their own API key for. Two protocols cover them:
// the OpenAI-compatible chat completions API (DeepSeek, Qwen, Kimi, GLM, Doubao, Gemini,
// Ollama and most others) and Anthropic's Messages API for Claude.
//
// Messages use one neutral shape on both sides of IPC:
//   { role: 'user' | 'assistant' | 'tool', content, images?, toolCalls?, toolCallId?, isError?,
//     reasoning?, raw? }
// `images` are data: URLs on user turns; they go before the text, as the services suggest.
// `raw` keeps Claude's content blocks (thinking included) so a tool loop can send them back
// unchanged; `reasoning` is echoed to providers that require it during tool use.

// `thinking` says how a request sets the reasoning level:
//   type     -> { thinking: { type: 'enabled' | 'disabled' } }, and reasoning_effort for a
//               level                                     (DeepSeek, GLM, Doubao, Kimi)
//   enable   -> { enable_thinking: boolean }, and reasoning_effort for a level      (Qwen)
//   effort   -> { reasoning_effort }                               (OpenAI, Gemini)
//   claude / codex / kimi -> the service's own effort setting
//   none     -> not controllable
// `efforts` are the levels offered to pick from and `effort` the one used until another is
// picked: the service's own default, so every request says its level. Where a service's
// models differ, `levels` gives [pattern, levels, default] by model name, from the
// service's documentation: the first pattern that matches wins, and models no pattern
// matches have `efforts`. 'off' among a model's levels means its thinking can be turned off;
// a model with no levels is sent none.
// `echo` providers require reasoning_content back on assistant turns once tools are used.
// `balance` services tell what's left on the account through the same key (readBalance).
const presets = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    context: 1_000_000,
    thinking: 'type',
    efforts: ['off', 'low', 'high', 'max'],
    effort: 'high',
    echo: true,
    usage: true,
    balance: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    region: 'cn',
  },
  {
    id: 'qwen',
    name: '通义千问',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-flash', 'qwen-long'],
    context: 131_072,
    thinking: 'enable',
    efforts: [],
    // qwen3.8's reasoning_effort is low, medium and xhigh, which `high` stands for; Qwen3,
    // 3.5 to 3.7, qwen-plus, -flash and -turbo only turn thinking on and off.
    levels: [
      ['^qwen3\\.8-2\\.4t', ['low', 'medium', 'high'], 'high'],
      ['^qwen3\\.8-', ['off', 'low', 'medium', 'high'], 'high'],
      ['thinking|instruct|coder|character|vl|^qwen3\\.7-max-preview', [], ''],
      ['^qwen3-max|^qwen-(plus|flash|turbo)', ['off', 'on'], 'off'],
      ['^qwen3(\\.\\d)?-', ['off', 'on'], 'on'],
    ],
    usage: true,
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    region: 'cn',
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: '',
    models: [],
    context: 262_144,
    thinking: 'type',
    efforts: [],
    // kimi-k3 always thinks; kimi-k2.7-code always thinks at its own level.
    levels: [
      ['^kimi-k3', ['low', 'high', 'max'], 'max'],
      ['^kimi-k2\\.6', ['off', 'on'], 'on'],
    ],
    echo: true,
    balance: true,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    region: 'cn',
  },
  // A Kimi membership through the Kimi Code CLI on this computer; no API key.
  {
    id: 'kimicode',
    name: 'Kimi Code',
    kind: 'kimi',
    baseUrl: '',
    model: 'kimi-for-coding',
    models: [],
    context: 262_144,
    thinking: 'kimi',
    // Each model's levels and default come from the CLI's model list; these stand in until
    // it has been read.
    efforts: [],
    levels: [
      ['^kimi-for-coding-highspeed', [], ''],
      ['^kimi-for-coding', ['low', 'high', 'max'], 'max'],
      ['^k3', ['low', 'high', 'max'], 'high'],
    ],
    noKey: true,
    region: 'cn',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: '',
    models: [],
    context: 131_072,
    thinking: 'type',
    efforts: [],
    // GLM-5.3 always thinks; GLM-5.2's low and medium are high.
    levels: [
      ['^glm-5\\.3', ['low', 'high', 'max'], 'max'],
      ['^glm-5\\.2', ['off', 'high', 'max'], 'max'],
      ['^glm-(4\\.[5-7]|5)', ['off', 'on'], 'on'],
    ],
    balance: true,
    keyUrl: 'https://open.bigmodel.cn/apikey/platform',
    region: 'cn',
  },
  {
    id: 'doubao',
    name: '豆包（火山方舟）',
    kind: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    models: [],
    context: 131_072,
    thinking: 'type',
    efforts: [],
    // Seed 2.x levels; their xhigh and max are high.
    levels: [
      ['^doubao-seed-(2-1-|evolving)', ['off', 'low', 'medium', 'high'], 'high'],
      ['^doubao-seed-(2-0-|character-260628)', ['off', 'low', 'medium', 'high'], 'medium'],
    ],
    // The key lists every model on the platform; only the ones opened on the account show.
    probe: true,
    keyUrl: 'https://console.volcengine.com/ark',
    region: 'cn',
  },
  {
    id: 'xiaomi',
    name: '小米 MiMo',
    kind: 'openai',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash',
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
    context: 1_048_576,
    thinking: 'type',
    // MiMo's text models think unless turned off, and have no levels.
    efforts: ['off', 'on'],
    effort: 'on',
    echo: true,
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    region: 'cn',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: '',
    models: [],
    context: 131_072,
    thinking: 'none',
    efforts: [],
    balance: true,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    region: 'cn',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    models: [],
    context: 400_000,
    thinking: 'effort',
    efforts: [],
    // The reasoning models; chat models and the pro models (which take only some levels)
    // are sent none.
    levels: [
      ['chat|-pro|^o1-mini', [], ''],
      ['^(gpt-[56]|o[134])', ['low', 'medium', 'high'], 'medium'],
    ],
    usage: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    region: 'global',
  },
  // A ChatGPT plan through the Codex app server on this computer; no API key.
  {
    id: 'codex',
    name: 'Codex',
    kind: 'codex',
    baseUrl: '',
    model: '',
    models: [],
    context: 272_000,
    thinking: 'codex',
    // Each model's levels and default come from Codex's model list.
    efforts: ['low', 'medium', 'high', 'xhigh'],
    effort: 'medium',
    noKey: true,
    region: 'global',
  },
  {
    id: 'anthropic',
    name: 'Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    context: 1_000_000,
    thinking: 'claude',
    efforts: [],
    // output_config.effort; Haiku 4.5 and Sonnet 4.5 have none.
    levels: [
      ['^claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
      [
        '^claude-(fable|mythos|opus-5|opus-4-[78]|sonnet-5)',
        ['low', 'medium', 'high', 'xhigh', 'max'],
        'high',
      ],
      ['^claude-(opus|sonnet)-4-6', ['low', 'medium', 'high', 'max'], 'high'],
      ['^claude-opus-4-5', ['low', 'medium', 'high'], 'high'],
    ],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    region: 'global',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    models: [],
    context: 1_000_000,
    thinking: 'effort',
    efforts: [],
    // Gemini 3 maps reasoning_effort onto its thinking levels; 2.5 thinks by a budget.
    levels: [
      ['^gemini-3(\\.\\d+)?-pro', ['low', 'medium', 'high'], 'high'],
      ['^gemini-3', ['low', 'medium', 'high'], 'medium'],
    ],
    keyUrl: 'https://aistudio.google.com/apikey',
    region: 'global',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    models: [],
    context: 131_072,
    thinking: 'none',
    efforts: [],
    balance: true,
    keyUrl: 'https://openrouter.ai/keys',
    region: 'global',
  },
  {
    id: 'ollama',
    name: 'Ollama（本机模型）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    models: [],
    context: 32_768,
    thinking: 'none',
    efforts: [],
    noKey: true,
    region: 'local',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本机模型）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    models: [],
    context: 32_768,
    thinking: 'none',
    efforts: [],
    noKey: true,
    region: 'local',
  },
  {
    id: 'custom',
    name: '其他（OpenAI 兼容）',
    kind: 'openai',
    baseUrl: '',
    model: '',
    models: [],
    context: 131_072,
    thinking: 'none',
    efforts: [],
    region: 'global',
  },
];
const presetFor = (id) => presets.find((p) => p.id === id) || presets.at(-1);

class AiError extends Error {
  // `noImages`: the service turned pictures away, so the model doesn't take them.
  constructor(message, { status = 0, retry = false, noImages = false } = {}) {
    super(message);
    this.status = status;
    this.retry = retry;
    this.noImages = noImages;
  }
}
function detail(body) {
  try {
    const value = JSON.parse(body);
    const message = value?.error?.message || value?.message || value?.error || value?.msg;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {}
  return String(body || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
// Explains an HTTP failure in words, keeping the service's own message for specifics.
function httpError(status, body, name) {
  const info = detail(body);
  const suffix = info ? `（${name}：${info}）` : '';
  if (status === 401 || status === 403)
    return new AiError(`API Key 无效、已过期或没有权限${suffix}`, { status });
  if (status === 402) return new AiError(`账户余额不足，请到 ${name} 充值${suffix}`, { status });
  if (status === 404)
    return new AiError(`找不到接口或模型，请检查接口地址和模型名称${suffix}`, { status });
  if (status === 413 || (status === 400 && /context|too long|maximum.*tokens|exceed/i.test(info)))
    return new AiError(`内容超过了模型能处理的长度${suffix}`, { status });
  if (status === 429)
    return new AiError(`请求太频繁或额度已用完，请稍后再试${suffix}`, { status, retry: true });
  if (status >= 500)
    return new AiError(`${name} 服务暂时不可用（${status}），请稍后再试${suffix}`, {
      status,
      retry: true,
    });
  return new AiError(`请求失败（${status}）${suffix}`, { status });
}
function networkError(e, provider) {
  if (e?.name === 'AbortError') return e;
  const local = /127\.0\.0\.1|localhost/.test(provider.baseUrl || '');
  return new AiError(
    local
      ? `无法连接到本机模型服务，请确认 ${provider.name || '服务'} 已启动`
      : `无法连接到 ${provider.name || provider.baseUrl}，请检查网络或代理设置（${e?.message || e}）`,
    { retry: true },
  );
}
function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new AiError('请填写以 http:// 或 https:// 开头的接口地址');
  return base.replace(/\/chat\/completions$/, '') + suffix;
}
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
    });
  });

// Server-sent events: yields each `data:` payload.
async function* sseData(body, signal, idleMs) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new AiError('服务长时间没有响应，已停止', { retry: true })),
          idleMs,
        );
      });
      let chunk;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length) yield data.join('\n');
  } finally {
    reader.releaseLock?.();
  }
}

// Local reasoning models (Ollama, LM Studio) put their thinking inside <think> tags.
function thinkSplitter() {
  let state = 'start';
  let pending = '';
  return (text) => {
    const out = { text: '', reasoning: '' };
    pending += text;
    while (pending) {
      if (state === 'start') {
        const trimmed = pending.trimStart();
        if (!trimmed) return out;
        if ('<think>'.startsWith(trimmed) && trimmed.length < 7) return out;
        if (trimmed.startsWith('<think>')) {
          state = 'think';
          pending = trimmed.slice(7);
        } else state = 'text';
      } else if (state === 'think') {
        const end = pending.indexOf('</think>');
        if (end === -1) {
          // Keep a possible partial closing tag for the next chunk.
          const keep = Math.min(pending.length, 7);
          out.reasoning += pending.slice(0, pending.length - keep);
          pending = pending.slice(pending.length - keep);
          if (!pending.includes('<')) {
            out.reasoning += pending;
            pending = '';
          }
          return out;
        }
        out.reasoning += pending.slice(0, end);
        pending = pending.slice(end + 8).replace(/^\s+/, '');
        state = 'text';
      } else {
        out.text += pending;
        pending = '';
      }
    }
    return out;
  };
}

function toOpenAIMessages(system, messages, { echo, tools }) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'tool')
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '' });
    else if (m.role === 'assistant') {
      const message = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        message.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
        if (!m.content) message.content = null;
      }
      if (echo && tools) message.reasoning_content = m.reasoning || '';
      out.push(message);
    } else if (m.images?.length)
      out.push({
        role: 'user',
        content: [
          ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
          { type: 'text', text: m.content || '' },
        ],
      });
    else out.push({ role: 'user', content: m.content || '' });
  }
  return out;
}
const hasImages = (messages) => messages.some((m) => m.images?.length);
// The levels a model offers and the one it uses until another is picked (see `levels` on
// the presets).
function modelLevels(preset, model) {
  const rule = preset.levels?.find(([pattern]) => new RegExp(pattern, 'i').test(model || ''));
  return rule
    ? { efforts: rule[1], effort: rule[2] }
    : { efforts: preset.efforts || [], effort: preset.effort || '' };
}
// Reasoning levels from least to most; `on` thinks as deeply as the model likes.
const depth = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, on: 4, high: 4, xhigh: 5, max: 6 };
const thinks = (level) => depth[level] >= 2;
const least = (levels) => levels.reduce((a, b) => (depth[b] < depth[a] ? b : a));
// The level a model uses (src/ai/levels.ts works it out the same way for the menus). One
// picked that the model doesn't have becomes the nearest it has, thinking or not as picked
// where it can, the higher of two as near. With none picked, a part of the app starts at
// its own: translation at the least, explanations and the whiteboard at the least that
// still thinks (not thinking, for a model only switched on or off), chat and source edits
// at the model's default.
function levelFor(levels, fallback, picked, use) {
  const known = levels.filter((l) => l in depth);
  if (levels.includes(picked) || !known.length) return levels.includes(picked) ? picked : fallback;
  if (picked in depth) {
    const same = known.filter((l) => thinks(l) === thinks(picked));
    const off = (l) => Math.abs(depth[l] - depth[picked]);
    return (same.length ? same : known).reduce((a, b) =>
      off(b) < off(a) || (off(b) === off(a) && depth[b] > depth[a]) ? b : a,
    );
  }
  if (use === 'translate') return least(known);
  if (use === 'explain' || use === 'board') {
    const graded = known.filter((l) => thinks(l) && l !== 'on');
    if (graded.length) return least(graded);
    if (known.includes('off')) return 'off';
  }
  return fallback;
}
// The level a request uses; `use` is the part of the app whose own choice it is.
function effortFor(provider) {
  const { efforts, effort } = modelLevels(presetFor(provider.preset), provider.model);
  return levelFor(efforts, effort, provider.effort, provider.use);
}
function effortParams(provider) {
  const preset = presetFor(provider.preset);
  const effort = effortFor(provider);
  if (!effort) return {};
  // A model that always thinks takes the level alone.
  const switchable = modelLevels(preset, provider.model).efforts.includes('off');
  if (preset.thinking === 'type') {
    if (effort === 'off' || effort === 'on')
      return { thinking: { type: effort === 'on' ? 'enabled' : 'disabled' } };
    return { ...(switchable ? { thinking: { type: 'enabled' } } : {}), reasoning_effort: effort };
  }
  if (preset.thinking === 'enable') {
    if (effort === 'off' || effort === 'on') return { enable_thinking: effort === 'on' };
    return { ...(switchable ? { enable_thinking: true } : {}), reasoning_effort: effort };
  }
  if (preset.thinking === 'effort') return { reasoning_effort: effort };
  return {};
}
function parseArguments(text) {
  if (!text?.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __invalid: text };
  }
}
async function streamOpenAI({ provider, key, request, signal, onDelta, fetch }) {
  const preset = presetFor(provider.preset);
  const tools = request.tools?.length ? request.tools : null;
  const body = {
    model: provider.model,
    messages: toOpenAIMessages(request.system, request.messages, { echo: preset.echo, tools }),
    stream: true,
    ...(preset.usage ? { stream_options: { include_usage: true } } : {}),
    ...(tools
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: 'auto',
        }
      : {}),
    ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    // A long piece (a whole notes page) asks for more room than some services' default.
    ...(provider.maxOutput || request.maxTokens
      ? { max_tokens: provider.maxOutput || request.maxTokens }
      : {}),
    ...effortParams(provider),
  };
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (provider.preset === 'openrouter') {
    headers['HTTP-Referer'] = 'https://helloxxy.com/works/folio/';
    headers['X-Title'] = 'Folio';
  }
  let response;
  try {
    response = await fetch(endpoint(provider.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw networkError(e, provider);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (
      hasImages(request.messages) &&
      // OpenRouter answers 404 when none of a model's hosts takes images.
      [400, 404, 415, 422].includes(response.status) &&
      /image|vision|multimodal|modal|picture/i.test(text)
    )
      throw new AiError(
        `${provider.model} 不能看图，请换一个能看图的模型，或去掉图片再问（${provider.name}：${detail(text)}）`,
        { status: response.status, noImages: true },
      );
    // Some services reject the JSON response format or a large output limit; retry without.
    if (request.json && response.status === 400 && /response_format|json/i.test(text))
      return streamOpenAI({
        provider,
        key,
        request: { ...request, json: false },
        signal,
        onDelta,
        fetch,
      });
    if (
      request.maxTokens &&
      !provider.maxOutput &&
      response.status === 400 &&
      /max_tokens|max_completion_tokens|maximum/i.test(text)
    )
      return streamOpenAI({
        provider,
        key,
        request: { ...request, maxTokens: 0 },
        signal,
        onDelta,
        fetch,
      });
    throw httpError(response.status, text, provider.name);
  }
  const split = thinkSplitter();
  const result = { text: '', reasoning: '', toolCalls: [], stopReason: '', usage: null };
  const calls = [];
  for await (const data of sseData(response.body, signal, request.idleMs || 180_000)) {
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new AiError(`${provider.name}：${detail(JSON.stringify(chunk))}`);
    if (chunk.usage) {
      const u = chunk.usage;
      result.usage = {
        input: u.prompt_tokens || 0,
        output: u.completion_tokens || 0,
        cached: u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    const reasoning = delta.reasoning_content || delta.reasoning || '';
    if (typeof reasoning === 'string' && reasoning) {
      result.reasoning += reasoning;
      onDelta({ reasoning });
    }
    if (typeof delta.content === 'string' && delta.content) {
      const part = split(delta.content);
      if (part.reasoning) {
        result.reasoning += part.reasoning;
        onDelta({ reasoning: part.reasoning });
      }
      if (part.text) {
        result.text += part.text;
        onDelta({ text: part.text });
      }
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? calls.length;
      const current = (calls[index] ||= { id: '', name: '', arguments: '' });
      if (call.id) current.id = call.id;
      if (call.function?.name) {
        current.name += call.function.name;
        onDelta({ tool: current.name });
      }
      if (call.function?.arguments) current.arguments += call.function.arguments;
    }
    if (choice.finish_reason) result.stopReason = choice.finish_reason;
  }
  result.toolCalls = calls
    .filter(Boolean)
    .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, input: parseArguments(c.arguments) }));
  if (result.stopReason === 'length') result.stopReason = 'max_tokens';
  return result;
}

let Anthropic;
const adaptive = /claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable|mythos)/;
// Refused requests continue on another model in the same call (Claude Opus 5, Fable 5.1).
const fallbackModels = /^claude-(opus-5|fable-5-1)$/;
function anthropicClient(provider, key, fetch) {
  Anthropic ||= require('@anthropic-ai/sdk').default;
  return new Anthropic({
    apiKey: key,
    baseURL: provider.baseUrl?.replace(/\/+$/, '').replace(/\/v1$/, '') || undefined,
    fetch,
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  });
}
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content || '',
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      // All results of one assistant turn go back in a single user message.
      if (last?.role === 'user' && Array.isArray(last.content) && last.toolResults)
        last.content.push(block);
      else out.push({ role: 'user', content: [block], toolResults: true });
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.raw)) out.push({ role: 'assistant', content: m.raw });
      else {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls || [])
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
        out.push({ role: 'assistant', content: content.length ? content : '（空）' });
      }
    } else if (m.images?.length)
      out.push({
        role: 'user',
        content: [
          ...m.images.map((url) => {
            const [, media_type, data] = url.match(/^data:(image\/[\w+]+);base64,(.*)$/s) || [];
            return { type: 'image', source: { type: 'base64', media_type, data } };
          }),
          { type: 'text', text: m.content || '' },
        ],
      });
    else out.push({ role: 'user', content: m.content || '' });
  }
  return out.map(({ toolResults, ...m }) => m);
}
function anthropicError(e, provider) {
  if (e?.name === 'AbortError' || e?.constructor?.name === 'APIUserAbortError')
    return Object.assign(new Error('已停止'), { name: 'AbortError' });
  if (typeof e?.status === 'number')
    return httpError(e.status, JSON.stringify(e.error || { message: e.message }), provider.name);
  return networkError(e, provider);
}
async function streamAnthropic({ provider, key, request, signal, onDelta, fetch }) {
  const client = anthropicClient(provider, key, fetch);
  const model = provider.model;
  const effort = effortFor(provider);
  const params = {
    model,
    max_tokens: provider.maxOutput || Math.min(64_000, Math.max(32_000, request.maxTokens || 0)),
    cache_control: { type: 'ephemeral' },
    messages: toAnthropicMessages(request.messages),
    ...(request.system ? { system: request.system } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
    ...(adaptive.test(model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };
  const withFallback = fallbackModels.test(model) && !request.noFallback;
  let stream;
  try {
    stream = withFallback
      ? client.beta.messages.stream(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal },
        )
      : client.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use')
        onDelta({ tool: event.content_block.name });
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') onDelta({ text: event.delta.text });
      if (event.delta.type === 'thinking_delta') onDelta({ reasoning: event.delta.thinking });
    }
    const message = await stream.finalMessage();
    const result = { text: '', reasoning: '', toolCalls: [], raw: message.content };
    for (const block of message.content) {
      if (block.type === 'text') result.text += block.text;
      if (block.type === 'thinking') result.reasoning += block.thinking || '';
      if (block.type === 'tool_use')
        result.toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
    result.stopReason = message.stop_reason;
    result.usage = {
      input:
        (message.usage.input_tokens || 0) +
        (message.usage.cache_read_input_tokens || 0) +
        (message.usage.cache_creation_input_tokens || 0),
      output: message.usage.output_tokens || 0,
      cached: message.usage.cache_read_input_tokens || 0,
    };
    return result;
  } catch (e) {
    // Accounts or proxies that don't accept the fallback beta still get an answer.
    if (withFallback && e?.status === 400 && /fallback|beta/i.test(e.message || ''))
      return streamAnthropic({
        provider,
        key,
        request: { ...request, noFallback: true },
        signal,
        onDelta,
        fetch,
      });
    throw anthropicError(e, provider);
  }
}

// Retries rate limits and outages, but only before anything has been shown.
async function streamChat({ provider, key, request, signal, onDelta, fetch }) {
  if (!provider.model) throw new AiError('请先在 AI 设置中选择模型');
  const preset = presetFor(provider.preset);
  if (!key && !preset.noKey && preset.id !== 'custom')
    throw new AiError(`请先在 AI 设置中填写 ${provider.name} 的 API Key`);
  const run = provider.kind === 'anthropic' ? streamAnthropic : streamOpenAI;
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      return await run({
        provider,
        key,
        request,
        signal,
        fetch,
        onDelta: (d) => {
          started = true;
          onDelta(d);
        },
      });
    } catch (e) {
      if (provider.kind === 'anthropic' || !e.retry || started || attempt >= 2) throw e;
      await sleep(1200 * (attempt + 1), signal);
    }
  }
}

// Whether a listed model takes images, where the list says so: OpenRouter's
// architecture.input_modalities, Kimi's supports_image_in.
function listedImages(m) {
  const modalities = m?.architecture?.input_modalities || m?.input_modalities;
  if (Array.isArray(modalities)) return modalities.includes('image');
  if (typeof m?.supports_image_in === 'boolean') return m.supports_image_in;
  return undefined;
}
// Ollama and LM Studio tell from their own APIs, beside the OpenAI-compatible /v1.
async function localImages(provider, ids, fetch, signal) {
  const root = String(provider.baseUrl || '').replace(/\/v1\/?$/, '');
  const found = new Map();
  if (provider.preset === 'ollama')
    await Promise.all(
      ids.map(async (id) => {
        try {
          const response = await fetch(endpoint(root, '/api/show'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: id }),
            signal,
          });
          const caps = response.ok ? (await response.json())?.capabilities : null;
          if (Array.isArray(caps)) found.set(id, caps.includes('vision'));
        } catch {}
      }),
    );
  if (provider.preset === 'lmstudio')
    try {
      const response = await fetch(endpoint(root, '/api/v0/models'), { signal });
      const list = response.ok ? (await response.json())?.data : null;
      for (const m of Array.isArray(list) ? list : [])
        if (m?.id && (m.type === 'vlm' || m.type === 'llm')) found.set(m.id, m.type === 'vlm');
    } catch {}
  return found;
}

// Qwen and Doubao list every model on their platforms: other makers', pictures, speech,
// retired models, open-weight sizes, previews and dated snapshots. Only their own current
// chat models show.
const qwenOther =
  /tts|asr|realtime|livetranslate|image|embedding|rerank|-mt-|ocr|s2s|deep-|audio|omni|math|character|gui|longcontext|^qwen-coder/i;
function shown(preset, m, id) {
  if (preset === 'qwen')
    return (
      /^qwen/i.test(id) &&
      !qwenOther.test(id) &&
      !/-\d+(\.\d+)?[bt](-|$)/i.test(id) &&
      !/-(\d{4}-\d{2}-\d{2}|\d{4}|latest|preview)$/.test(id)
    );
  if (preset === 'doubao')
    return /^doubao-/.test(id) && m?.status !== 'Shutdown' && ['LLM', 'VLM'].includes(m?.domain);
  if (preset === 'xiaomi') return !/tts|asr/i.test(id);
  return true;
}
// Whether a model is opened on the account: Doubao answers ModelNotOpen for one that isn't,
// before any reply, so the reply is dropped unread.
async function opened(provider, key, model, fetch, signal) {
  try {
    const response = await fetch(endpoint(provider.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '1' }],
        max_tokens: 1,
        stream: true,
      }),
      signal,
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return true;
    }
    const text = await response.text().catch(() => '');
    return response.status !== 404 && !/ModelNotOpen/i.test(text);
  } catch (e) {
    if (signal?.aborted) throw e;
    return true;
  }
}

// The service's models, each with whether it takes images when the service says.
async function listModels({ provider, key, fetch, signal }) {
  if (provider.kind === 'anthropic') {
    const client = anthropicClient(provider, key, fetch);
    const ids = [];
    try {
      for await (const model of client.models.list({ limit: 100 }, { signal })) ids.push(model.id);
    } catch (e) {
      throw anthropicError(e, provider);
    }
    return ids.map((id) => ({ id }));
  }
  let response;
  try {
    response = await fetch(endpoint(provider.baseUrl, '/models'), {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal,
    });
  } catch (e) {
    throw networkError(e, provider);
  }
  const text = await response.text();
  if (!response.ok) throw httpError(response.status, text, provider.name);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AiError('模型列表格式无法识别，请手动填写模型名称');
  }
  const list = Array.isArray(value) ? value : value.data || value.models || [];
  const models = new Map();
  for (const m of list) {
    const id = String((typeof m === 'string' ? m : m?.id || m?.name) || '');
    if (id && !models.has(id) && shown(provider.preset, m, id)) models.set(id, listedImages(m));
  }
  if (presetFor(provider.preset).probe) {
    const open = await Promise.all(
      [...models.keys()].map((id) => opened(provider, key, id, fetch, signal)),
    );
    [...models.keys()].forEach((id, i) => open[i] || models.delete(id));
  }
  const local = await localImages(provider, [...models.keys()], fetch, signal);
  return [...models]
    .map(([id, images]) => {
      const sees = local.has(id) ? local.get(id) : images;
      return typeof sees === 'boolean' ? { id, images: sees } : { id };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// What's left on the account, for the services whose key can ask (`balance` presets).
const amount = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n, currency) =>
  `${n < 0 ? '-' : ''}${currency === 'USD' ? '$' : '¥'}${Math.abs(n).toFixed(2)}`;
async function readBalance({ provider, key, fetch, signal }) {
  const get = async (url) => {
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal });
    } catch (e) {
      throw networkError(e, provider);
    }
    const text = await response.text();
    if (!response.ok) throw httpError(response.status, text, provider.name);
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError('余额格式无法识别');
    }
  };
  // DeepSeek's balance sits beside its /v1 alias, not under it.
  const base =
    provider.preset === 'deepseek' ? provider.baseUrl.replace(/\/v1\/?$/, '') : provider.baseUrl;
  // The .com and .ai sites of the Chinese services bill in dollars.
  const currency = /\.(com|ai)$/.test(new URL(base).hostname) ? 'USD' : 'CNY';
  switch (provider.preset) {
    case 'deepseek': {
      const value = await get(endpoint(base, '/user/balance'));
      const infos = Array.isArray(value?.balance_infos) ? value.balance_infos : [];
      const info = infos.find((i) => amount(i.total_balance) > 0) || infos[0];
      if (!info) throw new AiError('DeepSeek 没有返回余额');
      const c = info.currency === 'USD' ? 'USD' : 'CNY';
      return {
        kind: 'money',
        amount: amount(info.total_balance),
        currency: c,
        detail: `赠送 ${money(amount(info.granted_balance), c)} · 充值 ${money(amount(info.topped_up_balance), c)}`,
        empty: value.is_available === false,
      };
    }
    case 'moonshot': {
      const d = (await get(endpoint(base, '/users/me/balance')))?.data;
      if (!d) throw new AiError('Kimi 没有返回余额');
      const left = amount(d.available_balance);
      return {
        kind: 'money',
        amount: left,
        currency,
        detail: `代金券 ${money(amount(d.voucher_balance), currency)} · 现金 ${money(amount(d.cash_balance), currency)}`,
        empty: left <= 0,
      };
    }
    case 'siliconflow': {
      const d = (await get(endpoint(base, '/user/info')))?.data;
      if (!d) throw new AiError('硅基流动没有返回余额');
      const left = amount(d.totalBalance);
      return {
        kind: 'money',
        amount: left,
        currency,
        detail: `赠送 ${money(amount(d.balance), currency)} · 充值 ${money(amount(d.chargeBalance), currency)}`,
        empty: left <= 0,
      };
    }
    case 'zhipu': {
      // What the console's own finance pages ask; they take the API key too, though the API
      // docs don't list them. Usable resource packages count besides the cash.
      const origin = new URL(base).origin;
      const [account, list] = await Promise.all([
        get(`${origin}/api/biz/account/query-customer-account-report`),
        get(`${origin}/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=50&filterEnabled=true`),
      ]);
      if (account?.code !== 200 || !account.data)
        throw new AiError(`智谱没有返回余额${account?.msg ? `（${account.msg}）` : ''}`);
      const model = provider.model.toLowerCase();
      const packs = (Array.isArray(list?.rows) ? list.rows : [])
        .filter((r) => amount(r.availableBalance) > 0)
        .map((r) => {
          const tokens = r.consumeType === 'TOKENS';
          const fits = String(r.suitableModel || '');
          return {
            name: String(r.resourcePackageName || '资源包').replace(/^【[^】]*】/, ''),
            left: `${amount(r.availableBalance).toLocaleString('en-US')} ${tokens ? 'tokens' : '次'}`,
            // Beijing time, as the console shows it.
            until: Date.parse(`${r.expirationTime}+08:00`) || 0,
            // A package for this model, or for every model billed by tokens.
            fits:
              tokens &&
              (/[\u4e00-\u9fa5]/.test(fits) || fits.toLowerCase().split(',').includes(model)),
          };
        })
        .sort((a, b) => b.fits - a.fits);
      const left = amount(account.data.availableBalance);
      return {
        kind: 'money',
        amount: left,
        currency: 'CNY',
        detail: '',
        empty: left <= 0 && !packs.some((p) => p.fits),
        packs,
      };
    }
    case 'openrouter': {
      // OpenRouter tells a plain key only its own limit; the account's credits need a
      // management key.
      const d = (await get(endpoint(base, '/key')))?.data || {};
      const used = money(amount(d.usage), 'USD');
      if (typeof d.limit_remaining !== 'number')
        return {
          kind: 'money',
          amount: null,
          currency: 'USD',
          detail: `这个 Key 没设额度上限，已用 ${used}；账户余额请到 OpenRouter 官网查看`,
          empty: false,
        };
      const reset = { daily: '，每天重置', weekly: '，每周重置', monthly: '，每月重置' };
      return {
        kind: 'money',
        amount: d.limit_remaining,
        currency: 'USD',
        detail: `这个 Key 的额度上限 ${money(amount(d.limit), 'USD')}${reset[d.limit_reset] || ''}，已用 ${used}`,
        empty: d.limit_remaining <= 0,
      };
    }
    default:
      throw new AiError(`${provider.name} 查不了余额，请到官网查看`);
  }
}

module.exports = {
  presets,
  presetFor,
  streamChat,
  listModels,
  readBalance,
  money,
  toOpenAIMessages,
  toAnthropicMessages,
  effortParams,
  effortFor,
  levelFor,
  modelLevels,
  thinkSplitter,
  httpError,
  AiError,
};
