import { useSyncExternalStore } from 'react';
import { invoke, isDesktop, subscribe } from '../api';
import type { PluginDirectory, PluginInfo, PluginInspection, PluginList } from './types';

// The plugins as last read; the settings page and the scheduler share them.
let list: PluginList | null = null;
let loading: Promise<PluginList | null> | null = null;
const listeners = new Set<() => void>();
function put(next: PluginList) {
  list = next;
  listeners.forEach((l) => l());
  return next;
}
export function loadPlugins(force = false): Promise<PluginList | null> {
  if (!isDesktop) return Promise.resolve(null);
  if (list && !force) return Promise.resolve(list);
  loading ||= invoke<PluginList>('plugins')
    .then(put)
    .catch(() => null)
    .finally(() => (loading = null));
  return loading;
}
export const currentPlugins = () => list;
// A plugin loaded from a folder was changed there: read the list again (electron/plugins.cjs).
subscribe((e) => {
  if (e.type === 'plugins-changed') void loadPlugins(true);
});
export function usePlugins() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!list) void loadPlugins();
      return () => listeners.delete(l);
    },
    () => list,
  );
}
export const subscribePlugins = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const setPlugin = (change: {
  id: string;
  enabled?: boolean;
  settings?: Record<string, string>;
  root?: string;
  schedule?: { time?: string; off?: boolean };
}) => invoke<PluginList>('plugin-set', change).then(put);
export const setThirdParty = (on: boolean) =>
  invoke<PluginList>('plugin-third-party', { on }).then(put);
export const pluginRan = (change: {
  id: string;
  at?: number;
  result?: { ok: boolean; message: string; output?: string };
}) => invoke<PluginList>('plugin-ran', change).then(put);
export const inspectPlugin = (from: {
  url?: string;
  id?: string;
  local?: string;
  expect?: string;
  recommendation?: string;
}) => invoke<PluginInspection>('plugin-inspect', from);
// A plugin folder (loaded where it is) or .zip picked in Finder / Explorer; null when cancelled.
export const pickLocalPlugin = (kind: 'folder' | 'zip') =>
  invoke<PluginInspection | null>('plugin-pick-local', { kind });
// Where a dropped file or folder is on this computer.
export const droppedPath = (file: File) => window.folio?.pathForFile?.(file) || '';
export const loadDirectory = (refresh = false) =>
  invoke<PluginDirectory>('plugin-directory', { refresh });
export const installPlugin = (stage: string) =>
  invoke<PluginList>('plugin-install', { stage }).then(put);
// An official plugin: downloaded, checked against the SHA-256 Folio knows, and installed in one
// go (it stays off until switched on). Also how one is updated.
export const installOfficial = async (id: string) =>
  installPlugin((await inspectPlugin({ recommendation: id })).stage);
export const removePlugin = (id: string) => invoke<PluginList>('plugin-remove', { id }).then(put);
export const pluginIcon = (id: string) => invoke<string>('plugin-icon', { id });

// Names for the tools a plugin can use, for the permissions it asks for.
export const toolNames: Record<string, string> = {
  list_files: '查看项目里的文档列表',
  search: '搜索项目里的文档',
  read_document: '阅读项目里的文档',
  read_annotations: '读取你的批注和笔记',
  read_html_source: '查看 HTML 源码',
  open_document: '在阅读区打开文档',
  search_papers: '查找学术论文（OpenAlex、PubMed、arXiv）',
  fetch_url: '读取允许的网站上的网页',
  read_feed: '读取允许的网站上的 RSS 订阅',
  create_html: '新建 HTML 文档',
  edit_html: '修改 HTML 文档',
  add_highlights: '添加高亮批注',
  write_note: '写文档笔记',
  save_pdf: '下载 PDF',
};
export const isOfficial = (p: PluginInfo) => p.source?.type === 'official';
export const isDev = (p: PluginInfo) => p.source?.type === 'folder';
