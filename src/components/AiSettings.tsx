import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Blocks,
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
  UserRound,
  Volume2,
  X,
} from 'lucide-react';
import { invoke } from '../api';
import { errorText, savePrefs, setAiConfig, useAiConfig, useInfo } from '../ai/client';
import type {
  AiConfig,
  AiPreset,
  AiProvider,
  AiUse,
  CodexStatus,
  KimiStatus,
  ModelOption,
  SpeechService,
} from '../ai/types';
import { effortLabel, forgetModelOptions, levelFor, modelLevels } from '../ai/levels';
import { cloudPrefix, tryCloudVoice, useVoiceSettings } from '../ai/voice';
import { ModelMenu } from './ModelMenu';
import { BalanceLine, PlanUsage } from './BalanceLine';
import { forgetBalance } from '../ai/balance';

const blurbs: Record<string, string> = {
  deepseek: '国内直连，价格低，长文档友好',
  qwen: '阿里云百炼',
  moonshot: '月之暗面开放平台，按用量付费',
  kimicode: '用 Kimi 会员额度，不需要 API Key',
  zhipu: '智谱开放平台',
  doubao: '字节跳动火山方舟',
  xiaomi: '1M 上下文，能看图',
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
  page = '',
}: {
  onClose: () => void;
  root?: string;
  projectName?: string;
  // Opens on a page besides the services.
  page?: '' | 'voices';
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
  // A page besides the services: the reader profile, each part's model, or the voices the
  // whiteboard teacher can read in.
  const [side, setSide] = useState<'' | 'profile' | 'uses' | 'voices'>(page);
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
  const stored = config?.providers.find((p) => p.id === form?.id);
  const dirty = useMemo(() => {
    if (!form) return false;
    if (!stored) return true;
    return (
      !!form.key ||
      (['name', 'baseUrl', 'model', 'context', 'maxOutput', 'effort'] as const).some(
        (k) => form[k] !== stored[k],
      )
    );
  }, [form, stored]);
  function pick(p: AiProvider) {
    setAdding(false);
    setSide('');
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
      forgetBalance(r.provider.id);
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
  // The model's levels, and the one chat uses.
  const listed = modelInfo?.find((m) => m.id === form?.model);
  const { efforts: levels, effort: fallback } = listed
    ? { efforts: listed.efforts.filter(Boolean), effort: listed.defaultEffort }
    : modelLevels(preset, form?.model);
  const effort = levelFor(levels, fallback, form?.effort || '', 'chat');
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
          <span>用自己的 API Key、ChatGPT 账号或 Kimi 会员，接入国内外主流模型或本机模型</span>
          <button type="button" className="icon-button" aria-label="关闭 AI 设置" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="ai-settings-body">
          <nav className="ai-provider-list" aria-label="已添加的 AI 服务">
            {config?.providers.map((p) => (
              <button
                key={p.id}
                className={selected === p.id && !side ? 'active' : ''}
                onClick={() => pick(p)}
              >
                <strong>{p.name}</strong>
                <span>{p.model || '未选择模型'}</span>
                {config.active === p.id ? <em>默认</em> : null}
              </button>
            ))}
            <button
              className={`ai-add-provider ${adding && !side ? 'active' : ''}`}
              onClick={() => {
                setAdding(true);
                setSide('');
                setSelected(null);
                setForm(null);
                setStatus(null);
              }}
            >
              <Plus size={14} />
              添加服务
            </button>
            <button
              className={`ai-profile-link ${side === 'uses' ? 'active' : ''}`}
              disabled={!config?.providers.length}
              onClick={() => setSide('uses')}
            >
              <Blocks size={14} />
              各功能的模型
            </button>
            <button
              className={`ai-profile-link ${side === 'voices' ? 'active' : ''}`}
              onClick={() => setSide('voices')}
            >
              <AudioLines size={14} />
              语音服务
            </button>
            <button
              className={`ai-profile-link ${side === 'profile' ? 'active' : ''}`}
              onClick={() => setSide('profile')}
            >
              <UserRound size={14} />
              读者画像
            </button>
          </nav>
          <section className="ai-settings-main">
            {side === 'profile' ? (
              <ReaderProfile saved={config?.prefs.profile || ''} />
            ) : side === 'uses' ? (
              <UseModels />
            ) : side === 'voices' ? (
              <SpeechVoices services={config?.speech || []} />
            ) : adding || !form ? (
              <div className="ai-presets">
                <p className="ai-settings-lead">
                  选择一个服务，填入在它官网申请的 API Key，费用由服务商按用量收取，页间不经手。已有
                  ChatGPT 套餐的话，可以选“Codex”；有 Kimi 会员的话，可以选“Kimi
                  Code”，直接用套餐额度。
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
                      {preset?.balance && stored?.hasKey ? (
                        // Asked again once a new key or address is saved.
                        <BalanceLine
                          key={`${stored.id} ${stored.keyHint} ${stored.baseUrl}`}
                          providerId={stored.id}
                          fresh
                        />
                      ) : null}
                    </div>
                  ) : preset?.kind === 'codex' ? (
                    <CodexAccount
                      onReady={() => {
                        if (!models) void fetchModels(true);
                      }}
                    />
                  ) : preset?.kind === 'kimi' ? (
                    <KimiAccount
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
                        value={effort}
                        onChange={(e) => patch({ effort: e.target.value })}
                      >
                        {levels.map((level) => (
                          <option key={level} value={level}>
                            {effortLabel(level)}
                          </option>
                        ))}
                      </select>
                      <em className="ai-field-hint">也可以在助手输入框下方随时切换。</em>
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
                      : preset?.kind === 'codex' || preset?.kind === 'kimi'
                        ? '高级设置：上下文长度'
                        : '高级设置：接口地址、上下文长度'}
                  </button>
                  {advanced ? (
                    <div className="ai-advanced">
                      {preset?.kind === 'codex' || preset?.kind === 'kimi' ? null : (
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

// Who is reading, in the reader's own words; 精读笔记 pitch their groundwork and focus at it.
function ReaderProfile({ saved }: { saved: string }) {
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      await savePrefs({ profile: text });
      setStatus({ ok: true, text: '已保存' });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="ai-provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="ai-form-fields">
        <p className="ai-settings-lead">
          写一段自我介绍，比如背景、基础等等。AI
          会按你的情况来写精读笔记。只对「制作精读笔记」生效，不写也没关系。
        </p>
        <label>
          <span>读者画像</span>
          <textarea
            rows={10}
            maxLength={2000}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setStatus(null);
            }}
          />
        </label>
        {status ? (
          <p className={`ai-status ${status.ok ? 'ok' : 'error'}`} role="status">
            {status.ok ? <Check size={14} /> : <CircleX size={14} />}
            {status.text}
          </p>
        ) : null}
      </div>
      <div className="ai-form-actions">
        <span className="toolbar-flex" />
        <button className="primary-button" disabled={busy || text.trim() === saved}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

// Which service, model and reasoning level each part of the app uses.
function UseModels() {
  return (
    <div className="ai-uses">
      <p className="ai-settings-lead">
        每个功能可以用不同的服务、模型和推理强度，比如翻译用便宜快速的模型，聊天和白板用更强的模型。没有单独选的功能跟随助手聊天。
      </p>
      {(Object.keys(useInfo) as AiUse[]).map((use) => (
        <div className="ai-use-row" key={use}>
          <div>
            <strong>{useInfo[use].label}</strong>
            <span>{useInfo[use].hint}</span>
          </div>
          <ModelMenu use={use} className="model-pick" />
        </div>
      ))}
    </div>
  );
}

// Speech services whose voices the whiteboard teacher can read its script in, and which on
// Windows can also write down what the student says.
function SpeechVoices({ services }: { services: SpeechService[] }) {
  return (
    <div className="ai-provider-form">
      <div className="ai-form-fields">
        <p className="ai-settings-lead">
          页老师照着讲稿念的时候，可以换成这些服务的真人声音，比电脑自带的声音自然得多。填好其中一个的
          API Key，就能在白板的「出声」菜单里选它的声音。费用由服务商按字数收取，页间不经手。 在
          Windows 上语音对话时，通义百炼和豆包语音还能识别你说的话，按时长计费。
        </p>
        {services.map((s) => (
          <SpeechServiceKey key={s.id} service={s} />
        ))}
      </div>
    </div>
  );
}
function SpeechServiceKey({ service }: { service: SpeechService }) {
  const [key, setKey] = useState('');
  // The voice to try: the teacher's, when it's one of this service's.
  const { voice: teacher } = useVoiceSettings();
  const own = `${cloudPrefix}${service.id}:`;
  const [voiceId, setVoiceId] = useState(
    () => service.voices.find((v) => teacher === own + v.id)?.id || service.voices[0]?.id || '',
  );
  const sample = service.voices.find((v) => v.id === voiceId) || service.voices[0];
  const [busy, setBusy] = useState<'' | 'save' | 'try'>('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(next: string) {
    setBusy('save');
    setStatus(null);
    try {
      setAiConfig(await invoke<AiConfig>('ai-speech-key', { service: service.id, key: next }));
      setKey('');
      setStatus({
        ok: true,
        text: next ? '已保存，可以在白板的「出声」菜单里选它的声音了' : '已删除',
      });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy('');
    }
  }
  async function listen() {
    setBusy('try');
    setStatus(null);
    try {
      await tryCloudVoice(service.id, sample, key);
      setStatus({ ok: true, text: `可以用：这是「${sample.name}」的声音` });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy('');
    }
  }
  return (
    <form
      className="ai-voice-service"
      onSubmit={(e) => {
        e.preventDefault();
        if (key) void save(key);
      }}
    >
      <div className="ai-voice-name">
        <strong>
          {service.name}
          {service.hasKey ? (
            <em className="ai-voice-state on">
              <Check size={11} />
              {service.shared ? `已接入 · 用「${service.shared}」的 Key` : '已接入'}
            </em>
          ) : (
            <em className="ai-voice-state">未接入</em>
          )}
        </strong>
        <span>{service.about}</span>
      </div>
      <div className="ai-field">
        <span>
          API Key
          <button
            type="button"
            className="ai-link"
            onClick={() => void invoke('external', { url: service.keyUrl })}
          >
            去 {service.name} 获取
            <ExternalLink size={11} />
          </button>
        </span>
        <div className="ai-key-field">
          <KeyRound size={14} />
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${service.name} 的 API Key`}
            placeholder={
              service.keyHint
                ? `已保存 ${service.keyHint}，留空则不修改`
                : service.shared
                  ? `正在用「${service.shared}」的 Key，也可以单独填一个`
                  : '粘贴 API Key'
            }
            value={key}
            onChange={(e) => {
              setKey(e.target.value.trim());
              setStatus(null);
            }}
          />
        </div>
      </div>
      {status ? (
        <p className={`ai-status ${status.ok ? 'ok' : 'error'}`} role="status">
          {status.ok ? <Check size={14} /> : <CircleX size={14} />}
          {status.text}
        </p>
      ) : null}
      <div className="ai-form-actions">
        {service.keyHint ? (
          <button
            type="button"
            className="secondary-button"
            disabled={!!busy}
            onClick={() => void save('')}
          >
            删除 Key
          </button>
        ) : null}
        <span className="toolbar-flex" />
        <select
          className="ai-voice-pick"
          aria-label={`试听 ${service.name} 的哪个声音`}
          value={sample.id}
          onChange={(e) => {
            setVoiceId(e.target.value);
            setStatus(null);
          }}
        >
          {service.voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}（{v.about}）
            </option>
          ))}
        </select>
        <button
          type="button"
          className="secondary-button"
          disabled={!!busy || (!key && !service.hasKey)}
          onClick={() => void listen()}
        >
          {busy === 'try' ? <LoaderCircle className="spin" size={14} /> : <Volume2 size={14} />}
          试听
        </button>
        <button className="primary-button" disabled={!!busy || !key}>
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
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
        <>
          <p className="ai-codex-line ok">
            <Check size={14} />
            已通过这台电脑上的 Codex 登录 ChatGPT{plan}
            {state.account.email ? `（${state.account.email}）` : ''}
          </p>
          {state.windows?.length ? <PlanUsage windows={state.windows} /> : null}
        </>
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

// A Kimi membership through the Kimi Code CLI on this computer: found? signed in? how much of
// the membership is used? 页间 signs in on its own, apart from the user's own Kimi Code.
function KimiAccount({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<KimiStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'login' | 'logout'>('');
  const [error, setError] = useState('');
  function show(next: KimiStatus) {
    setState(next);
    if (next.signedIn) onReady();
  }
  async function check() {
    setState(null);
    setError('');
    try {
      show(await invoke<KimiStatus>('ai-kimi-status'));
    } catch (e) {
      setState({ found: false });
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void check();
  }, []);
  async function act(kind: 'login' | 'logout') {
    setBusy(kind);
    setError('');
    try {
      show(await invoke<KimiStatus>(kind === 'login' ? 'ai-kimi-login' : 'ai-kimi-logout'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  const again = (
    <button type="button" className="secondary-button" onClick={() => void check()}>
      重新检测
    </button>
  );
  return (
    <div className="ai-codex">
      {!state ? (
        <p className="ai-codex-line">
          <LoaderCircle className="spin" size={14} />
          正在检查这台电脑上的 Kimi Code…
        </p>
      ) : !state.found ? (
        <>
          <p className="ai-codex-line warn">
            <CircleX size={14} />
            没有找到 Kimi Code CLI。按 Kimi Code 官网的说明安装后再试。
          </p>
          <div className="ai-codex-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                void invoke('external', {
                  url: 'https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started.html',
                })
              }
            >
              查看安装说明
              <ExternalLink size={12} />
            </button>
            {again}
          </div>
        </>
      ) : state.signedIn ? (
        <>
          <p className="ai-codex-line ok">
            <Check size={14} />
            已通过这台电脑上的 Kimi Code 登录 Kimi 账号
            {state.account?.name ? `「${state.account.name}」` : ''}
            {state.account?.level ? `（${state.account.level}）` : ''}
          </p>
          {state.windows?.length ? <PlanUsage windows={state.windows} /> : null}
          <div className="ai-codex-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void act('logout')}
            >
              {busy === 'logout' ? '正在退出…' : '退出登录'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="ai-codex-line warn">
            <KeyRound size={14} />
            找到了 Kimi Code，但页间还没有登录 Kimi 账号。
          </p>
          <div className="ai-codex-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!!busy}
              onClick={() => void act('login')}
            >
              {busy === 'login' ? '请在浏览器中完成登录…' : '用 Kimi 账号登录'}
            </button>
            {again}
          </div>
        </>
      )}
      {error || state?.error ? <p className="ai-codex-line warn">{error || state?.error}</p> : null}
      <p className="ai-codex-note">
        使用 Kimi 会员里的 Kimi Code 额度，不需要 API Key，也不另外付费。页间单独登录，和你自己用的
        Kimi Code 互不影响；Kimi Code 自带的命令、读写文件和联网工具都不会启用。额度有 5
        小时和每周上限；每次回答会比直接用 API 慢几秒。
      </p>
    </div>
  );
}
