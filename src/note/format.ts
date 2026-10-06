import { EditorSelection, EditorState } from '@codemirror/state';
import type { ChangeSpec, Line } from '@codemirror/state';
import type { Command, EditorView, KeyBinding } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { insertNewline } from '@codemirror/commands';
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from '@codemirror/lang-markdown';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

// Formatting the note without knowing Markdown: toolbar buttons, shortcuts and the / menu
// write the Markdown, and Enter, Backspace and Tab act on lists, quotes and headings the way
// they do in other editors.

export type ListKind = 'bullet' | 'ordered' | 'task';
type Block = {
  quote: string;
  indent: string;
  kind: 'heading' | ListKind | null;
  level: number;
  checked: boolean;
  // Where the line's own text starts.
  prefix: number;
};
const blockPattern =
  /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:(#{1,6})(?:[ \t]+|$)|[-*+][ \t]+\[([ xX])\](?:[ \t]+|$)|[-*+](?:[ \t]+|$)|(\d{1,9})[.)](?:[ \t]+|$))?/;
export function lineBlock(text: string): Block {
  const m = blockPattern.exec(text)!;
  const [all, quote, indent, hashes, check, num] = m;
  const listed = all.length > quote.length + indent.length;
  const kind = hashes
    ? 'heading'
    : check !== undefined
      ? 'task'
      : num !== undefined
        ? 'ordered'
        : listed
          ? 'bullet'
          : null;
  return {
    quote,
    indent,
    kind,
    level: hashes?.length || 0,
    checked: !!check && check !== ' ',
    prefix: all.length,
  };
}
const isList = (b: Block) => b.kind === 'bullet' || b.kind === 'ordered' || b.kind === 'task';

// The lines a command works on: those in the selection, leaving out blank ones unless
// there is nothing else.
function selectedLines(state: EditorState) {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const r of state.selection.ranges) {
    const to = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(to).number; n++)
      if (!seen.has(n)) {
        seen.add(n);
        lines.push(state.doc.line(n));
      }
  }
  const written = lines.filter((l) => l.text.trim());
  return written.length ? written : lines;
}

export type BlockStyle = 'paragraph' | 'h1' | 'h2' | 'h3' | ListKind | 'quote';
export function setBlock(view: EditorView, style: BlockStyle) {
  const { state } = view;
  const lines = selectedLines(state);
  const blocks = lines.map((l) => lineBlock(l.text));
  const changes: ChangeSpec[] = [];
  if (style === 'quote') {
    const all = blocks.every((b) => b.quote);
    lines.forEach((l, i) => {
      if (!all) changes.push({ from: l.from, insert: '> ' });
      else {
        const m = /^[ \t]*>[ \t]?/.exec(blocks[i].quote)!;
        changes.push({ from: l.from, to: l.from + m[0].length });
      }
    });
  } else if (style === 'paragraph' || style.startsWith('h')) {
    const level = style === 'paragraph' ? 0 : Number(style[1]);
    const toggleOff = level && blocks.every((b) => b.kind === 'heading' && b.level === level);
    lines.forEach((l, i) => {
      const b = blocks[i];
      // 正文 takes off all of a line's formatting, quoting included.
      const start = level ? l.from + b.quote.length : l.from;
      const insert = level && !toggleOff ? '#'.repeat(level) + ' ' : '';
      changes.push({ from: start, to: l.from + b.prefix, insert });
    });
  } else {
    const kind = style as ListKind;
    const toggleOff = blocks.every((b) => b.kind === kind);
    // Numbers go on from an ordered item right above the selection.
    let n = 1;
    const above = lines[0].number > 1 ? state.doc.line(lines[0].number - 1) : null;
    const prev = above && lineBlock(above.text);
    if (prev?.kind === 'ordered')
      n = Number(/(\d+)[.)]/.exec(above!.text.slice(prev.quote.length))![1]) + 1;
    lines.forEach((l, i) => {
      const b = blocks[i];
      const start = l.from + b.quote.length + (b.kind === 'heading' ? 0 : b.indent.length);
      const marker = toggleOff
        ? ''
        : kind === 'bullet'
          ? '- '
          : kind === 'task'
            ? '- [ ] '
            : `${n++}. `;
      changes.push({ from: start, to: l.from + b.prefix, insert: marker });
    });
  }
  // A cursor where markup goes in ends up after it, ready to write.
  const set = state.changes(changes);
  view.dispatch({
    changes: set,
    selection: state.selection.map(set, 1),
    userEvent: 'input.format',
    scrollIntoView: true,
  });
  view.focus();
}

