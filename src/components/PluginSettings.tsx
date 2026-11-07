import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  FileArchive,
  FolderCode,
  FolderInput,
  FolderOpen,
  Globe,
  LibraryBig,
  LoaderCircle,
  Play,
  Puzzle,
  RefreshCw,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { invoke, isDesktop } from '../api';
import { errorText } from '../ai/client';
import { fileManager } from '../platform';
import { ModelMenu } from './ModelMenu';
import { usePluginRuns } from '../plugins/runner';
import { cleanFolder, projectFolder } from '../plugins/schedule';
import { clearPluginLog, usePluginLog } from '../plugins/log';
import {
  droppedPath,
  inspectPlugin,
  installOfficial,
  installPlugin,
  isDev,
  isOfficial,
  loadDirectory,
  pickLocalPlugin,
  pluginIcon,
  removePlugin,
  setPlugin,
  setThirdParty,
  toolNames,
  usePlugins,
} from '../plugins/store';
import type {
  DirectoryPlugin,
  PluginDirectory,
  PluginInfo,
  PluginInspection,
  PluginManifest,
} from '../plugins/types';

// The public repository with the plugin directory, the format and the tools for writing one.
const PLUGIN_HOME = 'https://github.com/XiangXiaoYuan5254/folio-plugins';

// Where on the page an error is shown: under the part it came from.
type Area = 'installed' | 'official' | 'community';

