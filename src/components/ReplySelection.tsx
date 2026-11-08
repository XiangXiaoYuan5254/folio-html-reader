import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  ArrowUp,
  Check,
  Copy,
  Languages,
  Lightbulb,
  LoaderCircle,
  MessageCircleQuestion,
  MessagesSquare,
  X,
} from 'lucide-react';
import { cardLabels } from '../ai/assistant';
import type { Assistant, ReplyAsk, Scope } from '../ai/assistant';
import { errorText } from '../ai/client';
import { translationTarget } from '../ai/prompts';
import { Markdown } from '../ai/Markdown';
import { invoke } from '../api';
import { IconButton } from './IconButton';
import { SelectionToolbar } from './SelectionToolbar';
import type { ScreenBox } from './SelectionToolbar';

type Picked = { range: Range; box: ScreenBox; answerId: string };
// What 解释, 翻译 or 提问 said about the selection, shown where the toolbar was.
type About = ReplyAsk & {
  text: string;
  status: 'idle' | 'streaming' | 'done' | 'error';
  error?: string;
};
const icons = { explain: Lightbulb, translate: Languages, ask: MessageCircleQuestion };

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
const answerIdOf = (range: Range) =>
  (answerOf(range.startContainer) as HTMLElement | null | undefined)?.dataset.message || '';
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

