// 页间（Folio）插件清单：folio-plugin.json 的写法和检查。
//
// 这个文件只依赖 Node 自带的模块，页间（electron/plugins.cjs）和公开的插件工具
// （folio-plugins/cli，`folio-plugin validate`）用的是同一份：改了这里，运行
// `node scripts/sync-plugin-kit.mjs` 把它复制过去（tests/plugins.test.cjs 会检查两份一致）。
const fs = require('node:fs/promises');
const path = require('node:path');

const FORMAT = 1;
const MANIFEST = 'folio-plugin.json';
// 插件可以让 AI 使用的工具：页间的项目工具，加上只能访问清单里网站的 fetch_url、read_feed。
const TOOLS = [
  'list_files',
  'search',
  'read_document',
  'read_annotations',
  'read_html_source',
  'open_document',
  'search_papers',
  'fetch_url',
  'read_feed',
  'create_html',
  'edit_html',
  'add_highlights',
  'write_note',
  'save_pdf',
];
// 往项目里写东西的工具，插件运行时只能写进它声明的文件夹。
const WRITE_TOOLS = ['create_html', 'edit_html', 'add_highlights', 'write_note', 'save_pdf'];
// 在自己文件夹里工作的插件（run.where 为 "folder"）能用的工具：不管打开的是哪个项目，它只看得到、
// 只能写进自己的文件夹（electron/plugins.cjs 在主进程里检查每个路径）。
const FOLDER_TOOLS = [
  'list_files',
  'read_document',
  'create_html',
  'fetch_url',
  'read_feed',
  'search_papers',
];
// 任务说明、模板和写入文件夹里，除了设置项还能用的 {{…}}（src/plugins/schedule.ts、runner.ts）。
const BUILTIN_VARS = ['today', 'yesterday', 'week_ago', 'now', 'weekday', 'project', 'folder'];
// 设置项不能用的名字：上面这些，以及 template。
const RESERVED_KEYS = [...BUILTIN_VARS, 'template'];
const TEXT_TYPES = ['.md', '.html', '.htm', '.css', '.txt', '.json', '.svg', '.js'];
const LIMITS = { files: 24, file: 1024 * 1024, total: 2 * 1024 * 1024, manifest: 64 * 1024 };

class PluginError extends Error {}
const fail = (message) => {
  throw new PluginError(message);
};
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// 版本号：1.2.3，可带预发布后缀。
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const idPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;
function compareVersions(a, b) {
  const pa = String(a).split(/[-+]/)[0].split('.').map(Number);
  const pb = String(b).split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
// engines.folio 只认最常见的写法：">=0.29.0"、">=0.29.0 <1.0.0"、"0.29.0"、"*"。
function satisfies(version, range) {
  if (!range || range.trim() === '*') return true;
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const m = part.match(/^(>=|<=|>|<|=)?v?(\d+\.\d+\.\d+)$/);
      if (!m) return false;
      const c = compareVersions(version, m[2]);
      switch (m[1]) {
        case '>=':
          return c >= 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '<':
          return c < 0;
        default:
          return c === 0;
      }
    });
}

// 插件里的文件：相对路径，只用字母数字和 . _ - /，不能跳出插件文件夹。
function cleanFile(value) {
  const file = text(value, 200).replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !file ||
    !/^[\w.\-/]+$/.test(file) ||
    file.startsWith('/') ||
    file.split('/').some((p) => !p || p === '.' || p === '..')
  )
    fail(`插件文件名无效：${String(value).slice(0, 80)}`);
  if (!TEXT_TYPES.includes(path.extname(file).toLowerCase()) && !/\.png$/i.test(file))
    fail(`插件里不能有这种文件：${file}`);
  return file;
}
// 网站：域名，或 *.example.com 表示它的所有子域名。
function cleanHost(value) {
  const host = text(value, 120).toLowerCase();
  if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(host)) fail(`网站写法无效：${host || value}`);
  return host;
}
// 写入范围：项目里的文件夹，可以引用设置，如 "{{output}}"。
function cleanFolder(value) {
  const folder = text(value, 120).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!folder || folder.startsWith('/') || folder.split('/').some((p) => p === '..' || p === '.'))
    fail(`写入文件夹无效：${value}`);
  return folder;
}

