import { useState } from 'react';
import {
  FolderOpen,
  Folder,
  ChevronDown,
  ChevronRight,
  FileCode2,
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
export type FileAction = 'create-file' | 'create-folder' | 'rename' | 'move' | 'trash' | 'reveal';
export function FileTree({
  workspace,
  active,
  onOpen,
  onFolder,
  onAction,
  onRefresh,
  onClose,
}: {
  workspace: WorkspaceInfo | null;
  active?: string;
  onOpen: (p: string) => void;
  onFolder: () => void;
  onAction: (action: FileAction, path: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  function match(n: FileNode): boolean {
    return n.name.toLowerCase().includes(query.toLowerCase()) || !!n.children?.some(match);
  }
  function rows(nodes: FileNode[], depth = 0) {
    return nodes.filter(match).map((n) => (
      <div key={n.path}>
        <div
          className={`tree-row ${n.path === active ? 'selected' : ''} ${n.kind === 'asset' ? 'asset' : ''}`}
          style={{ paddingLeft: 12 + depth * 16 }}
        >
          <button
            className="tree-item"
            title={n.path}
            onClick={() =>
              n.kind === 'folder'
                ? setCollapsed((prev) => {
                    const s = new Set(prev);
                    s.has(n.path) ? s.delete(n.path) : s.add(n.path);
                    return s;
                  })
                : n.kind === 'html'
                  ? onOpen(n.path)
                  : onAction('reveal', n.path)
            }
          >
            {n.kind === 'folder' ? (
              <>
                {collapsed.has(n.path) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <Folder size={16} />
              </>
            ) : (
              <>
                {depth === 0 ? <span className="tree-spacer" /> : null}
                {n.kind === 'html' ? <FileCode2 size={16} /> : <File size={16} />}
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
    nodes.reduce((n, f) => n + (f.kind === 'html' ? 1 : count(f.children || [])), 0);
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
      <div className="project-label">
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
      <div className="file-tree" role="navigation" aria-label="项目文件">
        {workspace ? rows(workspace.tree) : null}
        {workspace && !workspace.tree.some(match) ? (
          <div className="tree-empty">没有找到文件</div>
        ) : null}
      </div>
      <div className="sidebar-footer">
        <div>
          <HardDrive size={16} />
          <span>本地工作空间</span>
          <span className="connection-dot" />
        </div>
        <p>
          <BookOpen size={13} />
          {workspace ? count(workspace.tree) : 0} 份 HTML 文档
        </p>
      </div>
      <SidebarResizer />
    </aside>
  );
}