// Text selected in a reply is quoted in the next question, as text selected in the document
// is, and gets a toolbar to have it explained, translated or asked about beside it without
// adding to the conversation, until 继续追问 puts that exchange in the conversation to ask
// on. The toolbar goes when the selection does, on a click elsewhere, or with Esc.
export function ReplySelection(p: {
  list: RefObject<HTMLDivElement | null>;
  store: Assistant;
  scope: Scope;
  // The conversation shown; another one puts the toolbar away.
  conversation: string;
  // Whether the conversation can take more now (not while a reply is still coming).
  canAsk: boolean;
  // Text selected in a reply, and the selection let go of.
  onPick: (text: string) => void;
  onDrop: () => void;
  onContinue: (about: ReplyAsk, answer: string) => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [about, setAbout] = useState<About | null>(null);
  const [question, setQuestion] = useState('');
  const [copied, setCopied] = useState(false);
  const running = useRef<AbortController | null>(null);
  const shown = useRef(false);
  shown.current = !!picked;
  const on = useRef(p);
  on.current = p;
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
  function hide() {
    running.current?.abort();
    running.current = null;
    setAbout(null);
    setPicked(null);
  }
  // Closing a card whose box for a question took the selection selects the passage again, as
  // it is after a card that didn't.
  function close() {
    const range = pickedNow.current?.range;
    const selection = document.getSelection();
    const away =
      inside(selection?.anchorNode || null, '.reply-selection') ||
      inside(document.activeElement, '.reply-selection');
    if (range && selection && away) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    hide();
  }
  useEffect(hide, [p.conversation]);
  // The passage stays marked while a card about it is open, as that box takes the selection.
  const carded = !!about;
  useEffect(() => {
    if (!carded || !picked || !('highlights' in CSS)) return;
    CSS.highlights.set('reply-picked', new Highlight(picked.range));
    return () => void CSS.highlights.delete('reply-picked');
  }, [carded, picked]);
  useEffect(() => {
    const list = p.list.current;
    if (!list) return;
    const inBar = (node: Node | EventTarget | null) => inside(node, '.reply-selection');
    // Whether the text picked last is still selected.
    let held = false;
    const check = () => {
      const range = pickedRange(list);
      if (!range) return;
      running.current?.abort();
      running.current = null;
      setAbout(null);
      setPicked({ range, box: boxOf(range), answerId: answerIdOf(range) });
      const text = pickedText(range);
      if (!text) return;
      held = true;
      on.current.onPick(text);
    };
    let later: ReturnType<typeof setTimeout> | undefined;
    // Whether the click going on began in the conversation, where it can select text.
    let fromList = false;
    const down = (e: PointerEvent) => {
      if (inBar(e.target)) return;
      hide();
      const target = e.target instanceof Element ? e.target : null;
      fromList = !!target && list.contains(target);
      // Only the text of the app can be selected, and a click on the rest leaves a selection
      // as it was. In the conversation it lets go of it, as on a page; not on the scroll bar.
      const bar = target === list && e.offsetX >= list.clientWidth;
      if (fromList && e.button === 0 && !bar && getComputedStyle(target!).userSelect === 'none')
        document.getSelection()?.removeAllRanges();
    };
    // After the click that ends a selection; a click inside one clears it only after this.
    const up = (e: PointerEvent) => {
      if (inBar(e.target) || !fromList) return;
      clearTimeout(later);
      later = setTimeout(check);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && shown.current) close();
      else if (e.shiftKey || e.key === 'Shift') check();
    };
    const change = () => {
      if (inBar(document.getSelection()?.anchorNode || null) || inBar(document.activeElement))
        return;
      if (pickedRange(list)) return;
      if (shown.current) hide();
      if (held) {
        held = false;
        on.current.onDrop();
      }
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
  function open(mode: ReplyAsk['mode']) {
    const selection = picked ? pickedText(picked.range) : '';
    if (!selection) return;
    setQuestion('');
    if (mode === 'ask') {
      running.current?.abort();
      running.current = null;
      setAbout({ mode, selection, text: '', status: 'idle' });
    } else run({ mode, selection });
  }
  function run(ask: ReplyAsk) {
    if (!picked) return;
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    const live = () => running.current === controller;
    setCopied(false);
    setAbout({ ...ask, text: '', status: 'streaming' });
    p.store
      .aboutReply(p.scope, picked.answerId, ask, controller.signal, (d) => {
        if (live()) setAbout((a) => a && { ...a, text: a.text + d });
      })
      .then((text) => {
        if (live()) setAbout((a) => a && { ...a, text: text || a.text, status: 'done' });
      })
      .catch((e) => {
        if (live()) setAbout((a) => a && { ...a, status: 'error', error: errorText(e) });
      })
      .finally(() => {
        if (live()) running.current = null;
      });
  }
  const title = about
    ? about.mode === 'translate'
      ? `翻译成${translationTarget(about.selection)}`
      : cardLabels[about.mode]
    : '';
  const Icon = about ? icons[about.mode] : null;
  const streaming = about?.status === 'streaming';
  return (
    <SelectionToolbar
      box={picked.box}
      area=".assistant-messages"
      className={`reply-selection${about ? ' with-card' : ''}`}
      // Keeps the selection, except where the answer can be selected or a question typed.
      onMouseDown={(e) => {
        if (!inside(e.target, '.reply-card-body, input')) e.preventDefault();
      }}
    >
      {about && Icon ? (
        <div className="reply-card" role="dialog" aria-label={title}>
          <div className="reply-card-head">
            <Icon size={13} />
            <span>{title}</span>
            <IconButton label={`关闭${cardLabels[about.mode]}`} onClick={close}>
              <X size={13} />
            </IconButton>
          </div>
          {about.mode === 'ask' ? (
            <form
              className="ai-card-ask"
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim() && !streaming)
                  run({ mode: 'ask', selection: about.selection, question: question.trim() });
              }}
            >
              <input
                autoFocus
                aria-label="关于选中文字的问题"
                placeholder="关于这段话，你想问什么？"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <button aria-label="提问" disabled={!question.trim() || streaming}>
                <ArrowUp size={14} />
              </button>
            </form>
          ) : null}
          {about.text || streaming || about.error ? (
            <div className="reply-card-body">
              {about.text ? (
                <Markdown
                  text={about.text}
                  streaming={streaming}
                  onLink={(url) => void invoke('external', { url })}
                />
              ) : streaming ? (
                <div className="chat-waiting">
                  <LoaderCircle className="spin" size={14} />
                  {about.mode === 'translate' ? '正在翻译…' : '正在思考…'}
                </div>
              ) : null}
              {about.error ? <div className="chat-error">{about.error}</div> : null}
            </div>
          ) : null}
          {about.status === 'done' && about.text ? (
            <div className="reply-card-actions">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(about.text.trim());
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
              <button
                disabled={!p.canAsk}
                title={p.canAsk ? '放进对话里接着问' : '等这条回答结束后再追问'}
                onClick={() => {
                  const { mode, selection, question } = about;
                  document.getSelection()?.removeAllRanges();
                  hide();
                  p.onContinue({ mode, selection, question }, about.text.trim());
                }}
              >
                <MessagesSquare size={12} />
                继续追问
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <button
            className="selection-ai"
            onClick={() => open('explain')}
            title="AI 解释选中的文字"
          >
            <Lightbulb size={15} />
            解释
          </button>
          <button
            className="selection-ai"
            onClick={() => open('translate')}
            title="AI 翻译选中的文字"
          >
            <Languages size={15} />
            翻译
          </button>
          <button
            className="selection-ai"
            onClick={() => open('ask')}
            title="就选中的文字向 AI 提问"
          >
            <MessageCircleQuestion size={15} />
            提问
          </button>
        </>
      )}
    </SelectionToolbar>
  );
}
