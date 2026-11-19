import { useEffect, useRef, type RefObject } from 'react';
import { invoke } from '../api';
import { pluginLog } from './log';
import { cleanDecor, runtime, useRuntime, type FrameHandle } from './runtime';
import type { PluginInfo } from './types';
import { useWidgetTheme } from './widget-events';

// Folio's side of a plugin's page or background script (the `folio` object electron/plugins.cjs
// puts in it): the frame asks by message, and is answered here only with what its manifest's
// permissions allow. It's told what it listens for: the theme, whether its tab shows, the open
// document and how far it's read, that the library changed, a file-tree menu item chosen, what
// was asked of its page; and a background script is asked to run its AI tools.
export function usePluginFrame(p: {
  plugin: PluginInfo;
  kind: 'page' | 'background';
  frame: RefObject<HTMLIFrameElement | null>;
  // A page: whether its tab is the one showing.
  active?: boolean;
}) {
  const { plugin, kind } = p;
  const id = plugin.id;
  const manifest = plugin.manifest!;
  const theme = useWidgetTheme();
  const { values: shared } = useRuntime();
  const values: Record<string, unknown> = {
    theme,
    document: shared.document,
    progress: shared.progress,
    library: shared.library,
    ...(kind === 'page' ? { visible: { visible: !!p.active } } : {}),
  };
  const latest = useRef(values);
  latest.current = values;
  // The plugin list is read again now and then, each time as new objects: the frame keeps its
  // place (and its tools and marks) across that, and is answered by the manifest as it is now.
  const current = useRef(manifest);
  current.current = manifest;
  const listening = useRef(new Set<string>());
  const sent = useRef(new Map<string, string>());
  const calls = useRef(
    new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>(),
  );
  const seq = useRef(0);
  const last = useRef({ external: 0, notify: 0 });

  const post = (message: object) =>
    p.frame.current?.contentWindow?.postMessage({ folioWidget: 1, ...message }, '*');
  const tell = (event: string, force = false) => {
    if (!listening.current.has(event)) return;
    const data = latest.current[event];
    if (data === undefined) return;
    const key = JSON.stringify(data);
    if (!force && sent.current.get(event) === key) return;
    sent.current.set(event, key);
    post({ type: 'event', event, data });
  };

  useEffect(() => {
    const manifest = () => current.current;
    const perms = () => current.current.permissions;
    const canRead = () => !!perms().library;
    const canWrite = () => perms().library === 'write';
    const need = (ok: boolean, what: string) => {
      if (!ok) throw Error(`清单的 permissions 里没有写 ${what}`);
    };
    const frame: FrameHandle = {
      kind,
      event(event, data) {
        if (!listening.current.has(event)) return false;
        post({ type: 'event', event, data });
        return true;
      },
      tool(name, input, phase, via) {
        return new Promise((resolve, reject) => {
          const n = ++seq.current;
          const timer = setTimeout(() => {
            calls.current.delete(n);
            reject(Error(`${manifest().name}的 ${name} 两分钟没有回应`));
          }, 120_000);
          calls.current.set(n, {
            resolve: (v) => (clearTimeout(timer), resolve(v)),
            reject: (e) => (clearTimeout(timer), reject(e)),
          });
          post({ type: 'tool', id: n, name, input, phase, via });
        });
      },
    };
    const detach = runtime.attach(id, frame);
    const host = () => {
      const h = runtime.host();
      if (!h) throw Error('页间还没准备好');
      return h;
    };
    // What the frame asks for, each answered once.
    const answer = async (type: string, value: any): Promise<unknown> => {
      switch (type) {
        case 'storage-get':
          return invoke('plugin-widget-storage', { id, set: false });
        case 'storage-set':
          return invoke('plugin-widget-storage', { id, set: true, value });
        case 'project':
          return { name: host().projectName() };
        case 'open':
          if (typeof value !== 'string' || !value) throw Error('folio.open(path)');
          await host().openDocument(value);
          return true;
        case 'external': {
          // One page at a time, and only web pages: a plugin can't flood the browser with tabs.
          if (Date.now() - last.current.external < 800) throw Error('打开得太快了');
          last.current.external = Date.now();
          return invoke('external', { url: String(value) });
        }
        case 'notify': {
          if (Date.now() - last.current.notify < 2000) throw Error('通知发得太快了');
          last.current.notify = Date.now();
          const text = String(value?.text || '')
            .trim()
            .slice(0, 200);
          if (!text) throw Error('folio.notify(text)');
          return host().notify(text, String(value?.action || '').slice(0, 12));
        }
        case 'settings':
          host().openSettings();
          return true;
        case 'show-page':
          if (!manifest().page) throw Error('这个插件没有页面');
          runtime.showPage(id, value ?? null);
          return true;
        case 'badge':
          if (!manifest().page) throw Error('这个插件没有页面');
          runtime.setBadge(id, String(value || '').slice(0, 12));
          return true;
        case 'tree-set':
          need(perms().fileTree, 'fileTree');
          runtime.setDecor(id, cleanDecor(value));
          return true;
        case 'documents-list':
          need(!!perms().documents, 'documents');
          return host().files();
        case 'documents-read': {
          need(!!perms().documents, 'documents');
          const path = String(value?.path || '');
          const doc = await host().docText(path);
          if (!doc) throw Error(`读不了 ${path}`);
          const max = Math.min(Math.max(Number(value?.maxChars) || 200_000, 100), 2_000_000);
          return { path, title: doc.title || '', text: doc.text.slice(0, max) };
        }
        case 'documents-annotations':
          need(!!perms().documents, 'documents');
          return invoke('plugin-annotations', { path: String(value || '') });
      }
      if (type.startsWith('library-')) need(canRead(), 'library');
      switch (type) {
        case 'library-list':
          return invoke('library');
        case 'library-get':
          return invoke('library-detail', { id: value });
        case 'library-lookup':
          return invoke('library-lookup', value || {});
      }
      if (type.startsWith('library-') && !canWrite())
        throw Error('这个插件只能读文献库（permissions.library 要写 "write" 才能改）');
      switch (type) {
        case 'library-update':
          return invoke('library-update', { id: value?.id, patch: value?.patch });
        case 'library-add':
          return invoke('library-add', { paper: value });
        case 'library-add-many':
          return invoke('library-add', { papers: value?.papers, overwrite: !!value?.overwrite });
        case 'library-remove':
          return invoke('library-remove', { ids: value });
        case 'library-set-list':
          return invoke('library-list-set', value);
        case 'library-export':
          return invoke('library-export', value || {});
        case 'library-import':
          return invoke('library-import', value || {});
      }
      throw Error(`页间不认识 ${type}`);
    };
    const where = kind === 'page' ? '页面' : '后台脚本';
    const onMessage = (e: MessageEvent) => {
      if (e.source !== p.frame.current?.contentWindow || e.data?.folioWidget !== 1) return;
      const m = e.data;
      if (m.type === 'ready') {
        // Loaded (again): it listens afresh, and a background script implements its tools anew.
        listening.current.clear();
        sent.current.clear();
        if (kind === 'background') runtime.forgetTools(id);
      } else if (m.type === 'listen' && typeof m.event === 'string') {
        listening.current.add(m.event);
        tell(m.event, true);
        if (m.event === 'request' && kind === 'page') runtime.flushRequests(id);
      } else if (m.type === 'log') {
        const level = m.level === 'error' || m.level === 'warn' ? m.level : 'script';
        pluginLog(id, level, `${where}：${String(m.text || '').slice(0, 500)}`);
      } else if (m.type === 'tool-ready' && kind === 'background' && typeof m.name === 'string') {
        if (manifest().aiTools.some((t) => t.name === m.name)) runtime.toolReady(id, m.name);
      } else if (m.type === 'tool-done' && typeof m.id === 'number') {
        const call = calls.current.get(m.id);
        calls.current.delete(m.id);
        if (call) m.error ? call.reject(Error(String(m.error))) : call.resolve(m.value);
      } else if (typeof m.type === 'string' && typeof m.id === 'number') {
        answer(m.type, m.value)
          .then((value) => post({ type: 'reply', id: m.id, value }))
          .catch((err) =>
            post({
              type: 'reply',
              id: m.id,
              error: String(err?.message || err)
                .replace(/Error invoking remote method '[^']+': Error: /, '')
                .slice(0, 300),
            }),
          );
      }
    };
    addEventListener('message', onMessage);
    return () => {
      removeEventListener('message', onMessage);
      detach();
      for (const call of calls.current.values()) call.reject(Error('插件的后台脚本停了'));
      calls.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind]);

  // Tell it what changed.
  useEffect(() => {
    for (const event of Object.keys(latest.current)) tell(event);
  });
}
