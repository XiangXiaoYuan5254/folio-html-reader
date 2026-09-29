import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleX,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkle,
  Trash2,
  X,
} from 'lucide-react';
import { invoke } from '../api';
import { errorText, savePrefs, setAiConfig, useAiConfig } from '../ai/client';
import type { AiConfig, AiPreset, AiProvider, CodexStatus, ModelOption } from '../ai/types';
import { effortLabel, forgetModelOptions } from '../ai/levels';

const blurbs: Record<string, string> = {
  deepseek: '国内直连，价格低，长文档友好',
  qwen: '阿里云百炼',
  moonshot: '月之暗面，长上下文',
  zhipu: '智谱开放平台',
  doubao: '字节跳动火山方舟',
  siliconflow: '多种开源模型',
  anthropic: 'Anthropic',
  openai: 'GPT 系列',
  gemini: 'Google AI Studio',
  openrouter: '海外多模型聚合',
  ollama: '在本机运行，文档不出电脑',
  lmstudio: '在本机运行，文档不出电脑',
  custom: '任何 OpenAI 兼容接口',
  codex: '用 ChatGPT 套餐额度，不需要 API Key',
};
const groups: { title: string; region: AiPreset['region'] }[] = [
  { title: '国内服务', region: 'cn' },
  { title: '海外服务', region: 'global' },
  { title: '本机模型', region: 'local' },
];
type Form = {
  id?: string;
  preset: string;
  name: string;
  baseUrl: string;
  model: string;
  context: number;
  maxOutput: number;
  effort: string;
  key: string;
  keyHint: string;
  hasKey: boolean;
};
function fromProvider(p: AiProvider): Form {
  return { ...p, key: '' };
}
function fromPreset(p: AiPreset): Form {
  return {
    preset: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    context: p.context,
    maxOutput: 0,
    effort: '',
    key: '',
    keyHint: '',
    hasKey: false,
  };
}
const contextOptions = [8_192, 32_768, 65_536, 131_072, 262_144, 400_000, 1_000_000];
const contextLabel = (n: number) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1024)}K`;

export function AiSettings({
  onClose,
  root,
  projectName,
}: {
  onClose: () => void;
  root?: string;
  projectName?: string;
}) {
  const config = useAiConfig();
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'models'>('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [modelInfo, setModelInfo] = useState<ModelOption[] | null>(null);
  const models = modelInfo && modelInfo.map((m) => m.id);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!config || selected !== null || adding) return;
    const first = config.providers.find((p) => p.id === config.active) || config.providers[0];
    if (first) {
      setSelected(first.id);
      setForm(fromProvider(first));
    } else setAdding(true);
  }, [config]);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  const preset = config?.presets.find((p) => p.id === form?.preset);
  const dirty = useMemo(() => {
    if (!form) return false;
    const stored = config?.providers.find((p) => p.id === form.id);
    if (!stored) return true;
    return (
      !!form.key ||
      (['name', 'baseUrl', 'model', 'context', 'maxOutput', 'effort'] as const).some(
        (k) => form[k] !== stored[k],
      )
    );
  }, [form, config]);
  function pick(p: AiProvider) {
    setAdding(false);
    setSelected(p.id);
    setForm(fromProvider(p));
    setStatus(null);
    setModelInfo(null);
    setConfirmRemove(false);
  }
  function choosePreset(p: AiPreset) {
    setAdding(false);
    setSelected('new');
    setForm(fromPreset(p));
    setStatus(null);
    setModelInfo(null);
    setAdvanced(p.id === 'custom');
  }
  const patch = (fields: Partial<Form>) => setForm((f) => (f ? { ...f, ...fields } : f));
  const draft = () =>
    form && {
      preset: form.preset,
      name: form.name,
      baseUrl: form.baseUrl,
      model: form.model,
      context: form.context,
      maxOutput: form.maxOutput,
      effort: form.effort,
    };
  async function save() {
    if (!form) return null;
    setBusy('save');
    setStatus(null);
    try {
      const r = await invoke<{ provider: AiProvider; config: AiConfig }>('ai-save-provider', {
        id: form.id,
        ...draft(),
        ...(form.key ? { key: form.key } : {}),
      });
      setAiConfig(r.config);
      forgetModelOptions(r.provider.id);
      setSelected(r.provider.id);
      setForm(fromProvider(r.provider));
      setStatus({ ok: true, text: '已保存' });
      return r.provider;
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
      return null;
    } finally {
      setBusy('');
    }
  }
  async function test() {
    if (!form) return;
    setBusy('test');
    setStatus(null);
    try {
      const r = await invoke<{ ms: number; reply: string }>('ai-test', {
        id: form.id,
        draft: draft(),
        ...(form.key ? { key: form.key } : {}),
      });
      setStatus({
        ok: true,
        text: `连接成功 · ${(r.ms / 1000).toFixed(1)} 秒${r.reply ? ` · 回复：${r.reply}` : ''}`,
      });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy('');
    }
  }
  // `quiet` fills the list in the background (e.g. once Codex reports a login).
  async function fetchModels(quiet = false) {
    if (!form) return;
    setBusy('models');
    if (!quiet) setStatus(null);
    try {
      const info = await invoke<ModelOption[]>('ai-models', {
        id: form.id,
        draft: draft(),
        ...(form.key ? { key: form.key } : {}),
      });
      const list = info.map((m) => m.id);
      setModelInfo(info);
      if (!quiet) setModelsOpen(true);
      // A new service starts with the service's own default model.
      if (list.length) setForm((f) => (f && !f.model ? { ...f, model: list[0] } : f));
      if (!list.length) setStatus({ ok: false, text: '服务没有返回模型，请手动填写模型名称' });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    if (!form?.id) return;
    const next = await invoke<AiConfig>('ai-remove-provider', { id: form.id });
    setAiConfig(next);
    setConfirmRemove(false);
    const first = next.providers[0];
    if (first) pick(first);
    else {
      setSelected(null);
      setForm(null);
      setAdding(true);
    }
  }
  async function makeDefault() {
    if (!form?.id) return;
    setAiConfig(await invoke<AiConfig>('ai-set-active', { id: form.id }));
  }
  const disabled = !!root && !!config?.prefs.disabledRoots?.includes(root);
  const allModels = [...new Set([...(models || []), ...(preset?.models || [])])];
  const levels =
    modelInfo?.find((m) => m.id === form?.model)?.efforts.filter(Boolean) || preset?.efforts || [];
  // Typing narrows the list; an exact choice shows everything again.
  const typed = form?.model.toLowerCase() || '';
  const modelChoices = allModels.includes(form?.model || '')
    ? allModels
    : allModels.filter((m) => m.toLowerCase().includes(typed));
  const needsKey = !preset?.noKey;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="ai-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
        tabIndex={-1}
        ref={panel}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.stopPropagation();
            if (modelsOpen) setModelsOpen(false);
            else onClose();
          }
        }}
      >
        <header className="ai-settings-heading">
          <h2 id="ai-settings-title">
            <Sparkle size={17} />
            AI 设置
          </h2>
          <span>用自己的 API Key 或 ChatGPT 账号，接入国内外主流模型或本机模型</span>
          <button type="button" className="icon-button" aria-label="关闭 AI 设置" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="ai-settings-body">
          <nav className="ai-provider-list" aria-label="已添加的 AI 服务">
            {config?.providers.map((p) => (
              <button
                key={p.id}
                className={selected === p.id ? 'active' : ''}
                onClick={() => pick(p)}
              >
                <strong>{p.name}</strong>
                <span>{p.model || '未选择模型'}</span>
                {config.active === p.id ? <em>默认</em> : null}
              </button>
            ))}
            <button
              className={`ai-add-provider ${adding ? 'active' : ''}`}
              onClick={() => {
                setAdding(true);
                setSelected(null);
                setForm(null);
                setStatus(null);
              }}
            >
              <Plus size={14} />
              添加服务
            </button>
          </nav>
          <section className="ai-settings-main">
            {adding || !form ? (
              <div className="ai-presets">
                <p className="ai-settings-lead">
                  选择一个服务，填入在它官网申请的 API Key，费用由服务商按用量收取，页间不经手。已有
                  ChatGPT 套餐的话，可以选“ChatGPT（通过 Codex）”，直接用套餐额度。
                </p>
                {groups.map((g) => (
                  <div key={g.region}>
                    <h3>{g.title}</h3>
                    <div className="ai-preset-grid">
                      {config?.presets
                        .filter((p) => p.region === g.region && p.id !== 'custom')
                        .map((p) => (
                          <button key={p.id} onClick={() => choosePreset(p)}>
                            <strong>{p.name}</strong>
                            <span>{blurbs[p.id]}</span>
                          </button>
                        ))}
                      {g.region === 'global' ? (
                        <button
                          onClick={() => {
                            const custom = config?.presets.find((p) => p.id === 'custom');
                            if (custom) choosePreset(custom);
                          }}
                        >
                          <strong>其他</strong>
                          <span>{blurbs.custom}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <form
                className="ai-provider-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <div className="ai-form-fields">
                  <label>
                    <span>名称</span>
                    <input
                      value={form.name}
                      maxLength={60}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </label>
                  {needsKey ? (
                    // Not a <label>: it holds a link besides the input.
                    <div className="ai-field">
                      <span>
                        API Key
                        {preset?.keyUrl ? (
                          <button
                            type="button"
                            className="ai-link"
                            onClick={() => void invoke('external', { url: preset.keyUrl })}
                          >
                            去 {preset.name} 获取
                            <ExternalLink size={11} />
                          </button>
                        ) : null}
                      </span>
                      <div className="ai-key-field">
                        <KeyRound size={14} />
                        <input
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          aria-label="API Key"
                          placeholder={
                            form.hasKey ? `已保存 ${form.keyHint}，留空则不修改` : '粘贴 API Key'
                          }
                          value={form.key}
                          onChange={(e) => patch({ key: e.target.value.trim() })}
                        />
                      </div>
                    </div>
                  ) : preset?.kind === 'codex' ? (
                    <CodexAccount
                      onReady={() => {
                        if (!models) void fetchModels(true);
                      }}
                    />
                  ) : (
                    <p className="ai-local-hint">
                      本机模型不需要 API Key。请先启动 {preset?.name.replace(/（.*）/, '')}{' '}
                      并下载模型，文档内容不会离开这台电脑。
                    </p>
                  )}
                  <label className="ai-model-field">
                    <span>模型</span>
                    <div className="ai-model-input">
                      <input
                        value={form.model}
                        placeholder="填写模型名称，或点击右侧获取列表"
                        spellCheck={false}
                        aria-label="模型"
                        onFocus={() => models && setModelsOpen(true)}
                        onBlur={() => setTimeout(() => setModelsOpen(false), 150)}
                        onChange={(e) => {
                          patch({ model: e.target.value.trim() });
                          if (models) setModelsOpen(true);
                        }}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!!busy}
                        onClick={() => void fetchModels()}
                      >
                        {busy === 'models' ? (
                          <LoaderCircle className="spin" size={13} />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        获取列表
                      </button>
                      {modelsOpen && modelChoices.length ? (
                        <div className="ai-model-menu" role="listbox">
                          {modelChoices.slice(0, 200).map((m) => (
                            <button
                              type="button"
                              role="option"
                              aria-selected={m === form.model}
                              key={m}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                patch({ model: m });
                                setModelsOpen(false);
                              }}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {!models && preset?.models.length ? (
                      <div className="ai-model-suggestions">
                        {preset.models.map((m) => (
                          <button
                            type="button"
                            key={m}
                            className={m === form.model ? 'active' : ''}
                            onClick={() => patch({ model: m })}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </label>
                  {levels.length ? (
                    <label>
                      <span>推理强度</span>
                      <select
                        aria-label="推理强度"
                        value={form.effort}
                        onChange={(e) => patch({ effort: e.target.value })}
                      >
                        {['', ...levels].map((level) => (
                          <option key={level} value={level}>
                            {effortLabel(level)}
                            {level === '' ? '（由模型决定）' : ''}
                          </option>
                        ))}
                      </select>
                      <em className="ai-field-hint">
                        也可以在助手输入框下方随时切换。解释、翻译和划重点总是用最快的档位。
                      </em>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="ai-advanced-toggle"
                    aria-expanded={advanced}
                    onClick={() => setAdvanced((v) => !v)}
                  >
                    {advanced
                      ? '收起高级设置'
                      : preset?.kind === 'codex'
                        ? '高级设置：上下文长度'
                        : '高级设置：接口地址、上下文长度'}
                  </button>
                  {advanced ? (
                    <div className="ai-advanced">
                      {preset?.kind === 'codex' ? null : (
                        <label>
                          <span>接口地址</span>
                          <input
                            value={form.baseUrl}
                            spellCheck={false}
                            placeholder="https://…/v1"
                            onChange={(e) => patch({ baseUrl: e.target.value.trim() })}
                          />
                        </label>
                      )}
                      <div className="ai-advanced-row">
                        <label>
                          <span>上下文长度</span>
                          <select
                            value={form.context}
                            onChange={(e) => patch({ context: Number(e.target.value) })}
                          >
                            {[...new Set([...contextOptions, form.context])]
                              .sort((a, b) => a - b)
                              .map((n) => (
                                <option key={n} value={n}>
                                  {contextLabel(n)} tokens
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          <span>单次最多输出</span>
                          <input
                            type="number"
                            min={0}
                            step={1024}
                            value={form.maxOutput || ''}
                            placeholder="服务默认"
                            onChange={(e) => patch({ maxOutput: Number(e.target.value) || 0 })}
                          />
                        </label>
                      </div>
                      <p>
                        上下文长度决定一次能带上多少文档内容；超出时页间只发送与问题最相关的部分。
                      </p>
                    </div>
                  ) : null}
                  {status ? (
                    <p className={`ai-status ${status.ok ? 'ok' : 'error'}`} role="status">
                      {status.ok ? <Check size={14} /> : <CircleX size={14} />}
                      {status.text}
                    </p>
                  ) : null}
                </div>
                <div className="ai-form-actions">
                  {form.id ? (
                    confirmRemove ? (
                      <button type="button" className="ai-danger" onClick={() => void remove()}>
                        确认删除
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="删除这个服务"
                        title="删除这个服务"
                        onClick={() => setConfirmRemove(true)}
                      >
                        <Trash2 size={15} />
                      </button>
                    )
                  ) : null}
                  {form.id && config?.active !== form.id && !dirty ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void makeDefault()}
                    >
                      设为默认
                    </button>
                  ) : null}
                  <span className="toolbar-flex" />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!!busy || !form.model}
                    onClick={() => void test()}
                  >
                    {busy === 'test' ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <PlugZap size={14} />
                    )}
                    测试连接
                  </button>
                  <button className="primary-button" disabled={!!busy || !dirty}>
                    {busy === 'save' ? '保存中…' : form.id ? '保存' : '添加'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
        <footer className="ai-privacy">
          <ShieldCheck size={16} />
          <div>
            <p>
              API Key 只保存在这台电脑上，只发送给对应的服务商。使用 AI
              时，相关的文档文字会发送给你选择的服务商处理；本机模型则不会离开电脑。
            </p>
            <div className="ai-privacy-controls">
              {root ? (
                <label>
                  <input
                    type="checkbox"
                    checked={disabled}
                    onChange={() =>
                      void savePrefs({
                        disabledRoots: disabled
                          ? (config?.prefs.disabledRoots || []).filter((r) => r !== root)
                          : [...(config?.prefs.disabledRoots || []), root],
                      })
                    }
                  />
                  在「{projectName}」中停用 AI
                </label>
              ) : null}
              <label>
                回答语言
                <select
                  value={config?.prefs.language || 'auto'}
                  onChange={(e) => void savePrefs({ language: e.target.value as 'auto' })}
                >
                  <option value="auto">跟随提问</option>
                  <option value="zh">总是中文</option>
                  <option value="en">总是英文</option>
                </select>
              </label>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ChatGPT through the Codex app on this computer: found? signed in? how much allowance is used?
function CodexAccount({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<CodexStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');
  async function check() {
    setState(null);
    setError('');
    try {
      const next = await invoke<CodexStatus>('ai-codex-status');
      setState(next);
      if (next.account) onReady();
    } catch (e) {
      setState({ found: false });
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void check();
  }, []);
  async function login() {
    setSigningIn(true);
    setError('');
    try {
      const next = await invoke<CodexStatus>('ai-codex-login');
      setState(next);
      if (next.account) onReady();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSigningIn(false);
    }
  }
  const plan = state?.account?.plan
    ? ` ${state.account.plan[0].toUpperCase()}${state.account.plan.slice(1)}`
    : '';
  return (
    <div className="ai-codex">
      {!state ? (
        <p className="ai-codex-line">
          <LoaderCircle className="spin" size={14} />
          正在检查这台电脑上的 Codex…
        </p>
      ) : !state.found ? (
        <>
          <p className="ai-codex-line warn">
            <CircleX size={14} />
            没有找到 Codex。安装 ChatGPT 桌面版（其中包含 Codex）或 Codex 命令行工具，并登录后再试。
          </p>
          <div className="ai-codex-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void invoke('external', { url: 'https://chatgpt.com/download' })}
            >
              下载 ChatGPT 桌面版
              <ExternalLink size={12} />
            </button>
            <button type="button" className="secondary-button" onClick={() => void check()}>
              重新检测
            </button>
          </div>
        </>
      ) : state.account ? (
        <p className="ai-codex-line ok">
          <Check size={14} />
          已通过这台电脑上的 Codex 登录 ChatGPT{plan}
          {state.account.email ? `（${state.account.email}）` : ''}
        </p>
      ) : (
        <>
          <p className="ai-codex-line warn">
            <KeyRound size={14} />
            找到了 Codex，但还没有登录 ChatGPT。
          </p>
          <div className="ai-codex-actions">
            <button
              type="button"
              className="primary-button"
              disabled={signingIn}
              onClick={() => void login()}
            >
              {signingIn ? '请在浏览器中完成登录…' : '用 ChatGPT 登录'}
            </button>
            <button type="button" className="secondary-button" onClick={() => void check()}>
              重新检测
            </button>
          </div>
        </>
      )}
      {error ? <p className="ai-codex-line warn">{error}</p> : null}
      <p className="ai-codex-note">
        使用 ChatGPT 套餐里的 Codex 额度，不需要 API Key，也不另外付费。额度有 5
        小时和每周上限，用量大时可能需要等一会儿；每次回答会比直接用 API 慢几秒。
      </p>
    </div>
  );
}