// 检查并整理 folio-plugin.json；不认识的字段（包括 $schema）忽略。
function validateManifest(raw, { appVersion } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('folio-plugin.json 不是一个对象');
  if (raw.folio !== FORMAT) fail(`不支持的插件格式（folio: ${raw.folio}），请更新页间`);
  const id = text(raw.id, 40);
  if (!idPattern.test(id)) fail('插件 id 只能用小写字母、数字和 -，2–40 个字符');
  const name = text(raw.name, 40);
  if (!name) fail('插件没有名字');
  const version = text(raw.version, 40);
  if (!versionPattern.test(version)) fail(`版本号无效：${raw.version}`);
  const engines = text(raw.engines?.folio, 60);
  if (engines && appVersion && !satisfies(appVersion, engines))
    fail(`这个插件需要页间 ${engines}，当前是 ${appVersion}，请先更新页间`);
  const files = [...new Set((Array.isArray(raw.files) ? raw.files : []).map(cleanFile))];
  if (files.length > LIMITS.files) fail(`插件文件太多（最多 ${LIMITS.files} 个）`);
  const run = raw.run || {};
  const prompt = cleanFile(run.prompt);
  if (!/\.md$/i.test(prompt)) fail('run.prompt 应当是一个 .md 文件');
  if (!files.includes(prompt)) fail(`files 里没有列出 ${prompt}`);
  const template = run.template ? cleanFile(run.template) : '';
  if (template && !files.includes(template)) fail(`files 里没有列出 ${template}`);
  const script = run.script ? cleanFile(run.script) : '';
  if (script && (!/\.js$/i.test(script) || !files.includes(script)))
    fail('run.script 应当是 files 里列出的一个 .js 文件');
  // 只有 run.script 指向的那个文件可以是脚本。
  for (const f of files) if (/\.js$/i.test(f) && f !== script) fail(`插件里多了脚本文件：${f}`);
  const tools = [...new Set((Array.isArray(run.tools) ? run.tools : []).map((t) => text(t, 40)))];
  for (const t of tools) if (!TOOLS.includes(t)) fail(`不认识的工具：${t}`);
  const triggers = [];
  for (const t of Array.isArray(raw.triggers) ? raw.triggers.slice(0, 6) : []) {
    if (t?.type === 'daily') {
      const time = text(t.time, 5);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
        fail(`定时写法无效：${t.time}（应为 08:30 这样）`);
      triggers.push({ type: 'daily', time });
    } else if (t?.type === 'button') {
      triggers.push({ type: 'button', label: text(t.label, 24) || `运行${name}` });
    } else fail(`不认识的触发方式：${t?.type}`);
  }
  if (!triggers.some((t) => t.type === 'button'))
    triggers.push({ type: 'button', label: `运行${name}` });
  const permissions = raw.permissions || {};
  const network = [
    ...new Set((Array.isArray(permissions.network) ? permissions.network : []).map(cleanHost)),
  ];
  if (network.length > 40) fail('能访问的网站太多（最多 40 个）');
  if ((tools.includes('fetch_url') || tools.includes('read_feed') || script) && !network.length)
    fail('用到联网工具的插件，要在 permissions.network 里写明能访问哪些网站');
  const write = [
    ...new Set((Array.isArray(permissions.write) ? permissions.write : []).map(cleanFolder)),
  ];
  if (write.length > 5) fail('写入文件夹太多（最多 5 个）');
  if (tools.some((t) => WRITE_TOOLS.includes(t)) && !write.length)
    fail('用到写入工具的插件，要在 permissions.write 里写明能写哪些文件夹');
  const settings = [];
  for (const s of Array.isArray(raw.settings) ? raw.settings.slice(0, 12) : []) {
    const key = text(s?.key, 30);
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(key)) fail(`设置项名称无效：${s?.key}`);
    if (RESERVED_KEYS.includes(key)) fail(`设置项不能叫 ${key}`);
    if (settings.some((x) => x.key === key)) fail(`设置项重复：${key}`);
    const type = ['text', 'textarea', 'folder'].includes(s.type) ? s.type : 'text';
    settings.push({
      key,
      type,
      label: text(s.label, 40) || key,
      hint: text(s.hint, 160),
      default: text(s.default, 2000),
    });
  }
  // 写入范围里引用的设置必须存在，且应当是文件夹。
  for (const folder of write)
    for (const [, key] of folder.matchAll(/\{\{(\w+)\}\}/g))
      if (!settings.some((s) => s.key === key)) fail(`写入文件夹引用了不存在的设置：${key}`);
  // 在哪里运行：打开的项目（默认），或插件自己的文件夹。
  const where = run.where === 'folder' ? 'folder' : 'project';
  if (run.where !== undefined && !['folder', 'project'].includes(run.where))
    fail(`run.where 只能是 "project" 或 "folder"`);
  if (where === 'folder') {
    for (const t of tools)
      if (!FOLDER_TOOLS.includes(t)) fail(`在自己文件夹里运行的插件不能用 ${t}`);
    const own = write.length === 1 && write[0].match(/^\{\{(\w+)\}\}$/);
    if (!own || settings.find((s) => s.key === own[1])?.type !== 'folder')
      fail('在自己文件夹里运行的插件，permissions.write 要写成一个文件夹设置，例如 ["{{output}}"]');
  }
  const icon = raw.icon ? cleanFile(raw.icon) : '';
  if (icon && (!files.includes(icon) || !/\.(svg|png)$/i.test(icon)))
    fail('icon 应当是 files 里列出的 .svg 或 .png');
  const homepage = text(raw.homepage, 300);
  return {
    folio: FORMAT,
    id,
    name,
    version,
    author: text(raw.author, 60),
    description: text(raw.description, 300),
    homepage: /^https:\/\//.test(homepage) ? homepage : '',
    engines: engines ? { folio: engines } : undefined,
    icon,
    files,
    run: {
      prompt,
      template,
      script,
      tools,
      web: run.web === true,
      where,
    },
    triggers,
    permissions: { network, write },
    settings,
  };
}

