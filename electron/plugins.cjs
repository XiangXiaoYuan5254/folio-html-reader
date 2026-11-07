// 插件：用户从官网 .zip、GitHub / Gitee 链接装的（复制到用户数据目录的 plugins/），
// 以及从本地文件夹加载、正在写的
// 开发版（不复制，直接读那个文件夹，改了马上生效）。清单的写法和检查在 plugin-manifest.cjs。
// 插件是一个文件夹，folio-plugin.json 说明它叫什么、
// 什么时候运行、能用哪些工具、能访问哪些网站、能往哪些文件夹写；prompt.md 是交给 AI 的任务说明。
// 带脚本的插件（run.script）只在一个看不见的沙箱页面里运行（sandboxPage），不能自己联网，
// 也拿不到 API Key：它只能通过页间转交的 fetch 访问清单里写明的网站。
//
// 官方插件（官网上签过名的列表里的，从官网下载、按 SHA-256 校验；见 official-plugins.cjs）随时可以装。
// 其他插件是社区插件，和 Obsidian 的一样默认关闭：打开「社区插件」之后才能安装和运行。
const fs = require('node:fs/promises');
const fsWatch = require('node:fs').watch;
const path = require('node:path');
const crypto = require('node:crypto');
const {
  MANIFEST,
  TOOLS,
  WRITE_TOOLS,
  FOLDER_TOOLS,
  LIMITS,
  PluginError,
  fail,
  text,
  idPattern,
  satisfies,
  validateManifest,
  newPermissions,
  allowedUrl,
  readPluginDir,
  lintPlugin,
} = require('./plugin-manifest.cjs');
const { readZip } = require('./zip.cjs');
const { createOfficial, OFFICIAL_URL, OFFICIAL_KEYS } = require('./official-plugins.cjs');

const FETCH_LIMIT = 3 * 1024 * 1024;
// 插件目录：作者提交、页间收录的社区插件列表（公开仓库 folio-plugins 里的
// community-plugins.json）。GitHub 连不上时改走 jsDelivr。
const DIRECTORY_URLS = [
  'https://raw.githubusercontent.com/XiangXiaoYuan5254/folio-plugins/main/community-plugins.json',
  'https://cdn.jsdelivr.net/gh/XiangXiaoYuan5254/folio-plugins@main/community-plugins.json',
];
const ZIP_LIMIT = 8 * 1024 * 1024;
const LOG_KEEP = 400;

// A plugin's contents as one hash: its manifest, then the files it lists, in that order. The
// website build (scripts/website-plugins.mjs) records it for each official plugin, so a copy
// installed as a plain .zip (页间 0.30.0 didn't tell official plugins apart) is recognised by
// what it is, not by its file name.
// The official versions 0.30.0 could have installed that way, for when the website's list has
// moved on to newer ones (AI 前沿日报 1.1.0).
const OFFICIAL_BEFORE_0_30_1 = {
  'ai-daily': ['20f7aec1e19a6a953b162ecdd35a8f107a92c58cfd728a5ab7d5230c2ddb9bef'],
};
function pluginDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const { name, data } of files) hash.update(`${name}\0${data.length}\0`).update(data);
  return hash.digest('hex');
}

// GitHub / Gitee 链接：仓库，或仓库里的一个文件夹（…/tree/<分支>/<文件夹>）。
function parseSource(input) {
  let value = text(input, 400).replace(/\.git$/, '');
  if (!value) fail('请粘贴插件的 GitHub 或 Gitee 链接');
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}`;
  if (!/^https?:\/\//.test(value)) value = `https://${value}`;
  let u;
  try {
    u = new URL(value);
  } catch {
    fail('这不是一个有效的链接');
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'github.com' && host !== 'gitee.com')
    fail('目前只支持 GitHub（github.com）和 Gitee（gitee.com）上的插件');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) fail('链接里要有仓库，例如 https://github.com/someone/folio-plugin');
  const [owner, repo] = parts;
  if (![owner, repo].every((p) => /^[\w.-]+$/.test(p))) fail('仓库名无效');
  let ref = '';
  let dir = '';
  if (parts[2] === 'tree' || parts[2] === 'blob') {
    ref = parts[3] || '';
    dir = parts.slice(4).join('/');
    if (parts[2] === 'blob' && dir.endsWith(MANIFEST)) dir = dir.slice(0, -MANIFEST.length);
  } else if (parts.length > 2) fail('看不懂这个链接，请复制仓库首页或插件文件夹的链接');
  dir = dir.replace(/\/+$/, '');
  if (dir && dir.split('/').some((p) => !/^[\w.\- ]+$/.test(p) || p === '..'))
    fail('文件夹路径无效');
  if (ref && !/^[\w.\-/]+$/.test(ref)) fail('分支名无效');
  return {
    type: host === 'gitee.com' ? 'gitee' : 'github',
    owner,
    repo,
    ref,
    path: dir,
    url: `https://${host}/${owner}/${repo}${ref ? `/tree/${ref}${dir ? `/${dir}` : ''}` : ''}`,
  };
}

