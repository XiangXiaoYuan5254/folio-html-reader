import { useEffect, useRef, useState } from 'react';
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

// Floats above the selection toolbar with the answer about the selected text.
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
  useEffect(() => {
    if (card.mode === 'ask' && card.status === 'idle') input.current?.focus();
  }, [card.id]);
  const streaming = card.status === 'streaming';
  const title =
    card.mode === 'translate' && card.target ? `翻译成${card.target}` : cardLabels[card.mode];
  return (
    <div
      className="ai-card"
      role="dialog"
      aria-label={`AI ${title}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          p.onClose();
        }
      }}
    >
      <div className="ai-card-head">
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
    </div>
  );
}
