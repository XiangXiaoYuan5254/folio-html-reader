import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import { invoke, subscribe, useWorkspace, isDesktop } from './api';
import { isMac, shortcut, trashName } from './platform';
import type {
  Anchor,
  BackupEntry,
  EraserMode,
  FrameEvent,
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
import { Inspector } from './components/Inspector';
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
const SourceEditor = lazy(() => import('./components/SourceEditor'));
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
type PaneSide = 'left' | 'right';
type ReaderState = {
  selected: string | null;
  selection: Anchor | null;
  rebind: string | null;
  outline: OutlineItem[];
  orphans: string[];
  progress: number;
};
const emptyReaderState: ReaderState = {
  selected: null,
  selection: null,
  rebind: null,
  outline: [],
  orphans: [],
  progress: 0,
};
export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
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
  const focusedSide = useRef<PaneSide>('left');
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('folio.reading-split-ratio'));
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
  const [tab, setTab] = useState<InspectorTab>('annotations');
  const [readerStates, setReaderStates] = useState<Record<string, ReaderState>>({});
  const { selected, outline, orphans, selection, rebind, progress } =
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
  const [appVersion, setAppVersion] = useState('');
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  // “稍后” hides the card; the title bar keeps a button to bring it back.
  const [updateHidden, setUpdateHidden] = useState(false);
  const updateVersion = update.status === 'idle' ? '' : update.version;
  useEffect(() => setUpdateHidden(false), [update.status, updateVersion]);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => setHistoryOpen(false), [mode, doc?.id]);
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
    const timer = setTimeout(() => setNotice(null), 3500);
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
  function guardDirty(
    docs: OpenDocument[],
    action: () => Promise<unknown>,
    title = '放弃未保存的源码修改？',
  ) {
    run(async () => {
      // With auto-save, in-flight saves finish first; only edits that could not be saved need confirming.
      if (autosave) await model.saveAll(docs.map((d) => d.id));
      const ids = new Set(docs.map((d) => d.id));
      const dirty = model.docsRef.current.filter((d) => ids.has(d.id) && d.draft !== d.source);
      if (dirty.length)
        setDialog({
          title,
          message: `${dirty.map((d) => d.path.split('/').at(-1)).join('、')} ${autosave ? '未能保存' : '尚未保存'}。继续会放弃源码修改；批注和笔记已单独保存。`,
          danger: true,
          confirmLabel: '放弃修改并继续',
          onConfirm: action,
        });
      else await action();
    });
  }
  async function refresh() {
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
    if (closing)
      guardDirty([closing], async () => {
        await model.flush();
        closeDocument(id);
      });
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
    model.clear();
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
      await model.flush();
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
      await model.flush();
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
      await model.flush();
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
    setHistoryOpen(false);
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
    close: () =>
      guardDirty(model.docs, async () => {
        await model.flush();
        await invoke('close');
      }),
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
  const restartToUpdate = () =>
    guardDirty(model.docs, async () => {
      await model.flush();
      await invoke('update-restart');
    });
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
  function event(id: string, e: FrameEvent) {
    const doc = model.docsRef.current.find((d) => d.id === id);
    if (!doc) return;
    switch (e.type) {
      case 'activate':
        if (model.active !== id) selectDocument(id);
        break;
      case 'pointerdown':
        window.getSelection()?.removeAllRanges();
        if (model.active !== id) selectDocument(id);
        setInkSettingsOpen(false);
        focus.setToolsVisible(false);
        break;
      case 'outline':
        patchReader(id, { outline: e.items });
        break;
      case 'selection':
        patchReader(id, { selection: e.quote });
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
            if (/\.(html?|pdf)$/i.test(path))
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
  const existingDragPane = readingDrag
    ? panes.find((pane) => pane.doc?.path === readingDrag)
    : undefined;
  const dropPreviewSide = existingDragPane?.side || readingDropSide || 'right';
  const dropBoundary = readingSplit ? splitRatio : 0.5;
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
        <div className="titlebar-end">
          {updateHidden && (update.status === 'ready' || update.status === 'manual') ? (
            <button type="button" className="update-chip" onClick={() => setUpdateHidden(false)}>
              {update.status === 'ready' ? '重启以更新' : '有新版本'} {update.version}
            </button>
          ) : null}
          <span className="titlebar-document">{workspace?.name}</span>
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
              onFocusMode={() => liveActions.current.focus()}
              pdf={doc?.kind === 'pdf'}
              mode={mode}
              onMode={setMode}
              tool={tool}
              onTool={chooseTool}
              color={color}
              onColor={setColor}
              canLinkScroll={!!readingSplit && !!readingSplit.right}
              linkedScroll={linkedScroll}
              onLinkedScroll={() => setLinkedScroll((v) => !v)}
              zoom={doc?.data.zoom || 0}
              onZoom={(zoom) => doc && model.data(doc.id, { zoom })}
              onLeft={() => setLeft((v) => !v)}
              onRight={() => setRight((v) => !v)}
              onFind={startFind}
              onSave={save}
              inspecting={inspecting}
              onInspect={() => setInspecting((v) => !v)}
              autosave={autosave}
              onAutosave={toggleAutosave}
              onReload={() =>
                doc && guardDirty([doc], () => model.reload(doc.id), '重新载入文件？')
              }
              onHistory={() => setHistoryOpen(true)}
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
              className={`document-workbench ${mode === 'source' ? 'split-editor' : ''} ${readingSplit ? 'split-reading' : ''}`}
            >
              {mode === 'source' ? (
                <div className="editor-pane">
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
              {panes.map(({ side, doc: paneDoc }, index) => (
                <Fragment key={side}>
                  {index === 1 ? (
                    <ReadingResizer ratio={splitRatio} onChange={setSplitRatio} />
                  ) : null}
                  <div
                    className={`reader-pane${readingSplit ? ' reading-column' : ''}${paneDoc?.id === doc.id ? ' active-column' : ''}`}
                    data-pane={side}
                    data-document-id={paneDoc?.id}
                    style={
                      readingSplit && index === 0
                        ? { flex: `0 0 calc(${splitRatio * 100}% - 3px)` }
                        : undefined
                    }
                  >
                    {readingSplit ? (
                      <div
                        className="reading-column-header"
                        onPointerDown={() => {
                          focusedSide.current = side;
                          if (paneDoc) selectDocument(paneDoc.id);
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
                                (path) =>
                                  !panes.some((p) => p.side !== side && p.doc?.path === path),
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
                    {paneDoc ? (
                      <DocumentReader
                        key={paneDoc.id}
                        live={mode === 'source'}
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
                        zoom={mode === 'source' ? 0 : paneDoc.data.zoom}
                        zoomable={mode === 'read'}
                        linkedScroll={!!readingSplit && !!readingSplit.right && linkedScroll}
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
                      <div className="selection-toolbar" onMouseDown={(e) => e.preventDefault()}>
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
                        <IconButton label="取消文字选择" onClick={clearSelection}>
                          <X size={13} />
                        </IconButton>
                      </div>
                    ) : null}
                  </div>
                </Fragment>
              ))}
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
          outline={outline}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            sendToActive('jump', { id });
          }}
          onUpdate={(id, note) =>
            doc &&
            model.annotate(doc.id, (all) => all.map((a) => (a.id === id ? { ...a, note } : a)))
          }
          onDelete={(id) => doc && model.annotate(doc.id, (all) => all.filter((a) => a.id !== id))}
          onNote={(note) => doc && model.data(doc.id, { note })}
          onHeading={(id) => sendToActive('heading', { id })}
          onExport={exportNotes}
          orphans={orphans}
          saving={model.saving}
        />
      </div>
      {notice ? (
        <div
          className={`toast ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{notice.text.replace(/Error invoking remote method '[^']+': Error: /, '')}</span>
          <IconButton label="关闭提示" onClick={() => setNotice(null)}>
            <X size={15} />
          </IconButton>
        </div>
      ) : null}
      {(update.status === 'ready' || update.status === 'manual') &&
      !updateHidden &&
      !focus.enabled ? (
        <UpdateCard
          update={update}
          onRestart={restartToUpdate}
          onDownload={() => run(() => invoke('update-page'))}
          onLater={() => setUpdateHidden(true)}
        />
      ) : null}
      {projectPicker ? (
        <ProjectPicker
          projects={projectPicker}
          onOpen={openRecentProject}
          onNew={chooseNewProject}
          onClose={() => setProjectPicker(null)}
        />
      ) : null}
      {historyOpen && doc?.kind === 'html' ? (
        <HistoryPanel
          doc={doc}
          unsaved={doc.draft !== doc.source && (!autosave || !!doc.autosavePaused)}
          onRestore={restoreBackup}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
      {dialog ? <Dialog options={dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