const markNodes: Record<string, string> = {
  '**': 'StrongEmphasis',
  '*': 'Emphasis',
  '~~': 'Strikethrough',
  '`': 'InlineCode',
};
export type InlineMark = keyof typeof markNodes;

// The formatted piece of text of this kind the cursor or selection is in.
function enclosing(state: EditorState, from: number, to: number, mark: InlineMark) {
  const name = markNodes[mark];
  for (const side of [-1, 1] as const)
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, side); n; n = n.parent)
      if (n.name === name && n.from <= from && n.to >= to) return n;
  return null;
}
export function inlineMarksAt(state: EditorState) {
  const { from, to } = state.selection.main;
  const at = (m: InlineMark) => !!enclosing(state, from, to, m);
  return { bold: at('**'), italic: at('*'), strike: at('~~'), code: at('`') };
}

export function toggleMark(view: EditorView, mark: InlineMark) {
  const { state } = view;
  const len = mark.length;
  const tx = state.changeByRange((r) => {
    const node = enclosing(state, r.from, r.to, mark);
    if (node) {
      // Take the formatting off: remove the marks around it.
      const first = node.firstChild!;
      const last = node.lastChild!;
      const changes = [
        { from: first.from, to: first.to },
        { from: last.from, to: last.to },
      ];
      const map = state.changes(changes);
      return {
        changes,
        range: EditorSelection.range(map.mapPos(r.anchor, 1), map.mapPos(r.head, 1)),
      };
    }
    if (r.empty) {
      // Formatting for what's typed next.
      return {
        changes: { from: r.from, insert: mark + mark },
        range: EditorSelection.cursor(r.from + len),
      };
    }
    // Each line of the selection gets its own marks; formatting can't span lines.
    const changes: ChangeSpec[] = [];
    let first = -1;
    let last = -1;
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const l = state.doc.line(n);
      let a = Math.max(r.from, l.from + lineBlock(l.text).prefix);
      let b = Math.min(r.to, l.to);
      while (a < b && /\s/.test(state.sliceDoc(a, a + 1))) a++;
      while (b > a && /\s/.test(state.sliceDoc(b - 1, b))) b--;
      if (a >= b) continue;
      changes.push({ from: a, insert: mark }, { from: b, insert: mark });
      if (first < 0) first = a;
      last = b;
    }
    if (first < 0) return { range: r };
    const map = state.changes(changes);
    return {
      changes,
      range: EditorSelection.range(map.mapPos(first, 1), map.mapPos(last, -1)),
    };
  });
  view.dispatch(state.update(tx, { userEvent: 'input.format', scrollIntoView: true }));
  view.focus();
}

// A block of its own (code, formula, divider, table, pictures): on the cursor's line if
// it's blank, otherwise on a new line below; `cursor` is where to keep writing in it.
export function insertBlock(view: EditorView, text: string, cursor = text.length) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const blank = !line.text.trim();
  const from = blank ? line.from : line.to;
  const insert = (blank ? '' : '\n') + text;
  view.dispatch({
    changes: { from, to: line.to, insert },
    selection: EditorSelection.cursor(from + (blank ? 0 : 1) + cursor),
    userEvent: 'input.format',
    scrollIntoView: true,
  });
  view.focus();
}
export const insertCode = (view: EditorView) => {
  const { from, to } = view.state.selection.main;
  if (from < to) {
    const a = view.state.doc.lineAt(from);
    const b = view.state.doc.lineAt(to);
    view.dispatch({
      changes: [
        { from: a.from, insert: '```\n' },
        { from: b.to, insert: '\n```' },
      ],
      userEvent: 'input.format',
    });
    return view.focus();
  }
  insertBlock(view, '```\n\n```', 4);
};
export const insertMath = (view: EditorView) => {
  const { from, to } = view.state.selection.main;
  if (from < to && view.state.doc.lineAt(from).number === view.state.doc.lineAt(to).number) {
    view.dispatch({
      changes: [
        { from, insert: '$' },
        { from: to, insert: '$' },
      ],
      selection: EditorSelection.range(from + 1, to + 1),
      userEvent: 'input.format',
    });
    return view.focus();
  }
  insertBlock(view, '$$\n\n$$', 3);
};
export const insertDivider = (view: EditorView) => insertBlock(view, '---\n');
export const insertTable = (view: EditorView) =>
  insertBlock(view, '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', 2);
