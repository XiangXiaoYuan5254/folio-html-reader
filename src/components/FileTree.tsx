import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import {
  FolderOpen,
  Folder,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  File,
  Search,
  Plus,
  RefreshCw,
  MoreHorizontal,
  HardDrive,
  BookOpen,
  X,
} from 'lucide-react';
import type { FileNode, WorkspaceInfo } from '../types';
import { IconButton } from './IconButton';
import { SidebarResizer } from './SidebarResizer';
import { importFiles, invoke } from '../api';
export type FileAction = 'create-file' | 'create-folder' | 'rename' | 'move' | 'trash' | 'reveal';
export function FileTree({
  workspace,
  active,
  onOpen,
  onFolder,
  onAction,
  onMove,
  onRefresh,
  onClose,
  onReadingDrag,
  onImported,
  onImportError,
  status,
}: {
  workspace: WorkspaceInfo | null;
  active?: string;
  onOpen: (p: string) => void;
  onFolder: () => void;
  onAction: (action: FileAction, path: string) => void;
  onMove: (from: string, to: string) => Promise<boolean>;
  onRefresh: () => void;
  onClose: () => void;
  onReadingDrag: (path: string | null) => void;
  onImported: (result: { workspace: WorkspaceInfo; imported: string[] }) => void;
  onImportError: (message: string) => void;
  status?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [pasteDestination, setPasteDestination] = useState('');
  const [copying, setCopying] = useState(false);
  const importing = useRef(false);
  async function copyFiles(folder: string, files?: File[]) {
    if (!workspace || importing.current) return;
    importing.current = true;
    setCopying(true);
    setMenu(null);
    try {
      const result = files
        ? await importFiles(files, folder)
        : await invoke<{ workspace: WorkspaceInfo; imported: string[] }>('paste-files', {
            destination: folder,
          });
      onImported(result);
      setPasteDestination(folder);
      setCollapsed((previous) => new Set([...previous].filter((p) => p !== folder)));
    } catch (error) {
      onImportError((error as Error).message);
    } finally {
      importing.current = false;
      setCopying(false);
    }
  }
  const pasteAction = useRef(() => {});
  pasteAction.current = () => {
    void copyFiles(pasteDestination);
  };
  useEffect(() => {
    const paste = () => pasteAction.current();
    window.addEventListener('folio-paste-files', paste);
    return () => window.removeEventListener('folio-paste-files', paste);
  }, []);
  const externalFiles = (e: DragEvent<HTMLElement>) =>
    !dragSource.current && e.dataTransfer.types.includes('Files');
  const dragSource = useRef<FileNode | null>(null);
  const folderHover = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const parentOf = (path: string) =>
    path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  function clearHover() {
    if (folderHover.current) clearTimeout(folderHover.current.timer);
    folderHover.current = null;
  }
  useEffect(() => () => clearHover(), []);
  function endDrag() {
    onReadingDrag(null);
    dragSource.current = null;
    setDragging(null);
    setDropTarget(null);
    clearHover();
  }
  function canDrop(folder: string) {
    const source = dragSource.current;
    return (
      !!source &&
      !moving &&
      parentOf(source.path) !== folder &&
      source.path !== folder &&
      !(source.kind === 'folder' && folder.startsWith(source.path + '/'))
    );
  }
  function dropHandlers(folder: string) {
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (copying || (!canDrop(folder) && !externalFiles(e))) {
          e.dataTransfer.dropEffect = 'none';
          setDropTarget(null);
          clearHover();
          return;
        }
        e.dataTransfer.dropEffect = externalFiles(e) ? 'copy' : 'move';
        setDropTarget(folder);
        if (folderHover.current?.path !== folder) {
          clearHover();
          if (folder && collapsed.has(folder)) {
            folderHover.current = {
              path: folder,
              timer: setTimeout(() => {
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  next.delete(folder);
                  return next;
                });
              }, 650),
            };
          }
        }
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropTarget((current) => (current === folder ? null : current));
        clearHover();
      },
      onDrop: async (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (externalFiles(e)) {
          const files = Array.from(e.dataTransfer.files);
          endDrag();
          await copyFiles(folder, files);
          return;
        }
        const source = dragSource.current;
        const valid = canDrop(folder);
        endDrag();
        if (!source || !valid) return;
        setMoving(true);
        try {
          const target = (folder ? folder + '/' : '') + source.name;
          if (await onMove(source.path, target)) {
            setCollapsed(
              (prev) =>
                new Set(
                  [...prev]
                    .map((p) =>
                      p === source.path || p.startsWith(source.path + '/')
                        ? target + p.slice(source.path.length)
                        : p,
                    )
                    .filter((p) => p !== folder),
                ),
            );
          }
        } finally {
          setMoving(false);
        }
      },
    };
  }
  function match(n: FileNode): boolean {
    return n.name.toLowerCase().includes(query.toLowerCase()) || !!n.children?.some(match);
  }
  function rows(nodes: FileNode[], depth = 0) {
    return nodes.filter(match).map((n) => (
      <div key={n.path}>
        <div
          className={`tree-row ${n.kind} ${n.path === active ? 'selected' : ''} ${dragging === n.path ? 'dragging' : ''} ${n.kind === 'folder' && pasteDestination === n.path ? 'paste-destination' : ''} ${n.kind === 'folder' && dropTarget === n.path ? 'drop-target' : ''}`}
          onPointerDownCapture={() =>
            setPasteDestination(n.kind === 'folder' ? n.path : parentOf(n.path))
          }
          onContextMenu={(e) => {
            e.preventDefault();
            setPasteDestination(n.kind === 'folder' ? n.path : parentOf(n.path));
            e.currentTarget.querySelector('button')?.focus();
            setMenu(n.path);
          }}
          data-file-path={n.path}
          style={{ paddingLeft: 12 + depth * 16 }}
          draggable={!moving && !copying}
          onDragStart={(e) => {
            dragSource.current = n;
            e.dataTransfer.effectAllowed =
              n.kind === 'html' || n.kind === 'pdf' ? 'copyMove' : 'move';
            e.dataTransfer.setData('application/x-folio-file', n.path);
            onReadingDrag(n.kind === 'html' || n.kind === 'pdf' ? n.path : null);
            setDragging(n.path);
            setMenu(null);
          }}
          onDragEnd={endDrag}
          {...dropHandlers(n.kind === 'folder' ? n.path : parentOf(n.path))}
        >
          <button
            className="tree-item"
            title={n.path}
            aria-expanded={n.kind === 'folder' ? !collapsed.has(n.path) : undefined}
            onClick={() =>
              n.kind === 'folder'
                ? setCollapsed((prev) => {
                    const s = new Set(prev);
                    s.has(n.path) ? s.delete(n.path) : s.add(n.path);
                    return s;
                  })
                : n.kind === 'html' || n.kind === 'pdf'
                  ? onOpen(n.path)
                  : onAction('reveal', n.path)
            }
          >
            {n.kind === 'folder' ? (
              <>
                {collapsed.has(n.path) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                {collapsed.has(n.path) ? (
                  <Folder className="tree-icon-folder" size={17} />
                ) : (
                  <FolderOpen className="tree-icon-folder" size={17} />
                )}
              </>
            ) : (
              <>
                <span className="tree-spacer" />
                {n.kind === 'pdf' ? (
                  <FileText className="tree-icon-pdf" size={16} />
                ) : n.kind === 'html' ? (
                  <FileCode2 className="tree-icon-html" size={16} />
                ) : (
                  <File size={16} />
                )}
              </>
            )}
            <span>{n.name}</span>
          </button>
          <IconButton
            label={`${n.name} 的操作`}
            onClick={() => setMenu(menu === n.path ? null : n.path)}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        </div>
        {menu === n.path ? (
          <div className="tree-menu">
            <button
              disabled={copying}
              onClick={() => void copyFiles(n.kind === 'folder' ? n.path : parentOf(n.path))}
            >
              粘贴文件 <kbd>⌘ V</kbd>
            </button>
            {(n.kind === 'folder'
              ? [
                  ['create-file', '新建 HTML'],
                  ['create-folder', '新建文件夹'],
                ]
              : []
            )
              .concat([
                ['rename', '重命名'],
                ['move', '移动到…'],
                ['reveal', '在 Finder 中显示'],
                ['trash', '移到废纸篓'],
              ])
              .map(([action, label]) => (
                <button
                  key={action}
                  onClick={() => {
                    onAction(action as FileAction, n.path);
                    setMenu(null);
                  }}
                >
                  {label}
                </button>
              ))}
          </div>
        ) : null}
        {n.kind === 'folder' && !collapsed.has(n.path) ? rows(n.children || [], depth + 1) : null}
      </div>
    ));
  }
  const count = (nodes: FileNode[]): number =>
    nodes.reduce(
      (n, f) => n + (f.kind === 'html' || f.kind === 'pdf' ? 1 : count(f.children || [])),
      0,
    );
  return (
    <aside className="file-sidebar" id="project-file-sidebar">
      <div className="sidebar-heading">
        <span>工作空间</span>
        <IconButton className="drawer-close" label="收起文件树" onClick={onClose}>
          <X size={16} />
        </IconButton>
        <IconButton label="刷新文件树" onClick={onRefresh}>
          <RefreshCw size={15} />
        </IconButton>
      </div>
      <button className="open-folder" onClick={onFolder}>
        <FolderOpen size={17} />
        打开文件夹 <kbd>⌘ O</kbd>
      </button>
      <label className="tree-search">
        <Search size={14} />
        <input
          aria-label="搜索文件"
          placeholder="搜索文件…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div
        className={`project-label ${pasteDestination === '' ? 'paste-destination' : ''} ${dropTarget === '' ? 'drop-target' : ''}`}
        tabIndex={0}
        onClick={(e) => {
          if (!(e.target as Element).closest('button')) {
            setPasteDestination('');
            e.currentTarget.focus();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setPasteDestination('');
          e.currentTarget.focus();
          setMenu(menu === '' ? null : '');
        }}
        {...dropHandlers('')}
      >
        <FolderOpen size={16} />
        <span title={workspace?.root}>{workspace?.name || '选择一个项目'}</span>
        <IconButton
          label="新建 HTML"
          onClick={() => onAction('create-file', '')}
          disabled={!workspace}
        >
          <Plus size={15} />
        </IconButton>
        <IconButton
          label="新建文件夹"
          onClick={() => onAction('create-folder', '')}
          disabled={!workspace}
        >
          <Folder size={14} />
        </IconButton>
      </div>
      {menu === '' && workspace ? (
        <div className="tree-menu">
          <button disabled={copying} onClick={() => void copyFiles('')}>
            粘贴到工作空间 <kbd>⌘ V</kbd>
          </button>
        </div>
      ) : null}
      <div
        className={`file-tree ${dropTarget === '' ? 'drop-target' : ''}`}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            setPasteDestination('');
            setMenu(null);
            e.currentTarget.focus();
          }
        }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setPasteDestination('');
            e.currentTarget.focus();
            setMenu('');
          }
        }}
        role="navigation"
        aria-label="项目文件"
        aria-description="从访达拖入文件，或选择文件夹后按 Command V 粘贴；项目名称和空白处代表根目录"
        aria-busy={moving || copying}
        {...dropHandlers('')}
      >
        {workspace ? rows(workspace.tree) : null}
        {workspace && !workspace.tree.some(match) ? (
          <div className="tree-empty">没有找到文件</div>
        ) : null}
      </div>
      {dragging !== null || moving || copying || dropTarget !== null ? (
        <div className="tree-drop-hint" role="status">
          {copying
            ? '正在复制文件…'
            : moving
              ? '正在移动…'
              : dropTarget !== null
                ? `${dragSource.current ? '移动' : '复制'}到：${dropTarget || '项目根目录'}`
                : dragSource.current?.kind === 'html' || dragSource.current?.kind === 'pdf'
                  ? '拖到阅读区并排打开，或拖到文件夹移动'
                  : '拖到文件夹或项目名称移动'}
        </div>
      ) : null}
      <div className="sidebar-footer">
        <div>
          <HardDrive size={16} />
          <span>本地工作空间</span>
          <span className="connection-dot" />
        </div>
        <p>
          <BookOpen size={13} />
          {workspace ? count(workspace.tree) : 0} 份文档（HTML / PDF）
        </p>
      </div>
      <SidebarResizer />
      {status}
    </aside>
  );
}
