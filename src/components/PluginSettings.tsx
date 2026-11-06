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
  installPlugin,
  isDev,
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
const PLUGIN_DOWNLOADS = 'https://helloxxy.com/works/folio/plugins/';

// 设置 › 插件: Folio's own plugins and the ones installed from links. Third-party plugins
// are off until switched on, as Obsidian's community plugins are.
export function PluginSettings(p: {
  root?: string;
  projectName?: string;
  onRun: (id: string) => void;
  // A folder plugin's folder, opened in Folio as the project it is.
  onOpenFolder: (id: string) => void;
}) {
  const list = usePlugins();
  const [warning, setWarning] = useState(false);
  const [pendingRecommendation, setPendingRecommendation] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [inspection, setInspection] = useState<PluginInspection | null>(null);
  const [dragging, setDragging] = useState(false);
  if (!isDesktop) return <p className="settings-footnote">请在桌面版页间中使用插件。</p>;
  if (!list)
    return (
      <p className="settings-footnote" role="status">
        正在读取插件…
      </p>
    );
  const thirdParty = list.thirdParty;
  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  const inspect = (from: {
    url?: string;
    id?: string;
    local?: string;
    expect?: string;
    recommendation?: string;
  }) => act('inspect', async () => setInspection(await inspectPlugin(from)));
  const pickLocal = (kind: 'folder' | 'zip') =>
    act('inspect', async () => {
      const seen = await pickLocalPlugin(kind);
      if (seen) setInspection(seen);
    });
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
          if (!local) setError('没有读到拖进来的文件，请改用「从文件夹加载…」或「安装 .zip…」');
          else if (!busy) void inspect({ local });
        },
      }
    : {};
  return (
    <div className="plugin-settings">
      <section className="settings-group">
        <h4>推荐插件</h4>
        <p className="settings-footnote">
          推荐会一直显示，插件由你选择安装。点击「下载」才会从官网获取，确认安装后再手动开启。
        </p>
        <div className="plugin-list">
          {list.recommendations.map((item) => {
            const installed = list.plugins.some((plugin) => plugin.id === item.id);
            return (
              <article className="plugin-card" key={item.id} aria-label={`推荐：${item.name}`}>
                <div className="plugin-head">
                  <Puzzle size={24} aria-hidden="true" />
                  <div>
                    <h5>
                      {item.name}
                      <span className="plugin-version">{item.version}</span>
                    </h5>
                    <p className="plugin-meta">{item.author} · 官网独立下载</p>
                  </div>
                </div>
                <p>{item.description}</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy || installed}
                  onClick={() => {
                    if (thirdParty) void inspect({ recommendation: item.id });
                    else {
                      setPendingRecommendation(item.id);
                      setWarning(true);
                    }
                  }}
                >
                  {busy === 'inspect' ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  {installed ? '已安装' : busy === 'inspect' ? '正在下载…' : '下载'}
                </button>
              </article>
            );
          })}
        </div>
        <div className="plugin-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void act('website', () => invoke('external', { url: PLUGIN_DOWNLOADS }))}
            disabled={!!busy}
          >
            <ExternalLink size={14} />
            查看官网插件页
          </button>
        </div>
      </section>
      <section
        className={`settings-group plugin-third-party${dragging ? ' dragging' : ''}`}
        {...dropZone}
      >
        <h4>外部插件</h4>
        <label className="settings-row">
          <span>
            <strong>允许安装和运行外部插件</strong>
            <small>
              插件独立于页间安装。打开后可以从官网推荐、插件目录、GitHub / Gitee 链接、.zip
              或本地文件夹安装插件；关闭后已装的外部插件都会停止运行。
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="允许外部插件"
            checked={thirdParty || warning}
            disabled={!!busy}
            onChange={(e) => {
              if (e.target.checked) setWarning(true);
              else {
                setWarning(false);
                setPendingRecommendation('');
                void act('third-party', () => setThirdParty(false));
              }
            }}
          />
        </label>
        {warning && !thirdParty ? (
          <div className="plugin-warning" role="alertdialog" aria-label="打开外部插件前请确认">
            <ShieldAlert size={18} />
            <div>
              <strong>打开前请确认</strong>
              <ul>
                <li>请确认插件的来源和作者；社区插件由各自作者维护，推荐不代表对其内容的担保。</li>
                <li>
                  插件会让 AI 用你的 API Key
                  工作，产生的费用由你承担；它能访问安装时列出的网站，在列出的文件夹里写文件。
                </li>
                <li>
                  带脚本的插件在沙箱里运行，拿不到你的 API
                  Key，也不能自己联网；但请只安装你信任的作者的插件，安装前看清楚它要的权限。
                </li>
              </ul>
              <div className="plugin-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!!busy}
                  onClick={() =>
                    void act(pendingRecommendation ? 'inspect' : 'third-party', async () => {
                      await setThirdParty(true);
                      setWarning(false);
                      const recommendation = pendingRecommendation;
                      setPendingRecommendation('');
                      if (recommendation) setInspection(await inspectPlugin({ recommendation }));
                    })
                  }
                >
                  我了解，打开外部插件
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setWarning(false);
                    setPendingRecommendation('');
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {thirdParty ? (
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
        ) : null}
        {thirdParty ? (
          <div className="plugin-local">
            <button
              type="button"
              className="secondary-button"
              disabled={!!busy}
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
              {dragging
                ? '松开就会读取这个插件'
                : '也可以把插件文件夹或 .zip 拖到这里。从文件夹加载的是开发版：页间直接读那个文件夹，保存后马上生效，适合自己写插件时用。'}
            </small>
          </div>
        ) : null}
        {error ? (
          <p className="plugin-error" role="alert">
            <CircleAlert size={14} />
            {error}
          </p>
        ) : null}
        {inspection ? (
          <InstallConfirm
            inspection={inspection}
            busy={busy === 'install'}
            onCancel={() => setInspection(null)}
            onInstall={() =>
              void act('install', async () => {
                await installPlugin(inspection.stage);
                setInspection(null);
                setLink('');
              })
            }
          />
        ) : null}
        {thirdParty ? (
          <DirectoryBrowser
            installed={new Set(list.plugins.map((x) => x.id))}
            busy={!!busy}
            onInstall={(entry) => void inspect({ url: entry.repo, expect: entry.id })}
          />
        ) : null}
      </section>
      <section className="settings-group">
        <h4>插件</h4>
        {list.plugins.length ? (
          <div className="plugin-list">
            {list.plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                thirdParty={thirdParty}
                root={p.root}
                projectName={p.projectName}
                busy={!!busy}
                onRun={() => p.onRun(plugin.id)}
                onOpenFolder={p.onOpenFolder}
                onCheck={() => void inspect({ id: plugin.id })}
                onError={setError}
              />
            ))}
          </div>
        ) : (
          <p className="settings-footnote">还没有插件。</p>
        )}
        <p className="settings-footnote">
          插件默认用「AI」里为助手聊天选的模型，也可以在每个插件里单独选，会消耗你的 AI
          额度。定时运行需要页间开着；错过的时间会在下次启动时补跑一次。
        </p>
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

function PluginCard(p: {
  plugin: PluginInfo;
  thirdParty: boolean;
  root?: string;
  projectName?: string;
  busy: boolean;
  onRun: () => void;
  onOpenFolder: (id: string) => void;
  onCheck: () => void;
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
  const [open, setOpen] = useState(false);
  if (!m)
    return (
      <article className="plugin-card broken">
        <div className="plugin-head">
          <span className="plugin-icon plugin-icon-blank">
            <CircleAlert size={18} />
          </span>
          <div>
            <h5>
              {plugin.id}
              {isDev(plugin) ? <span className="plugin-badge dev">开发版</span> : null}
            </h5>
            {plugin.source?.type === 'folder' ? (
              <p className="plugin-meta" title={plugin.source.path}>
                {plugin.source.shown}
              </p>
            ) : null}
            <p className="plugin-error">这个插件读不了：{plugin.error}</p>
            {isDev(plugin) ? (
              <small className="plugin-hint">改好保存后，这里会自动重新读取。</small>
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
      </article>
    );
  const locked = !plugin.bundled && !p.thirdParty;
  const changed =
    m.settings.some((s) => (draft[s.key] ?? '') !== (plugin.settings[s.key] ?? '')) ||
    (!!moveTo && moveTo !== plugin.root);
  // The project its folders are in: the one it works in, or the one it's moving to.
  const home = moveTo || plugin.root || p.root || '';
  const homeName = home.split(/[\\/]/).filter(Boolean).pop() || '';
  const daily = m.triggers.find((t) => t.type === 'daily');
  // Works in a folder of its own, whichever project is open.
  const own = m.run.where === 'folder';
  const elsewhere = !own && plugin.enabled && plugin.root && p.root && plugin.root !== p.root;
  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => p.onError(errorText(e)));
  const shownOpen = open || changed;
  const summary = plugin.enabled
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
  // A folder setting picked in Finder / Explorer, inside the plugin's project; saved with the
  // other settings.
  async function pickFolder(key: string, title: string) {
    setFolderError('');
    try {
      // Its own folder: anywhere on this computer.
      if (own) {
        const picked = await invoke<string | null>('choose-plugin-folder', {
          anywhere: true,
          current:
            draft[key] === plugin.settings[key] ? plugin.folder?.path || '' : draft[key] || '',
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
  return (
    <article className={`plugin-card${plugin.enabled ? ' on' : ''}`}>
      <div className="plugin-head">
        <PluginIcon plugin={plugin} />
        <div>
          <h5>
            {m.name}
            <span className="plugin-version">{m.version}</span>
            {isDev(plugin) ? (
              <span className="plugin-badge dev">开发版</span>
            ) : (
              <span className={`plugin-badge${plugin.bundled ? '' : ' third'}`}>
                {plugin.bundled ? '页间自带' : '外部插件'}
              </span>
            )}
            {m.run.script ? <span className="plugin-badge third">含脚本</span> : null}
          </h5>
          <p
            className="plugin-meta"
            title={plugin.source?.type === 'folder' ? plugin.source.path : undefined}
          >
            {m.author ? `${m.author} · ` : ''}
            {plugin.source && 'commit' in plugin.source
              ? `${plugin.source.owner}/${plugin.source.repo} @ ${shortCommit(plugin.source.commit)}`
              : plugin.source?.type === 'folder'
                ? `从文件夹加载 · ${plugin.source.shown}`
                : plugin.source?.type === 'zip'
                  ? `从压缩包安装 · ${plugin.source.name}`
                  : plugin.bundled
                    ? '随页间安装'
                    : '本地'}
          </p>
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-label={`开启${m.name}`}
          checked={plugin.enabled}
          disabled={p.busy || locked}
          title={locked ? '先打开「外部插件」' : undefined}
          onChange={(e) =>
            run(() =>
              setPlugin({
                id: plugin.id,
                enabled: e.target.checked,
                // Its schedule runs in the project open when it's switched on.
                ...(!own && e.target.checked && !plugin.root && p.root ? { root: p.root } : {}),
              }).then(() => e.target.checked && setOpen(true)),
            )
          }
        />
      </div>
      {shownOpen ? (
        <>
          <p className="plugin-description">{m.description}</p>
          {isDev(plugin) ? (
            <p className="plugin-hint">
              开发版：页间每次运行都直接读这个文件夹，保存后马上生效（包括它要的权限），不会再问你。
            </p>
          ) : null}
          <Warnings warnings={plugin.warnings} />
          <Permissions manifest={m} />
          <PluginLog id={plugin.id} />
        </>
      ) : (
        <p className="plugin-summary" title={summary}>
          {summary}
        </p>
      )}
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
                    title={
                      draft[s.key] === plugin.settings[s.key] ? plugin.folder?.path : draft[s.key]
                    }
                    value={
                      draft[s.key] === plugin.settings[s.key]
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
                <p className="plugin-destination">
                  日报和每次运行的记录都放在这个文件夹里，它就是这个插件的项目：在页间里打开它，「整个项目」里能看到每一次运行。插件只在这里读写，没有的话第一次运行时会新建。
                  {draft[s.key] === plugin.settings[s.key] ? (
                    <button
                      type="button"
                      className="settings-link"
                      onClick={() => p.onOpenFolder(plugin.id)}
                    >
                      在页间里打开这个文件夹
                    </button>
                  ) : null}
                </p>
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
                <p className="plugin-destination">
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
                </p>
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
          <div className="plugin-field">
            <span>
              <Sparkles size={13} />
              用哪个 AI
            </span>
            <div className="plugin-model">
              <ModelMenu use={`plugin:${plugin.id}`} label={m.name} className="model-pick" />
            </div>
            <small>默认跟随助手聊天。单独选一个服务和模型后，只有这个插件用它，马上生效。</small>
          </div>
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
                <span>{plugin.schedule.off ? '不自动运行，需要时手动点' : '自动运行'}</span>
              </div>
              <small className="plugin-schedule">
                {own
                  ? '只要页间开着就会运行，不管打开的是哪个项目。'
                  : `在项目「${plugin.root ? plugin.root.split(/[\\/]/).pop() : '（未选择）'}」打开时运行。`}
                {elsewhere || (!own && !plugin.root && p.root) ? (
                  <button
                    type="button"
                    className="settings-link"
                    onClick={() => run(() => setPlugin({ id: plugin.id, root: p.root }))}
                  >
                    改为当前项目{p.projectName ? `「${p.projectName}」` : ''}
                  </button>
                ) : null}
                错过的时间会在下次启动时补跑一次；改了时间，从下一个这个时间开始。
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
      <div className="plugin-actions">
        {plugin.enabled ? (
          <button
            type="button"
            className="secondary-button"
            disabled={!running && ((!own && !p.root) || changed)}
            title={
              running
                ? '看它在「整个项目」里的每一步'
                : !p.root
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
        {shownOpen && plugin.source && 'commit' in plugin.source && p.thirdParty ? (
          <button type="button" className="secondary-button" disabled={p.busy} onClick={p.onCheck}>
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
            {plugin.bundled ? '主页' : '源代码'}
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
      </div>
    </article>
  );
}

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
      <summary>它能做什么</summary>
      <ul>
        {m.run.tools.map((t) => (
          <li key={t} className={isNew('tools', t) ? 'new' : ''}>
            {(m.run.where === 'folder' && folderToolNames[t]) || toolNames[t] || t}
          </li>
        ))}
        {m.run.web ? (
          <li className={added?.web ? 'new' : ''}>让模型用它自己的联网搜索（服务支持时）</li>
        ) : null}
        {m.run.script ? (
          <li className={added?.script ? 'new' : ''}>
            运行插件自带的脚本（在沙箱里，不能自己联网）
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
    <div className="plugin-confirm" role="dialog" aria-label={`安装${m.name}`}>
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
          {source.type === 'folder' ? (
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
      <p className="settings-footnote">
        {source.type === 'folder'
          ? '这是从文件夹加载的开发版，页间没有审核它。不会复制：页间每次运行都直接读这个文件夹，你保存的改动（包括它要的权限）马上生效，不会再问你。只加载你自己在写、或者已经看过内容的插件。'
          : source.type === 'zip'
            ? '会从压缩包复制一份插件装上。安装前请确认来源和权限；以后要更新，再装一次新的压缩包。'
            : `这是外部插件，页间没有审核它。会装上 commit ${shortCommit(source.commit)} 这一版，作者之后的修改要你再点「检查更新」才会装。`}
      </p>
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
        <p className="settings-footnote">
          还没有记录。运行一次后，这里会列出它调用的每个工具和结果，以及脚本用 folio.log
          写的话和出的错。
        </p>
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
        浏览插件目录
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
        目录里的插件由作者提交、经页间收录；收录前会看一遍清单和权限，但不保证安全，安装前仍会列出它要的权限。
        <button
          type="button"
          className="settings-link"
          onClick={() => void invoke('external', { url: PLUGIN_HOME }).catch(() => {})}
        >
          写一个插件 / 提交到目录
        </button>
      </p>
    </details>
  );
}