// 和已装的版本相比，新版本多要了哪些权限：更新时要请用户再确认这些。
function newPermissions(before, after) {
  if (!before) return null;
  const added = {
    network: after.permissions.network.filter((h) => !before.permissions.network.includes(h)),
    write: after.permissions.write.filter((w) => !before.permissions.write.includes(w)),
    tools: after.run.tools.filter((t) => !before.run.tools.includes(t)),
    script: !!after.run.script && !before.run.script,
    web: after.run.web && !before.run.web,
  };
  return added.network.length ||
    added.write.length ||
    added.tools.length ||
    added.script ||
    added.web
    ? added
    : null;
}

// 一个网址是否在插件允许访问的网站里。只允许 https，不带账号密码，用默认端口。
function allowedUrl(url, network) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return network.some((h) =>
    h.startsWith('*.') ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h,
  );
}

// 不会让插件装不上、但多半是写错了的地方。
function lintPlugin(manifest, { prompt = '', template = '' } = {}) {
  const warnings = [];
  const known = new Set([...BUILTIN_VARS, ...manifest.settings.map((s) => s.key)]);
  const unknown = new Set();
  for (const source of [prompt, template, ...manifest.permissions.write])
    for (const [, key] of String(source).matchAll(/\{\{\s*(\w+)\s*\}\}/g))
      if (!known.has(key)) unknown.add(key);
  for (const key of unknown)
    warnings.push(`{{${key}}} 既不是设置项也不是内置变量，运行时会原样留在文字里`);
  if (!prompt.trim()) warnings.push(`${manifest.run.prompt} 是空的，AI 不知道要做什么`);
  const online =
    manifest.run.tools.includes('fetch_url') ||
    manifest.run.tools.includes('read_feed') ||
    !!manifest.run.script;
  if (manifest.permissions.network.length && !online)
    warnings.push('permissions.network 写了网站，但没有用 fetch_url、read_feed 或脚本，用不上');
  const writes = manifest.run.tools.some((t) => WRITE_TOOLS.includes(t));
  if (manifest.permissions.write.length && !writes && manifest.run.where !== 'folder')
    warnings.push('permissions.write 写了文件夹，但没有用任何写入工具，用不上');
  if (!manifest.description) warnings.push('没有 description，用户在安装时看不到它是做什么的');
  if (!manifest.run.tools.length && !manifest.run.script && !manifest.run.web)
    warnings.push('没有任何工具，AI 只能回答一段话，读不到也写不了文件');
  return warnings;
}

// 读一个插件文件夹：检查清单、清单里列出的每个文件（必须是文件夹里真实的普通文件，不能是
// 链接）、大小，并给出提示。页间加载开发中的插件和 `folio-plugin validate` 都用它。
async function readPluginDir(dir, { appVersion } = {}) {
  const root = await fs.realpath(dir).catch(() => fail(`找不到文件夹 ${dir}`));
  let raw;
  try {
    raw = await fs.readFile(path.join(root, MANIFEST));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail(`这个文件夹里没有 ${MANIFEST}`);
    throw e;
  }
  if (raw.length > LIMITS.manifest) fail(`${MANIFEST} 太大（超过 64 KB）`);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    fail(`${MANIFEST} 不是有效的 JSON：${e.message}`);
  }
  const manifest = validateManifest(parsed, { appVersion });
  const files = [];
  let total = raw.length;
  for (const name of manifest.files) {
    const full = path.join(root, name);
    const st = await fs.lstat(full).catch(() => null);
    if (!st) fail(`files 里列出的 ${name} 不存在`);
    if (!st.isFile()) fail(`${name} 不是普通文件（不能是文件夹或链接）`);
    const real = await fs.realpath(full);
    if (!real.startsWith(root + path.sep)) fail(`${name} 在插件文件夹外面`);
    if (st.size > LIMITS.file) fail(`${name} 太大（超过 ${LIMITS.file / 1024} KB）`);
    total += st.size;
    if (total > LIMITS.total) fail(`插件太大（超过 ${LIMITS.total / 1024 / 1024} MB）`);
    files.push({ name, size: st.size });
  }
  const read = (file) => (file ? fs.readFile(path.join(root, file), 'utf8') : Promise.resolve(''));
  const warnings = lintPlugin(manifest, {
    prompt: await read(manifest.run.prompt),
    template: await read(manifest.run.template),
  });
  return { dir: root, manifest, raw, files, warnings };
}

module.exports = {
  FORMAT,
  MANIFEST,
  TOOLS,
  WRITE_TOOLS,
  FOLDER_TOOLS,
  BUILTIN_VARS,
  RESERVED_KEYS,
  TEXT_TYPES,
  LIMITS,
  PluginError,
  fail,
  text,
  idPattern,
  compareVersions,
  satisfies,
  cleanFile,
  cleanHost,
  cleanFolder,
  validateManifest,
  newPermissions,
  allowedUrl,
  lintPlugin,
  readPluginDir,
};
