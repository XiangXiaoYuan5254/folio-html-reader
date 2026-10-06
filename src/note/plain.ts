import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { Tree } from '@lezer/common';
import { noteMarkdown } from './syntax';
import { texOf } from './live';
import { sizedSpans } from './size';

// Copying from the note gives the text as it reads, without the Markdown that formats it:
// no ** or #, links as their words, lists with • and ☐, tables as tab-separated rows.
// Pasting that text back into a note brings the formatting back.

function plainRange(state: EditorState, tree: Tree, from: number, to: number): string {
  const doc = state.doc;
  const edits: { from: number; to: number; insert: string }[] = [];
  const edit = (a: number, b: number, insert = '') => {
    a = Math.max(a, from);
    b = Math.min(b, to);
    if (a < b || (a === b && insert)) edits.push({ from: a, to: b, insert });
  };
  const space = (pos: number) => /[ \t]/.test(doc.sliceString(pos, pos + 1));
  for (const span of sizedSpans(state, from, to)) {
    edit(span.open.from, span.open.to);
    edit(span.close.from, span.close.to);
  }
  tree.iterate({
    from,
    to,
    enter(ref) {
      const node = ref.node;
      const { from: a, to: b } = node;
      switch (ref.name) {
        case 'EmphasisMark':
        case 'StrikethroughMark':
          edit(a, b);
          return;
        case 'CodeMark':
          if (node.parent?.name === 'InlineCode') edit(a, b);
          return;
        case 'Escape':
          edit(a, a + 1);
          return;
        case 'Autolink':
          for (const m of node.getChildren('LinkMark')) edit(m.from, m.to);
          return false;
        case 'FencedCode': {
          const marks = node.getChildren('CodeMark');
          if (marks[0]) edit(a, Math.min(doc.lineAt(marks[0].from).to + 1, b));
          if (marks.length > 1) {
            const close = marks[marks.length - 1];
            edit(Math.max(a, doc.lineAt(close.from).from - 1), close.to);
          }
          return false;
        }
        case 'InlineMath':
        case 'BlockMath':
          edit(a, b, texOf(doc.sliceString(a, b)).trim());
          return false;
        case 'Image': {
          const marks = node.getChildren('LinkMark');
          const alt = marks.length > 1 ? doc.sliceString(marks[0].to, marks[1].from) : '';
          edit(a, b, `［${alt || '图片'}］`);
          return false;
        }
        case 'Link': {
          const marks = node.getChildren('LinkMark');
          if (marks.length < 2) return;
          edit(a, marks[0].to);
          edit(marks[1].from, b);
          return;
        }
        case 'HeaderMark': {
          const line = doc.lineAt(a);
          if (node.parent?.firstChild?.from === a) {
            let end = b;
            while (end < line.to && space(end)) end++;
            edit(a, end);
          } else {
            // A closing ## at the end of the heading, with the spaces before it.
            let start = a;
            while (start > line.from && space(start - 1)) start--;
            edit(start, b);
          }
          return;
        }
        case 'QuoteMark':
          edit(a, space(b) ? b + 1 : b);
          return;
        case 'ListMark': {
          const task = node.parent?.getChild('Task')?.getChild('TaskMarker');
          if (task) edit(a, task.to, /x/i.test(doc.sliceString(task.from, task.to)) ? '☑' : '☐');
          else if (/^[-*+]$/.test(doc.sliceString(a, b))) edit(a, b, '•');
          return;
        }
        case 'HorizontalRule':
          edit(a, b, '————————');
          return false;
        case 'Table': {
          // Within one cell, the cell's text is copied as it is.
          const one = doc.lineAt(from).number === doc.lineAt(to).number;
          if (one && !/(?<!\\)\|/.test(doc.sliceString(from, to))) return;
          const rows: string[] = [];
          const last = doc.lineAt(Math.min(b, to)).number;
          for (let n = doc.lineAt(Math.max(a, from)).number; n <= last; n++) {
            const l = doc.line(n);
            if (/^\s*\|?\s*:?-{2,}/.test(l.text)) continue;
            const bars = [...l.text.matchAll(/(?<!\\)\|/g)].map((m) => m.index);
            let edges = [-1, ...bars, l.text.length];
            if (bars.length && !l.text.slice(0, bars[0]).trim()) edges = edges.slice(1);
            if (bars.length && !l.text.slice(bars[bars.length - 1] + 1).trim())
              edges = edges.slice(0, -1);
            const cells: string[] = [];
            for (let i = 0; i + 1 < edges.length; i++) {
              const s = Math.max(l.from + edges[i] + 1, from);
              const e = Math.min(l.from + edges[i + 1], to);
              if (s <= e) cells.push(plainRange(state, tree, s, e).trim());
            }
            rows.push(cells.join('\t'));
          }
          edit(a, b, rows.join('\n'));
          return false;
        }
      }
    },
  });
  edits.sort((x, y) => x.from - y.from || x.to - y.to);
  let out = '';
  let at = from;
  for (const e of edits) {
    if (e.from < at) continue;
    out += doc.sliceString(at, e.from) + e.insert;
    at = e.to;
  }
  return out + doc.sliceString(at, to);
}

// The last copy, so pasting it into a note gives back its Markdown.
let copied: { plain: string; source: string } | null = null;

function toPlain(text: string, state: EditorState) {
  let ranges = state.selection.ranges.filter((r) => !r.empty).map((r) => [r.from, r.to]);
  // With nothing selected, a copy takes the cursor's whole line.
  if (!ranges.length)
    ranges = [...new Set(state.selection.ranges.map((r) => state.doc.lineAt(r.from).number))].map(
      (n) => [state.doc.line(n).from, state.doc.line(n).to],
    );
  let plain: string;
  if (ranges.map(([a, b]) => state.sliceDoc(a, b)).join(state.lineBreak) === text) {
    const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
    plain = ranges.map(([a, b]) => plainRange(state, tree, a, b)).join('\n');
  } else {
    const alone = EditorState.create({ doc: text, extensions: noteMarkdown() });
    const tree = ensureSyntaxTree(alone, text.length, 200) ?? syntaxTree(alone);
    plain = plainRange(alone, tree, 0, text.length);
  }
  copied = { plain, source: text };
  return plain;
}

export const plainClipboard: Extension = [
  EditorView.clipboardOutputFilter.of(toPlain),
  EditorView.clipboardInputFilter.of((text) =>
    copied && text.replace(/\r\n?/g, '\n') === copied.plain ? copied.source : text,
  ),
];
