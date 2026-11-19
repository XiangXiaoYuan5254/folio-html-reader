import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings2 } from 'lucide-react';
import type { Assistant, ReadingContext } from '../ai/assistant';
import type { AiConfig, AiProvider, ChatThread } from '../ai/types';
import { tokensLabel } from '../ai/context';
import type { ContextPart, ContextUse } from '../ai/context';

const colors: Record<ContextPart['key'], string> = {
  instructions: 'var(--text-4)',
  documents: 'var(--accent)',
  tools: 'var(--board-orange)',
  summary: 'var(--board-blue)',
  messages: 'var(--ai)',
};
const percent = (n: number, of: number) => {
  const p = (n / of) * 100;
  return n > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
};

// How much of the model's window the next question would take, beside the model picker;
// clicked, what it is made of, as Claude Code's /context shows it.
export function ContextMeter(p: {
  store: Assistant;
  scope: string;
  reading: ReadingContext | null;
  thread: ChatThread | undefined;
  running: boolean;
  provider: AiProvider | undefined;
  config: AiConfig | null;
  // The open project's folder: 整个项目 is the same scope in every project.
  root?: string;
  onOpenSettings: () => void;
}) {
  const [use, setUse] = useState<ContextUse | null>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const docs = p.reading?.docs.map((d) => d.path).join('\n') || '';
  const last = p.thread?.messages.at(-1);
  const project = p.scope === 'project';
  // Counted again once a reply is done, not with every word of it.
  useEffect(() => {
    if (!p.scope || !p.provider || !p.config) return setUse(null);
    if (p.running) return;
    let current = true;
    const timer = setTimeout(() => {
      p.store
        .contextUse(p.scope, project ? null : p.reading, p.provider!, p.config!)
        .then((u) => current && setUse(u))
        .catch(() => current && setUse(null));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    p.scope,
    p.thread?.id,
    p.thread?.messages.length,
    last?.status,
    p.thread?.summary?.upTo,
    p.running,
    p.provider?.id,
    p.provider?.model,
    p.provider?.context,
    p.config?.prefs,
    docs,
    p.root,
  ]);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setPlace({
      left: Math.max(8, Math.min(innerWidth - 288, r.right - 280)),
      bottom: innerHeight - r.top + 6,
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
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
  if (!use || !use.window) return null;
  const share = use.used / use.window;
  const level = share >= 0.9 ? 'full' : share >= 0.7 ? 'high' : '';
  const shown = percent(use.used, use.window);
  const free = Math.max(0, use.window - use.used);
  // The ring: r = 6 on a 16-unit box.
  const ring = 2 * Math.PI * 6;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`context-meter ${level} ${open ? 'open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`上下文已用 ${shown}`}
        title={`上下文已用 ${shown}：约 ${tokensLabel(use.used)} / ${tokensLabel(use.window)} tokens`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <circle cx="8" cy="8" r="6" className="context-meter-track" />
          <circle
            cx="8"
            cy="8"
            r="6"
            className="context-meter-fill"
            strokeDasharray={`${Math.min(1, Math.max(share, use.used ? 0.03 : 0)) * ring} ${ring}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span>{shown}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              className="model-menu context-menu"
              role="dialog"
              aria-label="上下文用量"
              style={place}
            >
              <div className="context-menu-head">
                <strong>上下文</strong>
                <span>
                  约 {tokensLabel(use.used)} / {tokensLabel(use.window)}
                </span>
              </div>
              <div className={`context-menu-total ${level}`}>{shown} 已用</div>
              <div className="context-menu-bar" aria-hidden="true">
                {use.parts.map((part) => (
                  <i
                    key={part.key}
                    style={{
                      width: `${Math.min(100, (part.tokens / use.window) * 100)}%`,
                      background: colors[part.key],
                    }}
                  />
                ))}
              </div>
              <ul className="context-menu-parts">
                {use.parts.map((part) => (
                  <li key={part.key}>
                    <i style={{ background: colors[part.key] }} />
                    <span>{part.label}</span>
                    <span>{tokensLabel(part.tokens)}</span>
                    <span>{percent(part.tokens, use.window)}</span>
                  </li>
                ))}
                <li className="free">
                  <i />
                  <span>剩余空间</span>
                  <span>{tokensLabel(free)}</span>
                  <span>{percent(free, use.window)}</span>
                </li>
              </ul>
              <p className="model-menu-note">按估算计。快满时，较早的对话会自动压缩成摘要。</p>
              <button
                type="button"
                className="model-menu-settings"
                onClick={() => {
                  setOpen(false);
                  p.onOpenSettings();
                }}
              >
                <Settings2 size={14} />
                调整上下文长度…
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
