import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Check, Copy, Languages, Lightbulb, LoaderCircle, Quote, X } from 'lucide-react';
import type { Assistant } from '../ai/assistant';
import { errorText } from '../ai/client';
import { translationTarget } from '../ai/prompts';
import { Markdown } from '../ai/Markdown';
import { invoke } from '../api';
import { IconButton } from './IconButton';
import { SelectionToolbar } from './SelectionToolbar';
import type { ScreenBox } from './SelectionToolbar';

type Picked = { range: Range; box: ScreenBox };
type Translation = {
  text: string;
  target: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
};

const inside = (node: Node | EventTarget | null, selector: string) =>
  !!(node instanceof Element ? node : node instanceof Node ? node.parentElement : null)?.closest(
    selector,
  );
const answerOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest('.chat-answer');

// The text selected in the conversation, when it lies within one reply that has finished.
function pickedRange(list: HTMLElement): Range | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  const answer = answerOf(range.startContainer);
  if (!answer || answer !== answerOf(range.endContainer) || !list.contains(answer)) return null;
  if (answer.classList.contains('streaming')) return null;
  return range.cloneRange();
}
function boxOf(range: Range): ScreenBox {
  const r = range.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
// The selected text as it reads: formulas as their TeX, without citation numbers or buttons.
export function pickedText(range: Range) {
  const part = range.cloneContents();
  part.querySelectorAll('.katex').forEach((el) => {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    const display = !!el.parentElement?.classList.contains('katex-display');
    el.replaceWith(
      tex
        ? display
          ? `$$${tex}$$`
          : `$${tex}$`
        : el.querySelector('.katex-html')?.textContent || '',
    );
  });
  part.querySelectorAll('.katex-mathml, .cite, button, .chat-actions').forEach((el) => el.remove());
  // Laid out off screen so paragraphs and list items keep their line breaks.
  const box = document.createElement('div');
  box.className = 'ai-markdown';
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;';
  box.append(part);
  document.body.append(box);
  const text = box.innerText;
  box.remove();
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// The toolbar for text selected in a reply: quote it in the question being written, have it
// explained in the conversation, or translated beside it without adding to the conversation.
// It goes when the selection does, on a click elsewhere, or with Esc.
export function ReplySelection(p: {
  list: RefObject<HTMLDivElement | null>;
  store: Assistant;
  // The conversation shown; another one puts the toolbar away.
  conversation: string;
  // Whether a question can go now (not while a reply is still coming).
  canAsk: boolean;
  onQuote: (text: string) => void;
  onExplain: (text: string) => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [copied, setCopied] = useState(false);
  const running = useRef<AbortController | null>(null);
  const shown = useRef(false);
  shown.current = !!picked;
  function hide() {
    running.current?.abort();
    running.current = null;
    setTranslation(null);
    setPicked(null);
  }
  useEffect(hide, [p.conversation]);
  useEffect(() => {
    const list = p.list.current;
    if (!list) return;
    const inBar = (node: Node | EventTarget | null) => inside(node, '.reply-selection');
    const check = () => {
      const range = pickedRange(list);
      if (!range) return;
      running.current?.abort();
      running.current = null;
      setTranslation(null);
      setPicked({ range, box: boxOf(range) });
    };
    let later: ReturnType<typeof setTimeout> | undefined;
    const down = (e: PointerEvent) => {
      if (!inBar(e.target)) hide();
    };
    // After the click that ends a selection; a click inside one clears it only after this.
    const up = (e: PointerEvent) => {
      if (inBar(e.target)) return;
      clearTimeout(later);
      later = setTimeout(check);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && shown.current) hide();
      else if (e.shiftKey || e.key === 'Shift') check();
    };
    const change = () => {
      if (!shown.current) return;
      if (inBar(document.getSelection()?.anchorNode || null)) return;
      if (!pickedRange(list)) hide();
    };
    const scroll = () => setPicked((s) => (s ? { ...s, box: boxOf(s.range) } : s));
    // Clicking into the document moves focus to its frame, which this page doesn't see.
    const blur = () =>
      setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) hide();
      });
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up);
    document.addEventListener('keyup', key);
    document.addEventListener('selectionchange', change);
    list.addEventListener('scroll', scroll);
    window.addEventListener('blur', blur);
    return () => {
      clearTimeout(later);
      running.current?.abort();
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('keyup', key);
      document.removeEventListener('selectionchange', change);
      list.removeEventListener('scroll', scroll);
      window.removeEventListener('blur', blur);
    };
  }, []);
  if (!picked) return null;
  // The text for 引用 and 解释, with the selection let go.
  function take() {
    const text = picked ? pickedText(picked.range) : '';
    document.getSelection()?.removeAllRanges();
    hide();
    return text;
  }
  function translate() {
    const text = picked ? pickedText(picked.range) : '';
    if (!text) return;
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    const live = () => running.current === controller;
    setCopied(false);
    setTranslation({ text: '', target: translationTarget(text), status: 'streaming' });
    p.store
      .translateSnippet(text, controller.signal, (d) => {
        if (live()) setTranslation((t) => t && { ...t, text: t.text + d });
      })
      .then((r) => {
        if (live()) setTranslation((t) => t && { ...t, text: r.text || t.text, status: 'done' });
      })
      .catch((e) => {
        if (live()) setTranslation((t) => t && { ...t, status: 'error', error: errorText(e) });
      })
      .finally(() => {
        if (live()) running.current = null;
      });
  }
  return (
    <SelectionToolbar
      box={picked.box}
      area=".assistant-messages"
      className={`reply-selection${translation ? ' translating' : ''}`}
      // Keeps the selection, except where the translation itself can be selected.
      onMouseDown={(e) => {
        if (!inside(e.target, '.reply-translation-body')) e.preventDefault();
      }}
    >
      {translation ? (
        <div className="reply-translation" role="dialog" aria-label={`翻译成${translation.target}`}>
          <div className="reply-translation-head">
            <Languages size={13} />
            <span>翻译成{translation.target}</span>
            {translation.status === 'done' && translation.text ? (
              <button
                className="reply-translation-copy"
                onClick={() => {
                  void navigator.clipboard.writeText(translation.text.trim());
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
            ) : null}
            <IconButton label="关闭翻译" onClick={hide}>
              <X size={13} />
            </IconButton>
          </div>
          <div className="reply-translation-body">
            {translation.text ? (
              <Markdown
                text={translation.text}
                streaming={translation.status === 'streaming'}
                onLink={(url) => void invoke('external', { url })}
              />
            ) : translation.status === 'streaming' ? (
              <div className="chat-waiting">
                <LoaderCircle className="spin" size={14} />
                正在翻译…
              </div>
            ) : null}
            {translation.error ? <div className="chat-error">{translation.error}</div> : null}
          </div>
        </div>
      ) : (
        <>
          <button
            onClick={() => {
              const text = take();
              if (text) p.onQuote(text);
            }}
            title="引用到输入框"
          >
            <Quote size={15} />
            引用
          </button>
          <i className="selection-divider" aria-hidden="true" />
          <button
            className="selection-ai"
            disabled={!p.canAsk}
            onClick={() => {
              const text = take();
              if (text) p.onExplain(text);
            }}
            title={p.canAsk ? 'AI 在对话里解释这段' : '等这条回答结束后再解释'}
          >
            <Lightbulb size={15} />
            解释
          </button>
          <button className="selection-ai" onClick={translate} title="AI 翻译选中的文字">
            <Languages size={15} />
            翻译
          </button>
        </>
      )}
    </SelectionToolbar>
  );
}
