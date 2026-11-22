import { useSyncExternalStore } from 'react';
import { invoke, subscribe } from '../api';
import type { DocKind } from '../doc-kind';

// What plugins' pages and background scripts add to Folio while they run, and how Folio reaches
// them (src/plugins/frame-bridge.ts answers each frame; electron/plugins.cjs gives it `folio`):
// marks and menu items on the file tree, a count beside a page in the sidebar, tools for the AI,
// and what they're told — the open document, how far it's read, that the library changed.

export type TreeBadge = {
  icon: '' | 'check' | 'half' | 'dot' | 'star' | 'flag' | 'bookmark';
  text: string;
  color: string;
  title: string;
};
// `kinds`: in fileMenu, only for these kinds of file ('pdf', 'html', 'markdown', 'image',
// 'word', 'code').
export type TreeMenuItem = { id: string; label: string; kinds?: string[] };
export type TreeDecor = {
  badges: Record<string, TreeBadge>;
  menus: Record<string, TreeMenuItem[]>;
  // For a document or a folder no entry of `menus` names.
  fileMenu: TreeMenuItem[];
  folderMenu: TreeMenuItem[];
};
export type DocumentInfo = { path: string; kind: DocKind | 'none'; title: string };

// A plugin's frame as the runtime reaches it.
export type FrameHandle = {
  kind: 'page' | 'background';
  // Tells it something, if it listens.
  event: (event: string, data: unknown) => boolean;
  // `via`: who calls it — the AI assistant (or a plugin's run), or another AI tool over MCP.
  tool: (
    name: string,
    input: unknown,
    phase: 'preview' | 'run',
    via: 'assistant' | 'mcp',
  ) => Promise<unknown>;
};

// What Folio does for a frame: kept current by the app (src/App.tsx).
export type RuntimeHost = {
  projectName: () => string;
  openDocument: (path: string) => Promise<void>;
  notify: (text: string, action: string) => Promise<boolean>;
  openPage: (plugin: string) => void;
  openSettings: () => void;
  files: () => { path: string; kind: DocKind }[];
  docText: (path: string) => Promise<{ title?: string; text: string } | null>;
};

const empty: TreeDecor = { badges: {}, menus: {}, fileMenu: [], folderMenu: [] };
const state = {
  decor: new Map<string, TreeDecor>(),
  badges: new Map<string, string>(),
  // The tools each background script has implemented so far.
  tools: new Map<string, Set<string>>(),
  values: {
    document: { path: '', kind: 'none', title: '' } as DocumentInfo,
    progress: { path: '', progress: 0 },
    library: { version: 0 },
  },
};
const frames = new Map<string, FrameHandle>();
// What was asked of a page before it was there to hear it (folio.showPage).
const requests = new Map<string, unknown[]>();
let host: RuntimeHost | null = null;

