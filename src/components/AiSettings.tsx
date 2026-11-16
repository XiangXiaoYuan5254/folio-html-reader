import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Blocks,
  Check,
  CircleX,
  ExternalLink,
  GraduationCap,
  KeyRound,
  Megaphone,
  LoaderCircle,
  NotebookPen,
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
import { useUnreadAnnouncements } from '../announcements';
import { errorText, savePrefs, setAiConfig, useAiConfig, useInfo } from '../ai/client';
import type {
  AiConfig,
  AiPreset,
  AiProvider,
  AiUse,
  CodexStatus,
  KimiStatus,
  GoogleStatus,
  ModelOption,
  SpeechService,
} from '../ai/types';
import {
  effortLabel,
  forgetModelOptions,
  levelFor,
  modelLevels,
  loadedModelOptions,
  rememberModelOptions,
} from '../ai/levels';
import { cloudPrefix, tryCloudVoice, useVoiceSettings } from '../ai/voice';
import { ModelMenu } from './ModelMenu';
import { useDismiss } from '../hooks/useDismiss';
import { Announcements } from './Announcements';
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
  gemini: 'Google AI Studio · API Key',
  google: '使用 Google 套餐额度，浏览器登录',
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
  picks: string[];
};
function fromProvider(p: AiProvider): Form {
  return { ...p, picks: p.picks || [], key: '' };
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
    picks: [],
  };
}
const byName = (a: string, b: string) => a.localeCompare(b);
const contextOptions = [8_192, 32_768, 65_536, 131_072, 262_144, 400_000, 1_000_000];
const contextLabel = (n: number) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1024)}K`;

export function AiSettings({
  onClose,
  root,
  projectName,
  page = '',
  embedded = false,
  presetRequest,
  onNavigate,
  onBusyChange,
}: {
  onClose: () => void;
  root?: string;
  projectName?: string;
  // Opens on a page besides the services.
  page?: '' | 'voices';
  embedded?: boolean;
  presetRequest?: { id: string };
  onNavigate?: (page: 'voices' | 'announcements') => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const config = useAiConfig();
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'models'>('');
  useEffect(() => {
    onBusyChange?.(!!busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [modelInfo, setModelInfo] = useState<ModelOption[] | null>(null);
  const models = modelInfo && modelInfo.map((m) => m.id);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const modelRequest = useRef(0);
  // Whether the list above is the service's whole list, not just the picked models.
  const [fetchedAll, setFetchedAll] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const picksButton = useRef<HTMLButtonElement>(null);
  const picksPanel = useRef<HTMLDivElement>(null);
  useDismiss(picking, () => setPicking(false), picksButton, picksPanel);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  // A page besides the services: the reader profile, each part's model, the voices the
  // whiteboard teacher can read in, or the model vendors' offers.
  const [side, setSide] = useState<
    '' | 'profile' | 'companion' | 'uses' | 'voices' | 'papers' | 'announcements'
  >(page);
  const unseen = useUnreadAnnouncements();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!config || selected !== null || adding) return;
    const first = config.providers.find((p) => p.id === config.active) || config.providers[0];
    if (first) {
      setSelected(first.id);
      setForm(fromProvider(first));
      setModelInfo(loadedModelOptions(first.id) ?? null);
    } else setAdding(true);
  }, [config]);
  useEffect(() => {
    if (!embedded) panel.current?.focus();
  }, []);
  useEffect(() => {
    if (presetRequest && config) configure(presetRequest.id);
  }, [presetRequest, !!config]);
  const preset = config?.presets.find((p) => p.id === form?.preset);
  const stored = config?.providers.find((p) => p.id === form?.id);
  const accountService = preset && ['codex', 'kimi', 'google'].includes(preset.kind);
  const dirty = useMemo(() => {
    if (!form) return false;
    if (!stored) return true;
    return (
      !!form.key ||
      (['name', 'baseUrl', 'model', 'context', 'maxOutput', 'effort'] as const).some(
        (k) => form[k] !== stored[k],
      ) ||
      form.picks.join('\n') !== (stored.picks || []).join('\n')
    );
  }, [form, stored]);
  function pick(p: AiProvider) {
    modelRequest.current++;
    if (busy === 'models') setBusy('');
    setAdding(false);
    setSide('');
    setSelected(p.id);
    setForm(fromProvider(p));
    setStatus(null);
    setModelInfo(loadedModelOptions(p.id) ?? null);
    setFetchedAll(false);
    setPicking(false);
    setModelQuery('');
    setModelsOpen(false);
    setConfirmRemove(false);
  }
  function choosePreset(p: AiPreset) {
    modelRequest.current++;
    if (busy === 'models') setBusy('');
    setAdding(false);
    setSide('');
    setSelected('new');
    setForm(fromPreset(p));
    setStatus(null);
    setModelInfo(null);
    setFetchedAll(false);
    setPicking(false);
    setModelQuery('');
    setModelsOpen(false);
    setAdvanced(p.id === 'custom');
  }
  // 公告 → 去配置: the service if it is already added, otherwise its preset, filled in.
  function configure(presetId: string) {
    const existing = config?.providers.find((p) => p.preset === presetId);
    if (existing) pick(existing);
    else {
      const found = config?.presets.find((p) => p.id === presetId);
      if (found) choosePreset(found);
    }
  }
  const patch = (fields: Partial<Form>) => {
    if ('key' in fields || 'baseUrl' in fields) {
      modelRequest.current++;
      if (busy === 'models') setBusy('');
      setModelInfo(null);
      setFetchedAll(false);
      setModelQuery('');
      setModelsOpen(false);
    }
    setForm((f) => (f ? { ...f, ...fields } : f));
  };
  const draft = () =>
    form && {
      preset: form.preset,
      name: form.name,
      baseUrl: form.baseUrl,
      model: form.model,
      context: form.context,
      maxOutput: form.maxOutput,
      effort: form.effort,
      picks: form.picks,
    };
  // A list remembered for the model menu is the whole list only while nothing is picked.
  const fullList = fetchedAll || (!!modelInfo && !stored?.picks?.length);
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
      // Before the new settings reach the model menus, which then ask for their lists again.
      forgetModelOptions(r.provider.id);
      // With models picked, the menu asks again: the picked list comes without calls.
      if (modelInfo && fullList && !r.provider.picks?.length)
        rememberModelOptions(r.provider.id, modelInfo);
      setAiConfig(r.config);
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
    const request = ++modelRequest.current;
    setBusy('models');
    if (!quiet) setStatus(null);
    try {
      // Everything the service has, to choose and pick from.
      const info = await invoke<ModelOption[]>('ai-models', {
        id: form.id,
        draft: draft(),
        all: true,
        refresh: !quiet,
        ...(form.key ? { key: form.key } : {}),
      });
      if (request !== modelRequest.current) return;
      const list = info.map((m) => m.id);
      setModelInfo(info);
      setFetchedAll(true);
      setModelQuery('');
      if (form.id && !form.key && form.baseUrl === stored?.baseUrl && !stored?.picks?.length)
        rememberModelOptions(form.id, info);
      if (!quiet) setModelsOpen(true);
      // A new service starts with the service's own default model.
      if (list.length) setForm((f) => (f && !f.model ? { ...f, model: list[0] } : f));
      if (!quiet || !list.length)
        setStatus(
          list.length
            ? { ok: true, text: `已获取 ${list.length} 个模型，请从列表中选择` }
            : { ok: false, text: '未获取到可用模型，可以重试或手动填写模型名称' },
        );
    } catch (e) {
      if (request !== modelRequest.current) return;
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      if (request === modelRequest.current) setBusy('');
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
  const allModels = [...new Set(models ?? (!form?.id ? preset?.models : []) ?? [])];
  // The model's levels, and the one chat uses.
  const listed = modelInfo?.find((m) => m.id === form?.model);
  const { efforts: levels, effort: fallback } = listed
    ? { efforts: listed.efforts.filter(Boolean), effort: listed.defaultEffort }
    : modelLevels(preset, form?.model);
  const effort = levelFor(levels, fallback, form?.effort || '', 'chat');
  // Only an explicit search filters the list. The saved model may no longer be usable.
  const modelChoices = allModels.filter((m) => m.toLowerCase().includes(modelQuery));
  // The models the menu shows once some are picked: those, and always the one in use.
  const picks = form?.picks || [];
  const inUse = (m: string) => picks.length > 0 && m === form?.model;
  const shownPicks = picks.length
    ? [...new Set([...picks, ...(form?.model ? [form.model] : [])])].sort(byName)
    : [];
  const pickChoices = [
    ...new Set([...(fullList ? allModels : []), ...picks, ...(form?.model ? [form.model] : [])]),
  ]
    .sort(byName)
    .filter((m) => m.toLowerCase().includes(pickQuery));
  const togglePick = (m: string) =>
    patch({
      picks: picks.includes(m) ? picks.filter((x) => x !== m) : [...picks, m].sort(byName),
    });
  function openPicks() {
    if (picking) return setPicking(false);
    setPicking(true);
    setPickQuery('');
    if (!fullList) void fetchModels(true);
  }
  const needsKey = !preset?.noKey;
  return (
    <div
      className={embedded ? 'ai-settings-embedded' : 'modal-backdrop'}
      onMouseDown={(e) => {
        if (!embedded && e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="ai-settings"
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="ai-settings-title"
        tabIndex={-1}
        ref={panel}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            if (modelsOpen) {
              e.stopPropagation();
              setModelsOpen(false);
            } else if (picking) {
              e.stopPropagation();
              setPicking(false);
            } else if (!embedded) {
              e.stopPropagation();
              onClose();
            }
          }
        }}
      >
        <header className="ai-settings-heading" hidden={embedded}>
          <h2 id="ai-settings-title">
            <Sparkle size={17} />
            AI 设置
          </h2>
          <span>用 API Key、ChatGPT 账号、Google 账号或 Kimi 会员接入模型，也支持本机模型</span>
          <button type="button" className="icon-button" aria-label="关闭 AI 设置" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {embedded ? (
          <nav className="settings-subnav" aria-label="AI 设置分类">
            {(
              [
                ['', '服务与账号'],
                ['uses', '各功能的模型'],
                ['profile', '读者画像'],
                ['companion', '精读笔记提示词'],
                ['papers', '论文检索'],
              ] as const
            ).map(([id, title]) => (
              <button
                type="button"
                key={id}
                className={side === id ? 'active' : ''}
                aria-current={side === id ? 'page' : undefined}
                onClick={() => setSide(id)}
              >
                {title}
              </button>
            ))}
            <span className="toolbar-flex" />
            <button type="button" onClick={() => onNavigate?.('voices')}>
              语音服务
            </button>
            <button type="button" onClick={() => onNavigate?.('announcements')}>
              公告{unseen ? <span className="announcement-dot" aria-hidden="true" /> : null}
            </button>
          </nav>
        ) : null}
        <div className="ai-settings-body">
          <nav
            className="ai-provider-list"
            aria-label="已添加的 AI 服务"
            hidden={embedded && !!side}
          >
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
            {!embedded ? (
              <>
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
                  className={`ai-profile-link ${side === 'papers' ? 'active' : ''}`}
                  onClick={() => setSide('papers')}
                >
                  <GraduationCap size={14} />
                  论文检索
                </button>
                <button
                  className={`ai-profile-link ${side === 'profile' ? 'active' : ''}`}
                  onClick={() => setSide('profile')}
                >
                  <UserRound size={14} />
                  读者画像
                </button>
                <button
                  className={`ai-profile-link ${side === 'companion' ? 'active' : ''}`}
                  onClick={() => setSide('companion')}
                >
                  <NotebookPen size={14} />
                  精读笔记提示词
                </button>
                <button
                  className={`ai-profile-link ${side === 'announcements' ? 'active' : ''}`}
                  onClick={() => setSide('announcements')}
                >
                  <Megaphone size={14} />
                  公告
                  {unseen ? <span className="announcement-dot" aria-hidden="true" /> : null}
                </button>
              </>
            ) : null}
          </nav>
          <section className="ai-settings-main">
            {side === 'profile' ? (
              <ReaderProfile saved={config?.prefs.profile || ''} />
            ) : side === 'companion' ? (
              <CompanionPrompt saved={config?.prefs.companionPrompt || ''} />
            ) : side === 'uses' ? (
              <UseModels />
            ) : side === 'voices' ? (
              <SpeechVoices services={config?.speech || []} />
            ) : side === 'papers' ? (
              <PaperLibraries openalex={config?.papers?.openalex} />
            ) : side === 'announcements' ? (
              <Announcements presets={config?.presets || []} onConfigure={configure} />
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
                          of={stored.id}
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
                  ) : preset?.kind === 'google' ? (
                    <GoogleAccount
                      onReady={() => void fetchModels(true)}
                      onLogout={() => {
                        if (form.id) forgetModelOptions(form.id);
                        setModelInfo(null);
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
                        onFocus={() => {
                          setModelQuery('');
                          if (models) setModelsOpen(true);
                        }}
                        onBlur={() => setTimeout(() => setModelsOpen(false), 150)}
                        onChange={(e) => {
                          patch({ model: e.target.value.trim() });
                          setModelQuery(e.target.value.trim().toLowerCase());
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
                                setModelQuery('');
                                setModelsOpen(false);
                              }}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {!form.id && !models && preset?.models.length ? (
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
                    {models === null && form.id ? (
                      <em className="ai-field-hint">
                        上方是已保存的模型，点击“获取列表”查看其他模型。
                      </em>
                    ) : models && form.model && !models.includes(form.model) ? (
                      <em className="ai-field-hint">
                        当前填写的模型不在本次获取的列表中，请重新选择或测试连接。
                      </em>
                    ) : null}
                  </label>
                  {!accountService ? (
                    // Not a <label>: it holds buttons and a list of checkboxes.
                    <div className="ai-field ai-picks">
                      <span>
                        模型菜单里显示
                        <button
                          ref={picksButton}
                          type="button"
                          className="ai-link"
                          disabled={!!busy && !picking}
                          aria-expanded={picking}
                          onClick={openPicks}
                        >
                          {picking ? '收起' : picks.length ? '修改' : '只显示部分模型'}
                        </button>
                      </span>
                      {shownPicks.length ? (
                        <div className="ai-picks-chips">
                          {shownPicks.map((m) => (
                            <span key={m} className={m === form.model ? 'active' : ''}>
                              {m}
                              {m === form.model ? (
                                <em>使用中</em>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`不再显示 ${m}`}
                                  title="不再显示"
                                  onClick={() => togglePick(m)}
                                >
                                  <X size={11} />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <em className="ai-field-hint">全部（获取到的所有模型）</em>
                      )}
                      {picking ? (
                        <div className="ai-picks-panel" ref={picksPanel}>
                          <input
                            value={pickQuery}
                            placeholder="搜索模型"
                            aria-label="搜索要显示的模型"
                            spellCheck={false}
                            onChange={(e) => setPickQuery(e.target.value.trim().toLowerCase())}
                          />
                          <div className="ai-picks-list" role="group" aria-label="要显示的模型">
                            {pickChoices.map((m) => (
                              <label key={m} className="ai-pick">
                                <input
                                  type="checkbox"
                                  checked={picks.includes(m) || inUse(m)}
                                  disabled={inUse(m)}
                                  onChange={() => togglePick(m)}
                                />
                                <span>{m}</span>
                                {m === form.model ? <em>使用中</em> : null}
                              </label>
                            ))}
                            {busy === 'models' ? (
                              <p className="ai-picks-note">
                                <LoaderCircle className="spin" size={12} />
                                正在获取全部模型…
                              </p>
                            ) : !pickChoices.length ? (
                              <p className="ai-picks-note">
                                {pickQuery ? '没有匹配的模型' : '没有获取到模型'}
                              </p>
                            ) : null}
                          </div>
                          <div className="ai-picks-actions">
                            <span>
                              {picks.length
                                ? `已勾选 ${picks.length} 个，保存后生效`
                                : '一个都不勾选时，显示全部模型'}
                            </span>
                            {picks.length ? (
                              <button
                                type="button"
                                className="ai-link"
                                onClick={() => patch({ picks: [] })}
                              >
                                全部取消
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="ai-link"
                              onClick={() => setPicking(false)}
                            >
                              完成
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {form.preset === 'qwen' ? (
                        <em className="ai-field-hint">
                          获取列表会逐个试调用模型，产生少量费用；能调用也不代表有免费额度。请对照百炼控制台的「免费额度」页面，只勾选还有额度的模型，之后模型菜单不再试调用。
                        </em>
                      ) : null}
                    </div>
                  ) : null}
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
                      : accountService
                        ? '高级设置：上下文长度'
                        : '高级设置：接口地址、上下文长度'}
                  </button>
                  {advanced ? (
                    <div className="ai-advanced">
                      {accountService ? null : (
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
                  <button
                    className="primary-button"
                    disabled={!!busy || !dirty || (preset?.kind === 'google' && !form.model)}
                  >
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

// The writing for 精读笔记 in the reader's own words, in place of Folio's, which is not shown.
// Folio's format goes after it whatever it says, so the notes still show and link to pages.
function CompanionPrompt({ saved }: { saved: string }) {
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(value: string, done = '已保存') {
    setBusy(true);
    setStatus(null);
    try {
      await savePrefs({ companionPrompt: value.trim() });
      setStatus({ ok: true, text: done });
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
        void save(text);
      }}
    >
      <div className="ai-form-fields">
        <p className="ai-settings-lead">
          制作精读笔记时，AI
          默认按页间自带的写作要求来写。想按自己的方式来，就在下面写：给谁讲、怎么讲、分哪几部分。留空就用页间默认的。读者画像会一起发给
          AI；页面格式由页间固定加上，保证笔记能正常显示、点页码能跳到原文。
        </p>
        <label>
          <span>
            写作要求
            <em className="ai-field-hint">
              {saved ? '正在使用你的版本' : '留空使用页间默认提示词'}
            </em>
          </span>
          <textarea
            className="ai-companion-prompt"
            aria-label="精读笔记的写作要求"
            rows={14}
            maxLength={20000}
            placeholder={
              '例如：\n你是我的论文导读助手。先用三句话说清这篇论文解决什么问题、怎么解决、效果如何；再按原文顺序讲每一节，术语第一次出现时解释；最后列出 3 个值得思考的问题。'
            }
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
        {saved ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setText('');
              void save('', '已恢复默认');
            }}
          >
            恢复默认
          </button>
        ) : null}
        <span className="toolbar-flex" />
        <button className="primary-button" disabled={busy || text.trim() === saved.trim()}>
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
export function SpeechVoices({ services }: { services: SpeechService[] }) {
  return (
    <div className="ai-provider-form">
      <div className="ai-form-fields">
        <p className="ai-settings-lead">
          页老师可以用这些在线合成的声音照着讲稿念。Edge TTS 免费、无需 Key，可以直接试听，
          再到白板的「出声」菜单里选择。其他服务需要填 API Key，费用由服务商按字数收取，页间不经手。
          朗读文字会发送给所选服务；Windows 上的通义百炼和豆包语音也可识别你说的话，按时长计费。
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
          {service.free || service.hasKey ? (
            <em className="ai-voice-state on">
              <Check size={11} />
              {service.free
                ? '无需 Key'
                : service.shared
                  ? `已接入 · 用「${service.shared}」的 Key`
                  : '已接入'}
            </em>
          ) : (
            <em className="ai-voice-state">未接入</em>
          )}
        </strong>
        <span>{service.about}</span>
      </div>
      {!service.free ? (
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
          {service.balance && service.hasKey ? (
            // Asked again once a new key is saved.
            <BalanceLine key={service.keyHint} of={`speech:${service.id}`} fresh />
          ) : null}
        </div>
      ) : null}
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
          disabled={!!busy || (!service.free && !key && !service.hasKey)}
          onClick={() => void listen()}
        >
          {busy === 'try' ? <LoaderCircle className="spin" size={14} /> : <Volume2 size={14} />}
          试听
        </button>
        {!service.free ? (
          <button className="primary-button" disabled={!!busy || !key}>
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
        ) : null}
      </div>
    </form>
  );
}

// The libraries the project assistant finds papers in. None needs a key; OpenAlex without one
// shares a small daily allowance with everyone on the same network, so it can take the user's.
function PaperLibraries({ openalex }: { openalex?: { hasKey: boolean; keyHint: string } }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(next: string) {
    setBusy(true);
    setStatus(null);
    try {
      const { config, checked } = await invoke<{ config: AiConfig; checked: boolean }>(
        'ai-paper-key',
        { key: next },
      );
      setAiConfig(config);
      setKey('');
      setStatus({
        ok: true,
        text: !next
          ? '已删除，之后使用共享的免费额度'
          : checked
            ? '已保存，OpenAlex 确认这个 Key 可以用'
            : '已保存。暂时连不上 OpenAlex，没能确认这个 Key 是否可用',
      });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ai-provider-form">
      <div className="ai-form-fields">
        <p className="ai-settings-lead">
          在助手的「整个项目」里可以让 AI 找论文、下载
          PDF。它会按学科去下面这些论文库里查，也可以指定只查某个库或某本期刊。这些库都不需要
          Key，查找时只把关键词发给它们。
        </p>
        <form
          className="ai-voice-service"
          onSubmit={(e) => {
            e.preventDefault();
            if (key) void save(key);
          }}
        >
          <div className="ai-voice-name">
            <strong>
              OpenAlex
              {openalex?.hasKey ? (
                <em className="ai-voice-state on">
                  <Check size={11} />
                  已填 Key
                </em>
              ) : (
                <em className="ai-voice-state">共享额度</em>
              )}
            </strong>
            <span>
              覆盖所有学科，每次找论文都会查。不填 Key
              也能用，但同一网络（同一个校园网、公司网络或代理）的人共用每天的免费额度，用完后会提示“暂时繁忙”。在
              OpenAlex 注册后可以免费申请一个 Key，有自己的每日额度。Key 只保存在这台电脑上，只发给
              OpenAlex。
            </span>
          </div>
          <div className="ai-field">
            <span>
              API Key（可选）
              <button
                type="button"
                className="ai-link"
                onClick={() =>
                  void invoke('external', { url: 'https://openalex.org/settings/api' })
                }
              >
                去 OpenAlex 获取
                <ExternalLink size={11} />
              </button>
            </span>
            <div className="ai-key-field">
              <KeyRound size={14} />
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="OpenAlex 的 API Key"
                placeholder={
                  openalex?.keyHint ? `已保存 ${openalex.keyHint}，留空则不修改` : '粘贴 API Key'
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
            {openalex?.keyHint ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void save('')}
              >
                删除 Key
              </button>
            ) : null}
            <span className="toolbar-flex" />
            <button className="primary-button" disabled={busy || !key}>
              {busy ? '检查中…' : '保存'}
            </button>
          </div>
        </form>
        {[
          ['PubMed', '医学、生命科学和心理学方向会加查，经 Europe PMC。'],
          ['arXiv', '理工科和经济学的预印本，这些方向会加查。'],
        ].map(([name, about]) => (
          <div className="ai-voice-service" key={name}>
            <div className="ai-voice-name">
              <strong>
                {name}
                <em className="ai-voice-state on">
                  <Check size={11} />
                  无需 Key
                </em>
              </strong>
              <span>{about}</span>
            </div>
          </div>
        ))}
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

function GoogleAccount({ onReady, onLogout }: { onReady: () => void; onLogout: () => void }) {
  const [state, setState] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'install' | 'login' | 'logout'>('');
  const [error, setError] = useState('');
  async function check() {
    setState(null);
    setError('');
    try {
      const next = await invoke<GoogleStatus>('ai-google-status');
      setState(next);
      if (next.signedIn) onReady();
    } catch (e) {
      setState({ found: false, supported: true });
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void check();
  }, []);

  async function login() {
    setError('');
    try {
      if (!state?.found) {
        setBusy('install');
        await invoke('ai-google-install');
        setState({ found: true, supported: true });
      }
      setBusy('login');
      const next = await invoke<GoogleStatus>('ai-google-login');
      setState(next);
      if (next.signedIn) onReady();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  async function logout() {
    setBusy('logout');
    setError('');
    try {
      setState(await invoke<GoogleStatus>('ai-google-logout'));
      onLogout();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="ai-codex">
      {!state ? (
        <p className="ai-codex-line">
          <LoaderCircle className="spin" size={14} /> 正在读取 Google 登录状态…
        </p>
      ) : !state.supported ? (
        <p className="ai-codex-line warn">这台电脑暂时没有可用的 Google 登录组件。</p>
      ) : state.signedIn ? (
        <>
          <p className="ai-codex-line ok">
            <Check size={14} /> 已登录 Google 账号{state.plan ? `（${state.plan}）` : ''}
          </p>
          <div className="ai-codex-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void logout()}
            >
              {busy === 'logout' ? '正在退出…' : '退出登录'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="ai-codex-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!!busy}
              onClick={() => void login()}
            >
              {busy === 'install'
                ? '正在下载 Google 登录组件…'
                : busy === 'login'
                  ? '请在浏览器中完成登录…'
                  : '用 Google 账号登录'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void check()}
            >
              重新检测
            </button>
          </div>
          {!state.found ? (
            <p className="ai-codex-note">
              首次登录会下载 Google 官方 Antigravity 组件，然后在浏览器中授权。
              <button
                type="button"
                className="ai-link"
                onClick={() => void invoke('external', { url: 'https://antigravity.google/terms' })}
              >
                Google 服务条款
              </button>
            </p>
          ) : null}
        </>
      )}
      {error || state?.error ? (
        <p className="ai-codex-line warn" role="status">
          {error || state?.error}
        </p>
      ) : null}
      <p className="ai-codex-note">
        使用 Google 账号的 Antigravity 额度，无需 API Key。插件使用独立的 API 服务。
      </p>
    </div>
  );
}
