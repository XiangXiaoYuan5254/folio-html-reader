import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
} from '@codemirror/state';
import type { Range } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { html } from '@codemirror/lang-html';
import { indentWithTab } from '@codemirror/commands';
import {
  ensureSyntaxTree,
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { openSearchPanel } from '@codemirror/search';
import { themeInfo, useTheme } from '../theme';

export type SourceEditorHandle = {
  find: () => void;
  // Shows the element whose start tag begins near `offset`; `select` also selects that tag.
  reveal: (offset: number, tag: string, select: boolean) => void;
  clearReveal: () => void;
  // The selected code, for AI edits that should focus on it.
  selection: () => string;
};

const phrases = EditorState.phrases.of({
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '全词匹配',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'on line': '行',
  'Go to line': '跳到行',
  go: '跳转',
});

// CodeMirror's default highlighting, with its colors taken from the interface theme.
const themedHighlight = HighlightStyle.define([
  { tag: t.meta, color: 'var(--syn-meta)' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.heading, textDecoration: 'underline', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.atom, t.bool, t.url, t.contentSeparator, t.labelName], color: 'var(--syn-atom)' },
  { tag: [t.literal, t.inserted], color: 'var(--syn-literal)' },
  { tag: [t.string, t.deleted], color: 'var(--syn-string)' },
  { tag: [t.regexp, t.escape, t.special(t.string)], color: 'var(--syn-escape)' },
  { tag: t.definition(t.variableName), color: 'var(--syn-def)' },
  { tag: t.local(t.variableName), color: 'var(--syn-local)' },
  { tag: [t.typeName, t.namespace], color: 'var(--syn-type)' },
  { tag: t.className, color: 'var(--syn-class)' },
  { tag: [t.special(t.variableName), t.macroName], color: 'var(--syn-macro)' },
  { tag: t.definition(t.propertyName), color: 'var(--syn-prop)' },
  { tag: t.attributeName, color: 'var(--syn-attr)' },
  { tag: t.comment, color: 'var(--syn-comment)' },
  { tag: t.invalid, color: 'var(--syn-invalid)' },
]);
const darkness = new Compartment();

type Target = { from: number; to: number; tagFrom: number; tagTo: number };
const setTarget = StateEffect.define<Target | null>();
const elementLine = Decoration.line({ class: 'cm-inspect-line' });
const startTag = Decoration.mark({ class: 'cm-inspect-tag' });
const targetField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setTarget)) {
        if (!e.value) return Decoration.none;
        const { from, to, tagFrom, tagTo } = e.value;
        const ranges: Range<Decoration>[] = [];
        for (let n = tr.state.doc.lineAt(from).number; n <= tr.state.doc.lineAt(to).number; n++)
          ranges.push(elementLine.range(tr.state.doc.line(n).from));
        ranges.push(startTag.range(tagFrom, tagTo));
        return Decoration.set(ranges, true);
      }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The preview may lag a keystroke behind the editor, so an offset that no longer
// starts `<tag` falls back to the nearest `<tag` in the current text.
function locate(state: EditorState, offset: number, tag: string): Target | null {
  const text = state.doc.toString();
  const opens = (at: number) =>
    text.slice(at, at + tag.length + 1).toLowerCase() === '<' + tag &&
    !/[\w-]/.test(text[at + tag.length + 1] || '');
  let at = opens(offset) ? offset : -1;
  if (at < 0) {
    const pattern = new RegExp(`<${tag.replace(/[^\w-]/g, '')}(?![\\w-])`, 'gi');
    let best = Infinity;
    for (const m of text.matchAll(pattern))
      if (Math.abs(m.index - offset) < Math.abs(best - offset)) best = m.index;
    if (best === Infinity) return null;
    at = best;
  }
  const tree = ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state);
  for (let node = tree.resolveInner(at + 1, 1); node.parent; node = node.parent) {
    if (node.name !== 'Element' || node.from !== at) continue;
    const open = node.firstChild;
    return {
      from: node.from,
      to: node.to,
      tagFrom: at,
      tagTo: open ? open.to : at + tag.length + 1,
    };
  }
  const close = text.indexOf('>', at);
  const end = close < 0 ? at + tag.length + 1 : close + 1;
  return { from: at, to: end, tagFrom: at, tagTo: end };
}

export default forwardRef<
  SourceEditorHandle,
  { value: string; onChange: (v: string) => void; onSave: () => void }
>(function SourceEditor({ value, onChange, onSave }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const { active } = useTheme();
  const activeTheme = useRef(active);
  activeTheme.current = active;
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useImperativeHandle(ref, () => ({
    selection() {
      const view = editor.current;
      if (!view) return '';
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    find() {
      const view = editor.current;
      if (view) openSearchPanel(view);
    },
    reveal(offset, tag, select) {
      const view = editor.current;
      if (!view) return;
      const target = locate(view.state, offset, tag);
      if (!target) return;
      // Only scroll when the tag is off screen, so small pointer moves don't jump around.
      const coords = view.coordsAtPos(target.tagFrom);
      const box = view.scrollDOM.getBoundingClientRect();
      const visible = !!coords && coords.top >= box.top && coords.bottom <= box.bottom;
      view.dispatch({
        effects: [
          setTarget.of(select ? null : target),
          ...(visible ? [] : [EditorView.scrollIntoView(target.tagFrom, { y: 'center' })]),
        ],
        ...(select ? { selection: EditorSelection.range(target.tagFrom, target.tagTo) } : {}),
      });
      if (select) view.focus();
    },
    clearReveal() {
      editor.current?.dispatch({ effects: setTarget.of(null) });
    },
  }));
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          html(),
          phrases,
          targetField,
          keymap.of([
            indentWithTab,
            {
              key: 'Mod-s',
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
          ]),
          EditorView.lineWrapping,
          syntaxHighlighting(themedHighlight),
          darkness.of(EditorView.darkTheme.of(themeInfo(activeTheme.current).dark)),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: '13px',
              color: 'var(--text)',
              backgroundColor: 'var(--code-bg)',
            },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: '"SFMono-Regular", Consolas, monospace',
            },
            '.cm-content': { padding: '18px 0', caretColor: 'var(--text)' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
            '.cm-gutters': {
              backgroundColor: 'var(--code-gutter-bg)',
              color: 'var(--code-gutter-text)',
              border: 'none',
            },
            // The selection is drawn beneath the text, so the active line must stay
            // translucent or it hides selections on the cursor's line.
            '.cm-activeLine': { backgroundColor: 'var(--code-active-line)' },
            '.cm-activeLineGutter': { backgroundColor: 'var(--code-active-gutter)' },
            '.cm-selectionBackground': { backgroundColor: 'var(--code-selection)' },
            '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
              backgroundColor: 'var(--code-selection-focus)',
            },
            '.cm-inspect-line': { backgroundColor: 'rgb(var(--code-mark-rgb) / 0.07)' },
            '.cm-inspect-tag': {
              backgroundColor: 'rgb(var(--code-mark-rgb) / 0.22)',
              borderRadius: '2px',
              outline: '1px solid rgb(var(--code-mark-rgb) / 0.55)',
            },
            '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
            '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
            '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
            '.cm-textfield': { borderColor: 'var(--line-strong)' },
            '.cm-tooltip': {
              backgroundColor: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--line)',
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    editor.current?.dispatch({
      effects: darkness.reconfigure(EditorView.darkTheme.of(themeInfo(active).dark)),
    });
  }, [active]);
  useEffect(() => {
    const v = editor.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  return <div className="source-editor" ref={host} aria-label="HTML 源码编辑器" />;
});