// 从 GitHub / Gitee 读一个插件：先查出分支当前的 commit，再按这个 commit 下载文件，
// 之后装的就是这一份，作者再推送也不会悄悄变。
function createRemote(fetch) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  async function get(url, { json = false, limit = LIMITS.file, headers = {} } = {}) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'Folio-Plugins', ...headers },
        signal: AbortSignal.timeout(20_000),
        credentials: 'omit',
        redirect: 'follow',
      });
    } catch (e) {
      const err = new PluginError(`连不上 ${new URL(url).hostname}（${e.message}）`);
      err.network = true;
      throw err;
    }
    if (res.status === 404) {
      const err = new PluginError('没找到');
      err.missing = true;
      throw err;
    }
    if (res.status === 403 || res.status === 429)
      fail(
        `${new URL(url).hostname} 暂时拒绝了请求（${res.status}），可能是访问太频繁，请稍后再试`,
      );
    if (!res.ok) fail(`${new URL(url).hostname} 返回了错误 ${res.status}`);
    const size = Number(res.headers.get('content-length') || 0);
    if (size > limit) fail(`文件太大（超过 ${Math.round(limit / 1024)} KB）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) fail(`文件太大（超过 ${Math.round(limit / 1024)} KB）`);
    return json ? JSON.parse(buf.toString('utf8')) : buf;
  }
  async function commit(source) {
    if (source.type === 'github') {
      const ref = source.ref || 'HEAD';
      const sha = String(
        await get(
          `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`,
          { headers: { Accept: 'application/vnd.github.sha' }, limit: 1000 },
        ).catch((e) => {
          if (e.missing)
            fail(
              `GitHub 上没有找到仓库 ${source.owner}/${source.repo}${source.ref ? ` 的分支 ${source.ref}` : ''}，或者它不是公开仓库`,
            );
          throw e;
        }),
      ).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) fail('GitHub 没有返回有效的 commit');
      return sha;
    }
    const base = `https://gitee.com/api/v5/repos/${source.owner}/${source.repo}`;
    const ref =
      source.ref ||
      (
        await get(base, { json: true }).catch((e) => {
          if (e.missing) fail(`Gitee 上没有找到公开仓库 ${source.owner}/${source.repo}`);
          throw e;
        })
      ).default_branch;
    const info = await get(`${base}/commits/${encodeURIComponent(ref)}`, { json: true });
    if (!/^[0-9a-f]{40}$/.test(info?.sha || '')) fail('Gitee 没有返回有效的 commit');
    return info.sha;
  }
  // 一个文件：GitHub 先走 raw.githubusercontent.com，连不上时改走 API（国内常常只有一个能用）。
  async function file(source, sha, name, limit) {
    const rel = source.path ? `${source.path}/${name}` : name;
    if (source.type === 'github') {
      const urls = [
        `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${sha}/${enc(rel)}`,
        `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${enc(rel)}?ref=${sha}`,
      ];
      let last;
      for (const url of urls) {
        try {
          return await get(url, {
            limit,
            headers: url.includes('api.github.com') ? { Accept: 'application/vnd.github.raw' } : {},
          });
        } catch (e) {
          last = e;
          if (!e.network && !e.missing) throw e;
        }
      }
      if (last?.missing) fail(`仓库里没有 ${rel}`);
      throw last;
    }
    return get(
      `https://gitee.com/api/v5/repos/${source.owner}/${source.repo}/raw/${enc(rel)}?ref=${sha}`,
      { limit },
    ).catch((e) => {
      if (e.missing) fail(`仓库里没有 ${rel}`);
      throw e;
    });
  }
  return { commit, file, get };
}