const listeners = new Set<() => void>();
let snapshot = { ...state };
function changed() {
  snapshot = { ...state };
  listeners.forEach((l) => l());
}
const onChange = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const runtime = {
  setHost(next: RuntimeHost) {
    host = next;
  },
  host: () => host,
  // A frame came or went. A background script gone takes its marks and tools with it.
  attach(plugin: string, frame: FrameHandle) {
    frames.set(`${plugin}:${frame.kind}`, frame);
    return () => {
      if (frames.get(`${plugin}:${frame.kind}`) !== frame) return;
      frames.delete(`${plugin}:${frame.kind}`);
      if (frame.kind === 'background') runtime.forget(plugin, ['tools', 'decor']);
    };
  },
  // What a plugin added, gone: when its background script stops, or the plugin is turned off.
  forget(plugin: string, what: ('tools' | 'decor' | 'badges')[] = ['tools', 'decor', 'badges']) {
    let any = false;
    for (const key of what)
      if (state[key].has(plugin)) {
        const next = new Map(state[key] as Map<string, never>);
        next.delete(plugin);
        (state as Record<typeof key, Map<string, unknown>>)[key] = next;
        any = true;
      }
    if (any) changed();
  },
  setDecor(plugin: string, decor: TreeDecor) {
    state.decor = new Map(state.decor).set(plugin, decor);
    changed();
  },
  setBadge(plugin: string, text: string) {
    if ((state.badges.get(plugin) || '') === text) return;
    state.badges = new Map(state.badges);
    if (text) state.badges.set(plugin, text);
    else state.badges.delete(plugin);
    changed();
  },
  toolReady(plugin: string, name: string) {
    const set = new Set(state.tools.get(plugin) || []).add(name);
    state.tools = new Map(state.tools).set(plugin, set);
    changed();
  },
  hasTool: (plugin: string, name: string) => !!state.tools.get(plugin)?.has(name),
  // Its background script loaded again: it implements its tools anew.
  forgetTools: (plugin: string) => runtime.forget(plugin, ['tools']),
  // A page now listening for what was asked of it before.
  flushRequests(plugin: string) {
    const page = frames.get(`${plugin}:page`);
    const queued = requests.get(plugin) || [];
    requests.delete(plugin);
    for (const data of queued) page?.event('request', data);
  },
  // A tool of a plugin's, answered by its background script.
  async callTool(
    plugin: string,
    name: string,
    input: unknown,
    phase: 'preview' | 'run',
    via: 'assistant' | 'mcp' = 'assistant',
  ) {
    const frame = frames.get(`${plugin}:background`);
    if (!frame) throw Error('这个插件的后台脚本没有在运行（插件关了，或者没有打开项目）');
    return frame.tool(name, input, phase, via);
  },
  // Something for a plugin's background script, or failing that its page (a menu item chosen).
  tell(plugin: string, event: string, data: unknown) {
    return (
      !!frames.get(`${plugin}:background`)?.event(event, data) ||
      !!frames.get(`${plugin}:page`)?.event(event, data)
    );
  },
  // Something every page and background script may hear (`created`: a document Folio made).
  broadcast(event: string, data: unknown) {
    for (const frame of frames.values()) frame.event(event, data);
  },
  // folio.showPage(data): the page opens (or comes in front) and hears `request`.
  showPage(plugin: string, data: unknown) {
    const page = frames.get(`${plugin}:page`);
    if (data !== null && !(page && page.event('request', data)))
      requests.set(plugin, [...(requests.get(plugin) || []), data].slice(-20));
    host?.openPage(plugin);
  },
  setDocument(document: DocumentInfo) {
    const now = state.values.document;
    if (now.path === document.path && now.title === document.title) return;
    state.values = { ...state.values, document };
    changed();
  },
  setProgress(path: string, progress: number) {
    const value = Math.max(0, Math.min(100, Math.round(progress)));
    const now = state.values.progress;
    if (now.path === path && now.progress === value) return;
    state.values = { ...state.values, progress: { path, progress: value } };
    changed();
  },
  get: () => snapshot,
  subscribe: onChange,
};

// The library changed (electron/main.cjs): the frames that use it read it again.
subscribe((e) => {
  if (e.type !== 'library-changed') return;
  state.values = { ...state.values, library: { version: state.values.library.version + 1 } };
  changed();
});
// A plugin's tool called by another AI tool on this computer (electron/plugin-mcp.cjs).
subscribe((e) => {
  const m = e as { type: string; callId?: number; plugin?: string; name?: string; input?: unknown };
  if (m.type !== 'plugin-tool' || typeof m.callId !== 'number') return;
  runtime
    .callTool(String(m.plugin), String(m.name), m.input, 'run', 'mcp')
    .then(
      (value) =>
        invoke('plugin-tool-reply', {
          callId: m.callId,
          value: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 1),
        }),
      (err) =>
        invoke('plugin-tool-reply', { callId: m.callId, error: String(err?.message || err) }),
    )
    .catch(() => {});
});

export function useRuntime() {
  return useSyncExternalStore(runtime.subscribe, runtime.get);
}

const badgeIcons = ['check', 'half', 'dot', 'star', 'flag', 'bookmark'];
const str = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const items = (value: unknown): TreeMenuItem[] =>
  (Array.isArray(value) ? value : [])
    .slice(0, 6)
    .map((x) => ({
      id: str(x?.id, 60),
      label: str(x?.label, 24),
      ...(Array.isArray(x?.kinds) ? { kinds: x.kinds.map((k: unknown) => str(k, 20)) } : {}),
    }))
    .filter((x) => x.id && x.label);
// folio.tree.set(...) as a plugin sent it, made safe to show: at most 20000 files.
export function cleanDecor(raw: any): TreeDecor {
  if (!raw || typeof raw !== 'object') return empty;
  const badges: Record<string, TreeBadge> = {};
  for (const [path, b] of Object.entries(raw.badges || {}).slice(0, 20000)) {
    const x = b as any;
    if (!x || typeof x !== 'object' || typeof path !== 'string') continue;
    const icon = badgeIcons.includes(x.icon) ? x.icon : '';
    const text = str(x.text, 2);
    if (!icon && !text) continue;
    const color = /^#[\da-f]{3,8}$/i.test(x.color || '') ? x.color : '';
    badges[path] = { icon, text, color, title: str(x.title, 120) };
  }
  const menus: Record<string, TreeMenuItem[]> = {};
  for (const [path, list] of Object.entries(raw.menus || {}).slice(0, 20000))
    if (typeof path === 'string') menus[path] = items(list);
  return { badges, menus, fileMenu: items(raw.fileMenu), folderMenu: items(raw.folderMenu) };
}
