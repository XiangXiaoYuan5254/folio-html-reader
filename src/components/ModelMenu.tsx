import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ImageOff, ImagePlus, LoaderCircle, Settings2 } from 'lucide-react';
import { invoke } from '../api';
import {
  activeProvider,
  errorText,
  providerFor,
  setAiConfig,
  useAiConfig,
  useChoice,
  useInfo,
} from '../ai/client';
import { effortLabel, levelsFor, modelOptions } from '../ai/levels';
import { refusesImages, seesImages } from '../ai/images';
import { tellsBalance } from '../ai/balance';
import type { AiConfig, AiProvider, AiUse, ModelOption } from '../ai/types';
import { BalanceLine } from './BalanceLine';

const shortName = (p: AiProvider) => p.name.replace(/（.*?）|\(.*?\)/g, '').trim() || p.name;

// Service, model and reasoning level, switched right where you type, like Codex's picker.
// Chat's picks the active service; another part's picks its own, or follows chat.
export function ModelMenu({
  use = 'chat',
  onOpenSettings,
  className = '',
}: {
  use?: AiUse;
  onOpenSettings?: () => void;
  className?: string;
}) {
  const config = useAiConfig();
  const chat = use === 'chat';
  const { label } = useInfo[use];
  const choice = useChoice(config, use);
  const following = !chat && !choice;
  const provider = providerFor(config, use);
  const [open, setOpen] = useState(false);
  // The service whose models are listed, or 'follow' for following chat.
  const [viewing, setViewing] = useState('');
  const [lists, setLists] = useState<Record<string, ModelOption[] | 'loading' | { error: string }>>(
    {},
  );
  const [place, setPlace] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>({ left: 0, bottom: 0, maxHeight: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const load = (id: string, refresh = false) => {
    if (!id || (!refresh && lists[id] && lists[id] !== 'loading')) return;
    setLists((l) => ({ ...l, [id]: 'loading' }));
    modelOptions(id, refresh).then(
      (list) => setLists((l) => ({ ...l, [id]: list })),
      (e) => setLists((l) => ({ ...l, [id]: { error: errorText(e) } })),
    );
  };
  useEffect(() => {
    // The model's levels are shown on the button before the menu is opened.
    if (provider?.id) load(provider.id);
  }, [provider?.id]);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - 316, r.left));
    const tall = innerHeight * 0.7;
    // Above the button, as in the composer, unless there's more room below.
    setPlace(
      r.top > innerHeight - r.bottom
        ? { left, bottom: innerHeight - r.top + 6, maxHeight: Math.min(tall, r.top - 14) }
        : { left, top: r.bottom + 6, maxHeight: Math.min(tall, innerHeight - r.bottom - 14) },
    );
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (!config || !provider)
    return (
      <button
        className={`assistant-model ${className}`}
        onClick={onOpenSettings}
        disabled={!onOpenSettings}
      >
        未配置 AI 服务
      </button>
    );
  const activeList = lists[provider.id];
  const { levels, effort } = levelsFor(
    provider,
    config,
    Array.isArray(activeList) ? activeList : undefined,
    following ? 'chat' : use,
  );
  const shown =
    viewing === 'follow'
      ? null
      : config.providers.find((p) => p.id === viewing) ||
        config.providers.find((p) => p.id === provider.id)!;
  const list = shown && lists[shown.id];
  const models: ModelOption[] = Array.isArray(list)
    ? list
    : shown?.model
      ? [{ id: shown.model, efforts: [], defaultEffort: '' }]
      : [];
  const chatProvider = activeProvider(config);
  // The menu stays open so the reasoning level can be picked right after the model.
  async function pickModel(p: AiProvider, model: string) {
    const options = lists[p.id];
    // The level in use stays if the new model has it, else the nearest one it has; a part
    // that followed chat starts at its own.
    const fit = (next: AiConfig | null, saved: AiProvider) =>
      levelsFor(saved, next, Array.isArray(options) ? options : undefined, use).effort;
    if (!chat) {
      const kept = fit(config, { ...p, model, effort: following ? '' : effort });
      setAiConfig(
        await invoke<AiConfig>('ai-set-use', { use, provider: p.id, model, effort: kept }),
      );
      return;
    }
    const next = await invoke<AiConfig>('ai-set-active', { id: p.id, model });
    setAiConfig(next);
    const saved = next.providers.find((x) => x.id === p.id);
    const kept = saved?.effort && fit(next, saved);
    if (saved && kept && kept !== saved.effort)
      setAiConfig(
        (await invoke<{ config: AiConfig }>('ai-save-provider', { id: p.id, effort: kept })).config,
      );
  }
  async function pickEffort(level: string) {
    setOpen(false);
    if (!chat) {
      setAiConfig(
        await invoke<AiConfig>('ai-set-use', {
          use,
          provider: provider!.id,
          model: provider!.model,
          effort: level,
        }),
      );
      return;
    }
    setAiConfig(
      (await invoke<{ config: AiConfig }>('ai-save-provider', { id: provider!.id, effort: level }))
        .config,
    );
  }
  async function follow() {
    setViewing('follow');
    if (!following) setAiConfig(await invoke<AiConfig>('ai-set-use', { use, follow: true }));
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`assistant-model ${className} ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`选择${chat ? '' : `${label}的`}模型和推理强度`}
        title={`${label}：${provider.name} · ${provider.model || '未选模型'}${following ? '（跟随助手聊天）' : ''}`}
        onClick={() => {
          if (!open) {
            setViewing(following ? 'follow' : provider.id);
            load(provider.id);
          }
          setOpen((v) => !v);
        }}
      >
        <span className="assistant-model-name">{following ? '跟随聊天' : shortName(provider)}</span>
        <span className="assistant-model-id">{provider.model || '未选模型'}</span>
        {levels.length ? (
          <span className="assistant-model-effort">{effortLabel(effort)}</span>
        ) : null}
        <ChevronDown size={12} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              className="model-menu"
              role="menu"
              aria-label={`${chat ? '' : `${label}的`}模型和推理强度`}
              style={place}
            >
              {!chat || config.providers.length > 1 ? (
                <div className="model-menu-services" role="group" aria-label="服务">
                  {!chat ? (
                    <button
                      type="button"
                      className={viewing === 'follow' ? 'active' : ''}
                      aria-pressed={viewing === 'follow'}
                      title="和助手聊天用同一个服务和模型"
                      onClick={() => void follow()}
                    >
                      跟随聊天
                      {following ? <i aria-label="正在使用" /> : null}
                    </button>
                  ) : null}
                  {config.providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={p.id === shown?.id ? 'active' : ''}
                      aria-pressed={p.id === shown?.id}
                      onClick={() => {
                        setViewing(p.id);
                        load(p.id);
                      }}
                    >
                      {shortName(p)}
                      {!following && p.id === provider.id ? <i aria-label="正在使用" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {!shown ? (
                <p className="model-menu-note">
                  {label}和助手聊天用同一个模型和推理强度
                  {chatProvider
                    ? `：${shortName(chatProvider)} · ${chatProvider.model || '未选模型'}${levels.length ? ` · ${effortLabel(effort)}` : ''}`
                    : ''}
                  。在聊天里换模型或推理强度，这里也跟着换。点一个服务，可以给{label}单独选。
                </p>
              ) : (
                <>
                  <div className="model-menu-label">
                    模型
                    {list === 'loading' ? <LoaderCircle className="spin" size={11} /> : null}
                  </div>
                  <div className="model-menu-models">
                    {models.map((m, i) => {
                      const current =
                        !following && shown.id === provider.id && m.id === provider.model;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={current}
                          className={current ? 'active' : ''}
                          onClick={() => void pickModel(shown, m.id)}
                        >
                          <span>{m.id}</span>
                          {refusesImages({ ...shown, model: m.id }, models) ? (
                            <ImageOff className="model-vision" size={12} aria-label="不能看图">
                              <title>不能看图</title>
                            </ImageOff>
                          ) : seesImages({ ...shown, model: m.id }, models) ? (
                            <ImagePlus className="model-vision" size={12} aria-label="能看图">
                              <title>能看图</title>
                            </ImagePlus>
                          ) : null}
                          {Array.isArray(list) && i === 0 && shown.preset === 'codex' ? (
                            <em>默认</em>
                          ) : null}
                          {current ? <Check size={13} /> : null}
                        </button>
                      );
                    })}
                    {list && typeof list === 'object' && 'error' in list ? (
                      <p className="model-menu-note">
                        获取不到模型列表：{list.error}
                        <button type="button" onClick={() => load(shown.id, true)}>
                          重试
                        </button>
                      </p>
                    ) : null}
                  </div>
                  {!following && shown.id === provider.id ? (
                    <>
                      <div className="model-menu-label">推理强度</div>
                      {levels.length ? (
                        <div className="model-menu-levels" role="group" aria-label="推理强度">
                          {levels.map((level) => (
                            <button
                              key={level}
                              type="button"
                              role="menuitemradio"
                              aria-checked={level === effort}
                              className={level === effort ? 'active' : ''}
                              onClick={() => void pickEffort(level)}
                            >
                              {effortLabel(level)}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="model-menu-note">这个服务不支持调整推理强度。</p>
                      )}
                      <p className="model-menu-note">
                        越高越仔细，也越慢、越费额度。
                        {chat ? '解释、翻译、白板可以单独选模型和推理强度。' : ''}
                      </p>
                    </>
                  ) : (
                    <p className="model-menu-note">
                      {chat
                        ? `选择一个模型即可切换到 ${shortName(shown)}。`
                        : `选择一个模型，${label}就改用 ${shortName(shown)}。`}
                    </p>
                  )}
                </>
              )}
              {shown && tellsBalance(shown, config) ? <BalanceLine providerId={shown.id} /> : null}
              {onOpenSettings ? (
                <button
                  type="button"
                  className="model-menu-settings"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                >
                  <Settings2 size={13} />
                  管理 AI 服务…
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
