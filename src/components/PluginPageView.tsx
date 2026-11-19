import { useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { usePluginFrame } from '../plugins/frame-bridge';
import { devVersion, isDev } from '../plugins/store';
import type { PluginInfo } from '../plugins/types';

// A plugin's page (folio-plugin.json's `page`), a tab in the reading area: its own HTML in a
// sandboxed frame at app://page/<id>/ (electron/plugins.cjs), which sees nothing of Folio and
// talks to it by message (src/plugins/frame-bridge.ts). Its code is only its own.
export function PluginPageView(p: {
  plugin: PluginInfo;
  // Whether its tab is the one showing; a page out of sight stays loaded.
  active: boolean;
}) {
  const { plugin } = p;
  const page = plugin.manifest!.page!;
  const frame = useRef<HTMLIFrameElement>(null);
  const [reloads, setReloads] = useState(0);
  usePluginFrame({ plugin, kind: 'page', frame, active: p.active });
  return (
    <div className="plugin-page" hidden={!p.active} data-plugin-page={plugin.id}>
      <iframe
        // Loaded again when asked to, and when its settings change (they are part of the page).
        key={`${reloads}:${JSON.stringify(plugin.settings)}`}
        ref={frame}
        title={page.title}
        sandbox="allow-scripts"
        src={`app://page/${encodeURIComponent(plugin.id)}/`}
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

// A plugin's background script (folio-plugin.json's `background`): a page no one sees, running
// while the plugin is on and a project is open — loaded again for another project, when its
// settings change, and when a plugin being written is saved.
export function PluginBackground({ plugin, project }: { plugin: PluginInfo; project: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  usePluginFrame({ plugin, kind: 'background', frame });
  return (
    <iframe
      key={`${project}:${JSON.stringify(plugin.settings)}:${plugin.manifest?.version}:${isDev(plugin) ? devVersion() : ''}`}
      ref={frame}
      className="plugin-background"
      title={`${plugin.manifest!.name}（后台）`}
      sandbox="allow-scripts"
      aria-hidden="true"
      tabIndex={-1}
      src={`app://page/${encodeURIComponent(plugin.id)}/${plugin
        .manifest!.background.split('/')
        .map(encodeURIComponent)
        .join('/')}`}
    />
  );
}