// 设置 › 插件: the plugins installed, the official ones not installed yet, and community plugins
// (from the directory, a link, a .zip or a folder), which are off until switched on, as
// Obsidian's are. Official plugins are checked against the SHA-256 Folio ships with, so they
// don't wait for that switch.
export function PluginSettings(p: {
  root?: string;
  projectName?: string;
  onRun: (id: string) => void;
  // A folder plugin's folder, opened in Folio as the project it is.
  onOpenFolder: (id: string) => void;
}) {
  const list = usePlugins();
  const [warning, setWarning] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ at: Area; text: string } | null>(null);
  const [inspection, setInspection] = useState<PluginInspection | null>(null);
  const [dragging, setDragging] = useState(false);
  // An official plugin just installed: its card opens, to show what it does.
  const [fresh, setFresh] = useState('');
  if (!isDesktop) return <p className="settings-footnote">请在桌面版页间中使用插件。</p>;
  if (!list)
    return (
      <p className="settings-footnote" role="status">
        正在读取插件…
      </p>
    );
  const thirdParty = list.thirdParty;
  async function act(label: string, at: Area, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError({ at, text: errorText(e) });
    } finally {
      setBusy('');
    }
  }
  const inspect = (from: { url?: string; id?: string; local?: string; expect?: string }) =>
    act('inspect', 'community', async () => setInspection(await inspectPlugin(from)));
  const pickLocal = (kind: 'folder' | 'zip') =>
    act('inspect', 'community', async () => {
      const seen = await pickLocalPlugin(kind);
      if (seen) setInspection(seen);
    });
  // Installing an official plugin, or updating one. (Marked fresh first: its card appears as
  // soon as the list has it, before the install call returns.)
  const official = (id: string, at: Area) =>
    act(`official:${id}`, at, async () => {
      if (at === 'official') setFresh(id);
      await installOfficial(id);
    });
  const installed = new Set(list.plugins.map((x) => x.id));
  const available = list.recommendations.filter((x) => !installed.has(x.id));
  const latest = new Map(list.recommendations.map((x) => [x.id, x.version]));
  const errorAt = (at: Area) =>
    error?.at === at ? (
      <p className="plugin-error" role="alert">
        <CircleAlert size={14} />
        {error.text}
      </p>
    ) : null;
  // A plugin folder or .zip dragged in from Finder / Explorer.
  const dropZone = thirdParty
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          const local = file ? droppedPath(file) : '';
          if (!local)
            setError({
              at: 'community',
              text: '没有读到拖进来的文件，请改用「从文件夹加载…」或「安装 .zip…」',
            });
          else if (!busy) void inspect({ local });
        },
      }
    : {};
  return (
    <div className="plugin-settings">
      {list.plugins.length ? (
        <section className="settings-group">
          <h4>已安装</h4>
          <div className="plugin-list">
            {list.plugins.map((plugin) => {
              const newer = latest.get(plugin.id);
              return (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  thirdParty={thirdParty}
                  fresh={fresh === plugin.id}
                  update={
                    isOfficial(plugin) && newer && newer !== plugin.manifest?.version ? newer : ''
                  }
                  updating={busy === `official:${plugin.id}`}
                  root={p.root}
                  projectName={p.projectName}
                  busy={!!busy}
                  onRun={() => p.onRun(plugin.id)}
                  onOpenFolder={p.onOpenFolder}
                  onCheck={() => void inspect({ id: plugin.id })}
                  onUpdate={() => void official(plugin.id, 'installed')}
                  onError={(text) => setError({ at: 'installed', text })}
                />
              );
            })}
          </div>
          {errorAt('installed')}
        </section>
      ) : null}
      {available.length ? (
        <section className="settings-group">
          <h4>官方插件</h4>
          <ul className="plugin-catalog" aria-label="官方插件">
            {available.map((item) => (
              <li key={item.id}>
                {item.icon ? (
                  <img className="plugin-icon" src={item.icon} alt="" />
                ) : (
                  <span className="plugin-icon plugin-icon-blank">
                    <Puzzle size={18} />
                  </span>
                )}
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.description}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`安装${item.name}`}
                  disabled={!!busy}
                  onClick={() => void official(item.id, 'official')}
                >
                  {busy === `official:${item.id}` ? (
                    <>
                      <LoaderCircle size={14} className="spin" />
                      正在安装
                    </>
                  ) : (
                    '安装'
                  )}
                </button>
              </li>
            ))}
          </ul>
          {errorAt('official')}
        </section>
      ) : null}
      <section
        className={`settings-group plugin-community${dragging ? ' dragging' : ''}`}
        {...dropZone}
      >
        <h4>社区插件</h4>
        <label className="settings-row">
          <span>
            <strong>允许社区插件</strong>
            <small>由其他作者编写，页间没有审核。</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="允许社区插件"
            checked={thirdParty || warning}
            disabled={!!busy}
            onChange={(e) => {
              if (e.target.checked) setWarning(true);
              else {
                setWarning(false);
                void act('third-party', 'community', () => setThirdParty(false));
              }
            }}
          />
        </label>
        {warning && !thirdParty ? (
          <div className="plugin-warning" role="alertdialog" aria-label="开启社区插件前请确认">
            <ShieldAlert size={18} />
            <div>
              <strong>开启前请确认</strong>
              <ul>
                <li>社区插件由各自的作者维护，只装你信任的。</li>
                <li>插件用你的 API Key 调用 AI，费用由你承担。</li>
                <li>安装前会列出它要访问的网站和写入的文件夹。</li>
                <li>
                  带脚本的插件可以自己访问任何网站，可能把它经手的内容发出去，不受这份网站列表限制。
                </li>
              </ul>
              <div className="plugin-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!!busy}
                  onClick={() =>
                    void act('third-party', 'community', async () => {
                      await setThirdParty(true);
                      setWarning(false);
                    })
                  }
                >
                  开启社区插件
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setWarning(false)}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {thirdParty ? (
          <div className="plugin-community-tools">
            <DirectoryBrowser
              installed={installed}
              busy={!!busy}
              onInstall={(entry) => void inspect({ url: entry.repo, expect: entry.id })}
            />
            <form
              className="plugin-install"
              onSubmit={(e) => {
                e.preventDefault();
                if (link.trim()) void inspect({ url: link });
              }}
            >
              <input
                type="url"
                aria-label="插件链接"
                placeholder="粘贴插件的 GitHub 或 Gitee 链接"
                value={link}
                disabled={!!busy}
                onChange={(e) => setLink(e.target.value)}
              />
              <button type="submit" className="secondary-button" disabled={!!busy || !link.trim()}>
                {busy === 'inspect' ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Download size={14} />
                )}
                {busy === 'inspect' ? '正在读取…' : '安装'}
              </button>
            </form>
            <div className="plugin-local">
              <button
                type="button"
                className="secondary-button"
                disabled={!!busy}
                title="写插件时用：页间直接读这个文件夹，保存后马上生效"
                onClick={() => void pickLocal('folder')}
              >
                <FolderCode size={14} />
                从文件夹加载…
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!!busy}
                onClick={() => void pickLocal('zip')}
              >
                <FileArchive size={14} />
                安装 .zip…
              </button>
              <small>
                {dragging ? '松开就会读取这个插件' : '也可以把插件文件夹或 .zip 拖到这里'}
              </small>
            </div>
          </div>
        ) : null}
        {errorAt('community')}
        {inspection ? (
          <InstallConfirm
            inspection={inspection}
            busy={busy === 'install'}
            onCancel={() => setInspection(null)}
            onInstall={() =>
              void act('install', 'community', async () => {
                await installPlugin(inspection.stage);
                setInspection(null);
                setLink('');
              })
            }
          />
        ) : null}
      </section>
    </div>
  );
}

function PluginIcon({ plugin }: { plugin: PluginInfo }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    if (plugin.manifest?.icon)
      void pluginIcon(plugin.id)
        .then((data) => live && setSrc(data))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [plugin.id, plugin.manifest?.version]);
  return src ? (
    <img className="plugin-icon" src={src} alt="" />
  ) : (
    <span className="plugin-icon plugin-icon-blank">
      <Puzzle size={18} />
    </span>
  );
}

