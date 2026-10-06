import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  placeholder,
  tooltips,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import {
  ALargeSmall,
  Bold,
  ChevronDown,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Plus,
  Strikethrough,
  TextQuote,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { noteMarkdown } from '../note/syntax';
import { liveMarkdown, noteHost } from '../note/live';
import { plainClipboard } from '../note/plain';
import { setTextSize, sizeAt, stepTextSize, textSizes } from '../note/size';
import {
  formatsAt,
  insertCode,
  insertDivider,
  insertImages,
  insertMath,
  insertTable,
  keepOutOfMarkup,
  noteKeymap,
  setBlock,
  slashMenu,
  toggleMark,
} from '../note/format';
import type { BlockStyle, Formats } from '../note/format';
import { IconButton } from './IconButton';
import { PopupMenu, belowButton } from './PopupMenu';
import type { MenuAnchor, MenuItem } from './PopupMenu';
import { isImageFile, prepareImage } from '../ai/images';
import { shortcut } from '../platform';
import type { NoteImages } from './Inspector';
import '../note.css';

// The document note: one page that is read and written in the same place. It is kept as
// Markdown (what AI answers and whiteboards add to it, and what is exported), shown
// formatted, and formatted with the toolbar, shortcuts or the / menu.

// Where each document's note was left (scroll and cursor), for coming back to it.
const places = new Map<string, { top: number; anchor: number; head: number }>();
// Changes that came from outside the editor: an AI answer or a whiteboard saved to the note.
const outside = Annotation.define<boolean>();

// The group of each tool in the toolbar, in order (see `tools`).
const groups = [0, 0, 0, 1, 1, 1, 1, 2];

const blockNames: Record<BlockStyle, string> = {
  paragraph: '正文',
  h1: '标题 1',
  h2: '标题 2',
  h3: '标题 3',
  bullet: '列表',
  ordered: '编号',
  task: '待办',
  quote: '引用',
};

export default function NoteEditor(p: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (note: string) => void;
  // Shows the end of the note, where saved answers and whiteboards land.
  reveal: boolean;
  onRevealed: () => void;
  onBoard: (id: string) => void;
  onLink: (url: string) => void;
  onImage: (src: string) => void;
  images?: NoteImages;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
  // Text size in px; the editor measures its lines again when it changes.
  size: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(p);
  latest.current = p;
  // Notes this editor sent up that may still come back down as the value.
  const sent = useRef<string[]>([]);
  const editable = useRef(new Compartment());
  const [formats, setFormats] = useState<(Formats & { size: number | null }) | null>(null);
  const [menu, setMenu] = useState<{ at: MenuAnchor; items: MenuItem[]; label: string } | null>(
    null,
  );
  const picker = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  // Pasted, dropped or picked pictures are kept in the project and written in at the cursor.
  async function addImages(files: File[]) {
    const view = viewRef.current;
    const images = files.filter(isImageFile);
    const save = latest.current.images?.save;
    if (!view || !images.length || !save || busy.current) return;
    busy.current = true;
    latest.current.onBusy(true);
    view.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(false)) });
    try {
      const names: string[] = [];
      for (const file of images) names.push(await save(await prepareImage(file)));
      view.dispatch({
        effects: editable.current.reconfigure(EditorView.editable.of(!latest.current.disabled)),
      });
      insertImages(view, names);
    } catch (e) {
      latest.current.onError('图片没有存上：' + (e as Error).message);
    } finally {
      busy.current = false;
      latest.current.onBusy(false);
      view.dispatch({
        effects: editable.current.reconfigure(EditorView.editable.of(!latest.current.disabled)),
      });
    }
  }

  useEffect(() => {
    const saved = places.get(p.id);
    const length = p.value.length;
    const pictures = !!p.images;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: p.value,
        selection: saved
          ? EditorSelection.single(Math.min(saved.anchor, length), Math.min(saved.head, length))
          : undefined,
        extensions: [
          history(),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          noteMarkdown(),
          liveMarkdown(),
          plainClipboard,
          keepOutOfMarkup,
          noteHost.of({
            image: pictures ? (name) => latest.current.images?.url(name) || '' : undefined,
            openImage: (src) => latest.current.onImage(src),
            openLink: (url) => latest.current.onLink(url),
            openBoard: (id) => latest.current.onBoard(id),
          }),
          // The / menu floats over the window rather than inside the panel.
          tooltips({ parent: document.body }),
          autocompletion({
            override: [
              slashMenu(
                pictures
                  ? [
                      {
                        label: '图片',
                        hint: '从文件选择',
                        keys: 'tp image img picture',
                        run: () => picker.current?.click(),
                      },
                    ]
                  : [],
              ),
            ],
            icons: false,
            optionClass: () => 'note-slash-option',
            tooltipClass: () => 'note-slash',
          }),
          keymap.of([
            { key: 'Mod-Shift-.', run: (v) => stepTextSize(v, 1) },
            { key: 'Mod-Shift-,', run: (v) => stepTextSize(v, -1) },
            ...noteKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          placeholder(
            '写下你的想法…\n\n直接打字就行。选中文字可以用上面的按钮加粗、做成列表；在空行输入 / 可以插入标题、待办、公式、表格' +
              (pictures ? '，也可以粘贴或拖入图片。' : '。'),
          ),
          editable.current.of(EditorView.editable.of(!p.disabled)),
          EditorView.contentAttributes.of({
            'aria-label': '文档笔记',
            spellcheck: 'false',
            autocapitalize: 'off',
          }),
          // Writing near the bottom keeps the line being written up off the panel's edge,
          // and the note scrolls on past its end, so writing goes on mid-panel.
          EditorView.scrollMargins.of((view) => ({
            bottom: Math.round(view.scrollDOM.clientHeight * 0.5),
          })),
          EditorView.domEventHandlers({
            paste(e) {
              const files = [...(e.clipboardData?.files || [])];
              if (!pictures || !files.some(isImageFile)) return false;
              e.preventDefault();
              void addImages(files);
              return true;
            },
            dragover(e) {
              if (!pictures || !e.dataTransfer?.types.includes('Files')) return false;
              e.preventDefault();
              return true;
            },
            drop(e, view) {
              const files = [...(e.dataTransfer?.files || [])];
              if (!pictures || !files.some(isImageFile)) return false;
              e.preventDefault();
              const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (at != null) view.dispatch({ selection: { anchor: at } });
              void addImages(files);
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(outside))) {
              const text = u.state.doc.toString();
              sent.current.push(text);
              if (sent.current.length > 50) sent.current.shift();
              latest.current.onChange(text);
            }
            if (u.docChanged || u.selectionSet || u.focusChanged) {
              const next = u.view.hasFocus
                ? { ...formatsAt(u.state), size: sizeAt(u.state) }
                : null;
              setFormats((f) => (JSON.stringify(f) === JSON.stringify(next) ? f : next));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (saved) view.scrollDOM.scrollTop = saved.top;
    if (!p.value.trim() && !p.disabled) view.focus();
    return () => {
      const { anchor, head } = view.state.selection.main;
      places.set(p.id, { top: view.scrollDOM.scrollTop, anchor, head });
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // A note changed elsewhere (an AI answer or a whiteboard saved into it) comes in as an
  // edit, so the cursor and what's being written stay put. It goes in before the browser
  // can deliver another keystroke, which would otherwise be typed into the old text.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const mine = sent.current.lastIndexOf(p.value);
    if (mine >= 0) {
      sent.current.splice(0, mine + 1);
      return;
    }
    const doc = view.state.doc.toString();
    if (doc === p.value) return;
    let start = 0;
    while (start < doc.length && start < p.value.length && doc[start] === p.value[start]) start++;
    let end = 0;
    while (
      end < doc.length - start &&
      end < p.value.length - start &&
      doc[doc.length - 1 - end] === p.value[p.value.length - 1 - end]
    )
      end++;
    view.dispatch({
      changes: {
        from: start,
        to: doc.length - end,
        insert: p.value.slice(start, p.value.length - end),
      },
      annotations: [outside.of(true), Transaction.addToHistory.of(false)],
    });
  }, [p.value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!p.disabled)),
    });
  }, [p.disabled]);

  useEffect(() => viewRef.current?.requestMeasure(), [p.size]);

  useEffect(() => {
    const view = viewRef.current;
    if (!p.reveal || !view) return;
    view.requestMeasure({
      read: () => view.scrollDOM.clientHeight,
      write: (height) =>
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.doc.length, {
            y: 'end',
            yMargin: Math.round(height * 0.5),
          }),
        }),
    });
    p.onRevealed();
  }, [p.reveal]);

  // How many tools fit next to the style button, the ⌄ button and +.
  const bar = useRef<HTMLDivElement>(null);
  const styleButton = useRef<HTMLButtonElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState(groups.length);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || !styleButton.current || !plus.current) return;
    const measure = () => {
      const css = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      const button = plus.current!.offsetWidth;
      const gap = el.querySelector<HTMLElement>('.note-toolbar-gap:last-of-type')!;
      const g = gap.offsetWidth + parseFloat(getComputedStyle(gap).marginLeft) * 2;
      const width = (k: number) =>
        styleButton.current!.offsetWidth +
        k * button +
        new Set(groups.slice(0, k)).size * g +
        g +
        button +
        (k < groups.length ? button : 0);
      let k = groups.length;
      while (k > 0 && width(k) > room) k--;
      setFit(k);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [el, styleButton.current, plus.current]) observer.observe(node);
    return () => observer.disconnect();
  }, [p.size]);

  const run = (command: (view: EditorView) => void) => () => {
    const view = viewRef.current;
    if (view && !p.disabled) command(view);
  };
  const open = (label: string, items: MenuItem[]) => (e: React.MouseEvent<HTMLElement>) => {
    const at = belowButton(e.currentTarget);
    setMenu((m) => (m?.label === label ? null : { at, items, label }));
  };
  const block = formats?.block || 'paragraph';
  const sizeMenu = (): MenuItem[] =>
    textSizes.map((t) => ({
      label: (
        <span
          className={`note-size-option${(formats?.size ?? 1) === t.em ? ' current' : ''}`}
          style={{ fontSize: `${Math.round(12 * Math.min(t.em, 1.6))}px` }}
        >
          {t.name}
        </span>
      ),
      hint: `${Math.round(p.size * t.em)}`,
      onSelect: run((v) => setTextSize(v, t.em)),
    }));
  // The tools in order; a narrow panel keeps as many as fit and the rest go behind ⌄.
  // Tools of one group sit between dividers.
  const tools: {
    label: string;
    icon: LucideIcon;
    help?: string;
    on: boolean;
    group: number;
    act: (anchor: HTMLElement) => void;
  }[] = [
    {
      label: '加粗',
      icon: Bold,
      help: shortcut('mod', 'B'),
      on: !!formats?.bold,
      group: 0,
      act: run((v) => toggleMark(v, '**')),
    },
    {
      label: '斜体',
      icon: Italic,
      help: shortcut('mod', 'I'),
      on: !!formats?.italic,
      group: 0,
      act: run((v) => toggleMark(v, '*')),
    },
    {
      label: '删除线',
      icon: Strikethrough,
      help: shortcut('mod', 'shift', 'X'),
      on: !!formats?.strike,
      group: 0,
      act: run((v) => toggleMark(v, '~~')),
    },
    {
      label: '列表',
      icon: List,
      help: shortcut('mod', 'shift', '8'),
      on: block === 'bullet',
      group: 1,
      act: run((v) => setBlock(v, 'bullet')),
    },
    {
      label: '编号列表',
      icon: ListOrdered,
      help: shortcut('mod', 'shift', '7'),
      on: block === 'ordered',
      group: 1,
      act: run((v) => setBlock(v, 'ordered')),
    },
    {
      label: '待办',
      icon: ListTodo,
      help: shortcut('mod', 'shift', '9'),
      on: block === 'task',
      group: 1,
      act: run((v) => setBlock(v, 'task')),
    },
    {
      label: '引用',
      icon: TextQuote,
      on: block === 'quote',
      group: 1,
      act: run((v) => setBlock(v, 'quote')),
    },
    {
      label: '字号',
      icon: ALargeSmall,
      help: `选中文字后设置大小；${shortcut('mod', 'shift', '>')} 放大，${shortcut('mod', 'shift', '<')} 缩小`,
      on: !!formats?.size && formats.size !== 1,
      group: 2,
      act: (anchor) => setMenu({ at: belowButton(anchor), items: sizeMenu(), label: '字号' }),
    },
  ];
  const overflow = tools.slice(fit);
  return (
    <>
      <div
        className="note-toolbar"
        role="toolbar"
        aria-label="笔记格式"
        ref={bar}
        // Buttons leave the cursor in the note.
        onMouseDown={(e) => {
          if ((e.target as Element).closest('button')) e.preventDefault();
        }}
      >
        <button
          type="button"
          ref={styleButton}
          className="note-style-button"
          aria-label="段落样式"
          aria-haspopup="menu"
          disabled={p.disabled}
          onClick={open('段落样式', [
            ...(['paragraph', 'h1', 'h2', 'h3'] as const).map((style, i) => ({
              label: <span className={`note-style-option ${style}`}>{blockNames[style]}</span>,
              hint: shortcut('mod', 'alt', String(i)),
              onSelect: run((v) => setBlock(v, style)),
            })),
          ])}
        >
          <span>{/^h\d$/.test(block) ? blockNames[block] : '正文'}</span>
          <ChevronDown />
        </button>
        {tools.map((t, i) => (
          <Fragment key={t.label}>
            {!i || tools[i - 1].group !== t.group ? (
              <span className="note-toolbar-gap" data-overflow={i >= fit || undefined} />
            ) : null}
            <IconButton
              label={t.label}
              help={t.help}
              active={t.on}
              disabled={p.disabled}
              data-overflow={i >= fit || undefined}
              aria-haspopup={t.label === '字号' ? 'menu' : undefined}
              onClick={(e) => t.act(e.currentTarget)}
            >
              <t.icon />
            </IconButton>
          </Fragment>
        ))}
        {overflow.length ? (
          <IconButton
            ref={more}
            label="更多格式"
            help={`面板太窄，${overflow.map((t) => t.label).join('、')}收在这里`}
            active={overflow.some((t) => t.on)}
            disabled={p.disabled}
            aria-haspopup="menu"
            onClick={open(
              '更多格式',
              overflow.map((t) => ({
                label: (
                  <span className="overflow-tool" data-active={t.on || undefined}>
                    <t.icon size={16} />
                    {t.label}
                  </span>
                ),
                hint: t.label === '字号' ? '›' : t.help,
                onSelect: () => t.act(more.current!),
              })),
            )}
          >
            <ChevronDown />
          </IconButton>
        ) : null}
        <span className="note-toolbar-gap" />
        <IconButton
          ref={plus}
          label="插入"
          help="代码、公式、分割线、表格、图片；也可以在空行输入 /"
          disabled={p.disabled}
          aria-haspopup="menu"
          onClick={open('插入', [
            { label: '代码块', onSelect: run(insertCode) },
            { label: '公式', hint: 'LaTeX', onSelect: run(insertMath) },
            { label: '分割线', onSelect: run(insertDivider) },
            { label: '表格', onSelect: run(insertTable) },
            ...(p.images ? [{ label: '图片…', onSelect: () => picker.current?.click() }] : []),
          ])}
        >
          <Plus />
        </IconButton>
      </div>
      <div className="note-editor" ref={host} />
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = '';
          void addImages(files);
        }}
      />
      {menu ? (
        <PopupMenu
          at={menu.at}
          items={menu.items}
          label={menu.label}
          onClose={() => {
            setMenu(null);
            viewRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
