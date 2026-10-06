import { Facet, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import {
  ensureSyntaxTree,
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { tags as t } from '@lezer/highlight';
import { createElement, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { Markdown, mathHtml } from '../ai/Markdown';
import { sizedSpans } from './size';

// The note is Markdown, shown as it reads: the symbols that format a piece of text are
// hidden until the cursor is in it, and a block's own markup (heading #, list bullet, quote
// >) stays hidden and is passed over as one unit, so writing feels like a word processor.
// Formulas, pictures, tables and dividers are drawn in place; clicking one shows its source.

// What the note's links and pictures do; given by the panel around the editor.
export type NoteHost = {
  image?: (name: string) => string;
  openImage: (src: string) => void;
  openLink: (url: string) => void;
  openBoard: (id: string) => void;
};
export const noteHost = Facet.define<NoteHost, NoteHost | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

const setFocus = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setFocus) ? e.value : v), value),
});

// Width of one list level, in em: a nested item's marker sits one step further in.
const step = 1.6;
const bullets = ['•', '◦', '▪'];

class Marker extends WidgetType {
  constructor(
    readonly level: number,
    readonly text: string,
    readonly ordered: boolean,
  ) {
    super();
  }
  eq(other: Marker) {
    return other.level === this.level && other.text === this.text;
  }
  toDOM() {
    const box = document.createElement('span');
    box.className = `cm-note-marker${this.ordered ? ' ordered' : ''}`;
    box.style.width = `${this.level * step}em`;
    box.setAttribute('aria-hidden', 'true');
    box.append(this.text);
    return box;
  }
}

class Check extends WidgetType {
  constructor(
    readonly level: number,
    readonly checked: boolean,
  ) {
    super();
  }
  eq(other: Check) {
    return other.level === this.level && other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span');
    box.className = 'cm-note-marker';
    box.style.width = `${this.level * step}em`;
    const check = document.createElement('span');
    check.className = 'cm-note-check';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(this.checked));
    check.setAttribute('aria-label', this.checked ? '已完成' : '未完成');
    check.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(box));
      const m = /^(?:[ \t]*>[ \t]?)*[ \t]*[-*+][ \t]+\[([ xX])\]/.exec(line.text);
      if (!m) return;
      const at = line.from + m[0].length - 2;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: m[1] === ' ' ? 'x' : ' ' },
        userEvent: 'input.check',
      });
    });
    box.append(check);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class Formula extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    // Shown under a formula's source while it's being written.
    readonly preview = false,
  ) {
    super();
  }
  eq(other: Formula) {
    return (
      other.tex === this.tex && other.display === this.display && other.preview === this.preview
    );
  }
  toDOM() {
    const box = document.createElement(this.display ? 'div' : 'span');
    box.className = this.display
      ? `cm-note-math-block${this.preview ? ' preview' : ''}`
      : 'cm-note-math-inline';
    box.innerHTML = this.tex.trim()
      ? mathHtml(this.tex, this.display)
      : '<span class="cm-note-math-empty">公式</span>';
    if (!this.preview) box.title = '点击修改公式';
    return box;
  }
  get estimatedHeight() {
    return this.display ? 44 : -1;
  }
  ignoreEvent() {
    return this.preview;
  }
}

class Picture extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: Picture) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const host = view.state.facet(noteHost);
    const name = this.src.match(/^note-image:([\w.-]+)$/)?.[1];
    const url = name && host?.image?.(name);
    const box = document.createElement('span');
    if (!url) {
      box.className = 'cm-note-image-missing';
      box.textContent = `［图片${this.alt ? `：${this.alt}` : ''}］`;
      return box;
    }
    box.className = 'cm-note-image';
    const img = document.createElement('img');
    img.src = url;
    img.alt = this.alt;
    if (this.alt) img.title = this.alt;
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('click', () => host?.openImage(url));
    const remove = document.createElement('button');
    remove.className = 'cm-note-image-remove';
    remove.type = 'button';
    remove.title = '删除图片';
    remove.setAttribute('aria-label', '删除图片');
    remove.textContent = '×';
    remove.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const from = view.posAtDOM(box);
      const line = view.state.doc.lineAt(from);
      const m = /^!\[[^\]]*\]\([^)\s]*\)/.exec(line.text.slice(from - line.from));
      if (!m) return;
      const to = from + m[0].length;
      // A picture alone on its line takes the line with it.
      const alone = !(
        line.text.slice(0, from - line.from) + line.text.slice(to - line.from)
      ).trim();
      const range =
        alone && line.number < view.state.doc.lines
          ? { from: line.from, to: line.to + 1 }
          : alone && line.number > 1
            ? { from: line.from - 1, to: line.to }
            : { from, to };
      view.dispatch({ changes: range, userEvent: 'delete.image' });
    });
    box.append(img, remove);
    return box;
  }
  get estimatedHeight() {
    return 160;
  }
}