export function insertImages(view: EditorView, names: string[]) {
  insertBlock(view, names.map((n) => `![图片](note-image:${n})`).join('\n') + '\n');
}

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });
const enter: Command = (view) => {
  const { state } = view;
  const r = state.selection.main;
  if (state.selection.ranges.length > 1 || !r.empty)
    return continueMarkup(view) || insertNewline(view);
  const line = state.doc.lineAt(r.head);
  const b = lineBlock(line.text);
  const rest = line.text.slice(b.prefix);
  if (!rest.trim() && (isList(b) || b.quote) && r.head === line.to) {
    // An empty item or quote line ends the list or quote: a nested item moves out a
    // level, a list in a quote leaves the quote, and otherwise the line turns into the
    // blank line that ends the block and writing goes on below it.
    if (isList(b) && b.indent) return outdent(view);
    if (isList(b) && b.quote) {
      view.dispatch({
        changes: { from: line.from + b.quote.length, to: line.to },
        userEvent: 'input',
      });
      return true;
    }
    const before = line.number > 1 ? state.doc.line(line.number - 1).text : '';
    const insert = before.trim() ? '\n' : '';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: EditorSelection.cursor(line.from + insert.length),
      userEvent: 'input',
      scrollIntoView: true,
    });
    return true;
  }
  // Enter before a heading's text opens a line above it rather than moving the text.
  if (b.kind === 'heading' && r.head === line.from + b.prefix && rest.trim()) {
    view.dispatch({
      changes: { from: line.from, insert: '\n' },
      userEvent: 'input',
      scrollIntoView: true,
    });
    return true;
  }
  return continueMarkup(view) || insertNewline(view);
};

// Backspace at the start of a heading, item or quote takes its formatting off first.
const backspace: Command = (view) => {
  const { state } = view;
  const r = state.selection.main;
  if (state.selection.ranges.length > 1 || !r.empty) return false;
  const line = state.doc.lineAt(r.head);
  const b = lineBlock(line.text);
  if (!b.prefix || r.head !== line.from + b.prefix) return deleteMarkupBackward(view);
  if (isList(b) && b.indent) return outdent(view);
  if (b.kind) {
    view.dispatch({
      changes: { from: line.from + b.quote.length, to: line.from + b.prefix },
      userEvent: 'delete.format',
    });
    return true;
  }
  if (b.quote) {
    const m = /[ \t]*>[ \t]?$/.exec(b.quote)!;
    view.dispatch({
      changes: { from: line.from + m.index, to: line.from + b.quote.length },
      userEvent: 'delete.format',
    });
    return true;
  }
  return deleteMarkupBackward(view);
};

// Tab and Shift-Tab nest a list item under the one above, or move it back out.
function shiftItems(view: EditorView, dir: 1 | -1) {
  const { state } = view;
  const lines = selectedLines(state);
  if (!lines.some((l) => isList(lineBlock(l.text)))) return false;
  const changes: ChangeSpec[] = [];
  for (const l of lines) {
    const b = lineBlock(l.text);
    if (!isList(b)) continue;
    const width = b.indent.length;
    let target = -1;
    for (let n = l.number - 1; n >= 1; n--) {
      const above = state.doc.line(n);
      if (!above.text.trim()) continue;
      const a = lineBlock(above.text);
      if (!isList(a)) {
        if (!/^[ \t]/.test(above.text)) break;
        continue;
      }
      const w = a.indent.length;
      if (dir === 1 && w === width) {
        const marker = /^(\d{1,9}[.)]|[-*+])[ \t]+/.exec(above.text.slice(a.quote.length + w))!;
        target = w + marker[0].length;
        break;
      }
      if (dir === 1 && w < width) break;
      if (dir === -1 && w < width) {
        target = w;
        break;
      }
    }
    if (dir === -1 && target < 0 && width) target = 0;
    if (target < 0) continue;
    const at = l.from + b.quote.length;
    changes.push({ from: at, to: at + width, insert: ' '.repeat(target) });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.indent' });
  return true;
}
const outdent: Command = (view) => shiftItems(view, -1);

export const noteKeymap: KeyBinding[] = [
  { key: 'Enter', run: enter },
  { key: 'Backspace', run: backspace },
  { key: 'Tab', run: (v) => shiftItems(v, 1) },
  { key: 'Shift-Tab', run: outdent },
  { key: 'Mod-b', run: (v) => (toggleMark(v, '**'), true) },
  { key: 'Mod-i', run: (v) => (toggleMark(v, '*'), true) },
  { key: 'Mod-Shift-x', run: (v) => (toggleMark(v, '~~'), true) },
  { key: 'Mod-e', run: (v) => (toggleMark(v, '`'), true) },
  { key: 'Mod-Alt-0', run: (v) => (setBlock(v, 'paragraph'), true) },
  { key: 'Mod-Alt-1', run: (v) => (setBlock(v, 'h1'), true) },
  { key: 'Mod-Alt-2', run: (v) => (setBlock(v, 'h2'), true) },
  { key: 'Mod-Alt-3', run: (v) => (setBlock(v, 'h3'), true) },
  { key: 'Mod-Shift-7', run: (v) => (setBlock(v, 'ordered'), true) },
  { key: 'Mod-Shift-8', run: (v) => (setBlock(v, 'bullet'), true) },
  { key: 'Mod-Shift-9', run: (v) => (setBlock(v, 'task'), true) },
];

