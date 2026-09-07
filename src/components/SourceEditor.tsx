import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { html } from '@codemirror/lang-html';
import { indentWithTab } from '@codemirror/commands';
export default function SourceEditor({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          html(),
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
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: '"SFMono-Regular", Consolas, monospace',
            },
            '.cm-content': { padding: '18px 0' },
            '.cm-gutters': { backgroundColor: '#f7f8fa', color: '#98a2ac', border: 'none' },
            '.cm-activeLine': { backgroundColor: '#eff7f5' },
            '.cm-activeLineGutter': { backgroundColor: '#e6efec' },
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
    const v = editor.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  return <div className="source-editor" ref={host} aria-label="HTML 源码编辑器" />;
}
