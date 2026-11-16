import { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { invoke } from '../api';
import { useLibrary } from '../library';
import { pluginLog } from '../plugins/log';
import { isDev } from '../plugins/store';
import type { PluginInfo } from '../plugins/types';
import { useWidgetTheme } from '../plugins/widget-events';

// A plugin's page (folio-plugin.json's `page`), a tab in the reading area: its own HTML in a
// sandboxed frame at app://page/<id>/ (electron/plugins.cjs), which sees nothing of Folio. It
// talks to Folio by message: its settings and storage, the theme, and — when its manifest
// asks for it — the project's library, to read or to change. It can ask Folio to open one of
// the project's documents. Like a widget it may go online by itself; its code is only its own.
export function PluginPageView(p: {
  plugin: PluginInfo;
  // Whether its tab is the one showing; a page out of sight stays loaded.
  active: boolean;
  projectName: string;
  onOpenDocument: (path: string) => Promise<void>;
}) {
  const { plugin } = p;
  const id = plugin.id;
  const page = plugin.manifest!.page!;
  const frame = useRef<HTMLIFrameElement>(null);
  const listening = useRef(new Set<string>());
  const sent = useRef(new Map<string, string>());
  const theme = useWidgetTheme();
  const library = useLibrary();
  // Counts the library's changes: the page is told that it changed, and reads it again.
  const version = useRef(0);
  const seen = useRef(library);
  if (seen.current !== library) {
    seen.current = library;
    version.current++;
  }
  const [reloads, setReloads] = useState(0);
  const values: Record<string, unknown> = {
    theme,
    visible: { visible: p.active },
    library: { version: version.current },
  };
  const latest = useRef({ values, props: p });
  latest.current = { values, props: p };
  const lastExternal = useRef(0);

  const post = (message: object) =>
    frame.current?.contentWindow?.postMessage({ folioWidget: 1, ...message }, '*');
  const tell = (event: string, force = false) => {
    if (!listening.current.has(event)) return;
    if (event === 'library' && !page.library) return;
    const data = latest.current.values[event];
    if (data === undefined) return;
    const key = JSON.stringify(data);
    if (!force && sent.current.get(event) === key) return;
    sent.current.set(event, key);
    post({ type: 'event', event, data });
  };

  useEffect(() => {
    const canRead = !!page.library;
    const canWrite = page.library === 'write';
    // What the page asks for, each answered once.
    const answer = async (type: string, value: any): Promise<unknown> => {
      switch (type) {
        case 'storage-get':
          return invoke('plugin-widget-storage', { id, set: false });
        case 'storage-set':
          return invoke('plugin-widget-storage', { id, set: true, value });
        case 'project':
          return { name: latest.current.props.projectName };
        case 'open':
          if (typeof value !== 'string' || !value) throw Error('folio.open(path)');
          await latest.current.props.onOpenDocument(value);
          return true;
        case 'external': {
          // One page at a time, and only web pages: a page can't flood the browser with tabs.
          if (Date.now() - lastExternal.current < 800) throw Error('打开得太快了');
          lastExternal.current = Date.now();
          return invoke('external', { url: String(value) });
        }
        case 'library-list':
          if (!canRead) throw Error('这个页面的清单里没有写 page.library，读不了文献库');
          return invoke('library');
        case 'library-get':
          if (!canRead) throw Error('这个页面的清单里没有写 page.library，读不了文献库');
          return invoke('library-detail', { id: value });
      }
      if (!canWrite) throw Error('这个页面只能读文献库（清单里要写 "library": "write" 才能改）');
      switch (type) {
        case 'library-update':
          return invoke('library-update', { id: value?.id, patch: value?.patch });
        case 'library-add':
          return invoke('library-add', { paper: value });
        case 'library-remove':
          return invoke('library-remove', { ids: [value] });
        case 'library-set-list':
          return invoke('library-list-set', value);
      }
      throw Error(`页间不认识 ${type}`);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.folioWidget !== 1) return;
      const m = e.data;
      if (m.type === 'ready') {
        listening.current.clear();
        sent.current.clear();
      } else if (m.type === 'listen' && typeof m.event === 'string') {
        listening.current.add(m.event);
        tell(m.event, true);
      } else if (m.type === 'log') {
        const level = m.level === 'error' || m.level === 'warn' ? m.level : 'script';
        pluginLog(id, level, `页面：${String(m.text || '').slice(0, 500)}`);
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
    return () => removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, page.library]);

  // Tell it what changed.
  useEffect(() => {
    for (const event of ['theme', 'visible', 'library']) tell(event);
  });

  return (
    <div className="plugin-page" hidden={!p.active} data-plugin-page={id}>
      <iframe
        // Loaded again when asked to, and when its settings change (they are part of the page).
        key={`${reloads}:${JSON.stringify(plugin.settings)}`}
        ref={frame}
        title={page.title}
        sandbox="allow-scripts"
        src={`app://page/${encodeURIComponent(id)}/`}
      />
      {isDev(plugin) ? (
        // A page being written: read again from its folder.
        <button
          type="button"
          className="plugin-page-reload"
          title="重新载入页面（开发中的插件）"
          onClick={() => setReloads((n) => n + 1)}
        >
          <RotateCw size={13} />
        </button>
      ) : null}
    </div>
  );
}