// A line's text never starts inside its hidden markup: a click left of a bullet or a press
// of Home lands at the start of the text.
export const keepOutOfMarkup = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection && !tr.docChanged) return tr;
  const doc = tr.newDoc;
  let moved = false;
  const selection = tr.newSelection;
  const ranges = selection.ranges.map((r) => {
    if (!r.empty) return r;
    const line = doc.lineAt(r.head);
    const b = lineBlock(line.text);
    if (!b.prefix || r.head >= line.from + b.prefix) return r;
    if (b.kind === 'heading' && !line.text.slice(b.prefix).trim()) return r;
    if (!b.kind && !b.quote) return r;
    moved = true;
    return EditorSelection.cursor(line.from + b.prefix);
  });
  return moved
    ? [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }]
    : tr;
});

// The / menu: blocks to insert by name, typed at the start of a line or after a space.
type SlashItem = { label: string; hint: string; keys: string; run: (view: EditorView) => void };
export function slashMenu(extra: SlashItem[] = []) {
  const items: SlashItem[] = [
    {
      label: '正文',
      hint: '普通文字',
      keys: 'zw text p paragraph',
      run: (v) => setBlock(v, 'paragraph'),
    },
    {
      label: '标题 1',
      hint: '大标题',
      keys: 'bt1 h1 title heading',
      run: (v) => setBlock(v, 'h1'),
    },
    {
      label: '标题 2',
      hint: '中标题',
      keys: 'bt2 h2 title heading',
      run: (v) => setBlock(v, 'h2'),
    },
    {
      label: '标题 3',
      hint: '小标题',
      keys: 'bt3 h3 title heading',
      run: (v) => setBlock(v, 'h3'),
    },
    {
      label: '无序列表',
      hint: '• 项目',
      keys: 'wxlb lb list ul bullet',
      run: (v) => setBlock(v, 'bullet'),
    },
    {
      label: '有序列表',
      hint: '1. 项目',
      keys: 'yxlb lb list ol number',
      run: (v) => setBlock(v, 'ordered'),
    },
    {
      label: '待办',
      hint: '☐ 可勾选',
      keys: 'db todo task check',
      run: (v) => setBlock(v, 'task'),
    },
    { label: '引用', hint: '摘录原文', keys: 'yy quote', run: (v) => setBlock(v, 'quote') },
    { label: '代码块', hint: '等宽代码', keys: 'dmk dm code', run: insertCode },
    { label: '公式', hint: 'LaTeX', keys: 'gs math latex formula', run: insertMath },
    { label: '分割线', hint: '———', keys: 'fgx hr divider line', run: insertDivider },
    { label: '表格', hint: '两列表格', keys: 'bg table', run: insertTable },
    ...extra,
  ];
  return (cx: CompletionContext): CompletionResult | null => {
    const typed = cx.matchBefore(/\/[^\s/]*$/);
    if (!typed) return null;
    const before = cx.state.sliceDoc(typed.from - 1, typed.from);
    const line = cx.state.doc.lineAt(typed.from);
    if (typed.from > line.from && !/\s/.test(before)) return null;
    const q = typed.text.slice(1).toLowerCase();
    const options: Completion[] = items
      .filter((i) => !q || i.label.includes(q) || i.keys.split(' ').some((k) => k.startsWith(q)))
      .map((i) => ({
        label: i.label,
        detail: i.hint,
        apply: (view, _c, from, to) => {
          view.dispatch({ changes: { from, to }, userEvent: 'input.format' });
          i.run(view);
        },
      }));
    return options.length ? { from: typed.from, to: cx.pos, options, filter: false } : null;
  };
}

// What the toolbar shows as on for the cursor's line and text.
export type Formats = {
  block: BlockStyle;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
};
export function formatsAt(state: EditorState): Formats {
  const line = state.doc.lineAt(state.selection.main.head);
  const b = lineBlock(line.text);
  const block: BlockStyle =
    b.kind === 'heading'
      ? (`h${Math.min(3, b.level)}` as BlockStyle)
      : b.kind
        ? b.kind
        : b.quote
          ? 'quote'
          : 'paragraph';
  return { block, ...inlineMarksAt(state) };
}
