import { EditorSelection } from '@codemirror/state';
import type { ChangeSpec, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { lineBlock } from './format';

// Text with a size of its own, as in a word processor. Markdown has no way to say this, so
// it's written the way Markdown editors do: <span style="font-size:1.5em">…</span>, sized
// relative to the note's text size so A− / A+ still scales everything together.

export const textSizes = [
  { name: '小', em: 0.85 },
  { name: '标准', em: 1 },
  { name: '大', em: 1.25 },
  { name: '较大', em: 1.5 },
  { name: '特大', em: 2 },
] as const;

const openTag = /^<span\s+style\s*=\s*"\s*font-size\s*:\s*(\d+(?:\.\d+)?)(em|px)\s*;?\s*"\s*>$/i;
export type SizedSpan = {
  open: { from: number; to: number };
  close: { from: number; to: number };
  // The CSS size: relative ones follow the note's text size.
  css: string;
  em: number | null;
};
export const sizeTag = (em: number) => `<span style="font-size:${em}em">`;

// The sized spans of the lines from `from` to `to`, an opening tag paired with the next
// </span> after it on the same line.
export function sizedSpans(state: EditorState, from = 0, to = state.doc.length): SizedSpan[] {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);
  const spans: SizedSpan[] = [];
  let stack: { from: number; to: number; css: string; em: number | null }[] = [];
  let line = -1;
  tree.iterate({
    from: doc.lineAt(from).from,
    to: doc.lineAt(to).to,
    enter(ref) {
      if (ref.name !== 'HTMLTag') return;
      const n = doc.lineAt(ref.from).number;
      if (n !== line) {
        line = n;
        stack = [];
      }
      const text = doc.sliceString(ref.from, ref.to);
      const open = openTag.exec(text);
      if (open) {
        const value = Number(open[1]);
        const em = open[2].toLowerCase() === 'em' ? value : null;
        stack.push({
          from: ref.from,
          to: ref.to,
          em,
          css: em !== null ? `calc(var(--note-size, 13px) * ${value})` : `${value}px`,
        });
      } else if (/^<\/span\s*>$/i.test(text)) {
        const o = stack.pop();
        if (o)
          spans.push({
            open: { from: o.from, to: o.to },
            close: { from: ref.from, to: ref.to },
            css: o.css,
            em: o.em,
          });
      }
    },
  });
  return spans.sort((a, b) => a.open.from - b.open.from);
}

// The size at the cursor: the innermost sized span around it.
export function sizeAt(state: EditorState): number | null {
  const { from, to } = state.selection.main;
  let best: SizedSpan | null = null;
  for (const s of sizedSpans(state, from, to))
    if (s.open.to <= from && to <= s.close.from && (!best || s.open.from > best.open.from))
      best = s;
  return best ? (best.em ?? 1) : null;
}

// Gives the selected text a size; 1 (标准) takes the size off.
export function setTextSize(view: EditorView, em: number) {
  const { state } = view;
  const plain = em === 1;
  const changes: ChangeSpec[] = [];
  // `inside`: a cursor that goes between new empty tags, to write sized text.
  const selections: { anchor: number; head: number; inside?: number }[] = [];
  const add = (c: ChangeSpec) => changes.push(c);
  for (const r of state.selection.ranges) {
    if (r.empty) {
      const around = sizedSpans(state, r.from, r.to).filter(
        (s) => s.open.to <= r.from && r.from <= s.close.from,
      );
      const inner = around[around.length - 1];
      if (inner && plain && around.length === 1) {
        add({ from: inner.open.from, to: inner.open.to });
        add({ from: inner.close.from, to: inner.close.to });
      } else if (inner) add({ from: inner.open.from, to: inner.open.to, insert: sizeTag(em) });
      else if (!plain) {
        add({ from: r.from, insert: sizeTag(em) + '</span>' });
        selections.push({ anchor: r.from, head: r.from, inside: sizeTag(em).length });
        continue;
      }
      selections.push({ anchor: r.from, head: r.from });
      continue;
    }
    // Each line of the selection is sized on its own, leaving out its list or heading marks.
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const l = state.doc.line(n);
      let a = Math.max(r.from, l.from + lineBlock(l.text).prefix);
      let b = Math.min(r.to, l.to);
      while (a < b && /\s/.test(state.sliceDoc(a, a + 1))) a++;
      while (b > a && /\s/.test(state.sliceDoc(b - 1, b))) b--;
      if (a >= b) continue;
      const spans = sizedSpans(state, a, b);
      // The selection is one sized piece of text (with or without its hidden tags).
      const same = spans.find(
        (s) => (s.open.to === a && s.close.from === b) || (s.open.from === a && s.close.to === b),
      );
      const outer = spans.some((s) => s.open.to <= a && b <= s.close.from && s !== same);
      if (same) {
        if (plain && !outer) {
          add({ from: same.open.from, to: same.open.to });
          add({ from: same.close.from, to: same.close.to });
        } else add({ from: same.open.from, to: same.open.to, insert: sizeTag(em) });
      } else {
        // Sizes set before inside the selection give way to the new one.
        for (const s of spans)
          if (s.open.from >= a && s.close.to <= b) {
            add({ from: s.open.from, to: s.open.to });
            add({ from: s.close.from, to: s.close.to });
          }
        // 标准 inside bigger text still needs its own size to stand out from it.
        if (!plain || outer) {
          add({ from: a, insert: sizeTag(em) });
          add({ from: b, insert: '</span>' });
        }
      }
      selections.push({ anchor: a, head: b });
    }
  }
  if (!changes.length) return view.focus();
  const set = state.changes(changes);
  const ranges = selections.map((s) =>
    s.inside !== undefined
      ? EditorSelection.cursor(set.mapPos(s.anchor, -1) + s.inside)
      : EditorSelection.range(set.mapPos(s.anchor, 1), set.mapPos(s.head, -1)),
  );
  view.dispatch({
    changes: set,
    selection: ranges.length ? EditorSelection.create(ranges) : undefined,
    userEvent: 'input.format',
  });
  view.focus();
}

// One size bigger or smaller, from the shortcut.
export function stepTextSize(view: EditorView, dir: 1 | -1) {
  const now = sizeAt(view.state) ?? 1;
  const i = textSizes.findIndex((t) => t.em >= now - 0.001);
  const at = i < 0 ? textSizes.length - 1 : i;
  const next = textSizes[Math.max(0, Math.min(textSizes.length - 1, at + dir))];
  setTextSize(view, next.em);
  return true;
}