class Divider extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const line = document.createElement('span');
    line.className = 'cm-note-hr';
    return line;
  }
  ignoreEvent() {
    return false;
  }
}

class CodeHead extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }
  eq(other: CodeHead) {
    return other.lang === this.lang && other.code === this.code;
  }
  toDOM() {
    const head = document.createElement('span');
    head.className = 'cm-note-code-head';
    const lang = document.createElement('span');
    lang.textContent = this.lang || '代码';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cm-note-code-copy';
    copy.textContent = '复制';
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.code);
      copy.textContent = '已复制';
      setTimeout(() => (copy.textContent = '复制'), 1500);
    });
    head.append(lang, copy);
    return head;
  }
  ignoreEvent(e: Event) {
    return (e.target as Element).closest?.('button') != null;
  }
}

// A table, drawn with the same Markdown renderer as answers; clicking it opens its source.
const roots = new WeakMap<HTMLElement, Root>();
function Drawn({ children, onDrawn }: { children?: ReactNode; onDrawn: () => void }) {
  useLayoutEffect(onDrawn);
  return children;
}
class Rendered extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: Rendered) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const host = view.state.facet(noteHost);
    const box = document.createElement('div');
    box.className = 'cm-note-block ai-markdown';
    box.title = '点击修改表格';
    const root = createRoot(box);
    roots.set(box, root);
    root.render(
      createElement(
        Drawn,
        { onDrawn: () => view.requestMeasure() },
        createElement(Markdown, {
          text: this.source,
          onLink: host?.openLink,
          onBoard: host?.openBoard,
          image: host?.image,
          onImage: host?.openImage,
        }),
      ),
    );
    return box;
  }
  destroy(dom: HTMLElement) {
    const root = roots.get(dom);
    if (root) setTimeout(() => root.unmount());
  }
  get estimatedHeight() {
    return this.source.split('\n').length * 26;
  }
  ignoreEvent(e: Event) {
    return (e.target as Element).closest?.('a, img') != null;
  }
}

const hidden = Decoration.replace({});
const markClass = (cls: string) => Decoration.mark({ class: cls });
const inlineCode = markClass('cm-note-code');
const faded = markClass('cm-note-faded');
const mathSource = markClass('cm-note-math-source');

// Formula source without its delimiters.
export function texOf(source: string) {
  const s = source.trim();
  if (s.startsWith('$$')) return s.slice(2, s.endsWith('$$') && s.length >= 4 ? -2 : undefined);
  if (s.startsWith('$')) return s.slice(1, -1);
  if (s.startsWith('\\(') || s.startsWith('\\['))
    return s.slice(2, /\\[)\]]$/.test(s) ? -2 : undefined);
  return s;
}