// What the tools do for a plugin working in a folder of its own.
const folderToolNames: Record<string, string> = {
  list_files: '查看它文件夹里的文档列表',
  read_document: '阅读它文件夹里的文档',
  create_html: '在它的文件夹里新建 HTML 文档',
};
const sourceLink = (plugin: PluginInfo) =>
  plugin.source && 'url' in plugin.source ? plugin.source.url : plugin.manifest?.homepage || '';
const shortCommit = (sha = '') => sha.slice(0, 7);
function when(time: number) {
  if (!time) return '';
  const d = new Date(time);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === today.toDateString()
    ? `今天 ${hm}`
    : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

// What kind of plugin it is, next to its name.
function Badge({ plugin }: { plugin: PluginInfo }) {
  if (isDev(plugin)) return <span className="plugin-badge dev">开发版</span>;
  if (plugin.bundled) return <span className="plugin-badge">页间自带</span>;
  if (isOfficial(plugin)) return <span className="plugin-badge">官方</span>;
  return <span className="plugin-badge third">社区</span>;
}

function PluginCard(p: {
  plugin: PluginInfo;
  thirdParty: boolean;
  // Just installed: shown open.
  fresh: boolean;
  // An official plugin's newer version, or ''.
  update: string;
  updating: boolean;
  root?: string;
  projectName?: string;
  busy: boolean;
  onRun: () => void;
  onOpenFolder: (id: string) => void;
  onCheck: () => void;
  onUpdate: () => void;
  onError: (message: string) => void;
}) {
  const { plugin } = p;
  const m = plugin.manifest;
  const [draft, setDraft] = useState(plugin.settings);
  // Saved settings (a folder just picked, a save) show; a field still being edited stays.
  const savedSettings = useRef(plugin.settings);
  useEffect(() => {
    const before = savedSettings.current || {};
    const now = plugin.settings || {};
    savedSettings.current = now;
    setDraft((d) =>
      Object.fromEntries(Object.keys(now).map((k) => [k, d?.[k] !== before[k] ? d?.[k] : now[k]])),
    );
  }, [plugin.settings]);
  const [time, setTime] = useState(plugin.schedule?.time || '');
  useEffect(() => setTime(plugin.schedule?.time || ''), [plugin.schedule?.time]);
  const [folderError, setFolderError] = useState('');
  // A folder picked in the open project while the plugin works in another: saving moves it.
  const [moveTo, setMoveTo] = useState('');
  const ids = useId();
  const running = usePluginRuns().has(plugin.id);
  // Shown in one line until opened; switching it on opens it, to set it up. Open while
  // anything is left unsaved. (Before the broken card's return: a plugin loaded from a folder
  // can turn broken and back while it's being written, and the hooks must stay the same.)
  const [open, setOpen] = useState(p.fresh);
  if (!m)
    return (
      <article className="plugin-card broken">
        <div className="plugin-head">
          <span className="plugin-icon plugin-icon-blank">
            <CircleAlert size={18} />
          </span>
          <div className="plugin-title">
            <h5>
              {plugin.id}
              {isDev(plugin) ? <span className="plugin-badge dev">开发版</span> : null}
            </h5>
            {plugin.source?.type === 'folder' ? (
              <p className="plugin-meta" title={plugin.source.path}>
                {plugin.source.shown}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="secondary-button"
            title={isDev(plugin) ? '只从页间移除，不会删除你的文件夹' : undefined}
            onClick={() => void removePlugin(plugin.id).catch((e) => p.onError(errorText(e)))}
          >
            <Trash2 size={14} />
            {isDev(plugin) ? '移除' : '卸载'}
          </button>
        </div>
        <p className="plugin-error">这个插件读不了：{plugin.error}</p>
        {isDev(plugin) ? (
          <small className="plugin-hint">改好保存后，这里会自动重新读取。</small>
        ) : null}
      </article>
    );
  // Official and bundled plugins: the name, then what it does. Others: where they came from.
  const trusted = plugin.bundled || isOfficial(plugin);
  const locked = !trusted && !p.thirdParty;
  const changed =
    m.settings.some((s) => (draft[s.key] ?? '') !== (plugin.settings[s.key] ?? '')) ||
    (!!moveTo && moveTo !== plugin.root);
  // The project its folders are in: the one it works in, or the one it's moving to.
  const home = moveTo || plugin.root || p.root || '';
  const homeName = home.split(/[\\/]/).filter(Boolean).pop() || '';
  const daily = m.triggers.find((t) => t.type === 'daily');
  // Works in a folder of its own, whichever project is open.
  const own = m.run.where === 'folder';
  // Has a task for the AI; a plugin with only a widget has none, so nothing to run or schedule.
  const runs = !!m.run.prompt;
  const elsewhere = !own && plugin.enabled && plugin.root && p.root && plugin.root !== p.root;
  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => p.onError(errorText(e)));
  const shownOpen = open || changed;
  const summary = !runs
    ? plugin.enabled && m.widget
      ? `挂件${widgetPlaces[m.widget.anchor]}`
      : m.description
    : plugin.enabled
    ? [
        plugin.schedule
          ? plugin.schedule.off
            ? '不定时运行'
            : `每天 ${plugin.schedule.time} 自动运行`
          : '',
        own
          ? plugin.folder
            ? `放在 ${plugin.folder.shown}`
            : ''
          : plugin.root
            ? `在项目「${plugin.root.split(/[\\/]/).pop()}」里运行`
            : '',
        plugin.lastResult
          ? `上次 ${when(plugin.lastResult.at)}${plugin.lastResult.ok ? ' 完成' : ' 没有完成'}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : m.description;
  const origin = [
    m.author,
    plugin.source && 'commit' in plugin.source
      ? `${plugin.source.owner}/${plugin.source.repo} @ ${shortCommit(plugin.source.commit)}`
      : plugin.source?.type === 'folder'
        ? `从文件夹加载 · ${plugin.source.shown}`
        : plugin.source?.type === 'zip'
          ? `从压缩包安装 · ${plugin.source.name}`
          : '本地',
  ]
    .filter(Boolean)
    .join(' · ');
  const savedFolder = (key: string) => draft[key] === plugin.settings[key];
  // A folder setting picked in Finder / Explorer, inside the plugin's project; saved with the
  // other settings.
  async function pickFolder(key: string, title: string) {
    setFolderError('');
    try {
      // Its own folder: anywhere on this computer.
      if (own) {
        const picked = await invoke<string | null>('choose-plugin-folder', {
          anywhere: true,
          current: savedFolder(key) ? plugin.folder?.path || '' : draft[key] || '',
          title,
        });
        // Saved at once: picking it in Finder is the choice.
        if (picked) run(() => setPlugin({ id: plugin.id, settings: { [key]: picked } }));
        return;
      }
      // Finder starts in the project open now, whichever the plugin worked in so far.
      const picked = await invoke<string | null>('choose-plugin-folder', {
        root: p.root,
        current: p.root === plugin.root ? (draft[key] ?? '') : '',
        title,
      });
      if (!picked) return;
      setDraft((d) => ({ ...d, [key]: picked }));
      if (p.root && p.root !== plugin.root) setMoveTo(p.root);
    } catch (e) {
      setFolderError(errorText(e));
    }
  }
  const checkable = shownOpen && plugin.source && 'commit' in plugin.source && p.thirdParty;
  const actions =
    !!p.update ||
    plugin.enabled ||
    (shownOpen && (checkable || !!sourceLink(plugin) || !plugin.bundled));
  return (
    <article className={`plugin-card${plugin.enabled ? ' on' : ''}`}>
      <div className="plugin-head">
        <PluginIcon plugin={plugin} />
        <div className="plugin-title">
          <h5>
            {m.name}
            <span className="plugin-version">{m.version}</span>
            <Badge plugin={plugin} />
            {m.run.script ? <span className="plugin-badge third">含脚本</span> : null}
          </h5>
          {trusted ? (
            <p
              className={shownOpen ? 'plugin-summary open' : 'plugin-summary'}
              title={shownOpen ? undefined : summary}
            >
              {shownOpen ? m.description : summary}
            </p>
          ) : (
            <p
              className="plugin-meta"
              title={plugin.source?.type === 'folder' ? plugin.source.path : origin}
            >
              {origin}
            </p>
          )}
        </div>
        <button
          type="button"
          className="plugin-more"
          aria-expanded={shownOpen}
          aria-label={`${shownOpen ? '收起' : '展开'}${m.name}`}
          disabled={changed}
          title={changed ? '先保存或还原设置' : undefined}
          onClick={() => setOpen(!shownOpen)}
        >
          {shownOpen ? '收起' : plugin.enabled ? '设置' : '详情'}
          <ChevronDown size={14} />
        </button>
        <input
          type="checkbox"
          role="switch"
          aria-label={`开启${m.name}`}
          checked={plugin.enabled}
          disabled={p.busy || locked}
          title={locked ? '先打开「社区插件」' : undefined}
          onChange={(e) =>
            run(() =>
              setPlugin({
                id: plugin.id,
                enabled: e.target.checked,
                // Its schedule runs in the project open when it's switched on.
                ...(runs && !own && e.target.checked && !plugin.root && p.root
                  ? { root: p.root }
                  : {}),
              }).then(() => e.target.checked && setOpen(true)),
            )
          }
        />
      </div>
      {trusted ? null : shownOpen ? (
        <p className="plugin-description">{m.description}</p>
      ) : (
        <p className="plugin-summary" title={summary}>
          {summary}
        </p>
      )}
      {shownOpen ? (
        <div className="plugin-details">
          {isDev(plugin) ? (
            <p className="plugin-hint">开发版：页间直接读这个文件夹，保存后马上生效。</p>
          ) : null}
          <Warnings warnings={plugin.warnings} />
          <Permissions manifest={m} />
          <PluginLog id={plugin.id} />
        </div>
      ) : null}
      {plugin.enabled && shownOpen ? (
        <div className="plugin-body">
          {m.settings.map((s) =>
            s.type === 'folder' && own ? (
              <div key={s.key} className="plugin-field">
                <label htmlFor={`${ids}-${s.key}`}>
                  <FolderInput size={13} />
                  {s.label}
                </label>
                <div className="plugin-folder">
                  <input
                    id={`${ids}-${s.key}`}
                    type="text"
                    placeholder="例如 ~/Documents/AI日报"
                    title={savedFolder(s.key) ? plugin.folder?.path : draft[s.key]}
                    value={
                      savedFolder(s.key)
                        ? plugin.folder?.shown || draft[s.key] || ''
                        : draft[s.key] || ''
                    }
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    title={`在${fileManager}里选择或新建文件夹`}
                    onClick={() => void pickFolder(s.key, s.label)}
                  >
                    选择…
                  </button>
                  {savedFolder(s.key) ? (
                    <button
                      type="button"
                      className="secondary-button"
                      title="在页间里打开这个文件夹，看它生成的每一篇"
                      onClick={() => p.onOpenFolder(plugin.id)}
                    >
                      <FolderOpen size={14} />
                      在页间打开
                    </button>
                  ) : null}
                </div>
                {folderError ? (
                  <p className="plugin-error" role="alert">
                    <CircleAlert size={13} />
                    {folderError}
                  </p>
                ) : null}
                {s.hint ? <small>{s.hint}</small> : null}
              </div>
            ) : s.type === 'folder' ? (
              <div key={s.key} className="plugin-field">
                <label htmlFor={`${ids}-${s.key}`}>
                  <FolderInput size={13} />
                  {s.label}
                </label>
                <div className="plugin-folder">
                  <input
                    id={`${ids}-${s.key}`}
                    type="text"
                    value={draft[s.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!plugin.root && !p.root}
                    title={`在${fileManager}里选择或新建文件夹`}
                    onClick={() => void pickFolder(s.key, s.label)}
                  >
                    <FolderOpen size={14} />
                    选择…
                  </button>
                </div>
                {folderError ? (
                  <p className="plugin-error" role="alert">
                    <CircleAlert size={13} />
                    {folderError}
                  </p>
                ) : null}
                <small>
                  {(() => {
                    const folder = cleanFolder(draft[s.key] ?? '');
                    if (!folder) return '这个文件夹写法不对，换一个名字或点「选择…」';
                    const where =
                      folder === projectFolder
                        ? `直接放在项目「${homeName}」的文件夹里`
                        : `放在：项目「${homeName}」› ${folder}`;
                    return moveTo && moveTo !== plugin.root
                      ? `${where}（保存后，这个插件改在「${homeName}」里运行）`
                      : where;
                  })()}
                </small>
                {s.hint ? <small>{s.hint}</small> : null}
              </div>
            ) : (
              <label key={s.key} className="plugin-field">
                <span>{s.label}</span>
                {s.type === 'textarea' ? (
                  <textarea
                    rows={3}
                    value={draft[s.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                  />
                ) : (
                  <input
                    type="text"
                    value={draft[s.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                  />
                )}
                {s.hint ? <small>{s.hint}</small> : null}
              </label>
            ),
          )}
          {runs ? (
            <div className="plugin-field">
              <span>
                <Sparkles size={13} />
                用哪个 AI
              </span>
              <div className="plugin-model">
                <ModelMenu use={`plugin:${plugin.id}`} label={m.name} className="model-pick" />
              </div>
            </div>
          ) : null}
          {changed ? (
            <div className="plugin-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  run(async () => {
                    await setPlugin({
                      id: plugin.id,
                      settings: draft,
                      ...(moveTo && moveTo !== plugin.root ? { root: moveTo } : {}),
                    });
                    setMoveTo('');
                  })
                }
              >
                保存设置
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setDraft(plugin.settings);
                  setMoveTo('');
                }}
              >
                还原
              </button>
            </div>
          ) : null}
          {daily && plugin.schedule ? (
            <div className="plugin-field">
              <span>
                <Clock size={13} />
                定时运行
              </span>
              <div className="plugin-time">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="每天定时运行"
                  checked={!plugin.schedule.off}
                  onChange={(e) =>
                    run(() => setPlugin({ id: plugin.id, schedule: { off: !e.target.checked } }))
                  }
                />
                <span>每天</span>
                <input
                  type="time"
                  aria-label="每天几点运行"
                  value={time}
                  disabled={plugin.schedule.off}
                  onChange={(e) => {
                    const next = e.target.value;
                    setTime(next);
                    if (/^\d\d:\d\d$/.test(next) && next !== plugin.schedule?.time)
                      run(() => setPlugin({ id: plugin.id, schedule: { time: next } }));
                  }}
                />
                <span>{plugin.schedule.off ? '不自动运行' : '自动运行'}</span>
              </div>
              <small className="plugin-schedule">
                {own
                  ? '页间开着就会按时运行，错过了下次打开时补一次。'
                  : `在项目「${plugin.root ? plugin.root.split(/[\\/]/).pop() : '（未选择）'}」打开时运行，错过了下次打开时补一次。`}
                {elsewhere || (!own && !plugin.root && p.root) ? (
                  <button
                    type="button"
                    className="settings-link"
                    onClick={() => run(() => setPlugin({ id: plugin.id, root: p.root }))}
                  >
                    改为当前项目{p.projectName ? `「${p.projectName}」` : ''}
                  </button>
                ) : null}
              </small>
            </div>
          ) : null}
          {plugin.lastResult ? (
            <p className={`plugin-last${plugin.lastResult.ok ? '' : ' failed'}`}>
              {plugin.lastResult.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
              上次运行 {when(plugin.lastResult.at)}：
              {plugin.lastResult.ok
                ? plugin.lastResult.output || plugin.lastResult.message
                : plugin.lastResult.message}
            </p>
          ) : null}
        </div>
      ) : null}
      {actions ? (
        <div className="plugin-actions">
          {p.update ? (
            <button type="button" className="primary-button" disabled={p.busy} onClick={p.onUpdate}>
              {p.updating ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
              {p.updating ? '正在更新…' : `更新到 ${p.update}`}
            </button>
          ) : null}
          {plugin.enabled && runs ? (
            <button
              type="button"
              className="secondary-button"
              disabled={!running && ((!own && !p.root) || changed)}
              title={
                running
                  ? '看它在「整个项目」里的每一步'
                  : !own && !p.root
                    ? '先打开一个项目'
                    : changed
                      ? '先保存设置'
                      : undefined
              }
              onClick={p.onRun}
            >
              {running ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}
              {running
                ? '正在运行 · 查看进度'
                : m.triggers.find((t) => t.type === 'button')?.label || '立即运行'}
            </button>
          ) : null}
          {checkable ? (
            <button
              type="button"
              className="secondary-button"
              disabled={p.busy}
              onClick={p.onCheck}
            >
              <RefreshCw size={14} />
              检查更新
            </button>
          ) : null}
          {shownOpen && sourceLink(plugin) ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void invoke('external', { url: sourceLink(plugin) }).catch(() => {})}
            >
              <ExternalLink size={14} />
              {trusted ? '主页' : '源代码'}
            </button>
          ) : null}
          {shownOpen && !plugin.bundled ? (
            <button
              type="button"
              className="secondary-button danger-text"
              disabled={p.busy}
              title={isDev(plugin) ? '只从页间移除，不会删除你的文件夹' : undefined}
              onClick={() => run(() => removePlugin(plugin.id))}
            >
              <Trash2 size={14} />
              {isDev(plugin) ? '移除' : '卸载'}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// Where a widget sits, and what each event it can hear tells it.
const widgetPlaces: Record<string, string> = {
  assistant: '趴在 AI 助手的输入框上',
  'bottom-right': '在窗口右下角',
  'bottom-left': '在窗口左下角',
  'top-right': '在窗口右上角',
  'top-left': '在窗口左上角',
};
const widgetEventNames: Record<string, string> = {
  ai: '知道 AI 是否在思考、回答或出错（不含对话内容）',
  reading: '知道你是否在阅读、读的是 HTML 还是 PDF（不含文档内容）',
  document: '能看到你正在读的文档标题',
};

function Permissions({
  manifest: m,
  added,
  open = false,
}: {
  manifest: PluginManifest;
  added?: PluginInspection['added'];
  open?: boolean;
}) {
  const isNew = (kind: 'network' | 'write' | 'tools', value: string) =>
    !!added && (added[kind] as string[]).includes(value);
  return (
    <details className="plugin-permissions" open={open}>
      <summary>
        <ShieldCheck size={13} />
        它能做什么
      </summary>
      <ul>
        {m.run.tools.map((t) => (
          <li key={t} className={isNew('tools', t) ? 'new' : ''}>
            {(m.run.where === 'folder' && folderToolNames[t]) || toolNames[t] || t}
          </li>
        ))}
        {m.run.web ? (
          <li className={added?.web ? 'new' : ''}>让模型用它自己的联网搜索（服务支持时）</li>
        ) : null}
        {m.widget ? (
          <>
            <li className={added?.widget ? 'new' : ''}>
              {`${widgetPlaces[m.widget.anchor]}显示一个挂件（鼠标移上去可以收起）`}
            </li>
            {m.widget.events.map((e) => (
              <li key={e} className={added?.events?.includes(e) ? 'new' : ''}>
                {widgetEventNames[e] || e}
              </li>
            ))}
            <li className={added?.widget ? 'new' : ''}>
              挂件可以自己访问任何网站，可能把上面这些发出去；页间从来不会在挂件里问你要密码或 API Key
            </li>
            {m.widget.art.author || m.widget.art.license ? (
              <li>
                美术素材：
                {[m.widget.art.author, m.widget.art.license].filter(Boolean).join('，')}
              </li>
            ) : null}
          </>
        ) : null}
        {m.run.script ? (
          <li className={added?.script ? 'new' : ''}>
            运行插件自带的脚本：脚本可以自己访问任何网站，可能把它经手的内容（包括 AI
            交给它的文档内容）发出去
          </li>
        ) : null}
        {m.permissions.network.length ? (
          <li>
            <Globe size={12} /> 访问这些网站：
            {m.permissions.network.map((h, i) => (
              <span key={h} className={isNew('network', h) ? 'new' : ''}>
                {i ? '、' : ''}
                {h}
              </span>
            ))}
          </li>
        ) : null}
        {m.run.where === 'folder' ? (
          <li>
            <FolderInput size={12} /> 只在它自己的文件夹里读写（
            {m.settings.find((x) => `{{${x.key}}}` === m.permissions.write[0])?.label}
            ），看不到你的项目和其他文件
          </li>
        ) : m.permissions.write.length ? (
          <li>
            <FolderInput size={12} /> 在这些文件夹里写文件：
            {m.permissions.write.map((w, i) => (
              <span key={w} className={isNew('write', w) ? 'new' : ''}>
                {i ? '、' : ''}
                {w.replace(
                  /\{\{(\w+)\}\}/g,
                  (_, k) => m.settings.find((s) => s.key === k)?.label || k,
                )}
              </span>
            ))}
          </li>
        ) : null}
        {m.triggers
          .filter((t) => t.type === 'daily')
          .map((t) => (
            <li key="daily">每天 {t.type === 'daily' ? t.time : ''} 自动运行（开启后）</li>
          ))}
      </ul>
    </details>
  );
}

function InstallConfirm(p: {
  inspection: PluginInspection;
  busy: boolean;
  onCancel: () => void;
  onInstall: () => void;
}) {
  const { manifest: m, source, installed, added, sameCommit, warnings } = p.inspection;
  const size = p.inspection.files.reduce((n, f) => n + f.size, 0);
  // Asked from a card higher up (检查更新), it's brought into view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(
    () => box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    [p.inspection],
  );
  const linked = source.type === 'folder';
  const title = linked
    ? installed
      ? `重新加载「${m.name}」`
      : `从文件夹加载「${m.name}」？`
    : installed
      ? sameCommit
        ? `「${m.name}」已是最新`
        : `更新「${m.name}」`
      : `安装「${m.name}」？`;
  return (
    <div className="plugin-confirm" role="dialog" aria-label={`安装${m.name}`} ref={box}>
      <h5>{title}</h5>
      <p className="plugin-description">{m.description || '（作者没有写介绍）'}</p>
      <dl>
        <dt>版本</dt>
        <dd>
          {installed && !sameCommit ? `${installed.version} → ` : ''}
          {m.version}
          {m.author ? ` · 作者 ${m.author}` : ''}
        </dd>
        <dt>来源</dt>
        <dd>
          {source.type === 'official' ? (
            <span>页间官网</span>
          ) : source.type === 'folder' ? (
            <span title={source.path}>本地文件夹 · {source.shown}</span>
          ) : source.type === 'zip' ? (
            <span>压缩包 · {source.name}</span>
          ) : (
            <>
              <button
                type="button"
                className="settings-link"
                onClick={() => void invoke('external', { url: source.url }).catch(() => {})}
              >
                {source.type === 'gitee' ? 'Gitee' : 'GitHub'} · {source.owner}/{source.repo}
                {source.path ? `/${source.path}` : ''}
              </button>
              <span className="plugin-commit"> @ {shortCommit(source.commit)}</span>
            </>
          )}
        </dd>
        <dt>文件</dt>
        <dd>
          {p.inspection.files.length} 个，共 {Math.max(1, Math.round(size / 1024))} KB
        </dd>
      </dl>
      {added ? (
        <p className="plugin-error">
          <ShieldAlert size={14} />
          新版本要的权限比现在多，下面标出的是新增的部分。
        </p>
      ) : null}
      <Warnings warnings={warnings} />
      <Permissions manifest={m} added={added} open />
      {source.type === 'official' ? null : (
        <p className="settings-footnote">
          {source.type === 'folder'
            ? '开发版：页间直接读这个文件夹，保存的改动（包括它要的权限）马上生效，不会再问你。'
            : source.type === 'zip'
              ? '以后要更新，再装一次新的压缩包。'
              : `装的是 commit ${shortCommit(source.commit)} 这一版；作者之后的修改，点「检查更新」才会装。`}
        </p>
      )}
      <div className="plugin-actions">
        <button
          type="button"
          className="primary-button"
          disabled={p.busy || sameCommit}
          onClick={p.onInstall}
        >
          {p.busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : linked ? (
            <FolderCode size={14} />
          ) : (
            <Download size={14} />
          )}
          {linked ? (installed ? '重新加载' : '加载') : installed ? '更新' : '安装'}
        </button>
        <button type="button" className="secondary-button" disabled={p.busy} onClick={p.onCancel}>
          {sameCommit ? '关闭' : '取消'}
        </button>
      </div>
    </div>
  );
}

// What a plugin's author may have got wrong: it still installs and runs.
function Warnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return (
    <div className="plugin-warnings" role="note">
      <TriangleAlert size={14} />
      <div>
        <strong>插件可能写错的地方</strong>
        <ul>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function stamp(at: number) {
  const d = new Date(at);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
const logKinds = { run: '运行', tool: '工具', script: '脚本', warn: '提示', error: '出错' };

// A plugin's run log: each run's start and end, the tools it called, and what its script said
// or threw. For finding out why a run went wrong, and for writing a plugin.
function PluginLog({ id }: { id: string }) {
  const entries = usePluginLog(id);
  const list = useRef<HTMLOListElement>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const el = list.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [open, entries.length]);
  const errors = entries.filter((e) => e.kind === 'error').length;
  const text = () =>
    entries.map((e) => `${stamp(e.at)} [${logKinds[e.kind]}] ${e.text}`).join('\n');
  return (
    <details
      className="plugin-log"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <ScrollText size={13} />
        运行日志
        {entries.length ? (
          <span className={errors ? 'plugin-log-count failed' : 'plugin-log-count'}>
            {entries.length} 条{errors ? `，${errors} 个出错` : ''}
          </span>
        ) : null}
      </summary>
      {entries.length ? (
        <>
          <ol ref={list} aria-label="运行日志">
            {entries.map((e, i) => (
              <li key={`${e.at}-${i}`} className={`log-${e.kind}`}>
                <time>{stamp(e.at)}</time>
                <span className="log-kind">{logKinds[e.kind]}</span>
                <span className="log-text">{e.text}</span>
              </li>
            ))}
          </ol>
          <div className="plugin-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(text())
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => {})
              }
            >
              <Copy size={13} />
              {copied ? '已复制' : '复制日志'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void clearPluginLog(id).catch(() => {})}
            >
              <Eraser size={13} />
              清空
            </button>
          </div>
        </>
      ) : (
        <p className="settings-footnote">还没有记录。运行一次后，这里会列出它的每一步。</p>
      )}
    </details>
  );
}

// The directory of third-party plugins: submitted by their authors to the public folio-plugins
// repository and listed there; installing one still shows what it asks for first.
function DirectoryBrowser(p: {
  installed: Set<string>;
  busy: boolean;
  onInstall: (entry: DirectoryPlugin) => void;
}) {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<PluginDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  async function load(refresh = false) {
    setLoading(true);
    setError('');
    try {
      setDirectory(await loadDirectory(refresh));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (open && !directory && !loading) void load();
  }, [open]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (directory?.plugins || []).filter((x) => {
    const hay = [x.name, x.id, x.author, x.description, ...x.tags].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return (
    <details
      className="plugin-directory"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <LibraryBig size={14} />
        浏览社区插件目录
      </summary>
      <div className="plugin-directory-bar">
        <label className="plugin-search">
          <Search size={13} />
          <input
            type="search"
            aria-label="搜索插件目录"
            placeholder="搜索名字、作者或用途"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          title="重新读取插件目录"
          onClick={() => void load(true)}
        >
          {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
          刷新
        </button>
      </div>
      {error ? (
        <p className="plugin-error" role="alert">
          <CircleAlert size={13} />
          {error}
        </p>
      ) : null}
      {loading && !directory ? (
        <p className="settings-footnote" role="status">
          正在读取插件目录…
        </p>
      ) : null}
      {directory ? (
        shown.length ? (
          <ul className="plugin-directory-list">
            {shown.map((x) => (
              <li key={x.id}>
                <div>
                  <strong>{x.name}</strong>
                  {x.author ? <span className="plugin-meta"> · {x.author}</span> : null}
                  {x.description ? <p>{x.description}</p> : null}
                  {x.tags.length ? (
                    <p className="plugin-tags">
                      {x.tags.map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                    </p>
                  ) : null}
                </div>
                <div className="plugin-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={p.busy || p.installed.has(x.id)}
                    aria-label={`安装${x.name}`}
                    onClick={() => p.onInstall(x)}
                  >
                    <Download size={13} />
                    {p.installed.has(x.id) ? '已安装' : '安装'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`${x.name}的源代码`}
                    onClick={() => void invoke('external', { url: x.repo }).catch(() => {})}
                  >
                    <ExternalLink size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-footnote">
            {directory.plugins.length ? '没有找到符合的插件。' : '目录里还没有插件。'}
          </p>
        )
      ) : null}
      <p className="settings-footnote">
        收录前看过清单和权限，但不保证安全。
        <button
          type="button"
          className="settings-link"
          onClick={() => void invoke('external', { url: PLUGIN_HOME }).catch(() => {})}
        >
          写一个插件
        </button>
      </p>
    </details>
  );
}
