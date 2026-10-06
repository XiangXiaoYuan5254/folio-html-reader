import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Check,
  CircleStop,
  Copy,
  Highlighter,
  LoaderCircle,
  MessagesSquare,
  X,
} from 'lucide-react';
import { cardLabels } from '../ai/assistant';
import type { SelectionCard } from '../ai/assistant';
import { Markdown } from '../ai/Markdown';
import { invoke } from '../api';
import { ModelMenu } from './ModelMenu';

// Floats over the document with the answer about the selected text. Drag it by its title to
// see what it covers; the next card opens in the usual place. A click anywhere outside it
// puts it away.
export function AiSelectionCard(p: {
  card: SelectionCard;
  onAsk: (question: string) => void;
  onStop: () => void;
  onClose: () => void;
  onSave: () => void;
  onContinue: () => void;
  onOpenSettings: () => void;
}) {
  const { card } = p;
  const [question, setQuestion] = useState('');
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const offset = useRef({ x: 0, y: 0 });
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inside = useRef(false);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    if (card.mode === 'ask' && card.status === 'idle') input.current?.focus();
  }, [card.id]);
  // Moves the card (x, y) from its usual place, keeping it inside the reading pane.
  function place(x: number, y: number) {
    const el = box.current;
    const pane = el?.offsetParent;
    if (!el || !(pane instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    const area = pane.getBoundingClientRect();
    const left = r.left - offset.current.x,
      top = r.top - offset.current.y,
      edge = 6;
    x = Math.max(area.left + edge - left, Math.min(x, area.right - edge - r.width - left));
    y = Math.max(area.top + edge - top, Math.min(y, area.bottom - edge - r.height - top));
    offset.current = { x, y };
    el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  }
  useLayoutEffect(() => {
    offset.current = { x: 0, y: 0 };
    if (box.current) box.current.style.translate = '';
  }, [card.id]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // It grows as the answer streams in, and the pane can shrink.
    const observer = new ResizeObserver(() => place(offset.current.x, offset.current.y));
    observer.observe(el);
    if (el.offsetParent) observer.observe(el.offsetParent);
    return () => observer.disconnect();
  }, []);
  // Clicks inside the document are reported by the app; here, the rest of the window. The
  // selection toolbar acts on the same text, and a dialog may have been opened from the card.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const hit = inside.current;
      inside.current = false;
      const target = e.target instanceof Element ? e.target : null;
      if (!hit && !target?.closest('.selection-toolbar, .modal-backdrop')) close.current();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);
  const streaming = card.status === 'streaming';
  const title =
    card.mode === 'translate' && card.target ? `翻译成${card.target}` : cardLabels[card.mode];
  return (
    <div
      ref={box}
      className="ai-card"
      role="dialog"
      aria-label={`AI ${title}`}
      // Also reached from the model menu, which is drawn outside the card.
      onPointerDown={() => (inside.current = true)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          p.onClose();
        }
      }}
    >
      <div
        className="ai-card-head"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest('button, input')) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            pointer: e.pointerId,
            x: e.clientX - offset.current.x,
            y: e.clientY - offset.current.y,
          };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d?.pointer === e.pointerId) place(e.clientX - d.x, e.clientY - d.y);
        }}
        onLostPointerCapture={() => {
          if (!drag.current) return;
          drag.current = null;
          setDragging(false);
        }}
      >
        <strong>{title}</strong>
        <span className="ai-card-quote" title={card.selection}>
          {card.selection}
        </span>
        <ModelMenu
          use={card.mode === 'translate' ? 'translate' : 'explain'}
          className="model-pick-mini"
          onOpenSettings={p.onOpenSettings}
        />
        <button className="icon-button" aria-label="关闭 AI 卡片" onClick={p.onClose}>
          <X size={15} />
        </button>
      </div>
      {card.mode === 'ask' && (card.status === 'idle' || card.question) ? (
        <form
          className="ai-card-ask"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim() && !streaming) p.onAsk(question);
          }}
        >
          <input
            ref={input}
            aria-label="关于选中文字的问题"
            placeholder="关于这段文字，你想问什么？"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button aria-label="提问" disabled={!question.trim() || streaming}>
            <ArrowUp size={14} />
          </button>
        </form>
      ) : null}
      {card.text || streaming || card.error ? (
        <div className="ai-card-body">
          {card.text ? (
            <Markdown
              text={card.text}
              streaming={streaming}
              onLink={(url) => void invoke('external', { url })}
            />
          ) : streaming ? (
            <div className="chat-waiting">
              <LoaderCircle className="spin" size={14} />
              {card.mode === 'translate' ? '正在翻译…' : '正在思考…'}
            </div>
          ) : null}
          {card.error ? <div className="chat-error">{card.error}</div> : null}
        </div>
      ) : null}
      {streaming ? (
        <div className="ai-card-actions">
          <button onClick={p.onStop}>
            <CircleStop size={13} />
            停止
          </button>
        </div>
      ) : card.status === 'done' && card.text ? (
        <div className="ai-card-actions">
          <button
            onClick={p.onSave}
            disabled={card.saved}
            title="高亮选中的原文，并把这段回答作为笔记附在上面"
          >
            {card.saved ? <Check size={13} /> : <Highlighter size={13} />}
            {card.saved ? '已存为高亮笔记' : '存为高亮笔记'}
          </button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(card.text.trim());
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? '已复制' : '复制'}
          </button>
          <button onClick={p.onContinue} title="在右侧助手中继续追问">
            <MessagesSquare size={13} />
            继续追问
          </button>
        </div>
      ) : null}
      {/* Keeps the document underneath from taking the pointer while the card moves. */}
      {dragging
        ? createPortal(
            <div className="sidebar-resize-shield card-drag-shield" aria-hidden="true" />,
            document.body,
          )
        : null}
    </div>
  );
}
