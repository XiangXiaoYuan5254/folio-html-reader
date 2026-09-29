import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ImagePlus, LoaderCircle, Settings2 } from 'lucide-react';
import { invoke } from '../api';
import { activeProvider, errorText, setAiConfig } from '../ai/client';
import { effortLabel, levelsFor, modelOptions } from '../ai/levels';
import { seesImages } from '../ai/images';
import type { AiConfig, AiProvider, ModelOption } from '../ai/types';

const shortName = (p: AiProvider) => p.name.replace(/（.*?）|\(.*?\)/g, '').trim() || p.name;

// Service, model and reasoning level, switched right where you type, like Codex's picker.
export function ModelMenu({
  config,
  onOpenSettings,
}: {
  config: AiConfig | null;
  onOpenSettings: () => void;
}) {
  const provider = activeProvider(config);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(provider?.id || '');
  const [lists, setLists] = useState<Record<string, ModelOption[] | 'loading' | { error: string }>>(
    {},
  );
  const [place, setPlace] = useState({ left: 0, bottom: 0 });
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
    // The active model's levels are shown on the button before the menu is opened.
    if (provider?.id) load(provider.id);
  }, [provider?.id]);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setPlace({
      left: Math.max(8, Math.min(innerWidth - 316, r.left)),
      bottom: innerHeight - r.top + 6,
    });
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
      <button className="assistant-model" onClick={onOpenSettings}>
        未配置 AI 服务
      </button>
    );
  const activeList = lists[provider.id];
  const levels = levelsFor(provider, config, Array.isArray(activeList) ? activeList : undefined);
  const effort = levels.includes(provider.effort) ? provider.effort : '';
  const shown = config.providers.find((p) => p.id === viewing) || provider;
  const list = lists[shown.id];
  const models: ModelOption[] = Array.isArray(list)
    ? list
    : shown.model
      ? [{ id: shown.model, efforts: [], defaultEffort: '' }]
      : [];
  // The menu stays open so the reasoning level can be picked right after the model.
  async function pickModel(p: AiProvider, model: string) {
    const next = await invoke<AiConfig>('ai-set-active', { id: p.id, model });
    setAiConfig(next);
    // A level the new model doesn't have falls back to automatic.
    const saved = next.providers.find((x) => x.id === p.id);
    const options = lists[p.id];
    const allowed = levelsFor(saved, next, Array.isArray(options) ? options : undefined);
    if (saved?.effort && !allowed.includes(saved.effort))
      setAiConfig(
        (await invoke<{ config: AiConfig }>('ai-save-provider', { id: p.id, effort: '' })).config,
      );
  }
  async function pickEffort(level: string) {
    setOpen(false);
    setAiConfig(
      (await invoke<{ config: AiConfig }>('ai-save-provider', { id: provider!.id, effort: level }))
        .config,
    );
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`assistant-model ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="选择模型和推理强度"
        title="选择服务、模型和推理强度"
        onClick={() => {
          if (!open) {
            setViewing(provider.id);
            load(provider.id);
          }
          setOpen((v) => !v);
        }}
      >
        <span className="assistant-model-name">{shortName(provider)}</span>
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
              aria-label="模型和推理强度"
              style={{ left: place.left, bottom: place.bottom }}
            >
              {config.providers.length > 1 ? (
                <div className="model-menu-services" role="group" aria-label="服务">
                  {config.providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={p.id === shown.id ? 'active' : ''}
                      aria-pressed={p.id === shown.id}
                      onClick={() => {
                        setViewing(p.id);
                        load(p.id);
                      }}
                    >
                      {shortName(p)}
                      {p.id === provider.id ? <i aria-label="正在使用" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="model-menu-label">
                模型
                {list === 'loading' ? <LoaderCircle className="spin" size={11} /> : null}
              </div>
              <div className="model-menu-models">
                {models.map((m, i) => {
                  const current = shown.id === provider.id && m.id === provider.model;
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
                      {seesImages({ ...shown, model: m.id }, models) ? (
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
              {shown.id === provider.id ? (
                <>
                  <div className="model-menu-label">推理强度</div>
                  {levels.length ? (
                    <div className="model-menu-levels" role="group" aria-label="推理强度">
                      {['', ...levels].map((level) => (
                        <button
                          key={level || 'auto'}
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
                    越高越仔细，也越慢、越费额度。解释、翻译和划重点总是用最快的档位。
                  </p>
                </>
              ) : (
                <p className="model-menu-note">选择一个模型即可切换到 {shortName(shown)}。</p>
              )}
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
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
