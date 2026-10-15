import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  FolderOpen,
  Highlighter,
  MessageSquare,
  Underline,
  X,
  AlertCircle,
  ChevronDown,
  Minimize,
  SlidersHorizontal,
  Languages,
  Lightbulb,
  MessageCircleQuestion,
  Palette,
  Presentation,
  Crown,
  ArrowUpToLine,
  ArrowLeftRight,
} from 'lucide-react';
import { invoke, subscribe, useWorkspace, isDesktop, documentUrl } from './api';
import { isMac, shortcut, trashName } from './platform';
import type {
  Anchor,
  BackupEntry,
  EraserMode,
  FrameEvent,
  NoteReveal,
  OpenDocument,
  OutlineItem,
  Tool,
  UpdateState,
  WorkspaceInfo,
} from './types';
import { FileTree } from './components/FileTree';
import type { FileAction } from './components/FileTree';
import { DocumentTabs } from './components/DocumentTabs';
import { Toolbar } from './components/Toolbar';
import { DocumentReader } from './components/DocumentReader';
import { ReadingResizer } from './components/ReadingResizer';
import { stickyNoteSize, textNoteWidth } from './reader/note-size';
import type { ReaderHandle } from './components/ReaderFrame';
import { Inspector, annotationLabels } from './components/Inspector';
import type { InspectorTab } from './components/Inspector';
import { Dialog } from './components/Dialog';
import type { DialogOptions } from './components/Dialog';
import { IconButton } from './components/IconButton';
import { restorablePaths, useDocuments } from './hooks/useDocuments';
import { useFocusMode } from './hooks/useFocusMode';
import { ReadingStatus } from './components/ReadingStatus';
import { ProjectPicker } from './components/ProjectPicker';
import { UpdateCard } from './components/UpdateCard';
import { HistoryPanel, backupLabel } from './components/HistoryPanel';
import type { RecentProject } from './components/ProjectPicker';
import { annotationColors, defaultColor, normalizeColor } from './colors';
import { zoomAfterWheel } from './zoom';
import { Assistant, useAssistantCard } from './ai/assistant';
import type { AiHost } from './ai/host';
import type { DocText } from './ai/types';
import { withHiddenReader } from './ai/hidden-reader';
import { AssistantPanel } from './components/AssistantPanel';
import type { AssistantMode } from './components/AssistantPanel';
import { AiSettings } from './components/AiSettings';
import { AiSelectionCard } from './components/AiSelectionCard';
import { Tutor, boardNote, withBoardNote } from './ai/board';
import type { BoardEntry, SavedBoard } from './ai/board';
import type { Where } from './ai/context';
import { fileName } from './ai/context';
import { errorText } from './ai/client';
import { BoardList, BoardShelf } from './components/BoardList';
import { prepareImage } from './ai/images';
import { RegionCapture } from './components/RegionCapture';
import { AiSourceEdit } from './components/AiSourceEdit';
import { SelectionToolbar } from './components/SelectionToolbar';
import { ThemePicker } from './components/ThemePicker';
import { MembershipDialog, MemberLock } from './components/MembershipDialog';
import { memberNow, renewLicense, useLicense } from './license';
import { setThemesUnlocked } from './theme';
import { Exit, objectKey, prefersReducedMotion } from './motion';
import type { ScreenBox, ToolbarSide } from './components/SelectionToolbar';
const SourceEditor = lazy(() => import('./components/SourceEditor'));
const Whiteboard = lazy(() => import('./components/Whiteboard'));
import type { SourceEditorHandle } from './components/SourceEditor';
const toolHints: Record<Tool, string> = {
  select: '选中文字开始批注',
  highlight: '拖选文字添加高亮 · 点击高亮添加笔记 · 悬停查看',
  underline: '拖选文字添加下划线',
  text: '点击页面直接输入文字 · 拖动标题移动 · 点击文字继续编辑',
  sticky: '点击页面贴便签 · 拖动标题移动 · 右下角调整大小',
  pen: '拖动画线 · 按住 E 临时擦除 · Esc 返回选择',
  laser: '拖动临时指示 · 松开约 3 秒后消失 · 不保存',
  arrow: '拖动绘制箭头 · Esc 返回选择',
  rectangle: '拖动绘制矩形 · Esc 返回选择',
  eraser: '拖动擦除局部笔迹 · 一次拖动可一次撤销',
};
function firstDocument(tree: WorkspaceInfo['tree']): string | undefined {
  for (const n of tree) {
    if (n.kind === 'html' || n.kind === 'pdf') return n.path;
    const found = firstDocument(n.children || []);
    if (found) return found;
  }
}
function readableFiles(tree: WorkspaceInfo['tree']): string[] {
  return tree.flatMap((n) =>
    n.kind === 'html' || n.kind === 'pdf' ? [n.path] : readableFiles(n.children || []),
  );
}
// A translation (全文翻译) or 精读笔记 page made from `of`: named after it, next to it, or
// naming it itself (`pairOf`).
function companionOf(page: OpenDocument, of: OpenDocument, pairOf?: string) {
  if (pairOf === of.path) return true;
  const dir = of.path.slice(0, of.path.lastIndexOf('/') + 1);
  const stem = of.path.slice(dir.length).replace(/\.[^.]+$/, '');
  const name = page.path.slice(dir.length);
  return (
    page.path.startsWith(dir) &&
    name.startsWith(`${stem}-`) &&
    /^(精读笔记|译文)(（\d+）)?\.html$/.test(name.slice(stem.length + 1))
  );
}
// What the reader's ai-text reply looks like for HTML and PDF.
function docText(path: string, raw: { title?: string; text?: string; pages?: string[] }): DocText {
  const kind = /\.pdf$/i.test(path) ? 'pdf' : 'html';
  return {
    path,
    kind,
    title: raw.title || path.split('/').at(-1) || path,
    text: raw.pages ? raw.pages.join('\n\n') : raw.text || '',
    pages: raw.pages,
  };
}
type PaneSide = 'left' | 'right';
type ReaderState = {
  selected: string | null;
  selection: Anchor | null;
  // Where the selected text is on screen, for placing the selection toolbar.
  selectionBox: ScreenBox | null;
  rebind: string | null;
  outline: OutlineItem[];
  orphans: string[];
  // Annotation ids in reading order, as the document last reported them.
  order: string[];
  progress: number;
  // For a translation (全文翻译), the path of the document it was made from.
  pairOf?: string;
};
const emptyReaderState: ReaderState = {
  selected: null,
  selection: null,
  selectionBox: null,
  rebind: null,
  outline: [],
  orphans: [],
  order: [],
  progress: 0,
};
// How long an update card put off with “稍后” stays hidden.
const updateRemindAfter = 24 * 60 * 60 * 1000;
export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    error: boolean;
    // A button in the notice, such as “撤销”.
    action?: { label: string; run: () => void };
  } | null>(null);
  const notify = useCallback(
    (text: string, error = false, action?: { label: string; run: () => void }) =>
      setNotice({ text, error, action }),
    [],
  );
  const onError = useCallback((s: string) => notify(s, true), [notify]);
  const model = useDocuments(onError);
  const doc = model.docs.find((d) => d.id === model.active);
  const focus = useFocusMode(onError);
  const [split, setSplit] = useState<{ left: string; right: string | null } | null>(null);
  const [linkedScroll, setLinkedScroll] = useState(() => {
    try {
      return localStorage.getItem('folio.linked-scroll') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('folio.linked-scroll', String(linkedScroll));
    } catch {}
  }, [linkedScroll]);
  // Whether the toolbar for selected text goes below the selection or above it.
  const [toolbarSide, setToolbarSide] = useState<ToolbarSide>(() => {
    try {
      return localStorage.getItem('folio.selection-toolbar') === 'above' ? 'above' : 'below';
    } catch {
      return 'below';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('folio.selection-toolbar', toolbarSide);
    } catch {}
  }, [toolbarSide]);
  const focusedSide = useRef<PaneSide>('left');
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('folio.reading-split-ratio'));
      return saved >= 0.2 && saved <= 0.8 ? saved : 0.5;
    } catch {
      return 0.5;
    }
  });
  // How much of the width the source takes, beside its live preview.
  const [sourceRatio, setSourceRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('folio.source-split-ratio'));
      return saved >= 0.2 && saved <= 0.8 ? saved : 0.5;
    } catch {
      return 0.5;
    }
  });
  const [htmlMode, setMode] = useState<'read' | 'source'>('read');
  const mode = focus.enabled || doc?.kind === 'pdf' ? 'read' : htmlMode;
  const [tool, setTool] = useState<Tool>('select');
  const recentTools = useRef<{ current: Tool; previous: Tool | null }>({
    current: 'select',
    previous: null,
  });
  const [readingDrag, setReadingDrag] = useState<string | null>(null);
  const [readingDropSide, setReadingDropSide] = useState<PaneSide | null>(null);
  // A column header pressed, and once it moves, the column it's over.
  const [paneDrag, setPaneDrag] = useState<{ side: PaneSide; over: PaneSide | null } | null>(null);
  function activateTool(next: Tool) {
    const history = recentTools.current;
    if (next !== history.current) {
      recentTools.current = { current: next, previous: history.current };
      setTool(next);
    }
  }
  function switchRecentTool() {
    const previous = recentTools.current.previous;
    if (previous) activateTool(previous);
    setInkSettingsOpen(false);
  }
  const [color, setColor] = useState(() => {
    try {
      return normalizeColor(localStorage.getItem('folio.ink-color')) || defaultColor;
    } catch {
      return defaultColor;
    }
  });
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(() => {
    try {
      return localStorage.getItem('folio.right-panel') !== 'closed';
    } catch {
      return true;
    }
  });
  const [strokeWidth, setStrokeWidth] = useState(2.5);
  const [eraserSize, setEraserSize] = useState(24);
  const [eraserMode, setEraserMode] = useState<EraserMode>(() => {
    try {
      return localStorage.getItem('folio.eraser-mode') === 'stroke' ? 'stroke' : 'partial';
    } catch {
      return 'partial';
    }
  });
  const [inkSettingsOpen, setInkSettingsOpen] = useState(false);
  const [stickySize, setStickySize] = useState(() => {
    try {
      return stickyNoteSize(JSON.parse(localStorage.getItem('folio.sticky-size') || 'null'));
    } catch {
      return stickyNoteSize(null);
    }
  });
  // HTML source edits are written as you type unless auto-save is turned off.
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem('folio.autosave') !== 'off';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('folio.autosave', autosave ? 'on' : 'off');
    } catch {}
  }, [autosave]);
  const [textWidth, setTextWidth] = useState(() => {
    try {
      return textNoteWidth(JSON.parse(localStorage.getItem('folio.text-width') || 'null'));
    } catch {
      return textNoteWidth(null);
    }
  });
  // Text size of highlight notes, set from the note editor in the page.
  const [noteFontSize, setNoteFontSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('folio.note-font-size'));
      return saved >= 12 && saved <= 26 ? saved : 15;
    } catch {
      return 15;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('folio.note-font-size', String(noteFontSize));
    } catch {}
  }, [noteFontSize]);
  const [tab, setTab] = useState<InspectorTab>('annotations');
  // Asks the note tab to show a section of the note: a saved answer, a board.
  const [noteReveal, setNoteReveal] = useState<NoteReveal | null>(null);
  const [readerStates, setReaderStates] = useState<Record<string, ReaderState>>({});
  const { selected, outline, orphans, order, selection, selectionBox, rebind, progress } =
    readerStates[doc?.id || ''] || emptyReaderState;
  function patchReader(id: string, patch: Partial<ReaderState>) {
    setReaderStates((states) => ({
      ...states,
      [id]: { ...(states[id] || emptyReaderState), ...patch },
    }));
  }
  const setSelected = (selected: string | null) => doc && patchReader(doc.id, { selected });
  const setSelection = (selection: Anchor | null) => doc && patchReader(doc.id, { selection });
  const setRebind = (rebind: string | null) => doc && patchReader(doc.id, { rebind });
  const [dialog, setDialog] = useState<DialogOptions | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  // The page the AI settings open on, when not the services.
  const [aiSettingsPage, setAiSettingsPage] = useState<'' | 'voices'>('');
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  // The membership dialog, with what was asked for when a member feature opened it.
  const [membership, setMembership] = useState<{ reason: string } | null>(null);
  const license = useLicense();
  useEffect(() => {
    const open = (e: Event) => setMembership({ reason: (e as CustomEvent<string>).detail || '' });
    window.addEventListener('folio-membership', open);
    return () => window.removeEventListener('folio-membership', open);
  }, []);
  useEffect(() => {
    if (license) setThemesUnlocked(license.member);
  }, [license?.member]);
  // Opening the dialog is a good moment to hear about a refund or a move from the server.
  useEffect(() => {
    if (membership && license && license.state !== 'none') void renewLicense().catch(() => {});
  }, [membership]);
  const [assistantMode, setAssistantMode] = useState<AssistantMode>(() => {
    try {
      return localStorage.getItem('folio.assistant-mode') === 'project' ? 'project' : 'doc';
    } catch {
      return 'doc';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('folio.assistant-mode', assistantMode);
    } catch {}
  }, [assistantMode]);
  // Source mode: the AI edit panel, and the edited version the preview shows while reviewing.
  const [aiSourceOpen, setAiSourceOpen] = useState(false);
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  useEffect(() => setAiSourceOpen(false), [mode, doc?.id]);
  // The AI features reach the app through this host; it is refreshed on every render.
  const hostImpl = useRef<AiHost>(null!);
  const [assistant] = useState(
    () =>
      new Assistant(
        new Proxy({} as AiHost, {
          get:
            (_, key) =>
            (...args: unknown[]) =>
              (hostImpl.current as any)[key](...args),
        }),
      ),
  );
  const aiCard = useAssistantCard(assistant);
  // The whiteboard teacher explaining a selection.
  const [lesson, setLesson] = useState<{ tutor: Tutor; selection: string } | null>(null);
  // The board put away for a while, to read on while the teacher thinks; the way back to it
  // is in the title bar.
  const [boardAway, setBoardAway] = useState(false);
  const [titleEnd, setTitleEnd] = useState<HTMLDivElement | null>(null);
  // Framing a formula or figure on the page for the whiteboard.
  const [boardCapture, setBoardCapture] = useState(false);
  const [boardList, setBoardList] = useState(false);
  // Bumped whenever a board is saved, for the list in the sidebar.
  const [boardsVersion, setBoardsVersion] = useState(0);
  // The sidebar asking the open board to keep itself in the note.
  const [noteAsk, setNoteAsk] = useState<{ id: string; n: number } | null>(null);
  // For saving the open board before the project changes or the window closes.
  const lessonRef = useRef(lesson);
  lessonRef.current = lesson;
  async function closeLesson() {
    const open = lessonRef.current;
    if (!open) return;
    await open.tutor.saveNow().catch(() => {});
    open.tutor.dispose(false);
    setLesson(null);
  }
  const [appVersion, setAppVersion] = useState('');
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  // “稍后” hides the card; the title bar keeps a button to bring it back, and the card comes back
  // by itself a day later if 页间 is still open.
  const [updateHidden, setUpdateHidden] = useState(false);
  const updateVersion = update.status === 'idle' ? '' : update.version;
  useEffect(() => setUpdateHidden(false), [update.status, updateVersion]);
  useEffect(() => {
    if (!updateHidden) return;
    // Checked against the clock, since timers don't run while the computer sleeps.
    const due = Date.now() + updateRemindAfter;
    const timer = setInterval(() => {
      if (Date.now() >= due) setUpdateHidden(false);
    }, 60 * 1000);
    return () => clearInterval(timer);
  }, [updateHidden]);
  useEffect(() => {
    if (isDesktop)
      invoke<{ version: string; update: UpdateState }>('update-state')
        .then((r) => {
          setAppVersion(r.version);
          setUpdate(r.update);
        })
        .catch(() => {});
  }, []);
  const [projectPicker, setProjectPicker] = useState<RecentProject[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [findMissing, setFindMissing] = useState(false);
  const readers = useRef(new Map<string, ReaderHandle>());
  const sourceEditor = useRef<SourceEditorHandle>(null);
  // Source mode: pointing at the preview locates the element's code.
  const [inspecting, setInspecting] = useState(false);
  useEffect(() => setInspecting(false), [mode, doc?.id]);
  // Each opening gets its own panel, so reopening while the last one is still leaving
  // lists the backups afresh instead of reusing the closing one.
  const [historyOpen, setHistoryOpen] = useState<object | null>(null);
  useEffect(() => setHistoryOpen(null), [mode, doc?.id]);
  useEffect(() => {
    if (!inspecting) sourceEditor.current?.clearReveal();
  }, [inspecting]);
  const findInput = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  const sessionReady = useRef(false);
  const current = useRef({ model, doc, tool, mode });
  current.current = { model, doc, tool, mode };
  function sendToActive(type: string, payload?: Record<string, unknown>) {
    readers.current.get(current.current.doc?.id || '')?.send(type, payload);
  }
  useEffect(() => {
    try {
      localStorage.setItem('folio.reading-split-ratio', String(splitRatio));
    } catch {}
  }, [splitRatio]);
  useEffect(() => {
    try {
      localStorage.setItem('folio.source-split-ratio', String(sourceRatio));
    } catch {}
  }, [sourceRatio]);
  useEffect(() => {
    try {
      localStorage.setItem('folio.ink-color', color);
    } catch {}
  }, [color]);
  useEffect(() => {
    try {
      localStorage.setItem('folio.eraser-mode', eraserMode);
    } catch {}
  }, [eraserMode]);
  useEffect(() => {
    try {
      localStorage.setItem('folio.right-panel', right ? 'open' : 'closed');
    } catch {}
  }, [right]);
  useEffect(() => {
    try {
      localStorage.setItem('folio.sticky-size', JSON.stringify(stickySize));
    } catch {}
  }, [stickySize]);
  useEffect(() => {
    try {
      localStorage.setItem('folio.text-width', JSON.stringify(textWidth));
    } catch {}
  }, [textWidth]);
  function run(action: () => Promise<unknown>) {
    void action().catch((e) => notify((e as Error).message, true));
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    run(async () => {
      const w = await invoke<WorkspaceInfo>('workspace');
      useWorkspace(w);
      const paths = w.session
        ? restorablePaths(w.session)
        : ([firstDocument(w.tree)].filter(Boolean) as string[]);
      for (const p of paths) {
        try {
          await model.open(p);
        } catch (e) {
          notify((e as Error).message, true);
        }
      }
      const activeDoc = model.docsRef.current.find((d) => d.path === w.session?.active);
      if (activeDoc) model.setActive(activeDoc.id);
      restoreSplit(w);
      sessionReady.current = true;
      setWorkspace(w);
      await openRequestedFiles(w.root);
    });
  }, []);
  const sessionSignature = model.docs.map((d) => d.path).join('\0');
  const splitLeftPath = model.docs.find((d) => d.id === split?.left)?.path;
  const splitRightPath = model.docs.find((d) => d.id === split?.right)?.path;
  useEffect(() => {
    if (workspace && sessionReady.current)
      model.session(
        model.docs.map((d) => d.path),
        doc?.path || '',
        splitLeftPath && splitRightPath
          ? { left: splitLeftPath, right: splitRightPath }
          : undefined,
      );
  }, [sessionSignature, model.active, workspace?.token, splitLeftPath, splitRightPath]);
  useEffect(() => {
    if (!notice || notice.error) return;
    // Leave time to reach a notice's button.
    const timer = setTimeout(() => setNotice(null), notice.action ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const previousActive = useRef('');
  useEffect(() => {
    const previous = previousActive.current;
    if (previous && previous !== doc?.id) {
      readers.current.get(previous)?.send('clear-selection');
      patchReader(previous, { selection: null, rebind: null });
    }
    previousActive.current = doc?.id || '';
    setFindMissing(false);
  }, [doc?.id]);
  useEffect(() => {
    if (
      split &&
      (!model.docs.some((d) => d.id === split.left) ||
        (split.right && !model.docs.some((d) => d.id === split.right)))
    )
      setSplit(null);
  }, [sessionSignature, split]);
  useEffect(() => {
    if (finding) findInput.current?.focus();
  }, [finding]);
  const liveActions = useRef({
    save: () => {},
    folder: () => {},
    find: () => {},
    close: () => {},
    refresh: () => {},
    focus: () => {},
    exitFocus: () => {},
    openFiles: () => {},
    checkUpdates: () => {},
  });
  liveActions.current.focus = () => {
    if (!doc) return;
    setFinding(false);
    setInkSettingsOpen(false);
    focus.setEnabled((value) => !value);
  };
  liveActions.current.exitFocus = () => focus.setEnabled(false);
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'paste') {
          const target = document.activeElement;
          if (
            target?.closest('.file-sidebar') &&
            !target.closest('input,textarea,[contenteditable]')
          ) {
            window.dispatchEvent(new Event('folio-paste-files'));
          } else void invoke('paste-text');
        }
        if (e.type === 'save') liveActions.current.save();
        if (e.type === 'open-folder') liveActions.current.folder();
        if (e.type === 'find') liveActions.current.find();
        if (e.type === 'close-request') liveActions.current.close();
        if (e.type === 'files-changed') liveActions.current.refresh();
        if (e.type === 'ai-settings') setAiSettingsOpen(true);
        if (e.type === 'theme-picker') setThemePickerOpen(true);
        if (e.type === 'membership') setMembership({ reason: '' });
        if (e.type === 'open-file' && sessionReady.current) liveActions.current.openFiles();
        if (e.type === 'toggle-focus') liveActions.current.focus();
        if (e.type === 'update') setUpdate(e.update);
        if (e.type === 'check-updates') liveActions.current.checkUpdates();
      }),
    [],
  );
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      const target = e.target instanceof Element ? e.target : null;
      const input = target?.closest('input,textarea,select,[contenteditable],.cm-editor');
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'v' &&
        !input &&
        target?.closest('.file-sidebar')
      ) {
        e.preventDefault();
        window.dispatchEvent(new Event('folio-paste-files'));
        return;
      }
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !input &&
        !document.querySelector('[role="dialog"]') &&
        !target?.closest('.file-sidebar,.inspector,.find-bar,.reading-column-header') &&
        current.current.mode === 'read' &&
        current.current.doc
      ) {
        e.preventDefault();
        if (!e.repeat) switchRecentTool();
      }
      if (
        !input &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.repeat &&
        e.key.toLowerCase() === 'e' &&
        current.current.tool === 'pen' &&
        current.current.mode === 'read'
      ) {
        e.preventDefault();
        sendToActive('temporary-eraser', { active: true });
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        liveActions.current.save();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        liveActions.current.folder();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !input) {
        e.preventDefault();
        // On macOS the menu shortcut toggles focus mode. On Windows the menu only sees
        // keys the page leaves unhandled, and this one is handled here.
        if (e.shiftKey) {
          if (!isDesktop || !isMac) liveActions.current.focus();
        } else liveActions.current.find();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !input) {
        e.preventDefault();
        const { model, doc } = current.current;
        if (doc) model.undo(doc.id, e.shiftKey);
      }
      // Windows also redoes with Ctrl+Y.
      if (!isMac && e.ctrlKey && e.key.toLowerCase() === 'y' && !input) {
        e.preventDefault();
        const { model, doc } = current.current;
        if (doc) model.undo(doc.id, true);
      }
      if (e.key === 'Escape') {
        if (e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
        liveActions.current.exitFocus();
        window.getSelection()?.removeAllRanges();
        activateTool('select');
        setReadingDrag(null);
        setReadingDropSide(null);
        setFinding(false);
        setInspecting(false);
        sendToActive('clear-selection');
        patchReader(current.current.doc?.id || '', { selection: null, selected: null });
      }
    }
    const keyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'e') sendToActive('temporary-eraser', { active: false });
    };
    const blur = () => {
      if (document.activeElement?.tagName !== 'IFRAME')
        sendToActive('temporary-eraser', { active: false });
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, []);
  // Saves everything still waiting before closing documents, the project or the app. Whatever
  // could not be saved is confirmed rather than blocking: when the project folder was deleted
  // or moved, nothing can be saved, and the reader must still be able to leave.
  function guardDirty(
    docs: OpenDocument[],
    action: () => Promise<unknown>,
    title = '放弃未保存的源码修改？',
  ) {
    run(async () => {
      // With auto-save, in-flight saves finish first; only edits that could not be saved need confirming.
      if (autosave) await model.saveAll(docs.map((d) => d.id));
      await assistant.flush();
      await lessonRef.current?.tutor.saveNow().catch(() => {});
      const unsaved = await model.flush().then(
        () => '',
        (e) => errorText(e),
      );
      const ids = new Set(docs.map((d) => d.id));
      const dirty = model.docsRef.current.filter((d) => ids.has(d.id) && d.draft !== d.source);
      if (!dirty.length && !unsaved) return action();
      const edits = dirty.length
        ? `${dirty.map((d) => d.path.split('/').at(-1)).join('、')} ${autosave ? '未能保存' : '尚未保存'}。`
        : '';
      setDialog({
        title: unsaved ? '有修改未能保存' : title,
        message: unsaved
          ? `批注和笔记未能保存：${unsaved}。${edits}继续会放弃这些修改。`
          : `${edits}继续会放弃源码修改；批注和笔记已单独保存。`,
        danger: true,
        confirmLabel: '放弃修改并继续',
        onConfirm: action,
      });
    });
  }
  async function refresh() {
    assistant.forgetText();
    setWorkspace(await invoke<WorkspaceInfo>('tree'));
  }
  function restoreSplit(w: WorkspaceInfo) {
    const saved = w.session?.split;
    const left = model.docsRef.current.find((d) => d.path === saved?.left);
    const right = model.docsRef.current.find((d) => d.path === saved?.right);
    setSplit(left && right && left.id !== right.id ? { left: left.id, right: right.id } : null);
    focusedSide.current = saved?.right === w.session?.active ? 'right' : 'left';
  }
  function selectDocument(id: string, side?: PaneSide) {
    if (split) {
      const visibleSide = split.left === id ? 'left' : split.right === id ? 'right' : null;
      if (visibleSide) focusedSide.current = visibleSide;
      else {
        const target = side || focusedSide.current;
        focusedSide.current = target;
        setSplit((s) => (s ? { ...s, [target]: id } : s));
      }
    }
    model.setActive(id);
  }
  async function openDocument(path: string, side?: PaneSide) {
    const id = await model.open(path, false, split ? [split.left, split.right] : []);
    selectDocument(id, side);
  }
  function closeDocument(id: string) {
    model.close(id);
    if (split && (split.left === id || split.right === id)) {
      const other = split.left === id ? split.right : split.left;
      setSplit(null);
      if (other && model.docsRef.current.some((d) => d.id === other)) model.setActive(other);
    }
  }
  function requestCloseDocument(id: string) {
    const closing = model.docsRef.current.find((d) => d.id === id);
    if (closing) guardDirty([closing], async () => closeDocument(id));
  }
  async function dropIntoReading(path: string, side: PaneSide) {
    if (!doc || !readableFiles(workspace?.tree || []).includes(path)) return;
    const id = await model.open(path, false, split ? [split.left, split.right] : []);
    setMode('read');
    if (id === doc.id && !split) return;
    const existingSide = split?.left === id ? 'left' : split?.right === id ? 'right' : null;
    focusedSide.current = existingSide || side;
    setSplit((current) => {
      if (current) return existingSide ? current : { ...current, [side]: id };
      return side === 'left' ? { left: id, right: doc.id } : { left: doc.id, right: id };
    });
    model.setActive(id);
  }
  // The two columns slide past each other into their new places, the current one on top.
  function swapSides() {
    if (!split?.right) return;
    const columns = [...document.querySelectorAll<HTMLElement>('.reading-column')];
    const before = columns.map((el) => el.getBoundingClientRect().left);
    focusedSide.current = focusedSide.current === 'left' ? 'right' : 'left';
    flushSync(() => setSplit((s) => (s?.right ? { left: s.right, right: s.left } : s)));
    if (prefersReducedMotion()) return;
    const timing = { duration: 380, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
    const shadow = getComputedStyle(document.documentElement).getPropertyValue('--shadow-rgb');
    columns.forEach((el, i) => {
      el.getAnimations().forEach((a) => a.cancel());
      const from = `translateX(${before[i] - el.getBoundingClientRect().left}px)`;
      const lifted = el.classList.contains('active-column');
      el.animate(
        lifted
          ? [
              { transform: from, zIndex: 2 },
              { boxShadow: `0 14px 36px rgb(${shadow} / 0.22)`, offset: 0.45 },
              { transform: 'none', zIndex: 2 },
            ]
          : [{ transform: from }, { opacity: 0.75, offset: 0.45 }, { transform: 'none' }],
        timing,
      );
    });
    document
      .querySelector('.pane-swap svg')
      ?.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(180deg)' }], timing);
    // The divider would cut across the columns as they pass; only the swap button stays.
    document
      .querySelector('.split-reading > .reading-resizer')
      ?.animate(
        [{ opacity: 1 }, { opacity: 0, offset: 0.15 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }],
        timing,
      );
  }
  // Dragging a column header to the other side swaps the two documents. While a header is
  // pressed the iframes ignore the pointer (see .pane-pressing), so its moves reach this window.
  function dragPaneHeader(e: ReactPointerEvent<HTMLElement>, side: PaneSide) {
    if (e.button !== 0 || !split?.right) return;
    const workbench = e.currentTarget.closest('.document-workbench')!;
    const { pointerId, clientX: x, clientY: y } = e;
    let over: PaneSide | null = null;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!(ev.buttons & 1)) return end(false);
      if (!over && Math.hypot(ev.clientX - x, ev.clientY - y) < 6) return;
      const bounds = workbench.getBoundingClientRect();
      over = ev.clientX < bounds.left + bounds.width * splitRatio ? 'left' : 'right';
      setPaneDrag({ side, over });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) end(!!over && over !== side);
    };
    const cancel = () => end(false);
    const escape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') end(false);
    };
    function end(swap: boolean) {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', cancel);
      removeEventListener('blur', cancel);
      removeEventListener('keydown', escape, true);
      setPaneDrag(null);
      if (swap) swapSides();
    }
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', cancel);
    addEventListener('blur', cancel);
    addEventListener('keydown', escape, true);
    setPaneDrag({ side, over: null });
  }
  function toggleSplit() {
    setMode('read');
    if (split) {
      setSplit(null);
      return;
    }
    if (!doc) return;
    const other = model.docs.find((d) => d.id !== doc.id);
    focusedSide.current = 'left';
    setSplit({ left: doc.id, right: other?.id || null });
  }
  async function loadWorkspace(w: WorkspaceInfo) {
    sessionReady.current = false;
    await closeLesson();
    await assistant.flush();
    model.clear();
    assistant.reset();
    setSplit(null);
    setReaderStates({});
    useWorkspace(w);
    setMode('read');
    const paths = w.session
      ? restorablePaths(w.session)
      : ([firstDocument(w.tree)].filter(Boolean) as string[]);
    for (const p of paths) {
      try {
        await model.open(p);
      } catch (e) {
        notify((e as Error).message, true);
      }
    }
    const activeDoc = model.docsRef.current.find((d) => d.path === w.session?.active);
    if (activeDoc) model.setActive(activeDoc.id);
    restoreSplit(w);
    sessionReady.current = true;
    setWorkspace(w);
  }
  function chooseNewProject() {
    setProjectPicker(null);
    guardDirty(model.docs, async () => {
      const w = await invoke<WorkspaceInfo | null>('choose-folder');
      if (w) await loadWorkspace(w);
    });
  }
  // Files opened from Finder or Explorer. They open as the focused single document; files in
  // another project switch to that project first.
  async function openRequestedFiles(currentRoot: string | undefined) {
    const targets =
      await invoke<{ root?: string; relative?: string; error?: string }[]>('pending-open');
    for (const t of targets) if (t.error) notify(t.error, true);
    const root = targets.filter((t) => t.root).at(-1)?.root;
    if (!root) return;
    const paths = targets.flatMap((t) => (t.root === root && t.relative ? [t.relative] : []));
    const openAll = async () => {
      setSplit(null);
      setMode('read');
      for (const p of paths) await model.open(p).catch((e) => notify(e.message, true));
    };
    if (root === currentRoot) return openAll();
    guardDirty(model.docs, async () => {
      await loadWorkspace(await invoke<WorkspaceInfo>('open-recent-workspace', { root }));
      await openAll();
    });
  }
  function openRecentProject(root: string) {
    setProjectPicker(null);
    run(async () => {
      const w = await invoke<WorkspaceInfo>('open-recent-workspace', { root });
      await loadWorkspace(w);
    });
  }
  function openFolder() {
    if (!isDesktop) {
      chooseNewProject();
      return;
    }
    guardDirty(model.docs, async () => {
      const projects = await invoke<RecentProject[]>('recent-workspaces');
      setProjectPicker(projects);
    });
  }
  function save() {
    saveDocument(model.active);
  }
  function saveDocument(id: string) {
    const doc = model.docsRef.current.find((d) => d.id === id);
    if (doc?.draft === doc?.source) {
      if (!autosave) notify('没有未保存的源码修改');
      return;
    }
    if (doc)
      run(async () => {
        await model.save(doc.id);
        notify('HTML 已保存');
      });
  }
  async function restoreBackup(entry: BackupEntry) {
    if (!doc) return;
    await model.restore(doc.id, entry.name);
    setHistoryOpen(null);
    notify(`已恢复到 ${backupLabel(entry.time)} 的版本，恢复前的内容也已备份`);
  }
  function toggleAutosave() {
    const next = !autosave;
    setAutosave(next);
    // Turning it on saves what was edited while it was off.
    if (next)
      for (const d of model.docsRef.current)
        if (d.draft !== d.source)
          model.save(d.id).catch((e) => onError('自动保存失败：' + (e as Error).message));
  }
  function startFind() {
    if (mode === 'source') {
      sourceEditor.current?.find();
      return;
    }
    setMode('read');
    setFinding(true);
  }
  liveActions.current = {
    ...liveActions.current,
    save,
    folder: openFolder,
    find: startFind,
    close: () => guardDirty(model.docs, () => invoke('close')),
    refresh: () => run(refresh),
    openFiles: () => run(() => openRequestedFiles(workspace?.root)),
    checkUpdates,
  };
  async function checkUpdates() {
    if (!isDesktop) return;
    notify('正在检查更新…');
    try {
      const result = await invoke<UpdateState | { status: 'latest'; version: string }>(
        'check-updates',
      );
      if (result.status === 'latest') notify(`页间 ${result.version} 已是最新版本`);
      else if (result.status === 'downloading')
        notify(`发现新版本 ${result.version}，正在后台下载，下载好后会提醒你`);
      else if (result.status !== 'idle') {
        setNotice(null);
        setUpdateHidden(false);
      }
    } catch (e) {
      onError((e as Error).message);
    }
  }
  // Saves like closing the window does, then quits; the new version opens by itself.
  const restartToUpdate = () => guardDirty(model.docs, () => invoke('update-restart'));
  function fileAction(action: FileAction, path: string) {
    if (action === 'reveal') {
      run(() => invoke('reveal', { path }));
      return;
    }
    if (action === 'trash') {
      const affected = model.docs.filter((d) => d.path === path || d.path.startsWith(path + '/'));
      setDialog({
        title: `移到${trashName}？`,
        message: `${path} 将移到系统${trashName}。${affected.some((d) => d.draft !== d.source) ? '未保存的源码修改会被放弃。' : ''}批注数据仍保留，恢复文件后可以继续阅读。`,
        danger: true,
        confirmLabel: `移到${trashName}`,
        onConfirm: async () => {
          await model.flush();
          setWorkspace(await invoke('trash', { path }));
          affected.forEach((d) => closeDocument(d.id));
        },
      });
      return;
    }
    const create = action.startsWith('create');
    const folder = action === 'create-folder';
    const rename = action === 'rename';
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    setDialog({
      title: create ? (folder ? '新建文件夹' : '新建 HTML 文档') : rename ? '重命名' : '移动文件',
      input: true,
      initial: create
        ? folder
          ? '新文件夹'
          : '未命名.html'
        : rename
          ? path.split('/').at(-1)
          : path,
      message:
        action === 'move'
          ? '输入相对于项目根目录的目标路径，例如：论文/文章.html。目标文件夹需要已存在。移动可能影响 HTML 中的相对资源链接。'
          : undefined,
      confirmLabel: create ? '创建' : '确定',
      onConfirm: async (value) => {
        const name = value.trim();
        if (!name) throw Error('名称不能为空');
        if (rename && name.includes('/')) throw Error('重命名不能包含 /，请使用移动操作');
        const target = create ? (path ? path + '/' : '') + name : rename ? parent + name : name;
        await model.flush();
        if (create) {
          setWorkspace(await invoke('create', { path: target, kind: folder ? 'folder' : 'file' }));
          if (!folder) await openDocument(target);
        } else {
          await relocate(path, target);
        }
      },
    });
  }
  async function relocate(from: string, to: string) {
    await model.flush();
    setWorkspace(await invoke('move', { from, to }));
    model.move(from, to);
  }
  function chooseTool(next: Tool) {
    if (selection && ['highlight', 'underline'].includes(next)) {
      annotateSelection(next as 'highlight' | 'underline');
      return;
    }
    activateTool(next);
    if (next === 'text' && color === defaultColor) setColor(annotationColors[4].value);
  }
  function annotateSelection(type: 'highlight' | 'underline') {
    sendToActive('annotate', { tool: type });
    setSelection(null);
  }
  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    sendToActive('clear-selection');
    setSelection(null);
  }
  // Two-column reading with `id` on `side` and `beside` kept on the other side.
  function placeBeside(id: string, beside: string, side: PaneSide) {
    const keep = split && (split.left === beside || split.right === beside);
    const sideOf = split?.left === beside ? 'right' : 'left';
    const target: PaneSide = keep ? sideOf : side;
    focusedSide.current = target;
    setSplit((s) =>
      keep && s
        ? { ...s, [target]: id }
        : target === 'right'
          ? { left: beside, right: id }
          : { left: id, right: beside },
    );
  }
  // Page links in notes (paper.pdf#page=3) open the PDF next to the note at that page; a
  // translation's links (#page=3&find=…, or #find=… for HTML) also mark the passage there.
  async function openSourceAt(path: string, from: string, page: number, find: string) {
    const visible = split && [split.left, split.right];
    const id = await model.open(path, false, keepPanes());
    setMode('read');
    if (id !== from && !visible?.includes(id)) placeBeside(id, from, 'left');
    else if (split) focusedSide.current = split.left === id ? 'left' : 'right';
    model.setActive(id);
    let reader: ReaderHandle | undefined;
    for (let i = 0; i < 60 && !(reader = readers.current.get(id)); i++)
      await new Promise((r) => setTimeout(r, 100));
    await reader?.whenReady();
    if (page) reader?.send('pdf-page', { page });
    if (find) await reader?.request('ai-flash', { quote: find, page }, 30_000).catch(() => {});
  }
  function openAiCard(cardMode: 'explain' | 'translate' | 'ask') {
    if (!doc || !selection) return;
    if (!memberNow(cardMode === 'translate' ? 'AI 翻译' : 'AI 解释与提问')) return;
    assistant.openCard(cardMode, { docId: doc.id, path: doc.path, anchor: selection });
  }
  // The selected text, a picture of a framed region of the page, or a blank board for any
  // question.
  function openWhiteboard(
    from: { picture?: string; blank?: boolean; path?: string; where?: Where } = {},
  ) {
    const path = from.blank ? undefined : from.path || doc?.path;
    const text = from.picture || from.blank ? '' : selection?.exact || '';
    if (!from.picture && !from.blank && !text) return;
    if (!memberNow('白板讲解')) return;
    lessonRef.current?.tutor.dispose();
    const tutor = new Tutor({
      selection: text,
      picture: from.picture,
      where: from.where,
      source: path,
      save: saveBoard,
      docText: () => (path ? assistant.text(path) : Promise.reject(Error('没有打开的文档'))),
      ready: () => assistant.provider('board'),
    });
    setLesson({ tutor, selection: text || (from.picture ? '框选的区域' : '空白白板') });
    setBoardAway(false);
    void tutor.start();
  }
  // The document and spot a framed box is over: the reader under its middle says which
  // page it is on and what text is there.
  async function framedSpot(box: { left: number; top: number; right: number; bottom: number }) {
    for (const [id, reader] of readers.current) {
      const inside = reader.inFrame(box);
      const path = model.docsRef.current.find((d) => d.id === id)?.path;
      if (!inside || !path) continue;
      const where = await reader
        .request<Where>('ai-region', { box: inside }, 5_000)
        .catch(() => undefined);
      return { path, where };
    }
    return null;
  }
  async function saveBoard(entry: BoardEntry, data: SavedBoard) {
    try {
      await invoke('save-board', { entry, data });
      setBoardsVersion((v) => v + 1);
    } catch (e) {
      notify(
        '白板保存失败：' +
          (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
        true,
      );
    }
  }
  async function openBoard(id: string) {
    const entry = (await invoke<BoardEntry[]>('boards').catch(() => [])).find((b) => b.id === id);
    if (!entry) return notify('这块白板已经删掉了', true);
    await openSavedBoard(entry);
  }
  function boardDeleted(id: string) {
    setBoardsVersion((v) => v + 1);
    if (lessonRef.current?.tutor.id !== id) return;
    lessonRef.current.tutor.dispose(false);
    setLesson(null);
  }
  // Keeps a board in its document's note (a blank board in the open document's), with a
  // picture of it, replacing what was kept from it before.
  async function boardToNote(
    entry: BoardEntry,
    board: SavedBoard['state'],
    picture: string | null,
  ) {
    const path = entry.source || doc?.path;
    if (!path) return notify('先打开要存入笔记的文档', true);
    try {
      const image = picture
        ? await invoke<string>('save-note-image', { data: picture, prefix: 'board' })
        : '';
      const { data } = await hostImpl.current.documentData(path);
      const section = boardNote({ ...entry, updatedAt: Date.now() }, board, image);
      const { note, replaced } = withBoardNote(data.note, entry.id, section);
      await hostImpl.current.setNote(path, note);
      // The picture from the last time this board was kept here is no longer shown.
      for (const [, name] of replaced.matchAll(/note-image:(board-[\w.-]+)/g))
        if (!note.includes(name)) void invoke('delete-note-image', { name }).catch(() => {});
      if (path === doc?.path) {
        setRight(true);
        setTab('note');
        setNoteReveal({ find: `(folio-board:${entry.id})` });
      }
      notify(`已存入「${fileName(path)}」的笔记`);
    } catch (e) {
      notify('存入笔记失败：' + (e as Error).message, true);
    }
  }
  // The sidebar keeps a board in the note by opening it, so a picture can be taken.
  async function boardToNoteFromList(entry: BoardEntry) {
    if (!entry.source && !doc?.path) return notify('先打开要存入笔记的文档', true);
    if (await openSavedBoard(entry)) setNoteAsk((a) => ({ id: entry.id, n: (a?.n || 0) + 1 }));
  }
  async function openSavedBoard(entry: BoardEntry) {
    setBoardList(false);
    if (lessonRef.current?.tutor.id === entry.id) {
      setBoardAway(false);
      return true;
    }
    const board = await invoke<SavedBoard | null>('board', { id: entry.id }).catch(() => null);
    if (!board) {
      notify('这块白板读取不了', true);
      return false;
    }
    lessonRef.current?.tutor.dispose();
    const tutor = new Tutor({
      selection: board.selection,
      picture: board.picture,
      source: entry.source,
      save: saveBoard,
      restore: { entry, board },
      docText: () =>
        entry.source ? assistant.text(entry.source) : Promise.reject(Error('没有打开的文档')),
      ready: () => assistant.provider('board'),
    });
    setLesson({ tutor, selection: entry.title });
    setBoardAway(false);
    return true;
  }
  function openAssistant() {
    setRight(true);
    setTab('assistant');
  }
  function event(id: string, e: FrameEvent) {
    const doc = model.docsRef.current.find((d) => d.id === id);
    if (!doc) return;
    switch (e.type) {
      case 'activate':
        if (model.active !== id) selectDocument(id);
        break;
      case 'ready': {
        // A translation names the document it was made from, which sits next to it.
        const name =
          typeof e.pairOf === 'string' && !/[\\/]|^\.\.?$/.test(e.pairOf) ? e.pairOf : '';
        const dir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/') + 1) : '';
        const pairOf = name ? dir + name : undefined;
        if (readerStates[id]?.pairOf !== pairOf) patchReader(id, { pairOf });
        break;
      }
      case 'pair-scroll': {
        const other = pairedIds?.find((x) => x !== id);
        if (other && pairedIds?.includes(id) && Number.isFinite(e.at))
          readers.current.get(other)?.send('pair-follow', { at: e.at });
        break;
      }
      case 'pointerdown':
        window.getSelection()?.removeAllRanges();
        if (assistant.get().card) assistant.closeCard();
        if (model.active !== id) selectDocument(id);
        setInkSettingsOpen(false);
        focus.setToolsVisible(false);
        break;
      case 'outline':
        patchReader(id, { outline: e.items });
        break;
      case 'selection':
        patchReader(id, { selection: e.quote, selectionBox: e.quote ? e.rect : null });
        break;
      case 'selection-box':
        patchReader(id, { selectionBox: e.rect });
        break;
      case 'zoom-wheel': {
        if (!Number.isFinite(e.delta)) break;
        const zoom = mode === 'read' ? zoomAfterWheel(doc.data.zoom || e.scale, e.delta) : 0;
        if (mode === 'read' && zoom !== doc.data.zoom) {
          if (model.active !== id) selectDocument(id);
          model.data(id, { zoom }, true);
          setInkSettingsOpen(false);
        } else
          readers.current
            .get(id)
            ?.send('zoom-state', { scale: zoom || 1, enabled: mode === 'read' });
        break;
      }
      case 'scroll':
        if (Math.abs(e.scroll - doc.data.scroll) > 3) model.data(id, { scroll: e.scroll });
        patchReader(id, { progress: Math.max(0, Math.min(100, e.progress || 0)) });
        break;
      case 'linked-wheel': {
        if (!Number.isFinite(e.delta)) break;
        // If a pane closes while its last wheel event is in flight, keep that
        // final movement local instead of applying it to an unrelated document.
        const targets =
          linkedScroll &&
          mode === 'read' &&
          split?.right &&
          (split.left === id || split.right === id)
            ? [split.left, split.right]
            : [id];
        for (const target of targets)
          readers.current.get(target)?.send('linked-scroll', { delta: e.delta });
        break;
      }
      case 'orphans':
        patchReader(id, { orphans: e.ids });
        break;
      case 'order':
        if (Array.isArray(e.ids)) patchReader(id, { order: e.ids });
        break;
      case 'create': {
        const a = e.annotation;
        if (
          !a?.id ||
          !['highlight', 'underline', 'text', 'sticky', 'pen', 'arrow', 'rectangle'].includes(
            a.type,
          )
        )
          return;
        model.annotate(id, (all) => [...all, a]);
        patchReader(id, { selected: a.id, selection: null });
        break;
      }
      case 'select-annotation':
        patchReader(id, { selected: e.id });
        break;
      case 'note-font-size':
        if (Number.isFinite(e.size))
          setNoteFontSize(Math.max(12, Math.min(26, Math.round(e.size))));
        break;
      case 'update-annotation':
        if (e.patch?.size) {
          const type = doc.data.annotations.find((a) => a.id === e.id)?.type;
          if (type === 'sticky') setStickySize(stickyNoteSize(e.patch.size));
          if (type === 'text') setTextWidth(textNoteWidth(e.patch.size.width));
        }
        model.annotate(
          id,
          (all) => all.map((a) => (a.id === e.id ? { ...a, ...e.patch } : a)),
          e.group,
        );
        break;
      case 'erase-ink': {
        const changed = new Map(
          (e.changes || []).map((a: { id: string; paths: unknown }) => [a.id, a.paths]),
        );
        const removed = new Set(e.removed || []);
        model.annotate(id, (all) =>
          all
            .filter((a) => !removed.has(a.id))
            .map((a) =>
              changed.has(a.id) ? { ...a, paths: changed.get(a.id) as typeof a.paths } : a,
            ),
        );
        break;
      }
      case 'delete':
        model.annotate(id, (all) => all.filter((a) => a.id !== e.id));
        break;
      case 'escape':
        setInspecting(false);
        focus.setEnabled(false);
        window.getSelection()?.removeAllRanges();
        activateTool('select');
        patchReader(id, { selection: null });
        break;
      case 'switch-tool':
        if (mode !== 'read') break;
        if (model.active !== id) selectDocument(id);
        switchRecentTool();
        break;
      case 'shortcut':
        if (e.key === 's') saveDocument(id);
        if (e.key === 'f') {
          if (e.shift) liveActions.current.focus();
          else startFind();
        }
        if (e.key === 'z') model.undo(id, e.shift);
        if (e.key === 'y') model.undo(id, true);
        break;
      case 'inspect-hover':
      case 'inspect-pick':
        sourceEditor.current?.reveal(e.offset, e.tag, e.type === 'inspect-pick');
        if (e.type === 'inspect-pick') setInspecting(false);
        break;
      case 'found':
        setFindMissing(!e.ok);
        break;
      case 'link':
        run(async () => {
          const url = new URL(e.url);
          if (url.protocol === 'folio:' && url.host === 'asset') {
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (parts.shift() !== workspace?.token) return;
            const path = parts.join('/');
            const hash = new URLSearchParams(url.hash.slice(1));
            const page = Number(hash.get('page')) || 0;
            const find = hash.get('find') || '';
            if (/\.pdf$/i.test(path) && page > 0) await openSourceAt(path, id, page, find);
            else if (/\.html?$/i.test(path) && find) await openSourceAt(path, id, 0, find);
            else if (/\.(html?|pdf)$/i.test(path))
              await openDocument(path, split?.right === id ? 'right' : 'left');
            else notify('该链接不是 HTML 或 PDF 文档');
          } else if (!isDesktop && url.pathname.startsWith('/__asset/')) {
            const path = url.pathname.split('/').slice(3).map(decodeURIComponent).join('/');
            await openDocument(path, split?.right === id ? 'right' : 'left');
          } else if (['https:', 'http:'].includes(url.protocol)) {
            if (isDesktop) await invoke('external', { url: url.toString() });
            else window.open(url.toString(), '_blank', 'noopener');
          }
        });
        break;
    }
  }
  // Deleting from the side panel says what went and offers to bring it back.
  function deleteFromList(id: string) {
    if (!doc) return;
    const docId = doc.id;
    const before = doc.data.annotations;
    const index = before.findIndex((a) => a.id === id);
    if (index < 0) return;
    const removed = before[index];
    model.annotate(docId, (all) => all.filter((a) => a.id !== id));
    const after = model.docsRef.current.find((d) => d.id === docId)?.data.annotations;
    notify(`已删除${annotationLabels[removed.type] || '批注'}`, false, {
      label: '撤销',
      run: () => {
        const current = model.docsRef.current.find((d) => d.id === docId);
        if (!current) return;
        // Nothing changed since: a plain undo, so redo still works.
        if (current.data.annotations === after) model.undo(docId);
        else if (!current.data.annotations.some((a) => a.id === id))
          model.annotate(docId, (all) => [...all.slice(0, index), removed, ...all.slice(index)]);
      },
    });
  }
  function exportNotes() {
    if (!doc) return;
    const names: Record<string, string> = {
      highlight: '高亮',
      underline: '下划线',
      text: '文本注释',
      sticky: '便签',
      pen: '画笔',
      arrow: '箭头',
      rectangle: '矩形',
    };
    const text =
      `# ${doc.path.split('/').at(-1)}\n\n${doc.data.note || ''}\n\n## 批注\n\n` +
      doc.data.annotations
        .map(
          (a, i) =>
            `### ${i + 1}. ${names[a.type]}\n\n${a.quote ? '> ' + a.quote.exact.replaceAll('\n', '\n> ') : a.type === 'sticky' ? '[页面便签]' : a.type === 'text' ? '[页面文字]' : '[页面图形标记]'}\n\n${a.note}\n`,
        )
        .join('\n');
    if (isDesktop)
      run(async () => {
        if (await invoke('export', { path: doc.path, content: text })) notify('笔记已导出');
      });
    else {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.path.split('/').at(-1) + '-笔记.md';
      a.click();
      URL.revokeObjectURL(url);
    }
  }
  const files = readableFiles(workspace?.tree || []);
  const readingSplit = mode === 'read' && split;
  const panes: { side: PaneSide; doc: OpenDocument | undefined }[] = readingSplit
    ? [
        { side: 'left', doc: model.docs.find((d) => d.id === readingSplit.left) },
        { side: 'right', doc: model.docs.find((d) => d.id === readingSplit.right) },
      ]
    : [{ side: 'left', doc }];
  // The columns render in a fixed order and CSS `order` places them, so swapping sides moves
  // no iframe (a moved iframe reloads) and both documents stay where they were read.
  const paneOrder = [...panes].sort((a, b) => ((a.doc?.id || '') < (b.doc?.id || '') ? -1 : 1));
  const existingDragPane = readingDrag
    ? panes.find((pane) => pane.doc?.path === readingDrag)
    : undefined;
  const dropPreviewSide = existingDragPane?.side || readingDropSide || 'right';
  const dropBoundary = readingSplit ? splitRatio : 0.5;
  const otherPane = readingSplit
    ? panes.find((pane) => pane.doc && pane.doc.id !== doc?.id)?.doc
    : undefined;
  // A translation and the PDF it was made from, side by side with 同步滚动 on, scroll together
  // paragraph by paragraph instead of by the same distance.
  const pairIds = (() => {
    if (!readingSplit) return null;
    const [a, b] = panes.map((pane) => pane.doc);
    if (!a || !b) return null;
    const pair = (t: OpenDocument, s: OpenDocument) =>
      s.kind === 'pdf' && readerStates[t.id]?.pairOf === s.path;
    return pair(a, b) || pair(b, a) ? [a.id, b.id] : null;
  })();
  const pairedIds = linkedScroll ? pairIds : null;
  // What the assistant reads, and which conversation it's in. Two documents side by side share
  // one, numbered left then right whichever is clicked; a document beside its own translation
  // or 精读笔记 keeps its own conversation, so a task that opens one stays in view.
  const reading = (() => {
    if (!doc) return null;
    const ref = (d: OpenDocument) => ({ id: d.id, path: d.path });
    const [left, right] = panes.map((pane) => pane.doc);
    if (!otherPane || !left || !right) return { scope: doc.id, docs: [ref(doc)], active: doc.id };
    const source = companionOf(right, left, readerStates[right.id]?.pairOf)
      ? left
      : companionOf(left, right, readerStates[left.id]?.pairOf)
        ? right
        : null;
    return source
      ? {
          scope: source.id,
          docs: [source, source === left ? right : left].map(ref),
          active: doc.id,
        }
      : {
          scope: `pair:${[left.id, right.id].sort().join('+')}`,
          docs: [left, right].map(ref),
          active: doc.id,
        };
  })();
  const keepPanes = () => (split ? [split.left, split.right] : []);
  // The reader showing `path`; with `show`, the document is opened first.
  async function readerFor(path: string, show = false) {
    const open = model.docsRef.current.find((d) => d.path === path);
    let reader = open && readers.current.get(open.id);
    if (reader || !show) return reader;
    await openDocument(path);
    setMode('read');
    const id = model.docsRef.current.find((d) => d.path === path)?.id;
    for (let i = 0; i < 60 && id && !(reader = readers.current.get(id)); i++)
      await new Promise((r) => setTimeout(r, 100));
    return reader;
  }
  function offscreen<T>(path: string, type: string, payload: Record<string, unknown> = {}) {
    return withHiddenReader(
      documentUrl(path, Date.now()),
      /\.pdf$/i.test(path) ? 'pdf' : 'html',
      (request) => request<T>(type, payload),
    );
  }
  hostImpl.current = {
    projectName: () => workspace?.name || '',
    root: () => workspace?.root,
    files: () => files.map((path) => ({ path, kind: /\.pdf$/i.test(path) ? 'pdf' : 'html' })),
    activePath: () => doc?.path,
    async docText(path) {
      const reader = await readerFor(path);
      type Raw = { title?: string; text?: string; pages?: string[] };
      const raw = reader
        ? await reader.request<Raw>('ai-text', {}, 90_000)
        : await offscreen<Raw>(path, 'ai-text');
      return docText(path, raw);
    },
    async anchors(path, quotes) {
      const reader = await readerFor(path);
      type Result = (Anchor | null)[];
      if (!reader) return offscreen<Result>(path, 'ai-anchors', { quotes });
      const found = await reader.request<Result>('ai-anchors', { quotes }, 90_000);
      // A reader that places nothing may be mid-reload; a freshly loaded copy decides.
      if (quotes.length && found.every((a) => !a)) {
        const again = await offscreen<Result>(path, 'ai-anchors', { quotes }).catch(() => found);
        return found.map((a, i) => a || again[i] || null);
      }
      return found;
    },
    async flash(path, quote) {
      const reader = await readerFor(path, true);
      return !!reader && (await reader.request<boolean>('ai-flash', { quote }, 30_000));
    },
    async documentData(path) {
      const open = model.docsRef.current.find((d) => d.path === path);
      if (open) return { id: open.id, kind: open.kind, data: open.data, source: open.draft };
      const raw = await invoke<OpenDocument>('document', { path });
      return { id: raw.id, kind: raw.kind, data: raw.data, source: raw.source };
    },
    // Changes land in the document like manual ones: one undo step, saved as usual.
    async addAnnotations(path, annotations) {
      const id = await model.open(path, false, keepPanes());
      model.annotate(id, (all) => [...all, ...annotations]);
    },
    async setNote(path, note) {
      const id = await model.open(path, false, keepPanes());
      model.data(id, { note });
    },
    saveNoteImage: (data) => invoke<string>('save-note-image', { data, prefix: 'ask' }),
    async showNote(path, find = '') {
      await openDocument(path);
      setRight(true);
      setTab('note');
      setNoteReveal({ find });
    },
    async setSource(path, source) {
      const id = await model.open(path, false, keepPanes());
      model.edit(id, source, false);
      if (!autosave) return { saved: false };
      await model.save(id);
      return { saved: true };
    },
    async createHtml(path, content) {
      setWorkspace(await invoke<WorkspaceInfo>('create', { path, kind: 'file', content }));
    },
    async writeHtml(path, content) {
      const open = model.docsRef.current.find((d) => d.path === path);
      if (open && open.draft !== open.source) throw Error(`「${path}」有没保存的修改`);
      const version = open?.version ?? (await invoke<OpenDocument>('document', { path })).version;
      await invoke('save-source', { path, source: content, version });
      if (open) await model.reload(open.id);
    },
    searchPapers: (options) => invoke('papers-search', options),
    async savePdf(url, path) {
      const saved = await invoke<{ workspace: WorkspaceInfo; size: number }>('save-pdf', {
        url,
        path,
      });
      setWorkspace(saved.workspace);
      return saved.size;
    },
    async open(path) {
      await openDocument(path);
      setMode('read');
    },
    async openBeside(path, beside, options = {}) {
      if (options.linked) setLinkedScroll(true);
      const other = model.docsRef.current.find((d) => d.path === beside);
      const id = await model.open(path, false, keepPanes());
      setMode('read');
      if (!other || other.id === id) return model.setActive(id);
      // The source stays the active document, so its conversation (and the result
      // message) stays in the assistant.
      placeBeside(id, other.id, 'right');
      focusedSide.current = 'left';
      model.setActive(other.id);
    },
    confirm: (options) =>
      new Promise((resolve) =>
        setDialog({
          ...options,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      ),
    notify,
    openSettings: () => setAiSettingsOpen(true),
  };
  return (
    <div
      className={`app-shell ${left ? '' : 'hide-left'} ${right ? '' : 'hide-right'}${focus.enabled ? ' focus-mode' : ''}${focus.toolsVisible ? ' focus-tools-visible' : ''}`}
    >
      <header className="titlebar">
        {!isDesktop ? (
          <div className="traffic-lights">
            <i />
            <i />
            <i />
          </div>
        ) : null}
        {isDesktop ? (
          // Also the way to check for updates on Windows, where the menu bar is hidden.
          <button
            type="button"
            className="brand"
            title={`页间 ${appVersion} · 点击检查更新`}
            onClick={checkUpdates}
          >
            <BookOpen size={18} />
            <strong>页间</strong>
            <span>Folio</span>
          </button>
        ) : (
          <div className="brand">
            <BookOpen size={18} />
            <strong>页间</strong>
            <span>Folio</span>
          </div>
        )}
        <div className="titlebar-end" ref={setTitleEnd}>
          {updateHidden && (update.status === 'ready' || update.status === 'manual') ? (
            <button type="button" className="update-chip" onClick={() => setUpdateHidden(false)}>
              {update.status === 'ready' ? '重启以更新' : '有新版本'} {update.version}
            </button>
          ) : null}
          {isDesktop && license ? (
            <button
              type="button"
              className={`member-chip is-${license.state}`}
              title={
                license.member && license.forever
                  ? '永久会员'
                  : license.member && license.expires
                    ? `会员到 ${new Date(license.expires).toLocaleString('zh-CN', { hour12: false })}`
                    : 'PDF 阅读、AI 功能和界面主题需要会员'
              }
              onClick={() => setMembership({ reason: '' })}
            >
              {license.state === 'paid' ? <Crown size={13} /> : null}
              {
                {
                  paid: license.forever ? '永久会员' : '会员',
                  trial: '试用中',
                  offline: '会员待验证',
                  clock: '会员待验证',
                  expired: '会员已到期',
                  none: '开通会员',
                }[license.state]
              }
            </button>
          ) : null}
          <span className="titlebar-document">{workspace?.name}</span>
          <div className="theme-menu">
            <IconButton
              label="界面主题"
              help="切换配色，可跟随系统浅色 / 深色"
              className="theme-button"
              active={themePickerOpen}
              onClick={() => setThemePickerOpen((open) => !open)}
            >
              <Palette size={16} />
            </IconButton>
            <Exit when={themePickerOpen}>
              {() => <ThemePicker onClose={() => setThemePickerOpen(false)} />}
            </Exit>
          </div>
        </div>
      </header>
      <div className="workspace-layout">
        <FileTree
          key={workspace?.token || 'empty'}
          onClose={() => setLeft(true)}
          workspace={workspace}
          active={doc?.path}
          onOpen={(p) => run(() => openDocument(p))}
          onFolder={openFolder}
          onAction={fileAction}
          onReadingDrag={(path) => {
            setReadingDrag(path);
            setReadingDropSide(null);
          }}
          onMove={async (from, to) => {
            try {
              await relocate(from, to);
              notify(
                `已移动到 ${to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '项目根目录'}`,
              );
              return true;
            } catch (e) {
              notify((e as Error).message, true);
              return false;
            }
          }}
          onImported={(result) => {
            setWorkspace(result.workspace);
            notify(`已复制 ${result.imported.length} 个项目到工作空间`);
          }}
          onImportError={(message) => notify(message, true)}
          onRefresh={() => run(refresh)}
          boards={
            isDesktop ? (
              <BoardShelf
                version={boardsVersion}
                current={lesson?.tutor.id}
                active={doc?.path}
                onOpen={(entry) => void openSavedBoard(entry)}
                onBlank={() => openWhiteboard({ blank: true })}
                onNote={(entry) => void boardToNoteFromList(entry)}
                onDeleted={boardDeleted}
              />
            ) : null
          }
          status={
            <ReadingStatus
              format={doc?.kind === 'pdf' ? 'PDF' : 'HTML'}
              saving={model.saving}
              error={!!notice?.error}
              annotations={doc?.data.annotations.length || 0}
              progress={progress}
              hint={
                mode === 'source'
                  ? doc?.draft !== doc?.source
                    ? '源码有未保存的修改'
                    : '源码修改前的版本会自动备份，可在“历史版本”中恢复'
                  : tool === 'eraser'
                    ? `${eraserMode === 'stroke' ? '笔画擦除 · 碰到即擦除整笔' : '局部擦除 · 只擦掉经过的部分'} · 一次拖动可一次撤销`
                    : toolHints[tool]
              }
            />
          }
        />
        <main className="main-panel">
          <DocumentTabs
            docs={model.docs}
            active={model.active}
            onSelect={selectDocument}
            onClose={requestCloseDocument}
            onNew={() => fileAction('create-file', '')}
            split={!!split}
            onSplit={toggleSplit}
            autosave={autosave}
          />
          {focus.enabled ? (
            <>
              <div className="focus-top-edge" onPointerEnter={() => focus.setToolsVisible(true)} />
              {!focus.toolsVisible ? (
                <div className="focus-controls">
                  <button
                    aria-label="显示批注工具"
                    title="鼠标移到顶部也可显示批注工具"
                    onClick={() => focus.setToolsVisible(true)}
                  >
                    <SlidersHorizontal size={15} />
                    工具
                  </button>
                  <button
                    aria-label="退出专注阅读"
                    title={`Esc / ${shortcut('mod', 'shift', 'F')} 退出`}
                    onClick={() => focus.setEnabled(false)}
                  >
                    <Minimize size={15} />
                    退出专注
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
          <div className="toolbar-host" inert={focus.enabled && !focus.toolsVisible}>
            <Toolbar
              focusMode={focus.enabled}
              onLeft={() => setLeft((v) => !v)}
              onRight={() => setRight((v) => !v)}
              onFocusMode={() => liveActions.current.focus()}
              pdf={doc?.kind === 'pdf'}
              mode={mode}
              onMode={setMode}
              tool={tool}
              onTool={chooseTool}
              color={color}
              onColor={setColor}
              canLinkScroll={!!readingSplit && !!readingSplit.right}
              pairScroll={!!pairIds}
              linkedScroll={linkedScroll}
              onLinkedScroll={() => setLinkedScroll((v) => !v)}
              zoom={doc?.data.zoom || 0}
              onZoom={(zoom) => doc && model.data(doc.id, { zoom })}
              onFind={startFind}
              onSave={save}
              inspecting={inspecting}
              onInspect={() => setInspecting((v) => !v)}
              autosave={autosave}
              onAutosave={toggleAutosave}
              onReload={() =>
                doc && guardDirty([doc], () => model.reload(doc.id), '重新载入文件？')
              }
              onHistory={() => setHistoryOpen({})}
              aiEditing={aiSourceOpen}
              onAiEdit={isDesktop ? () => setAiSourceOpen((v) => !v) : undefined}
              assistantOpen={right && tab === 'assistant'}
              onWhiteboard={
                isDesktop
                  ? () => (selection && mode === 'read' ? openWhiteboard() : setBoardCapture(true))
                  : undefined
              }
              onAssistant={
                isDesktop
                  ? () => (right && tab === 'assistant' ? setRight(false) : openAssistant())
                  : undefined
              }
              dirty={!!doc && doc.draft !== doc.source}
              onUndo={() => doc && model.undo(doc.id)}
              onRedo={() => doc && model.undo(doc.id, true)}
              canUndo={!!doc?.history.length}
              canRedo={!!doc?.future.length}
              disabled={!doc}
              strokeWidth={strokeWidth}
              eraserSize={eraserSize}
              eraserMode={eraserMode}
              onEraserMode={setEraserMode}
              onStrokeWidth={setStrokeWidth}
              onEraserSize={setEraserSize}
              settingsOpen={inkSettingsOpen}
              onSettingsOpenChange={setInkSettingsOpen}
            />
          </div>
          {finding ? (
            <div className="find-bar">
              <input
                ref={findInput}
                aria-label="查找文内文字输入"
                placeholder="查找文内文字…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFindMissing(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendToActive('find', { query, backwards: e.shiftKey });
                }}
              />
              {findMissing ? <span>未找到</span> : null}
              <IconButton
                label="上一个结果"
                onClick={() => sendToActive('find', { query, backwards: true })}
              >
                <ChevronLeft size={16} />
              </IconButton>
              <IconButton label="下一个结果" onClick={() => sendToActive('find', { query })}>
                <ChevronRight size={16} />
              </IconButton>
              <IconButton label="关闭查找" onClick={() => setFinding(false)}>
                <X size={15} />
              </IconButton>
            </div>
          ) : null}
          {doc ? (
            <div
              className={`document-workbench ${mode === 'source' ? 'split-editor' : ''} ${readingSplit ? 'split-reading' : ''}${paneDrag ? ' pane-pressing' : ''}${paneDrag?.over ? ' pane-dragging' : ''}`}
            >
              {mode === 'source' ? (
                <div
                  className="editor-pane"
                  style={{ '--source-ratio': sourceRatio } as CSSProperties}
                >
                  <div className="pane-caption">
                    <Code2 size={13} />
                    源码
                    <span>
                      {autosave
                        ? doc.autosavePaused && doc.draft !== doc.source
                          ? '未保存 · 自动保存已暂停'
                          : ''
                        : doc.draft !== doc.source
                          ? '未保存'
                          : '已保存'}
                    </span>
                  </div>
                  {aiSourceOpen ? (
                    <AiSourceEdit
                      key={doc.id}
                      doc={doc}
                      store={assistant}
                      editorSelection={() => sourceEditor.current?.selection() || ''}
                      onPreview={setAiPreview}
                      onApply={(source) => {
                        model.edit(doc.id, source, autosave);
                        notify(
                          autosave
                            ? '已应用 AI 修改；修改前的版本已自动备份，也可以在编辑器中撤销'
                            : '已应用 AI 修改，保存后写入文件',
                        );
                      }}
                      onOpenSettings={() => setAiSettingsOpen(true)}
                      onClose={() => setAiSourceOpen(false)}
                    />
                  ) : null}
                  <Suspense fallback={<div className="editor-loading">正在载入编辑器…</div>}>
                    <SourceEditor
                      ref={sourceEditor}
                      key={doc.id}
                      value={doc.draft}
                      onChange={(draft) => model.edit(doc.id, draft, autosave)}
                      onSave={save}
                    />
                  </Suspense>
                </div>
              ) : null}
              {mode === 'source' ? (
                <ReadingResizer ratio={sourceRatio} onChange={setSourceRatio} />
              ) : null}
              {readingSplit ? <ReadingResizer ratio={splitRatio} onChange={setSplitRatio} /> : null}
              {readingSplit && readingSplit.right ? (
                <IconButton
                  className="pane-swap"
                  label="交换左右栏"
                  help="两篇文档左右互换，各自的阅读位置不变；也可以把栏标题拖到另一侧"
                  style={{ left: `${splitRatio * 100}%` }}
                  onClick={swapSides}
                >
                  <ArrowLeftRight size={14} />
                </IconButton>
              ) : null}
              {paneOrder.map(({ side, doc: paneDoc }) => (
                <div
                  key={paneDoc?.id || side}
                  className={`reader-pane${readingSplit ? ' reading-column' : ''}${paneDoc?.id === doc.id ? ' active-column' : ''}`}
                  data-pane={side}
                  data-document-id={paneDoc?.id}
                  style={
                    readingSplit
                      ? side === 'left'
                        ? { order: 0, flex: `0 0 calc(${splitRatio * 100}% - 3px)` }
                        : { order: 2 }
                      : undefined
                  }
                >
                  {readingSplit ? (
                    <div
                      className={`reading-column-header${readingSplit.right ? ' swappable' : ''}`}
                      onPointerDown={(e) => {
                        focusedSide.current = side;
                        if (paneDoc) selectDocument(paneDoc.id);
                        dragPaneHeader(e, side);
                      }}
                    >
                      <button
                        className="pane-focus"
                        aria-label={`激活${side === 'left' ? '左' : '右'}栏`}
                        onClick={() => {
                          if (paneDoc) selectDocument(paneDoc.id);
                        }}
                      >
                        <BookOpen size={14} />
                        {side === 'left' ? '左栏' : '右栏'}
                      </button>
                      {paneDoc ? (
                        <button
                          className="pane-document-title"
                          title={paneDoc.path}
                          onClick={() => selectDocument(paneDoc.id)}
                        >
                          {paneDoc.path.split('/').at(-1)}
                        </button>
                      ) : (
                        <select
                          aria-label={`${side === 'left' ? '左' : '右'}栏文档`}
                          value=""
                          onChange={(e) => {
                            if (e.target.value) run(() => openDocument(e.target.value, side));
                          }}
                        >
                          <option value="" disabled>
                            选择另一篇文档…
                          </option>
                          {files
                            .filter(
                              (path) => !panes.some((p) => p.side !== side && p.doc?.path === path),
                            )
                            .map((path) => (
                              <option key={path} value={path}>
                                {path}
                              </option>
                            ))}
                        </select>
                      )}
                      <span className="pane-active-label">
                        {paneDoc?.id === doc.id ? '当前' : ''}
                      </span>
                      <IconButton
                        label={`关闭${side === 'left' ? '左' : '右'}栏文档`}
                        help="关闭这篇文档，另一篇继续单栏阅读"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() =>
                          paneDoc ? requestCloseDocument(paneDoc.id) : setSplit(null)
                        }
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  ) : mode === 'source' ? (
                    <div className="pane-caption">
                      <BookOpen size={13} />
                      实时预览
                      <span>
                        {inspecting ? '指向元素定位源码 · 点击选中 · Esc 退出' : '修改后自动更新'}
                      </span>
                    </div>
                  ) : null}
                  {paneDoc?.kind === 'pdf' && isDesktop && !license?.member ? (
                    license ? (
                      <MemberLock />
                    ) : (
                      <div className="reading-column-empty" />
                    )
                  ) : paneDoc ? (
                    <DocumentReader
                      key={paneDoc.id}
                      live={mode === 'source'}
                      override={mode === 'source' && paneDoc.id === doc.id ? aiPreview : null}
                      inspect={mode === 'source' && inspecting}
                      ref={(handle) => {
                        if (handle) readers.current.set(paneDoc.id, handle);
                        else readers.current.delete(paneDoc.id);
                      }}
                      doc={paneDoc}
                      onError={onError}
                      annotations={paneDoc.data.annotations}
                      selected={readerStates[paneDoc.id]?.selected || null}
                      tool={mode === 'source' ? 'select' : tool}
                      color={color}
                      strokeWidth={strokeWidth}
                      eraserSize={eraserSize}
                      eraserMode={eraserMode}
                      stickySize={stickySize}
                      textWidth={textWidth}
                      noteFontSize={noteFontSize}
                      zoom={mode === 'source' ? 0 : paneDoc.data.zoom}
                      zoomable={mode === 'read'}
                      linkedScroll={
                        !!readingSplit && !!readingSplit.right && linkedScroll && !pairedIds
                      }
                      paired={!!pairedIds?.includes(paneDoc.id)}
                      scroll={paneDoc.data.scroll}
                      onEvent={(e) => event(paneDoc.id, e)}
                    />
                  ) : (
                    <div className="reading-column-empty">
                      <BookOpen size={30} />
                      <strong>选择另一篇文档</strong>
                      <span>从工作空间拖入 HTML 或 PDF，也可以在上方选择。</span>
                    </div>
                  )}
                  {paneDoc?.id === doc.id && selection && mode === 'read' ? (
                    <SelectionToolbar
                      box={selectionBox}
                      side={toolbarSide}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <span>已选 {selection.exact.length} 字</span>
                      {rebind ? (
                        <button
                          onClick={() => {
                            model.annotate(doc.id, (all) =>
                              all.map((a) => (a.id === rebind ? { ...a, quote: selection } : a)),
                            );
                            clearSelection();
                            setRebind(null);
                            notify('批注已关联到新的原文');
                          }}
                        >
                          <MessageSquare size={15} />
                          关联此批注
                        </button>
                      ) : null}
                      <button onClick={() => annotateSelection('highlight')}>
                        <Highlighter size={15} />
                        高亮
                      </button>
                      <button onClick={() => annotateSelection('underline')}>
                        <Underline size={15} />
                        划线
                      </button>
                      {isDesktop ? (
                        <>
                          <i className="selection-divider" aria-hidden="true" />
                          <button
                            className="selection-ai"
                            onClick={() => openAiCard('explain')}
                            title="AI 解释选中的文字"
                          >
                            <Lightbulb size={15} />
                            解释
                          </button>
                          <button
                            className="selection-ai"
                            onClick={() => openAiCard('translate')}
                            title="AI 翻译选中的文字"
                          >
                            <Languages size={15} />
                            翻译
                          </button>
                          <button
                            className="selection-ai"
                            onClick={() => openAiCard('ask')}
                            title="就选中的文字向 AI 提问"
                          >
                            <MessageCircleQuestion size={15} />
                            提问
                          </button>
                          <button
                            className="selection-ai"
                            onClick={() => openWhiteboard()}
                            title="页老师在白板上边写边讲这段内容，可以随时圈出来打断提问"
                          >
                            <Presentation size={15} />
                            白板
                          </button>
                        </>
                      ) : null}
                      <IconButton
                        className="toolbar-side-button"
                        data-side={toolbarSide}
                        label={toolbarSide === 'below' ? '放到文字上方' : '放到文字下方'}
                        help="以后选中文字时，工具栏都出现在这一侧"
                        onClick={() => setToolbarSide(toolbarSide === 'below' ? 'above' : 'below')}
                      >
                        <ArrowUpToLine size={13} />
                      </IconButton>
                      <IconButton label="取消文字选择" onClick={clearSelection}>
                        <X size={13} />
                      </IconButton>
                    </SelectionToolbar>
                  ) : null}
                  {aiCard && paneDoc?.id === aiCard.docId && mode === 'read' ? (
                    <AiSelectionCard
                      card={aiCard}
                      onAsk={(q) => assistant.askCard(q)}
                      onStop={() => assistant.stopCard()}
                      onClose={() => assistant.closeCard()}
                      onOpenSettings={() => setAiSettingsOpen(true)}
                      onSave={() =>
                        run(async () => {
                          await assistant.saveCard(color);
                          clearSelection();
                        })
                      }
                      onContinue={() => {
                        if (reading) assistant.continueCard(reading);
                        setAssistantMode('doc');
                        openAssistant();
                      }}
                    />
                  ) : null}
                </div>
              ))}
              {paneDrag?.over && paneDrag.over !== paneDrag.side ? (
                <div className="reading-drop-overlay pane-swap-overlay" aria-hidden="true">
                  <div
                    className="reading-drop-preview hovered"
                    style={
                      paneDrag.over === 'left'
                        ? { left: 0, right: `${(1 - splitRatio) * 100}%` }
                        : { left: `${splitRatio * 100}%`, right: 0 }
                    }
                  >
                    <ArrowLeftRight size={30} />
                    <strong>松开，两栏互换</strong>
                    <span>
                      {panes
                        .find((pane) => pane.side === paneDrag.side)
                        ?.doc?.path.split('/')
                        .at(-1)}
                    </span>
                  </div>
                </div>
              ) : null}
              {readingDrag ? (
                <div
                  className="reading-drop-overlay"
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'copy';
                    const bounds = e.currentTarget.getBoundingClientRect();
                    setReadingDropSide(
                      e.clientX < bounds.left + bounds.width * dropBoundary ? 'left' : 'right',
                    );
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                      setReadingDropSide(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const path = e.dataTransfer.getData('application/x-folio-file');
                    const bounds = e.currentTarget.getBoundingClientRect();
                    const side =
                      e.clientX < bounds.left + bounds.width * dropBoundary ? 'left' : 'right';
                    setReadingDrag(null);
                    setReadingDropSide(null);
                    if (path === readingDrag) run(() => dropIntoReading(path, side));
                  }}
                >
                  <div
                    className={`reading-drop-preview ${readingDropSide ? 'hovered' : ''}`}
                    style={{
                      left: dropPreviewSide === 'left' ? 0 : `${dropBoundary * 100}%`,
                      right:
                        dropPreviewSide === 'left' && (readingSplit || !existingDragPane)
                          ? `${(1 - dropBoundary) * 100}%`
                          : 0,
                    }}
                  >
                    <BookOpen size={30} />
                    <strong>
                      {existingDragPane
                        ? '松开，切换到已打开的文章'
                        : `松开，在${dropPreviewSide === 'left' ? '左' : '右'}栏打开`}
                    </strong>
                    <span>{readingDrag.split('/').at(-1)}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="welcome">
              <div className="welcome-mark">
                <BookOpen size={38} />
              </div>
              <h1>在文字之间，留下思考。</h1>
              <p>选择一个项目，开始阅读和批注 HTML、PDF。</p>
              <button className="primary-button" onClick={openFolder}>
                <FolderOpen size={17} />
                选择项目
              </button>
              <span>高亮 · 批注 · 手绘 · 笔记</span>
            </div>
          )}
        </main>
        <Inspector
          onClose={() => setRight(false)}
          onRebind={(id) => {
            setRebind(id);
            activateTool('select');
            setMode('read');
            notify('请选中新的原文，然后点击“关联此批注”');
          }}
          doc={doc}
          tab={tab}
          onTab={setTab}
          noteReveal={noteReveal}
          onNoteRevealed={() => setNoteReveal(null)}
          onBoard={(id) => void openBoard(id)}
          noteImages={
            isDesktop && workspace
              ? {
                  url: (name) =>
                    `folio://note-image/${workspace.token}/${encodeURIComponent(name)}`,
                  save: (data) => invoke<string>('save-note-image', { data }),
                }
              : undefined
          }
          onError={(message) => notify(message, true)}
          outline={outline}
          order={order}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            sendToActive('jump', { id });
          }}
          onUpdate={(id, note) =>
            doc &&
            model.annotate(doc.id, (all) => all.map((a) => (a.id === id ? { ...a, note } : a)))
          }
          onDelete={deleteFromList}
          onNote={(note) => doc && model.data(doc.id, { note })}
          onHeading={(id) => sendToActive('heading', { id })}
          onExport={exportNotes}
          orphans={orphans}
          saving={model.saving}
          assistant={
            isDesktop ? (
              <AssistantPanel
                store={assistant}
                mode={assistantMode}
                onMode={setAssistantMode}
                reading={reading}
                selection={mode === 'read' ? selection?.exact || '' : ''}
                onClearSelection={clearSelection}
                onOpenSettings={() => setAiSettingsOpen(true)}
                onOpenPair={(other, scope, threadId) =>
                  run(async () => {
                    await assistant.load(scope);
                    assistant.selectThread(scope, threadId);
                    if (doc) await hostImpl.current!.openBeside(other, doc.path);
                  })
                }
                hasFiles={files.length > 0}
              />
            ) : (
              <div className="inspector-empty">
                <h3>AI 助手仅在桌面版中可用</h3>
              </div>
            )
          }
        />
      </div>
      <Exit when={notice}>
        {(notice) => (
          <div
            key={notice.text}
            className={`toast ${notice.error ? 'error' : ''}`}
            role={notice.error ? 'alert' : 'status'}
          >
            {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}
            <span>{notice.text.replace(/Error invoking remote method '[^']+': Error: /, '')}</span>
            {notice.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  notice.action?.run();
                  setNotice(null);
                }}
              >
                {notice.action.label}
              </button>
            ) : null}
            <IconButton label="关闭提示" onClick={() => setNotice(null)}>
              <X size={15} />
            </IconButton>
          </div>
        )}
      </Exit>
      <Exit
        when={
          (update.status === 'ready' || update.status === 'manual') &&
          !updateHidden &&
          !focus.enabled &&
          update
        }
      >
        {(update) => (
          <UpdateCard
            update={update}
            onRestart={restartToUpdate}
            onDownload={() => run(() => invoke('update-page'))}
            onLater={() => setUpdateHidden(true)}
          />
        )}
      </Exit>
      <Exit when={projectPicker}>
        {(projects) => (
          <ProjectPicker
            projects={projects}
            onOpen={openRecentProject}
            onNew={chooseNewProject}
            onClose={() => setProjectPicker(null)}
          />
        )}
      </Exit>
      <Exit when={historyOpen && doc?.kind === 'html' && { doc, opened: historyOpen }}>
        {({ doc, opened }) => (
          <HistoryPanel
            key={objectKey(opened)}
            doc={doc}
            unsaved={doc.draft !== doc.source && (!autosave || !!doc.autosavePaused)}
            onRestore={restoreBackup}
            onClose={() => setHistoryOpen(null)}
          />
        )}
      </Exit>
      {boardCapture ? (
        <RegionCapture
          hint="拖动框选要讲解的公式、图表或段落 · Esc 取消"
          onCancel={() => setBoardCapture(false)}
          onError={(message) => {
            setBoardCapture(false);
            notify(message, true);
          }}
          onCapture={(png, box) => {
            setBoardCapture(false);
            void Promise.all([prepareImage(png), framedSpot(box)]).then(([picture, spot]) =>
              openWhiteboard({ picture, path: spot?.path, where: spot?.where }),
            );
          }}
        />
      ) : null}
      <Exit when={boardList}>
        {() => (
          <BoardList
            current={lesson?.tutor.id}
            onOpen={(entry) => void openSavedBoard(entry)}
            onBlank={() => {
              setBoardList(false);
              openWhiteboard({ blank: true });
            }}
            onClose={() => setBoardList(false)}
            onDeleted={boardDeleted}
          />
        )}
      </Exit>
      {lesson ? (
        <Suspense fallback={null}>
          <Whiteboard
            tutor={lesson.tutor}
            selection={lesson.selection}
            away={boardAway}
            onAway={setBoardAway}
            awayIn={titleEnd}
            onNotify={notify}
            onHistory={() => setBoardList(true)}
            onOpenSettings={(page) => {
              setAiSettingsPage(page === 'voices' ? page : '');
              setAiSettingsOpen(true);
            }}
            noteTarget={lesson.tutor.source || doc?.path}
            onNote={(picture) => boardToNote(lesson.tutor.entry(), lesson.tutor.get(), picture)}
            noteAsk={noteAsk}
            onClose={() => {
              lesson.tutor.dispose();
              setLesson(null);
            }}
          />
        </Suspense>
      ) : null}
      <Exit when={aiSettingsOpen}>
        {() => (
          <AiSettings
            page={aiSettingsPage}
            onClose={() => {
              setAiSettingsOpen(false);
              setAiSettingsPage('');
            }}
            root={workspace?.root}
            projectName={workspace?.name}
          />
        )}
      </Exit>
      <Exit when={membership}>
        {(membership) => (
          <MembershipDialog
            reason={membership.reason}
            onClose={() => setMembership(null)}
            onNotify={notify}
          />
        )}
      </Exit>
      <Exit when={dialog}>
        {(dialog) => (
          <Dialog key={objectKey(dialog)} options={dialog} onClose={() => setDialog(null)} />
        )}
      </Exit>
    </div>
  );
}