// 带脚本的插件运行的页面：一个独立的沙箱（iframe sandbox="allow-scripts"，没有同源权限），
// 内容安全策略禁止它自己联网、加载图片或别的资源。它通过 postMessage 和页间说话：
// 注册工具、通过页间按白名单联网、写运行日志。
//
// 工具在脚本顶层注册最好；先 await folio.fetch(…) 再注册也行：脚本跑完后，页间等这些请求
// 都回来、注册不再变化（最多 8 秒）才告诉 AI 有哪些工具。之后才注册的会在运行日志里提示。
function sandboxPage({ code, settings, name }) {
  const safe = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  // Built twice: first to count the lines before the plugin's own code (the count doesn't depend
  // on the number), so an error says which of its lines it was.
  const bootstrap = (
    codeLine,
  ) => `<!doctype html><html><head><meta charset="utf-8"><title>${name.replace(/[<&"\s]+/g, ' ')}</title></head><body><script>
(() => {
  const host = window.parent;
  const tools = new Map();
  const pending = new Map();
  let seq = 0;
  let ready = false;
  const send = (m) => host.postMessage({ folioPlugin: 1, ...m }, '*');
  const say = (level, args) => send({ type: 'log', level, text: args.map((a) => a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ').slice(0, 500) });
  const call = (type, payload) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ type, id, payload });
  });
  const folio = Object.freeze({
    settings: Object.freeze(${safe(settings || {})}),
    registerTool(def, handler) {
      if (!def || typeof def.name !== 'string' || typeof handler !== 'function') throw Error('registerTool(def, handler)');
      if (ready) return say('error', ['工具 ' + def.name + ' 注册得太晚，这次运行用不上：请在脚本顶层注册，或在 await folio.fetch(…) 之后马上注册']);
      tools.set(def.name, { def: { name: def.name, description: String(def.description || ''), parameters: def.parameters || { type: 'object', properties: {} } }, handler });
    },
    fetch: (url, options = {}) => call('fetch', { url: String(url), accept: options.accept ? String(options.accept) : '' }),
    log: (...args) => say('info', args),
    warn: (...args) => say('warn', args),
    error: (...args) => say('error', args),
  });
  Object.defineProperty(window, 'folio', { value: folio });
  addEventListener('message', async (e) => {
    if (e.source !== host || !e.data || e.data.folioPlugin !== 1) return;
    const m = e.data;
    if (m.type === 'reply') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) m.error ? p.reject(Error(m.error)) : p.resolve(m.value);
    } else if (m.type === 'call') {
      const tool = tools.get(m.name);
      try {
        if (!tool) throw Error('没有这个工具：' + m.name);
        const out = await tool.handler(m.input || {});
        send({ type: 'done', id: m.id, content: typeof out === 'string' ? out : JSON.stringify(out, null, 1) });
      } catch (err) {
        send({ type: 'done', id: m.id, error: String(err && err.message || err) });
      }
    }
  });
  addEventListener('error', (e) => say('error', ['脚本出错：' + e.message + (e.lineno > ${codeLine} ? '（脚本第 ' + (e.lineno - ${codeLine}) + ' 行）' : '')]));
  addEventListener('unhandledrejection', (e) => say('error', ['脚本里有没处理的错误：', e.reason]));
  window.__folioReady = async () => {
    const start = Date.now();
    let last = -1;
    while (Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 20));
      if (!pending.size && tools.size === last) break;
      last = tools.size;
    }
    ready = true;
    send({ type: 'ready', tools: [...tools.values()].map((t) => t.def) });
  };
})();
</script><script>
`;
  return `${bootstrap(bootstrap(0).split('\n').length - 1)}${code.replace(/<\/script/gi, '<\\/script')}
</script><script>window.__folioReady();</script></body></html>`;
}
const sandboxCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function createPlugins({
  bundledDir,
  userDir,
  fetch,
  atomicWrite,
  appVersion,
  documentsDir,
  // Told when a plugin being written in a folder of its own (loaded for development) changes.
  onChange,
  directoryUrls = DIRECTORY_URLS,
  // The signed list of official plugins on the website (tests pass their own).
  officialUrl = OFFICIAL_URL,
  officialKeys = OFFICIAL_KEYS,
}) {
  const installedDir = path.join(userDir, 'plugins');
  const stagingDir = path.join(installedDir, '.staging');
  const stateFile = path.join(userDir, 'plugins.json');
  const logDir = path.join(userDir, 'logs', 'plugins');
  const remote = createRemote(fetch);
  const official = createOfficial({
    fetch,
    atomicWrite,
    file: path.join(userDir, 'official-plugins.json'),
    url: officialUrl,
    keys: officialKeys,
  });
  // The official plugins this 页间 can install: the list as last read, while a newer one is
  // fetched in the background (the window reads the plugins again when it comes).
  async function officialPlugins() {
    if (official.stale()) void official.refresh().then((changed) => changed && onChange?.());
    const list = await official.saved();
    return (list?.plugins || []).filter((p) => satisfies(appVersion, p.requires));
  }
  let state = null;
  let writing = Promise.resolve();
  const staged = new Map();

  async function readState() {
    if (state) return state;
    try {
      const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      state = {
        version: 1,
        thirdParty: saved.thirdParty === true,
        plugins: saved.plugins && typeof saved.plugins === 'object' ? saved.plugins : {},
      };
    } catch {
      state = { version: 1, thirdParty: false, plugins: {} };
    }
    return state;
  }
  function saveState() {
    const snapshot = JSON.stringify(state, null, 1);
    writing = writing.then(() => atomicWrite(stateFile, snapshot)).catch(() => {});
    return writing;
  }
  async function readManifest(dir) {
    const raw = await fs.readFile(path.join(dir, MANIFEST), 'utf8');
    return validateManifest(JSON.parse(raw), { appVersion });
  }
  // 页间自带的和官方插件不受「社区插件」开关影响。
  const trusted = (entry, s) =>
    entry.bundled || (!entry.dev && s.plugins[entry.manifest?.id]?.source?.type === 'official');
  // An official plugin installed by 0.30.0 is saved as a .zip install: its files, compared with
  // the official release's, make it official again. Checked once per install.
  const notOfficial = new Set();
  async function recogniseOfficial(s, found, offered) {
    let changed = false;
    for (const [id, entry] of found) {
      const saved = s.plugins[id];
      const digests = new Set(
        [offered.find((r) => r.id === id)?.digest, ...(OFFICIAL_BEFORE_0_30_1[id] || [])].filter(
          Boolean,
        ),
      );
      if (!digests.size || entry.error || entry.bundled || entry.dev) continue;
      if (saved?.source?.type !== 'zip') continue;
      const key = `${id}:${saved.installedAt}`;
      if (notOfficial.has(key)) continue;
      try {
        const files = [{ name: MANIFEST, data: await fs.readFile(path.join(entry.dir, MANIFEST)) }];
        for (const name of entry.manifest.files)
          files.push({ name, data: await fs.readFile(path.join(entry.dir, name)) });
        if (digests.has(pluginDigest(files))) {
          saved.source = { type: 'official' };
          changed = true;
          continue;
        }
      } catch {}
      notOfficial.add(key);
    }
    if (changed) await saveState();
  }
  // 自带的、装好的，和从本地文件夹加载、正在写的插件（开发版：直接读那个文件夹，不复制）。
  // 读不了的插件也列出来，附上原因。
  async function catalog() {
    const s = await readState();
    const found = new Map();
    for (const [base, bundled] of [
      [bundledDir, true],
      [installedDir, false],
    ]) {
      if (!base) continue;
      let names = [];
      try {
        names = await fs.readdir(base);
      } catch {}
      for (const dirName of names) {
        if (dirName.startsWith('.')) continue;
        const dir = path.join(base, dirName);
        try {
          if (!(await fs.stat(dir)).isDirectory()) continue;
          const manifest = await readManifest(dir);
          if (manifest.id !== dirName) continue;
          // 装好的同名插件不会顶替自带的。
          if (found.has(manifest.id)) continue;
          found.set(manifest.id, { manifest, dir, bundled });
        } catch (e) {
          if (!bundled) found.set(dirName, { error: e.message, dir, bundled });
        }
      }
    }
    for (const [id, saved] of Object.entries(s.plugins)) {
      if (saved?.source?.type !== 'folder' || found.has(id) || !idPattern.test(id)) continue;
      const dir = String(saved.source.path || '');
      try {
        const { manifest, warnings } = await readPluginDir(dir, { appVersion });
        if (manifest.id !== id)
          fail(`文件夹里插件的 id 改成了「${manifest.id}」，请移除后重新加载这个文件夹`);
        found.set(id, { manifest, dir, bundled: false, dev: true, warnings });
      } catch (e) {
        found.set(id, { error: e.message, dir, bundled: false, dev: true });
      }
    }
    return found;
  }
  async function find(id) {
    const entry = (await catalog()).get(String(id));
    if (!entry || entry.error) fail('没有找到这个插件');
    return entry;
  }
  function settingsFor(manifest, saved = {}) {
    const out = {};
    for (const s of manifest.settings)
      out[s.key] = typeof saved[s.key] === 'string' ? saved[s.key].slice(0, 4000) : s.default;
    return out;
  }
  // A folder plugin's folder: the setting its permissions.write names, anywhere on this
  // computer (~ for the home folder); a bare name (the default) is in Documents. The folder is
  // also the plugin's project: opened in Folio, its 整个项目 holds the plugin's runs.
  function folderFor(manifest, settings) {
    const key = manifest.permissions.write[0]?.match(/^\{\{(\w+)\}\}$/)?.[1];
    const fallback = manifest.settings.find((s) => s.key === key)?.default || manifest.id;
    let value = String((key && settings[key]) || '').trim();
    if (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))
      value = path.join(require('node:os').homedir(), value.slice(2));
    if (path.isAbsolute(value)) return path.normalize(value);
    // A name in Documents; '.', '' or a way out of Documents (an old project-relative value)
    // means the default.
    value = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!value || value === '.' || value.split('/').some((p) => p === '..' || p === '.'))
      value = fallback;
    return path.join(documentsDir, value);
  }
  const shown = (dir) => {
    const home = require('node:os').homedir();
    return dir === home || dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
  };
  // Where a folder plugin works: as set, as shown, and as the project path Folio would have
  // for it once it exists (links resolved).
  async function placeOf(manifest, saved) {
    if (manifest.run.where !== 'folder') return {};
    try {
      const dir = folderFor(manifest, settingsFor(manifest, saved.settings));
      const real = await fs.realpath(dir).catch(() => dir);
      return { folder: { path: dir, shown: shown(dir), real } };
    } catch {
      return {};
    }
  }
  async function list() {
    const s = await readState();
    const plugins = [];
    const found = await catalog();
    const offered = await officialPlugins();
    await recogniseOfficial(s, found, offered);
    for (const [id, entry] of found) {
      const saved = s.plugins[id] || {};
      if (entry.error) {
        // The same fields as any other, so a card can turn broken and back while it's written.
        plugins.push({
          id,
          error: entry.error,
          bundled: false,
          enabled: false,
          source: sourceOf(saved.source),
          settings: {},
          root: '',
          enabledAt: 0,
          lastRun: 0,
          lastResult: null,
          installedAt: Number(saved.installedAt) || 0,
        });
        continue;
      }
      const { manifest, bundled } = entry;
      plugins.push({
        id,
        manifest,
        bundled,
        source: bundled ? { type: 'bundled' } : sourceOf(saved.source) || { type: 'local' },
        // A plugin loaded from a folder: what its author may have got wrong.
        ...(entry.dev ? { warnings: entry.warnings || [] } : {}),
        // 关掉「社区插件」时，社区插件都不运行；自带的和官方插件照常。
        enabled: !!saved.enabled && (trusted(entry, s) || s.thirdParty),
        settings: settingsFor(manifest, saved.settings),
        root: typeof saved.root === 'string' ? saved.root : '',
        enabledAt: Number(saved.enabledAt) || 0,
        lastRun: Number(saved.lastRun) || 0,
        lastResult: saved.lastResult || null,
        // Its daily time: the reader's own, or the one it comes with; or not on a schedule.
        ...(() => {
          const daily = manifest.triggers.find((t) => t.type === 'daily');
          if (!daily) return {};
          const own = saved.schedule || {};
          return {
            schedule: {
              time: /^([01]\d|2[0-3]):[0-5]\d$/.test(own.time || '') ? own.time : daily.time,
              off: own.off === true,
              changedAt: Number(own.changedAt) || 0,
            },
          };
        })(),
        installedAt: Number(saved.installedAt) || 0,
        ...(await placeOf(manifest, saved)),
      });
    }
    plugins.sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.id.localeCompare(b.id));
    syncWatchers(s);
    return { thirdParty: s.thirdParty, appVersion, plugins, recommendations: offered };
  }
  // Where a plugin came from, as the window shows it.
  function sourceOf(source) {
    if (source?.type === 'folder')
      return { type: 'folder', path: String(source.path), shown: shown(String(source.path)) };
    return source;
  }
  // Plugins loaded from folders are watched while third-party plugins are on: saved changes
  // show at once (the window reads the list again), and the next run uses them.
  const watchers = new Map();
  let changeTimer;
  function syncWatchers(s) {
    if (!onChange) return;
    const want = new Set(
      s.thirdParty
        ? Object.values(s.plugins)
            .filter((p) => p?.source?.type === 'folder' && typeof p.source.path === 'string')
            .map((p) => p.source.path)
        : [],
    );
    for (const [dir, w] of watchers)
      if (!want.has(dir)) {
        w.close();
        watchers.delete(dir);
      }
    for (const dir of want) {
      if (watchers.has(dir)) continue;
      try {
        const w = fsWatch(dir, { recursive: true }, (_, file) => {
          const parts = String(file || '').split(/[\\/]/);
          if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return;
          clearTimeout(changeTimer);
          changeTimer = setTimeout(() => onChange(), 200);
        });
        w.on('error', () => {
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch {}
    }
  }
  function close() {
    clearTimeout(changeTimer);
    for (const w of watchers.values()) w.close();
    watchers.clear();
  }
  async function set({ id, enabled, settings, root, schedule }) {
    const entry = await find(id);
    const s = await readState();
    if (enabled && !trusted(entry, s) && !s.thirdParty) fail('请先在插件设置里打开「社区插件」');
    const saved = { ...(s.plugins[id] || {}) };
    if (typeof enabled === 'boolean') {
      if (enabled && !saved.enabled) saved.enabledAt = Date.now();
      saved.enabled = enabled;
    }
    if (settings && typeof settings === 'object')
      saved.settings = settingsFor(entry.manifest, { ...saved.settings, ...settings });
    if (typeof root === 'string') saved.root = root.slice(0, 2000);
    // A time of the reader's choosing, or the schedule off. Changed, it next runs when the
    // new time comes round, not at once for a time already passed today.
    if (schedule && typeof schedule === 'object') {
      if (!entry.manifest.triggers.some((t) => t.type === 'daily')) fail('这个插件没有定时运行');
      const next = { ...(saved.schedule || {}) };
      if (schedule.time !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.time)))
          fail('时间写法不对，应为 08:30 这样');
        next.time = String(schedule.time);
      }
      if (typeof schedule.off === 'boolean') next.off = schedule.off;
      next.changedAt = Date.now();
      saved.schedule = next;
    }
    s.plugins[id] = saved;
    await saveState();
    return list();
  }
  async function setThirdParty({ on }) {
    const s = await readState();
    s.thirdParty = on === true;
    await saveState();
    return list();
  }
  // 一次运行开始和结束时记下来：开始时记时间，定时任务就不会因为页间中途退出而反复重跑。
  async function ran({ id, at, result }) {
    const s = await readState();
    if (!s.plugins[id]) s.plugins[id] = {};
    if (Number(at)) s.plugins[id].lastRun = Number(at);
    if (result && typeof result === 'object')
      s.plugins[id].lastResult = {
        ok: result.ok === true,
        message: text(result.message, 300),
        output: text(result.output, 300),
        at: Date.now(),
      };
    await saveState();
    return list();
  }
  // 运行时要读的文件：任务说明、模板和脚本。
  async function load({ id }) {
    const entry = await find(id);
    const { manifest, dir } = entry;
    const s = await readState();
    if (!trusted(entry, s) && !s.thirdParty) fail('「社区插件」已关闭');
    const read = (file) => (file ? fs.readFile(path.join(dir, file), 'utf8') : Promise.resolve(''));
    return {
      manifest,
      prompt: await read(manifest.run.prompt),
      template: await read(manifest.run.template),
      hasScript: !!manifest.run.script,
    };
  }
  async function icon({ id }) {
    const { manifest, dir } = await find(id);
    if (!manifest.icon) return '';
    const data = await fs.readFile(path.join(dir, manifest.icon));
    const type = /\.svg$/i.test(manifest.icon) ? 'image/svg+xml' : 'image/png';
    return `data:${type};base64,${data.toString('base64')}`;
  }
  // 一个插件和已有的同名插件：自带的不能顶替；从文件夹加载的开发版和装好的副本不能混着装，
  // 先移除一个。返回已装的那个（更新时比较权限），或 null。
  async function existingFor(manifest, kind) {
    const s = await readState();
    const existing = (await catalog()).get(manifest.id);
    if (existing?.bundled) fail(`「${manifest.id}」和页间自带的插件重名了`);
    const linked = s.plugins[manifest.id]?.source?.type === 'folder';
    if (existing && kind === 'folder' && !linked)
      fail(
        `已经装了同名的插件「${existing.manifest?.name || manifest.id}」，先在插件列表里卸载它，再加载这个文件夹`,
      );
    if (existing && kind !== 'folder' && linked)
      fail(
        `「${manifest.id}」已经从文件夹 ${shown(existing.dir)} 加载了开发版，先在插件列表里移除它`,
      );
    return existing && !existing.error ? existing.manifest : null;
  }
  // 下载或解压好的文件放进暂存处，等用户确认。
  async function stageFiles(raw, files) {
    const stage = crypto.randomUUID();
    const dir = path.join(stagingDir, stage);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, MANIFEST), raw);
    for (const f of files) {
      await fs.mkdir(path.dirname(path.join(dir, f.name)), { recursive: true });
      await fs.writeFile(path.join(dir, f.name), f.data);
    }
    return { stage, dir };
  }
  const listed = (raw, files) => [
    { name: MANIFEST, size: raw.length },
    ...files.map((f) => ({ name: f.name, size: f.size ?? f.data.length })),
  ];
  // 从链接读出插件、下载到暂存处，交给窗口请用户确认；确认后 install 才真正装上。
  // local：本地的插件文件夹（开发版，直接读那个文件夹）或 .zip（解压出一份装上）。
  // expect：从插件目录装时目录里写的 id，仓库里的插件必须是它。
  // recommendation：官方插件，从官网下载，和页间里记下的 SHA-256 对上才装；不用打开「社区插件」。
  async function inspect({ url, id, local, expect, recommendation }) {
    const s = await readState();
    if (recommendation) {
      const entry = (await officialPlugins()).find((p) => p.id === recommendation);
      if (!entry) fail('没有找到这个官方插件');
      if (!satisfies(appVersion, entry.requires)) fail(`这个插件需要页间 ${entry.requires}`);
      const zip = await remote.get(entry.url, { limit: ZIP_LIMIT });
      if (crypto.createHash('sha256').update(zip).digest('hex') !== entry.sha256)
        fail('插件下载校验失败，请稍后重新下载');
      return inspectZip(zip, path.basename(new URL(entry.url).pathname), entry);
    }
    if (!s.thirdParty) fail('请先在插件设置里打开「社区插件」');
    if (local) return inspectLocal(String(local));
    let source;
    if (id) {
      source = s.plugins[id]?.source;
      if (!source?.owner) fail('这个插件不是从链接装的，没法检查更新');
    } else source = parseSource(url);
    const sha = await remote.commit(source);
    const raw = await remote.file(source, sha, MANIFEST, LIMITS.manifest);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      fail('folio-plugin.json 不是有效的 JSON');
    }
    const manifest = validateManifest(parsed, { appVersion });
    if (expect && manifest.id !== expect)
      fail(`插件目录里写的是「${expect}」，仓库里却是「${manifest.id}」，没有安装`);
    if (id && manifest.id !== id) fail('仓库里的插件已经换成了另一个插件');
    const before = await existingFor(manifest, 'link');
    const files = [];
    let total = raw.length;
    for (const name of manifest.files) {
      const data = await remote.file(source, sha, name, LIMITS.file);
      total += data.length;
      if (total > LIMITS.total) fail(`插件太大（超过 ${LIMITS.total / 1024 / 1024} MB）`);
      files.push({ name, data });
    }
    const { stage, dir } = await stageFiles(raw, files);
    const fullSource = { ...source, commit: sha };
    staged.set(stage, { dir, manifest, source: fullSource });
    const text = (file) => files.find((f) => f.name === file)?.data.toString('utf8') || '';
    return {
      stage,
      manifest,
      source: fullSource,
      files: listed(raw, files),
      installed: before
        ? { version: before.version, commit: s.plugins[manifest.id]?.source?.commit || '' }
        : null,
      sameCommit: !!before && s.plugins[manifest.id]?.source?.commit === sha,
      added: newPermissions(before, manifest),
      warnings: lintPlugin(manifest, {
        prompt: text(manifest.run.prompt),
        template: text(manifest.run.template),
      }),
    };
  }
  async function inspectLocal(local) {
    const st = await fs.stat(local).catch(() => fail(`找不到 ${local}`));
    if (st.isDirectory()) {
      // A folder being written: read where it is, every time, so saved changes count at once.
      const { dir, manifest, raw, files, warnings } = await readPluginDir(local, { appVersion });
      const before = await existingFor(manifest, 'folder');
      const stage = crypto.randomUUID();
      const source = { type: 'folder', path: dir };
      staged.set(stage, { link: dir, manifest, source });
      return {
        stage,
        manifest,
        source: sourceOf(source),
        files: listed(raw, files),
        installed: before ? { version: before.version, commit: '' } : null,
        sameCommit: false,
        added: newPermissions(before, manifest),
        warnings,
      };
    }
    if (!/\.zip$/i.test(local)) fail('请选择插件文件夹，或者一个 .zip 压缩包');
    if (st.size > ZIP_LIMIT) fail(`压缩包太大（超过 ${ZIP_LIMIT / 1024 / 1024} MB）`);
    return inspectZip(await fs.readFile(local), path.basename(local));
  }
  async function inspectZip(zip, name, expected) {
    const entries = readZip(zip).filter(
      (e) =>
        !e.isDir &&
        !e.name.startsWith('__MACOSX/') &&
        !e.name.split('/').some((p) => p.startsWith('.')),
    );
    // The plugin is the shallowest folio-plugin.json: at the top, or in the one folder Finder,
    // Explorer or GitHub's “Download ZIP” put everything in.
    const manifests = entries.filter((e) => e.name.split('/').pop() === MANIFEST);
    if (!manifests.length) fail(`压缩包里没有 ${MANIFEST}`);
    const depth = (e) => e.name.split('/').length;
    const shallowest = Math.min(...manifests.map(depth));
    const top = manifests.filter((e) => depth(e) === shallowest);
    if (top.length > 1)
      fail(
        `压缩包里有 ${top.length} 个插件（${top.map((e) => e.name.slice(0, -MANIFEST.length - 1)).join('、')}），一次只能装一个`,
      );
    const prefix = top[0].name.slice(0, -MANIFEST.length);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const raw = top[0].read(LIMITS.manifest);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      fail(`folio-plugin.json 不是有效的 JSON：${e.message}`);
    }
    const manifest = validateManifest(parsed, { appVersion });
    if (expected && (manifest.id !== expected.id || manifest.version !== expected.version))
      fail('下载的插件和官方插件的信息对不上，没有安装');
    const before = await existingFor(manifest, 'zip');
    const files = [];
    let total = raw.length;
    for (const name of manifest.files) {
      const entry = byName.get(prefix + name);
      if (!entry) fail(`压缩包里没有 files 列出的 ${name}`);
      const data = entry.read(LIMITS.file);
      total += data.length;
      if (total > LIMITS.total) fail(`插件太大（超过 ${LIMITS.total / 1024 / 1024} MB）`);
      files.push({ name, data });
    }
    const { stage, dir } = await stageFiles(raw, files);
    const source = expected ? { type: 'official' } : { type: 'zip', name };
    staged.set(stage, { dir, manifest, source });
    const text = (file) => files.find((f) => f.name === file)?.data.toString('utf8') || '';
    return {
      stage,
      manifest,
      source,
      files: listed(raw, files),
      installed: before ? { version: before.version, commit: '' } : null,
      sameCommit: false,
      added: newPermissions(before, manifest),
      warnings: lintPlugin(manifest, {
        prompt: text(manifest.run.prompt),
        template: text(manifest.run.template),
      }),
    };
  }
  async function install({ stage }) {
    const s = await readState();
    const item = staged.get(stage);
    if (!s.thirdParty && item?.source.type !== 'official') fail('请先在插件设置里打开「社区插件」');
    if (!item) fail('安装已过期，请重新选择插件');
    staged.delete(stage);
    if (item.link) {
      // Loaded where it is: nothing copied.
      const saved = s.plugins[item.manifest.id] || {};
      s.plugins[item.manifest.id] = {
        ...saved,
        source: item.source,
        installedAt: Date.now(),
        settings: settingsFor(item.manifest, saved.settings),
      };
      await saveState();
      return list();
    }
    const target = path.join(installedDir, item.manifest.id);
    const old = `${target}.old-${Date.now()}`;
    await fs.mkdir(installedDir, { recursive: true });
    await fs.rename(target, old).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    try {
      await fs.rename(item.dir, target);
    } catch (e) {
      await fs.rename(old, target).catch(() => {});
      throw e;
    }
    await fs.rm(old, { recursive: true, force: true }).catch(() => {});
    const saved = s.plugins[item.manifest.id] || {};
    s.plugins[item.manifest.id] = {
      ...saved,
      source: item.source,
      installedAt: Date.now(),
      settings: settingsFor(item.manifest, saved.settings),
    };
    await saveState();
    return list();
  }
  async function remove({ id }) {
    const entry = await find(id).catch(() => null);
    if (entry?.bundled) fail('页间自带的插件不能卸载，可以关掉它');
    const dir = path.join(installedDir, String(id));
    if (path.dirname(dir) !== installedDir) fail('插件名无效');
    const s = await readState();
    // A plugin loaded from a folder is only forgotten: its folder is the author's own.
    if (s.plugins[id]?.source?.type !== 'folder')
      await fs.rm(dir, { recursive: true, force: true });
    delete s.plugins[id];
    await saveState();
    logs.delete(String(id));
    await fs.unlink(logFile(String(id))).catch(() => {});
    return list();
  }
  // 插件联网：只能是清单里写明的网站，https，GET；跳转后的地址也要在名单里。
  async function pluginFetch({ id, url, accept }) {
    const entry = await find(id);
    const { manifest } = entry;
    const s = await readState();
    if (!trusted(entry, s) && !s.thirdParty) fail('「社区插件」已关闭');
    if (!s.plugins[id]?.enabled) fail('插件没有开启');
    let current = String(url || '');
    for (let hop = 0; hop < 5; hop++) {
      if (!allowedUrl(current, manifest.permissions.network))
        fail(
          `插件「${manifest.name}」不能访问 ${(() => {
            try {
              return new URL(current).hostname;
            } catch {
              return current.slice(0, 80);
            }
          })()}。它能访问的网站：${manifest.permissions.network.join('、')}`,
        );
      let res;
      try {
        res = await fetch(current, {
          redirect: 'manual',
          credentials: 'omit',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Folio Plugins)',
            Accept:
              text(accept, 200) ||
              'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(25_000),
        });
      } catch (e) {
        fail(`连不上 ${new URL(current).hostname}：${e.message}`);
      }
      if (res.type === 'opaqueredirect' || res.status === 0)
        fail('网站跳转到了别处，页间没法确认跳转后的地址');
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const next = res.headers.get('location');
        if (!next) fail('网站跳转到了一个空地址');
        current = new URL(next, current).toString();
        continue;
      }
      const type = res.headers.get('content-type') || '';
      if (/^(image|audio|video|font)\//.test(type) || /octet-stream|pdf|zip/.test(type))
        fail(`这个地址是文件（${type.split(';')[0]}），不是网页或数据`);
      const reader = res.body?.getReader();
      const chunks = [];
      let size = 0;
      let cut = false;
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > FETCH_LIMIT) {
            chunks.push(value.subarray(0, value.length - (size - FETCH_LIMIT)));
            cut = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
      return {
        url: current,
        status: res.status,
        ok: res.ok,
        contentType: type,
        text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
        cut,
      };
    }
    fail('网站跳转次数太多');
  }
  // 脚本插件的沙箱页面（electron/main.cjs 用 app://plugin/<id> 提供）。
  async function sandbox(id) {
    const entry = await find(id);
    const { manifest, dir } = entry;
    const s = await readState();
    if (!trusted(entry, s) && !s.thirdParty) fail('「社区插件」已关闭');
    if (!s.plugins[id]?.enabled) fail('插件没有开启');
    if (!manifest.run.script) fail('这个插件没有脚本');
    const code = await fs.readFile(path.join(dir, manifest.run.script), 'utf8');
    return {
      html: sandboxPage({
        code,
        settings: settingsFor(manifest, s.plugins[id]?.settings),
        name: manifest.name,
      }),
      csp: sandboxCsp,
    };
  }
  // A folder plugin at work in its folder: what's there, reading a page, writing a new one.
  // Every path stays inside the folder, links included; nothing is deleted or overwritten.
  async function folderPlugin(id) {
    const entry = await find(id);
    const { manifest } = entry;
    const s = await readState();
    if (!trusted(entry, s) && !s.thirdParty) fail('「社区插件」已关闭');
    if (!s.plugins[id]?.enabled) fail('插件没有开启');
    if (manifest.run.where !== 'folder') fail('这个插件在打开的项目里运行');
    return { manifest, dir: folderFor(manifest, settingsFor(manifest, s.plugins[id]?.settings)) };
  }
  async function inside(dir, relative) {
    const clean = String(relative ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '');
    if (
      !clean ||
      clean.length > 400 ||
      clean.startsWith('/') ||
      clean.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))
    )
      fail(
        `路径无效：${String(relative).slice(0, 80)}。请用相对插件文件夹的路径，例如「名字.html」`,
      );
    const full = path.resolve(dir, clean);
    const back = path.relative(dir, full);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) fail('路径跳出了插件的文件夹');
    // The nearest part that exists, as it really is, must still be in the folder.
    const real = await fs.realpath(dir).catch(() => fail('插件的文件夹还不存在，里面还没有文件'));
    let probe = full;
    while (probe !== dir && !(await fs.lstat(probe).catch(() => null))) probe = path.dirname(probe);
    const actual = await fs.realpath(probe).catch(() => probe);
    if (actual !== real && !actual.startsWith(real + path.sep)) fail('路径跳出了插件的文件夹');
    return { full, clean };
  }
  async function folder({ id, action, path: relative, content }) {
    const { dir } = await folderPlugin(id);
    // Made before a run, so its record and its reports have somewhere to go.
    if (action === 'ensure') {
      await fs.mkdir(dir, { recursive: true });
      return { path: await fs.realpath(dir), shown: shown(dir) };
    }
    if (action === 'list') {
      const found = [];
      const walk = async (at, depth) => {
        for (const e of await fs.readdir(at, { withFileTypes: true }).catch(() => [])) {
          if (e.name.startsWith('.') || found.length >= 300) continue;
          const full = path.join(at, e.name);
          if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
          else if (e.isFile() && /\.(html?|pdf|md)$/i.test(e.name)) {
            const st = await fs.stat(full).catch(() => null);
            if (st)
              found.push({
                path: path.relative(dir, full).split(path.sep).join('/'),
                size: st.size,
                modified: st.mtimeMs,
              });
          }
        }
      };
      await walk(dir, 0);
      found.sort((a, b) => b.modified - a.modified);
      return { folder: shown(dir), files: found };
    }
    if (action === 'read') {
      const { full, clean } = await inside(dir, relative);
      if (!/\.(html?|md|txt)$/i.test(clean)) fail('只能读取 HTML、Markdown 或文本文件');
      const st = await fs.stat(full).catch(() => null);
      if (!st?.isFile()) fail(`插件的文件夹里没有 ${clean}，可以先用 list_files 看看有哪些文件`);
      if (st.size > 3 * 1024 * 1024) fail('文件太大');
      return { path: clean, text: await fs.readFile(full, 'utf8') };
    }
    if (action === 'create') {
      // The folder itself is made on the first report, where it was picked or in Documents.
      await fs.mkdir(dir, { recursive: true });
      const { full, clean } = await inside(dir, relative);
      if (!/\.html?$/i.test(clean)) fail('文件名必须以 .html 结尾');
      if (typeof content !== 'string' || !content.trim()) fail('内容为空');
      if (content.length > 20_000_000) fail('文件过大');
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, { flag: 'wx' }).catch((e) => {
        if (e.code === 'EEXIST') fail(`${clean} 已存在，请换一个文件名`);
        throw e;
      });
      return { path: clean };
    }
    fail('未知的文件操作');
  }
  // A run's conversation, kept in the plugin folder's own project (.html-reader/ai/project.json,
  // where Folio keeps 整个项目), while that project isn't the one open: opened, it shows there.
  let saving = Promise.resolve();
  function saveRun({ id, thread }) {
    const job = saving.then(async () => {
      const { dir } = await folderPlugin(id);
      if (!thread || typeof thread.id !== 'string' || !Array.isArray(thread.messages))
        fail('运行记录格式不对');
      const record = JSON.stringify(thread);
      if (record.length > 10_000_000) fail('运行记录太大');
      const file = path.join(await fs.realpath(dir), '.html-reader', 'ai', 'project.json');
      let saved = null;
      try {
        saved = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {}
      const threads = saved?.version === 1 && Array.isArray(saved.threads) ? saved.threads : [];
      const at = threads.findIndex((t) => t?.id === thread.id);
      const next =
        at === -1 ? [thread, ...threads] : threads.map((t, i) => (i === at ? thread : t));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicWrite(
        file,
        JSON.stringify({
          ...(saved?.version === 1 ? saved : {}),
          version: 1,
          active: saved?.active || thread.id,
          threads: next.slice(0, 60),
        }),
      );
      return true;
    });
    saving = job.catch(() => {});
    return job;
  }
  // 上次没装完的暂存文件。
  async function cleanup() {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    const names = await fs.readdir(installedDir).catch(() => []);
    for (const n of names)
      if (/\.old-\d+$/.test(n))
        await fs.rm(path.join(installedDir, n), { recursive: true, force: true }).catch(() => {});
  }

  // 每个插件的运行日志：开始和结束、每次工具调用、脚本里 folio.log 写的话和出的错。窗口在运行
  // 时记下来（src/plugins/log.ts），这里替它存着，每个插件留最近 LOG_KEEP 条。
  const logs = new Map();
  let logWrites = Promise.resolve();
  const logFile = (id) => path.join(logDir, `${id}.json`);
  async function readLog(id) {
    if (logs.has(id)) return logs.get(id);
    let entries = [];
    try {
      entries = JSON.parse(await fs.readFile(logFile(id), 'utf8'));
      if (!Array.isArray(entries)) entries = [];
    } catch {}
    logs.set(id, entries);
    return entries;
  }
  async function log({ id, add, clear }) {
    id = String(id || '');
    if (!idPattern.test(id)) fail('插件名无效');
    let entries = await readLog(id);
    if (clear) entries = [];
    const kinds = ['run', 'tool', 'script', 'warn', 'error'];
    if (Array.isArray(add))
      entries = entries.concat(
        add.slice(0, 200).map((e) => ({
          at: Number(e?.at) || Date.now(),
          kind: kinds.includes(e?.kind) ? e.kind : 'script',
          text: text(e?.text, 800),
        })),
      );
    if (entries.length > LOG_KEEP) entries = entries.slice(-LOG_KEEP);
    logs.set(id, entries);
    if (clear || add?.length) {
      const snapshot = JSON.stringify(entries);
      logWrites = logWrites
        .then(async () => {
          await fs.mkdir(logDir, { recursive: true });
          await atomicWrite(logFile(id), snapshot);
        })
        .catch(() => {});
      await logWrites;
    }
    return entries;
  }

  // 插件目录：公开仓库里的 community-plugins.json，半小时内不重复下载。
  let directoryCache = null;
  async function directory({ refresh } = {}) {
    if (directoryCache && !refresh && Date.now() - directoryCache.at < 30 * 60_000)
      return directoryCache;
    let last;
    for (const url of directoryUrls) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Folio-Plugins', Accept: 'application/json' },
          credentials: 'omit',
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new PluginError(`${new URL(url).hostname} 返回了错误 ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > 2 * 1024 * 1024) throw new PluginError('插件目录太大');
        const plugins = cleanDirectory(JSON.parse(body.toString('utf8')));
        directoryCache = { at: Date.now(), from: new URL(url).hostname, plugins };
        return directoryCache;
      } catch (e) {
        last = e;
      }
    }
    fail(`读不到插件目录：${last?.message || '没有可用的地址'}`);
  }

  return {
    list,
    set,
    setThirdParty,
    ran,
    load,
    icon,
    inspect,
    install,
    remove,
    fetch: pluginFetch,
    sandbox,
    folder,
    saveRun,
    cleanup,
    log,
    directory,
    close,
  };
}

// 插件目录的一项：id、名字、作者、介绍和仓库链接（GitHub / Gitee，可以指向仓库里的文件夹）。
// 写错的条目跳过，不影响其他的。
function cleanDirectory(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.plugins)) fail('插件目录的格式不对');
  const out = [];
  const seen = new Set();
  for (const p of raw.plugins.slice(0, 2000)) {
    try {
      const id = text(p?.id, 40);
      const name = text(p?.name, 40);
      if (!idPattern.test(id) || seen.has(id) || !name) continue;
      const source = parseSource(p.repo);
      seen.add(id);
      out.push({
        id,
        name,
        author: text(p.author, 60),
        description: text(p.description, 300),
        repo: source.url,
        tags: (Array.isArray(p.tags) ? p.tags : [])
          .slice(0, 5)
          .map((t) => text(t, 16))
          .filter(Boolean),
      });
    } catch {}
  }
  return out;
}

module.exports = {
  createPlugins,
  pluginDigest,
  validateManifest,
  parseSource,
  allowedUrl,
  satisfies,
  newPermissions,
  sandboxPage,
  cleanDirectory,
  PluginError,
  TOOLS,
  WRITE_TOOLS,
  FOLDER_TOOLS,
  DIRECTORY_URLS,
};
