import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import { invoke, subscribe, useWorkspace, documentUrl, isDesktop } from './api';
import type { Anchor, FrameEvent, OpenDocument, OutlineItem, Tool, WorkspaceInfo } from './types';
import { FileTree } from './components/FileTree';
import type { FileAction } from './components/FileTree';
import { DocumentTabs } from './components/DocumentTabs';
import { Toolbar } from './components/Toolbar';
import { ReaderFrame } from './components/ReaderFrame';
import { stickyNoteSize } from './reader/note-size';
import type { ReaderHandle } from './components/ReaderFrame';
import { Inspector } from './components/Inspector';
import type { InspectorTab } from './components/Inspector';
import { Dialog } from './components/Dialog';
import type { DialogOptions } from './components/Dialog';
import { IconButton } from './components/IconButton';
import { useDocuments } from './hooks/useDocuments';
const SourceEditor = lazy(() => import('./components/SourceEditor'));
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
function firstHTML(tree: WorkspaceInfo['tree']): string | undefined {
  for (const n of tree) {
    if (n.kind === 'html') return n.path;
    const found = firstHTML(n.children || []);
    if (found) return found;
  }
}
export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  const onError = useCallback((s: string) => notify(s, true), [notify]);
  const model = useDocuments(onError);
  const doc = model.docs.find((d) => d.id === model.active);
  const [mode, setMode] = useState<'read' | 'source'>('read');
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState('#edbd39');
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
  const [inkSettingsOpen, setInkSettingsOpen] = useState(false);
  const [stickySize, setStickySize] = useState(() => {
    try {
      return stickyNoteSize(JSON.parse(localStorage.getItem('folio.sticky-size') || 'null'));
    } catch {
      return stickyNoteSize(null);
    }
  });
  const [tab, setTab] = useState<InspectorTab>('annotations');
  const [selected, setSelected] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [selection, setSelection] = useState<Anchor | null>(null);
  const [rebind, setRebind] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [dialog, setDialog] = useState<DialogOptions | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [findMissing, setFindMissing] = useState(false);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const reader = useRef<ReaderHandle>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  const sessionReady = useRef(false);
  const current = useRef({ model, doc });
  current.current = { model, doc };
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
  function run(action: () => Promise<unknown>) {
    void action().catch((e) => notify((e as Error).message, true));
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    run(async () => {
      const w = await invoke<WorkspaceInfo>('workspace');
      useWorkspace(w);
      const paths =
        w.session?.paths || ([firstHTML(w.tree)].filter(Boolean) as string[]);
      for (const p of paths) {
        try {
          await model.open(p);
        } catch (e) {
          notify((e as Error).message, true);
        }
      }
      const activeDoc = model.docsRef.current.find((d) => d.path === w.session?.active);
      if (activeDoc) model.setActive(activeDoc.id);
      sessionReady.current = true;
      setWorkspace(w);
    });
  }, []);
  const sessionSignature = model.docs.map((d) => d.path).join('\0');
  useEffect(() => {
    if (workspace && sessionReady.current)
      model.session(
        model.docs.map((d) => d.path),
        doc?.path || '',
      );
  }, [sessionSignature, model.active, workspace?.token]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setOutline([]);
    setOrphans([]);
    setSelection(null);
    setProgress(0);
    setSelected(null);
    setRebind(null);
  }, [doc?.id]);
  useEffect(() => {
    if (!doc || doc.draft === doc.source) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const id = doc.id;
    const timer = setTimeout(() => {
      invoke<string>('preview', { path: doc.path, source: doc.draft })
        .then((url) => {
          if (!cancelled) setPreview({ id, url });
        })
        .catch((e) => {
          if (!cancelled) notify(e.message, true);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc?.id, doc?.draft, doc?.source, doc?.path]);
  useEffect(() => {
    if (finding) findInput.current?.focus();
  }, [finding]);
  const liveActions = useRef({
    save: () => {},
    folder: () => {},
    find: () => {},
    close: () => {},
    refresh: () => {},
  });
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'save') liveActions.current.save();
        if (e.type === 'open-folder') liveActions.current.folder();
        if (e.type === 'find') liveActions.current.find();
        if (e.type === 'close-request') liveActions.current.close();
        if (e.type === 'files-changed') liveActions.current.refresh();
      }),
    [],
  );
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      const input = (e.target as Element)?.closest('input,textarea,.cm-editor');
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
        liveActions.current.find();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !input) {
        e.preventDefault();
        const { model, doc } = current.current;
        if (doc) model.undo(doc.id, e.shiftKey);
      }
      if (e.key === 'Escape') {
        setTool('select');
        setFinding(false);
        setSelection(null);
      }
    }
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  function guardDirty(
    docs: OpenDocument[],
    action: () => Promise<unknown>,
    title = '放弃未保存的源码修改？',
  ) {
    const dirty = docs.filter((d) => d.draft !== d.source);
    if (dirty.length)
      setDialog({
        title,
        message: `${dirty.map((d) => d.path.split('/').at(-1)).join('、')} 尚未保存。继续会放弃源码修改；批注和笔记已单独保存。`,
        danger: true,
        confirmLabel: '放弃修改并继续',
        onConfirm: action,
      });
    else run(action);
  }
  async function refresh() {
    setWorkspace(await invoke<WorkspaceInfo>('tree'));
  }
  function openFolder() {
    guardDirty(model.docs, async () => {
      await model.flush();
      const w = await invoke<WorkspaceInfo | null>('choose-folder');
      if (!w) return;
      sessionReady.current = false;
      model.clear();
      useWorkspace(w);
      setMode('read');
      const paths = w.session?.paths || ([firstHTML(w.tree)].filter(Boolean) as string[]);
      for (const p of paths) {
        try {
          await model.open(p);
        } catch (e) {
          notify((e as Error).message, true);
        }
      }
      const activeDoc = model.docsRef.current.find((d) => d.path === w.session?.active);
      if (activeDoc) model.setActive(activeDoc.id);
      sessionReady.current = true;
      setWorkspace(w);
    });
  }
  function save() {
    if (doc?.draft === doc?.source) {
      notify('没有未保存的源码修改');
      return;
    }
    if (doc)
      run(async () => {
        await model.save(doc.id);
        notify('HTML 已保存，修改前的版本已备份');
      });
  }
  function startFind() {
    setMode('read');
    setFinding(true);
  }
  liveActions.current = {
    save,
    folder: openFolder,
    find: startFind,
    close: () =>
      guardDirty(model.docs, async () => {
        await model.flush();
        await invoke('close');
      }),
    refresh: () => run(refresh),
  };
  function fileAction(action: FileAction, path: string) {
    if (action === 'reveal') {
      run(() => invoke('reveal', { path }));
      return;
    }
    if (action === 'trash') {
      const affected = model.docs.filter((d) => d.path === path || d.path.startsWith(path + '/'));
      setDialog({
        title: '移到废纸篓？',
        message: `${path} 将移到系统废纸篓。${affected.some((d) => d.draft !== d.source) ? '未保存的源码修改会被放弃。' : ''}批注数据仍保留，恢复文件后可以继续阅读。`,
        danger: true,
        confirmLabel: '移到废纸篓',
        onConfirm: async () => {
          await model.flush();
          setWorkspace(await invoke('trash', { path }));
          affected.forEach((d) => model.close(d.id));
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
          if (!folder) await model.open(target);
        } else {
          setWorkspace(await invoke('move', { from: path, to: target }));
          model.move(path, target);
        }
      },
    });
  }
  function chooseTool(next: Tool) {
    setTool(next);
    if (next === 'text' && color === '#edbd39') setColor('#334155');
    if (selection && ['highlight', 'underline'].includes(next)) {
      reader.current?.send('annotate', { tool: next });
      setSelection(null);
    }
  }
  function event(e: FrameEvent) {
    if (!doc) return;
    const id = doc.id;
    switch (e.type) {
      case 'pointerdown':
        setInkSettingsOpen(false);
        break;
      case 'outline':
        setOutline(e.items);
        break;
      case 'selection':
        setSelection(e.quote);
        break;
      case 'scroll':
        if (Math.abs(e.scroll - doc.data.scroll) > 3) model.data(id, { scroll: e.scroll });
        setProgress(Math.max(0, Math.min(100, e.progress || 0)));
        break;
      case 'orphans':
        setOrphans(e.ids);
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
        setSelected(a.id);
        setSelection(null);
        break;
      }
      case 'select-annotation':
        setSelected(e.id);
        break;
      case 'update-annotation':
        if (e.patch?.size && doc.data.annotations.find((a) => a.id === e.id)?.type === 'sticky')
          setStickySize(stickyNoteSize(e.patch.size));
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
        setTool('select');
        setSelection(null);
        break;
      case 'shortcut':
        if (e.key === 's') save();
        if (e.key === 'f') startFind();
        if (e.key === 'z') model.undo(id, e.shift);
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
            if (/\.html?$/i.test(path)) await model.open(path);
            else notify('该链接不是 HTML 文档');
          } else if (!isDesktop && url.pathname.startsWith('/__asset/')) {
            const path = url.pathname.split('/').slice(3).map(decodeURIComponent).join('/');
            await model.open(path);
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
  const url = doc
    ? preview?.id === doc.id
      ? preview.url
      : documentUrl(doc.path, doc.preview)
    : '';
  return (
    <div className={`app-shell ${left ? '' : 'hide-left'} ${right ? '' : 'hide-right'}`}>
      <header className="titlebar">
        {!isDesktop ? (
          <div className="traffic-lights">
            <i />
            <i />
            <i />
          </div>
        ) : null}
        <div className="brand">
          <BookOpen size={18} />
          <strong>页间</strong>
          <span>Folio</span>
        </div>
        <span className="titlebar-document">{workspace?.name}</span>
      </header>
      <div className="workspace-layout">
        <FileTree
          onClose={() => setLeft(true)}
          workspace={workspace}
          active={doc?.path}
          onOpen={(p) => run(() => model.open(p))}
          onFolder={openFolder}
          onAction={fileAction}
          onRefresh={() => run(refresh)}
        />
        <main className="main-panel">
          <DocumentTabs
            docs={model.docs}
            active={model.active}
            onSelect={model.setActive}
            onClose={(id) => {
              const d = model.docs.find((d) => d.id === id);
              if (d)
                guardDirty([d], async () => {
                  await model.flush();
                  model.close(id);
                });
            }}
            onNew={() => fileAction('create-file', '')}
          />
          <Toolbar
            mode={mode}
            onMode={setMode}
            tool={tool}
            onTool={chooseTool}
            color={color}
            onColor={setColor}
            zoom={doc?.data.zoom || 0}
            onZoom={(zoom) => doc && model.data(doc.id, { zoom })}
            onLeft={() => setLeft((v) => !v)}
            onRight={() => setRight((v) => !v)}
            onFind={startFind}
            onSave={save}
            onReload={() => doc && guardDirty([doc], () => model.reload(doc.id), '重新载入文件？')}
            dirty={!!doc && doc.draft !== doc.source}
            onUndo={() => doc && model.undo(doc.id)}
            onRedo={() => doc && model.undo(doc.id, true)}
            canUndo={!!doc?.history.length}
            canRedo={!!doc?.future.length}
            disabled={!doc}
            strokeWidth={strokeWidth}
            eraserSize={eraserSize}
            onStrokeWidth={setStrokeWidth}
            onEraserSize={setEraserSize}
            settingsOpen={inkSettingsOpen}
            onSettingsOpenChange={setInkSettingsOpen}
          />
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
                  if (e.key === 'Enter')
                    reader.current?.send('find', { query, backwards: e.shiftKey });
                }}
              />
              {findMissing ? <span>未找到</span> : null}
              <IconButton
                label="上一个结果"
                onClick={() => reader.current?.send('find', { query, backwards: true })}
              >
                <ChevronLeft size={16} />
              </IconButton>
              <IconButton
                label="下一个结果"
                onClick={() => reader.current?.send('find', { query })}
              >
                <ChevronRight size={16} />
              </IconButton>
              <IconButton label="关闭查找" onClick={() => setFinding(false)}>
                <X size={15} />
              </IconButton>
            </div>
          ) : null}
          {doc ? (
            <div className={`document-workbench ${mode === 'source' ? 'split-editor' : ''}`}>
              {mode === 'source' ? (
                <div className="editor-pane">
                  <div className="pane-caption">
                    <Code2 size={13} />
                    源码{doc.draft !== doc.source ? <span>未保存</span> : <span>已保存</span>}
                  </div>
                  <Suspense fallback={<div className="editor-loading">正在载入编辑器…</div>}>
                    <SourceEditor
                      key={doc.id}
                      value={doc.draft}
                      onChange={(draft) => model.update(doc.id, (d) => ({ ...d, draft }))}
                      onSave={save}
                    />
                  </Suspense>
                </div>
              ) : null}
              <div className="reader-pane">
                {mode === 'source' ? (
                  <div className="pane-caption">
                    <BookOpen size={13} />
                    实时预览<span>修改后自动更新</span>
                  </div>
                ) : null}
                <ReaderFrame
                  key={doc.id}
                  ref={reader}
                  url={url}
                  annotations={doc.data.annotations}
                  tool={mode === 'source' ? 'select' : tool}
                  color={color}
                  strokeWidth={strokeWidth}
                  eraserSize={eraserSize}
                  stickySize={stickySize}
                  zoom={mode === 'source' ? 0 : doc.data.zoom}
                  scroll={doc.data.scroll}
                  onEvent={event}
                />
              </div>
              {selection && mode === 'read' ? (
                <div className="selection-toolbar" onMouseDown={(e) => e.preventDefault()}>
                  <span>已选 {selection.exact.length} 字</span>
                  {rebind ? (
                    <button
                      onClick={() => {
                        model.annotate(doc.id, (all) =>
                          all.map((a) => (a.id === rebind ? { ...a, quote: selection } : a)),
                        );
                        setSelection(null);
                        setRebind(null);
                        notify('批注已关联到新的原文');
                      }}
                    >
                      <MessageSquare size={15} />
                      关联此批注
                    </button>
                  ) : null}
                  <button onClick={() => chooseTool('highlight')}>
                    <Highlighter size={15} />
                    高亮
                  </button>
                  <button onClick={() => chooseTool('underline')}>
                    <Underline size={15} />
                    划线
                  </button>
                  <IconButton label="取消文字选择" onClick={() => setSelection(null)}>
                    <X size={13} />
                  </IconButton>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="welcome">
              <div className="welcome-mark">
                <BookOpen size={38} />
              </div>
              <h1>在文字之间，留下思考。</h1>
              <p>打开一个文件夹，让 HTML 成为你的阅读工作空间。</p>
              <button className="primary-button" onClick={openFolder}>
                <FolderOpen size={17} />
                打开文件夹
              </button>
              <span>高亮 · 批注 · 手绘 · 笔记</span>
            </div>
          )}
        </main>
        <Inspector
          onClose={() => setRight(false)}
          onRebind={(id) => {
            setRebind(id);
            setTool('select');
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
            reader.current?.send('jump', { id });
          }}
          onUpdate={(id, note) =>
            doc &&
            model.annotate(doc.id, (all) => all.map((a) => (a.id === id ? { ...a, note } : a)))
          }
          onDelete={(id) => doc && model.annotate(doc.id, (all) => all.filter((a) => a.id !== id))}
          onNote={(note) => doc && model.data(doc.id, { note })}
          onHeading={(id) => reader.current?.send('heading', { id })}
          onExport={exportNotes}
          orphans={orphans}
          saving={model.saving}
        />
      </div>
      <footer className="statusbar">
        <span className="status-format">HTML</span>
        <span className={`save-state ${notice?.error ? 'error' : ''}`}>
          <i />
          {model.saving ? '正在保存…' : notice?.error ? '请检查提示' : '本地保存'}
        </span>
        <span className="status-hint">
          {mode === 'source'
            ? doc?.draft !== doc?.source
              ? '源码有未保存的修改'
              : '源码修改会自动保留历史备份'
            : toolHints[tool]}
        </span>
        <div className="status-spacer" />
        <span>{doc?.data.annotations.length || 0} 条批注</span>
        <span>阅读进度 {progress}%</span>
        <div className="reading-progress">
          <i style={{ width: progress + '%' }} />
        </div>
      </footer>
      {notice ? (
        <div
          className={`toast ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{notice.text.replace(/^Error invoking remote method '[^']+': Error: /, '')}</span>
          <IconButton label="关闭提示" onClick={() => setNotice(null)}>
            <X size={15} />
          </IconButton>
        </div>
      ) : null}
      {dialog ? <Dialog options={dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