type Built = { deco: DecorationSet; atomic: DecorationSet };
function build(state: EditorState): Built {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 400) ?? syntaxTree(state);
  const focus = state.field(focused, false) ?? false;
  const ranges = state.selection.ranges;
  // Markup shows where the cursor is, and only while writing.
  const touches = (from: number, to: number) =>
    focus && ranges.some((r) => r.from <= to && r.to >= from);
  const deco: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const hide = (from: number, to: number, solid = false) => {
    if (from >= to) return;
    deco.push(hidden.range(from, to));
    if (solid) atomic.push(hidden.range(from, to));
  };
  const widget = (from: number, to: number, w: WidgetType, solid = true, block = false) => {
    const d = Decoration.replace({ widget: w, block });
    deco.push(d.range(from, to));
    if (solid) atomic.push(d.range(from, to));
  };
  // Line classes and styles, merged per line.
  const lines = new Map<number, { cls: string[]; style: string[] }>();
  const line = (pos: number, cls: string, style?: string) => {
    const from = doc.lineAt(pos).from;
    const entry = lines.get(from) || { cls: [], style: [] };
    entry.cls.push(cls);
    if (style) entry.style.push(style);
    lines.set(from, entry);
  };
  // Ranges drawn as one block; markup inside them is left alone.
  const blocks: [number, number][] = [];
  const inBlock = (pos: number) => blocks.some(([a, b]) => pos >= a && pos <= b);
  const quoteEnds = new Map<number, number>();
  const items: SyntaxNode[] = [];
  const quoteMarks: SyntaxNode[] = [];

  tree.iterate({
    enter(ref) {
      const node = ref.node;
      const { from, to } = node;
      switch (ref.name) {
        case 'QuoteMark':
          quoteMarks.push(node);
          return;
        case 'ListItem':
          items.push(node);
          return;
        case 'FencedCode': {
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          for (let n = first.number; n <= last.number; n++)
            line(
              doc.line(n).from,
              `cm-note-pre${n === first.number ? ' first' : ''}${n === last.number ? ' last' : ''}`,
            );
          const codeMarks = node.getChildren('CodeMark');
          const code = node
            .getChildren('CodeText')
            .map((c) => doc.sliceString(c.from, c.to))
            .join('\n');
          const info = node.getChild('CodeInfo');
          const open = codeMarks[0];
          const close = codeMarks.length > 1 ? codeMarks[codeMarks.length - 1] : null;
          if (!touches(from, to)) {
            if (open)
              widget(
                open.from,
                first.to,
                new CodeHead(info ? doc.sliceString(info.from, info.to) : '', code),
              );
            if (close) {
              hide(close.from, doc.lineAt(close.from).to, true);
              line(close.from, 'cm-note-pre-end');
            }
          } else {
            if (open) deco.push(faded.range(open.from, first.to));
            if (close) deco.push(faded.range(close.from, close.to));
          }
          return false;
        }
        case 'BlockMath': {
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          const tex = texOf(doc.sliceString(from, to));
          if (!touches(first.from, last.to)) {
            widget(first.from, last.to, new Formula(tex, true), false, true);
            blocks.push([first.from, last.to]);
          } else {
            for (let n = first.number; n <= last.number; n++)
              line(doc.line(n).from, 'cm-note-math-lines');
            deco.push(
              Decoration.widget({
                widget: new Formula(tex, true, true),
                block: true,
                side: 1,
              }).range(last.to),
            );
          }
          return false;
        }
        case 'Table': {
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          if (!touches(first.from, last.to)) {
            widget(
              first.from,
              last.to,
              new Rendered(doc.sliceString(first.from, last.to)),
              false,
              true,
            );
            blocks.push([first.from, last.to]);
          } else
            for (let n = first.number; n <= last.number; n++)
              line(doc.line(n).from, 'cm-note-table-lines');
          return false;
        }
        case 'HorizontalRule': {
          const l = doc.lineAt(from);
          if (!touches(l.from, l.to)) widget(from, to, new Divider(), true);
          else deco.push(faded.range(from, to));
          line(from, 'cm-note-hr-line');
          return false;
        }
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
          if (!touches(from, to))
            for (let c = node.firstChild; c; c = c.nextSibling)
              if (c.name.endsWith('Mark')) hide(c.from, c.to);
          return;
        case 'InlineCode':
          deco.push(inlineCode.range(from, to));
          if (!touches(from, to)) for (const c of node.getChildren('CodeMark')) hide(c.from, c.to);
          return;
        case 'InlineMath':
          if (!touches(from, to))
            widget(from, to, new Formula(texOf(doc.sliceString(from, to)), false), false);
          else deco.push(mathSource.range(from, to));
          return false;
        case 'Image': {
          if (node.parent?.name === 'Link') return false;
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          if (!url || marks.length < 2) return false;
          widget(
            from,
            to,
            new Picture(
              doc.sliceString(url.from, url.to),
              doc.sliceString(marks[0].to, marks[1].from),
            ),
          );
          return false;
        }
        case 'Link': {
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          if (!url || marks.length < 2) return;
          const textFrom = marks[0].to;
          const textTo = marks[1].from;
          const href = doc.sliceString(url.from, url.to);
          if (!touches(from, to)) {
            hide(from, textFrom);
            hide(textTo, to);
            deco.push(
              Decoration.mark({
                class: 'cm-note-link',
                attributes: { 'data-href': href, title: linkTitle(href) },
              }).range(textFrom, textTo),
            );
          } else deco.push(markClass('cm-note-link').range(textFrom, textTo));
          return;
        }
        case 'URL':
          if (node.parent && /^(Link|Image)$/.test(node.parent.name)) return;
          deco.push(
            Decoration.mark(
              touches(from, to)
                ? { class: 'cm-note-link' }
                : {
                    class: 'cm-note-link',
                    attributes: { 'data-href': doc.sliceString(from, to), title: '打开链接' },
                  },
            ).range(from, to),
          );
          return;
      }
      const heading = /^ATXHeading(\d)$/.exec(ref.name);
      if (heading) {
        line(from, `cm-note-h${heading[1]}`);
        const marks = node.getChildren('HeaderMark');
        const open = marks[0];
        if (open) {
          let end = open.to;
          while (end < to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
          const closing = marks.length > 1 ? marks[marks.length - 1] : null;
          const empty = !doc.sliceString(end, closing ? closing.from : to).trim();
          // An empty heading shows its # while it's being written.
          if (!(empty && touches(doc.lineAt(from).from, doc.lineAt(from).to)))
            hide(open.from, end, true);
          if (closing && !touches(from, to)) {
            let start = closing.from;
            while (start > end && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
            hide(start, closing.to);
          }
        }
      }
    },
  });

  // Quote markers: hidden, with a bar along the quoted lines.
  for (const mark of quoteMarks) {
    if (inBlock(mark.from)) continue;
    const l = doc.lineAt(mark.from);
    let end = mark.to;
    if (/[ \t]/.test(doc.sliceString(end, end + 1))) end++;
    if (!quoteEnds.has(l.from)) line(l.from, 'cm-note-quote');
    quoteEnds.set(l.from, Math.max(end, quoteEnds.get(l.from) ?? end));
  }
  for (const [from, end] of quoteEnds) hide(from, end, true);

  // List items: bullet, number or checkbox in a column of their own, the item's text and its
  // indented continuation lines lined up after it.
  for (const item of items) {
    let level = 0;
    for (let p: SyntaxNode | null = item; p; p = p.parent) if (p.name === 'ListItem') level++;
    const mark = item.getChild('ListMark');
    if (!mark || inBlock(mark.from)) continue;
    const first = doc.lineAt(item.from);
    const start = quoteEnds.get(first.from) ?? first.from;
    const indent = `${level * step}em`;
    const quoted = quoteEnds.has(first.from);
    const pad = quoted ? `calc(0.85em + ${indent})` : indent;
    const task = item.getChild('Task')?.getChild('TaskMarker');
    let end = task ? task.to : mark.to;
    if (/[ \t]/.test(doc.sliceString(end, end + 1))) end++;
    const markText = doc.sliceString(mark.from, mark.to);
    const ordered = item.parent?.name === 'OrderedList';
    widget(
      start,
      end,
      task
        ? new Check(level, /x/i.test(doc.sliceString(task.from, task.to)))
        : new Marker(
            level,
            ordered ? markText.replace(')', '.') : bullets[(level - 1) % 3],
            ordered,
          ),
    );
    line(
      first.from,
      `cm-note-li${task && /x/i.test(doc.sliceString(task.from, task.to)) ? ' done' : ''}`,
      `padding-left:${pad};text-indent:-${indent}`,
    );
    const nested = item
      .getChildren('BulletList')
      .concat(item.getChildren('OrderedList'))
      .map((l) => [l.from, l.to]);
    const last = doc.lineAt(item.to).number;
    for (let n = first.number + 1; n <= last; n++) {
      const l = doc.line(n);
      if (nested.some(([a, b]) => l.from >= a && l.from <= b) || inBlock(l.from)) continue;
      const from = quoteEnds.get(l.from) ?? l.from;
      const lead = /^[ \t]*/.exec(doc.sliceString(from, l.to))![0].length;
      // A line that isn't indented only belongs to the item by Markdown's lazy rule; it
      // reads as a paragraph of its own, as notes have always shown it.
      if (!lead || from + lead === l.to) continue;
      hide(from, from + lead, true);
      line(l.from, 'cm-note-li-more', `padding-left:${pad}`);
    }
  }
  // Text with its own size: the tags are hidden and passed over, the text sized.
  for (const span of sizedSpans(state)) {
    if (inBlock(span.open.from)) continue;
    hide(span.open.from, span.open.to, true);
    hide(span.close.from, span.close.to, true);
    if (span.open.to < span.close.from)
      deco.push(
        Decoration.mark({ attributes: { style: `font-size:${span.css}` } }).range(
          span.open.to,
          span.close.from,
        ),
      );
  }
  // Blank lines between paragraphs read as spacing, not as a full empty line.
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n);
    if (!l.length && !lines.has(l.from)) line(l.from, 'cm-note-blank');
  }
  for (const [from, { cls, style }] of lines)
    deco.push(
      Decoration.line({
        class: cls.join(' '),
        attributes: style.length ? { style: style.join(';') } : undefined,
      }).range(from),
    );
  return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

function linkTitle(href: string) {
  return href.startsWith('folio-board:') ? '在白板中打开' : href;
}

const live = StateField.define<Built>({
  create: build,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setFocus)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    )
      return build(tr.state);
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

export function openHref(view: EditorView, href: string) {
  const host = view.state.facet(noteHost);
  const board = /^folio-board:([\w-]+)$/.exec(href)?.[1];
  if (board) return host?.openBoard(board);
  const url = /^www\./i.test(href) ? `https://${href}` : href;
  if (/^https?:\/\//i.test(url)) host?.openLink(url);
}

const noteHighlight = HighlightStyle.define([
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-4)' },
  { tag: t.processingInstruction, color: 'var(--fainter)' },
  { tag: [t.url, t.labelName], color: 'var(--faint)' },
  { tag: t.quote, color: 'var(--text-3)' },
]);

export function liveMarkdown(): Extension {
  return [
    focused,
    live,
    syntaxHighlighting(noteHighlight),
    EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing)),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        const link = (e.target as Element).closest?.('[data-href]');
        if (!link || e.button !== 0 || e.shiftKey) return false;
        e.preventDefault();
        openHref(view, link.getAttribute('data-href')!);
        return true;
      },
    }),
  ];
}
