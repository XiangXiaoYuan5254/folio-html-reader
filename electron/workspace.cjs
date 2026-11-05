const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const documentStore = require('./document-store.cjs');
const backups = require('./backups.cjs');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hidden = new Set(['node_modules', 'dist', 'release', 'build', 'coverage']);
const isHtml = (p) => /\.html?$/i.test(p);
// The k-th name to try in place of one already taken, numbered before a file's extension:
// 未命名.html → 未命名2.html, 未命名3.html…; a name ending in a number goes on from it, in as
// many digits: 未命名2.html → 未命名3.html, 文档09.html → 文档10.html. A name that is only a
// number (a year, say) gets a dash: 2024.html → 2024-2.html. src/names.ts numbers alike.
function numbered(relative, k, folder) {
  const slash = relative.lastIndexOf('/') + 1;
  const name = relative.slice(slash);
  const dot = folder ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const counted = /^(.*\D)(\d+)$/.exec(stem);
  const next = counted
    ? counted[1] + String(Number(counted[2]) + k).padStart(counted[2].length, '0')
    : `${stem}${/^\d+$/.test(stem) ? '-' : ''}${k + 1}`;
  return `${relative.slice(0, slash)}${next}${ext}`;
}
const isPdf = (p) => /\.pdf$/i.test(p);
const isDocument = (p) => isHtml(p) || isPdf(p);
const clone = (x) => JSON.parse(JSON.stringify(x));
// Normalize legacy comments at the storage boundary so every UI uses the same types.
// Reading leaves the original file intact; the next normal save persists the conversion.
function mergeLegacyComments(data) {
  if (!Array.isArray(data.annotations)) return data;
  return {
    ...data,
    annotations: data.annotations.map((a) =>
      a?.type !== 'comment'
        ? a
        : a.quote
          ? { ...a, type: 'highlight' }
          : { ...a, type: 'sticky', collapsed: a.collapsed ?? true },
    ),
  };
}
// On Windows, replacing a file fails while another program (antivirus, the search
// indexer, a sync client) briefly holds it open, so the rename is retried for a moment.
async function replaceFile(tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(tmp, file);
    } catch (e) {
      if (
        process.platform !== 'win32' ||
        attempt >= 8 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)
      )
        throw e;
      await new Promise((resolve) => setTimeout(resolve, attempt * 40));
    }
  }
}
// Names Windows cannot store. A colon is worse than an error: it writes into a hidden stream
// of another file, so “BERT: Pre-training.pdf” would seem saved and never show up.
function windowsNameError(relative) {
  for (const name of relative.split(/[\\/]/)) {
    if (/[<>:"|?*\x00-\x1f]/.test(name)) return '文件名不能包含下列字符：\\ / : * ? " < > |';
    if (/[. ]$/.test(name) && name !== '.' && name !== '..') return '文件名不能以空格或句点结尾';
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name))
      return `“${name}”是 Windows 保留的名称，请换一个`;
  }
  return '';
}
async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await replaceFile(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
// The bytes a file or folder takes, everything in it counted; links are not followed.
async function sizeOf(target) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let total = 0;
  for (const name of await fs.readdir(target).catch(() => []))
    total += await sizeOf(path.join(target, name));
  return total;
}
async function boardIndex(meta) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(meta, 'boards', 'index.json'), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return [];
    throw e;
  }
}
// A board's sounds stay as long as the board does. Deleting it deletes them; any a sentence
// still being kept wrote after that go when the project is opened next.
async function pruneBoardSounds(meta) {
  const dir = path.join(meta, 'boards', 'sounds');
  const names = await fs.readdir(dir).catch(() => []);
  if (!names.length) return;
  const list = await boardIndex(meta);
  for (const name of names)
    if (!list.some((b) => b.id === name))
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
}
class Workspace {
  constructor() {
    this.root = null;
    this.index = { version: 1, files: {} };
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }
  async open(root) {
    return this.serial(async () => {
      const real = await fs.realpath(root);
      if (!(await fs.stat(real)).isDirectory()) throw Error('请选择文件夹');
      const meta = path.join(real, '.html-reader');
      let index;
      try {
        index = JSON.parse(await fs.readFile(path.join(meta, 'workspace.json'), 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT')
          throw Error('项目索引无法读取，请检查 .html-reader/workspace.json');
        index = { version: 1, files: {} };
      }
      if (
        index.version !== 1 ||
        !index.files ||
        typeof index.files !== 'object' ||
        !Object.values(index.files).every(
          (e) =>
            e &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.id) &&
            /^[0-9a-f]{64}$/i.test(e.hash),
        )
      )
        throw Error('不支持的项目索引格式');
      this.root = real;
      this.meta = meta;
      this.token = crypto.randomUUID();
      this.index = index;
      // Old backups are cleaned in the background, so opening a project is not delayed.
      backups.pruneAll(path.join(meta, 'backups')).catch(() => {});
      pruneBoardSounds(meta).catch(() => {});
      return this.summary();
    });
  }
  async resolve(relative, { create = false, internal = false } = {}) {
    if (!this.root) throw Error('请先选择项目');
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0'))
      throw Error('无效的文件路径');
    const badName = create && process.platform === 'win32' && windowsNameError(relative);
    if (badName) throw Error(badName);
    const full = path.resolve(this.root, relative);
    if (full !== this.root && !full.startsWith(this.root + path.sep))
      throw Error('文件必须位于当前项目内');
    const rel = path.relative(this.root, full);
    if (!internal && rel.split(path.sep).some((p) => p.startsWith('.')))
      throw Error('不能访问项目内部文件');
    let real;
    try {
      real = await fs.realpath(full);
    } catch (e) {
      if (e.code === 'ENOENT' && !(await fs.stat(this.root).catch(() => null)))
        throw Error('项目文件夹已被移动或删除');
      if (!create || e.code !== 'ENOENT') throw e;
      real = path.join(await fs.realpath(path.dirname(full)), path.basename(full));
    }
    if (real !== this.root && !real.startsWith(this.root + path.sep))
      throw Error('不能访问项目外的链接');
    if (
      !internal &&
      path
        .relative(this.root, real)
        .split(path.sep)
        .some((p) => p.startsWith('.'))
    )
      throw Error('不能访问项目内部链接');
    return full;
  }
  async tree(dir = '', depth = 0) {
    if (depth > 30) return [];
    const entries = await fs.readdir(await this.resolve(dir), { withFileTypes: true });
    const rows = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith('.') && !hidden.has(e.name) && !e.isSymbolicLink())
        .map(async (e) => {
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (e.isDirectory())
            return {
              name: e.name,
              path: p,
              kind: 'folder',
              children: await this.tree(p, depth + 1),
            };
          return { name: e.name, path: p, kind: isHtml(p) ? 'html' : isPdf(p) ? 'pdf' : 'asset' };
        }),
    );
    return rows.sort(
      (a, b) =>
        (a.kind === 'folder' ? -1 : 1) - (b.kind === 'folder' ? -1 : 1) ||
        a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
    );
  }
  async summary() {
    return {
      root: this.root,
      name: path.basename(this.root),
      token: this.token,
      tree: await this.tree(),
      session: this.index.session || null,
    };
  }
  async saveSession({ paths, active, split }) {
    return this.serial(async () => {
      if (Array.isArray(paths) && paths.length > 100)
        throw Error('同时打开的文档过多，请先关闭一些标签页');
      if (
        !Array.isArray(paths) ||
        !paths.every((p) => typeof p === 'string' && isDocument(p)) ||
        typeof active !== 'string'
      )
        throw Error('无效的阅读会话');
      this.index.session = { paths, active };
      if (
        split &&
        typeof split.left === 'string' &&
        typeof split.right === 'string' &&
        split.left !== split.right &&
        paths.includes(split.left) &&
        paths.includes(split.right)
      )
        this.index.session.split = { left: split.left, right: split.right };
      await this.persistIndex();
      return true;
    });
  }
  async persistIndex() {
    await atomicWrite(path.join(this.meta, 'workspace.json'), JSON.stringify(this.index, null, 2));
  }
  async document(relative) {
    return this.serial(async () => {
      if (!isDocument(relative)) throw Error('请选择 HTML 或 PDF 文件');
      const full = await this.resolve(relative);
      const bytes = await fs.readFile(full);
      const kind = isPdf(relative) ? 'pdf' : 'html';
      const source = kind === 'pdf' ? '' : bytes.toString('utf8');
      const version = hash(bytes);
      const store = await documentStore.locate(this, full, version, atomicWrite);
      const entry = store.entry;
      const data = store.data;
      if (
        this.index.files[relative]?.id !== entry.id ||
        this.index.files[relative]?.storage !== 'adjacent'
      ) {
        await documentStore.backup(path.join(this.meta, 'workspace.json'), atomicWrite);
        this.index.files[relative] = { id: entry.id, hash: entry.hash, storage: 'adjacent' };
        await this.persistIndex();
      }
      return {
        path: relative,
        id: entry.id,
        kind,
        source,
        version,
        data: mergeLegacyComments(data),
      };
    });
  }
  async saveData({ id, data }) {
    return this.serial(async () => {
      const relative = Object.keys(this.index.files).find((p) => this.index.files[p].id === id);
      if (!relative) throw Error('文档不属于当前项目');
      const full = await this.resolve(relative);
      if (data.version !== 1 || !Array.isArray(data.annotations) || typeof data.note !== 'string')
        throw Error('无效的批注数据');
      const json = JSON.stringify(mergeLegacyComments(data), null, 2);
      if (json.length > 30_000_000) throw Error('批注数据过大');
      await atomicWrite(documentStore.dataPath(path.dirname(full), id), json);
      return true;
    });
  }
  // Assistant conversations sit beside the document's annotations; project-wide ones at the root.
  // Two documents read side by side ("pair:<id>+<id>") share one, beside the first of them.
  // AI 修改 conversations about a document's source ("edit:<id>") sit beside it too.
  async aiHistoryPath(key) {
    if (key === 'project') return path.join(this.meta, 'ai', 'project.json');
    const edit = /^edit:([\w-]+)$/.exec(key);
    const pair = /^pair:([\w-]+)\+([\w-]+)$/.exec(key);
    const ids = edit ? [edit[1]] : pair ? [pair[1], pair[2]] : [key];
    const relative = ids.map((id) =>
      Object.keys(this.index.files).find((p) => this.index.files[p].id === id),
    );
    if (relative.some((r) => !r)) throw Error('文档不属于当前项目');
    const full = await this.resolve(relative[0]);
    const name = edit
      ? `edit-${ids[0]}.json`
      : pair
        ? `pair-${ids[0]}+${ids[1]}.json`
        : `${key}.json`;
    return path.join(path.dirname(full), '.html-reader', 'ai', name);
  }
  // The conversations a document had with others read beside it (pair-<id>+<id>.json, beside
  // the first of the two): the other document and each conversation's title.
  async aiPairs({ id }) {
    return this.serial(async () => {
      const files = this.index.files;
      const pathOf = (doc) => Object.keys(files).find((p) => files[p].id === doc);
      const found = [];
      for (const dir of new Set(Object.keys(files).map((p) => path.dirname(p)))) {
        const base = dir === '.' ? this.root : await this.resolve(dir).catch(() => null);
        if (!base) continue;
        const folder = path.join(base, '.html-reader', 'ai');
        for (const name of await fs.readdir(folder).catch(() => [])) {
          const m = /^pair-([\w-]+)\+([\w-]+)\.json$/.exec(name);
          const other = m && (m[1] === id || m[2] === id) && pathOf(m[1] === id ? m[2] : m[1]);
          if (!other) continue;
          try {
            const data = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
            const threads = (Array.isArray(data?.threads) ? data.threads : [])
              .filter((t) => t.messages?.length)
              .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt }));
            if (threads.length) found.push({ key: `pair:${m[1]}+${m[2]}`, other, threads });
          } catch {}
        }
      }
      return found;
    });
  }
  async aiHistory({ key }) {
    return this.serial(async () => {
      try {
        const value = JSON.parse(await fs.readFile(await this.aiHistoryPath(key), 'utf8'));
        return value?.version === 1 && Array.isArray(value.threads) ? value : null;
      } catch (e) {
        if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
        throw e;
      }
    });
  }
  async saveAiHistory({ key, data }) {
    return this.serial(async () => {
      if (data?.version !== 1 || !Array.isArray(data.threads)) throw Error('无效的对话记录');
      const json = JSON.stringify(data);
      if (json.length > 20_000_000) throw Error('对话记录过大，请删除一些旧对话');
      await atomicWrite(await this.aiHistoryPath(key), json);
      return true;
    });
  }
  // Whiteboard lessons, for the whole project: one file each, and a small index for the list.
  boardPath(id) {
    if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id)) throw Error('无效的白板');
    return path.join(this.meta, 'boards', `${id}.json`);
  }
  async boardIndex() {
    return boardIndex(this.meta);
  }
  async boards() {
    return this.serial(() => this.boardIndex());
  }
  async board({ id }) {
    return this.serial(async () => {
      try {
        const value = JSON.parse(await fs.readFile(this.boardPath(id), 'utf8'));
        return value?.version === 1 ? value : null;
      } catch (e) {
        if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
        throw e;
      }
    });
  }
  async saveBoard({ entry, data }) {
    return this.serial(async () => {
      if (data?.version !== 1 || data.id !== entry?.id) throw Error('无效的白板');
      const json = JSON.stringify(data);
      if (json.length > 60_000_000) throw Error('白板太大，保存不了');
      await atomicWrite(this.boardPath(entry.id), json);
      const list = (await this.boardIndex()).filter((b) => b.id !== entry.id);
      list.unshift(entry);
      await atomicWrite(path.join(this.meta, 'boards', 'index.json'), JSON.stringify(list));
      return true;
    });
  }
  async deleteBoard({ id }) {
    return this.serial(async () => {
      await fs.rm(this.boardPath(id), { force: true });
      await fs.rm(this.boardSounds(id), { recursive: true, force: true });
      const list = (await this.boardIndex()).filter((b) => b.id !== id);
      await atomicWrite(path.join(this.meta, 'boards', 'index.json'), JSON.stringify(list));
      return true;
    });
  }
  // The sentences of a lesson said in a speech service's voice, as Ogg Opus, so watching it
  // again doesn't pay for them twice: a folder for each board, a file for each sentence.
  boardSounds(id) {
    this.boardPath(id);
    return path.join(this.meta, 'boards', 'sounds', id);
  }
  boardSoundPath(id, key) {
    if (typeof key !== 'string' || !/^[0-9a-f]{16,64}$/.test(key)) throw Error('无效的语音');
    return path.join(this.boardSounds(id), `${key}.ogg`);
  }
  async saveBoardSound({ id, key, data }) {
    if (!(data instanceof Uint8Array) || data.length > 4_000_000) throw Error('无效的语音');
    await atomicWrite(this.boardSoundPath(id, key), data);
    return true;
  }
  async boardSound({ id, key }) {
    try {
      return new Uint8Array(await fs.readFile(this.boardSoundPath(id, key)));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  // Pictures in document notes (a whiteboard, a pasted screenshot): files beside the notes,
  // which the notes refer to by name.
  noteImagePath(name) {
    if (typeof name !== 'string' || !/^[\w-]{1,80}\.(png|jpe?g|webp)$/.test(name))
      throw Error('无效的图片');
    if (!this.meta) throw Error('请先选择项目');
    return path.join(this.meta, 'note-images', name);
  }
  async saveNoteImage({ data, prefix = 'img' }) {
    const m = typeof data === 'string' && data.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!m || !/^[a-z]{1,12}$/.test(prefix)) throw Error('无效的图片');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 30_000_000) throw Error('图片太大，存不了');
    const name = `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    await atomicWrite(this.noteImagePath(name), bytes);
    return name;
  }
  async deleteNoteImage({ name }) {
    await fs.rm(this.noteImagePath(name), { force: true });
    return true;
  }
  async saveSource({ path: relative, source, version }) {
    return this.serial(async () => {
      if (!isHtml(relative) || typeof source !== 'string') throw Error('无效的 HTML 文档');
      const full = await this.resolve(relative);
      const current = await fs.readFile(full, 'utf8');
      if (hash(current) !== version)
        throw Error(
          '文件已被外部程序修改。你的编辑仍保留在源码区，请复制保留后重新载入文件，再合并修改。',
        );
      // Keep the version before editing, then at most one copy per 10 minutes.
      await backups.snapshot(this.backupDir(relative), current, atomicWrite);
      await atomicWrite(full, source);
      this.index.files[relative].hash = hash(source);
      await this.persistIndex();
      return { version: hash(source) };
    });
  }
  backupDir(relative) {
    const id = this.index.files[relative]?.id;
    if (!id) throw Error('请重新打开文档');
    return path.join(this.meta, 'backups', id);
  }
  async backups({ path: relative }) {
    return this.serial(async () => {
      if (!isHtml(relative)) throw Error('无效的 HTML 文档');
      await this.resolve(relative);
      const dir = this.backupDir(relative);
      await backups.prune(dir);
      return (await backups.list(dir)).map(({ name, time, size, restore }) => ({
        name,
        time,
        size,
        restore,
      }));
    });
  }
  async backup({ path: relative, name }) {
    return this.serial(async () => {
      if (!isHtml(relative)) throw Error('无效的 HTML 文档');
      await this.resolve(relative);
      return backups.read(this.backupDir(relative), name);
    });
  }
  async restoreBackup({ path: relative, name, version }) {
    return this.serial(async () => {
      if (!isHtml(relative)) throw Error('无效的 HTML 文档');
      const full = await this.resolve(relative);
      const dir = this.backupDir(relative);
      const source = await backups.read(dir, name);
      const current = await fs.readFile(full, 'utf8');
      if (hash(current) !== version)
        throw Error('文件已被外部程序修改，请先重新载入文件，再恢复历史版本。');
      if (source !== current) {
        // Back up what is being replaced, so a restore can itself be undone.
        await backups.snapshot(dir, current, atomicWrite, { force: true, restore: true });
        await atomicWrite(full, source);
        this.index.files[relative].hash = hash(source);
        await this.persistIndex();
      }
      return { source, version: hash(source) };
    });
  }
  // `unique`: a name already taken gets a number instead (未命名.html → 未命名2.html,
  // 未命名2.html → 未命名3.html), and the name used comes back as `created`.
  async create({ path: relative, kind, content, unique = false }) {
    return this.serial(async () => {
      if (kind !== 'folder') {
        if (!isHtml(relative)) throw Error('文件名须以 .html 或 .htm 结尾');
        if (typeof content === 'string' && content.length > 20_000_000) throw Error('文件过大');
      }
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? relative : numbered(relative, n - 1, kind === 'folder');
        const full = await this.resolve(candidate, { create: true });
        try {
          if (kind === 'folder') await fs.mkdir(full);
          else
            await fs.writeFile(
              full,
              typeof content === 'string'
                ? content
                : '<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><title>新文档</title><style>body{max-width:800px;margin:64px auto;padding:0 32px;font:18px/1.8 system-ui;color:#243240}h1{font-size:36px}</style></head>\n<body><h1>新文档</h1><p>从这里开始记录你的想法。</p></body>\n</html>\n',
              { flag: 'wx' },
            );
          return { ...(await this.summary()), created: candidate };
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (!unique || n >= 999)
            throw Error(`已有同名${kind === 'folder' ? '文件夹' : '文件'}「${candidate}」`);
        }
      }
    });
  }
  // A downloaded PDF; folders on the way are created, each checked like any other path.
  async savePdf({ path: relative, data }) {
    return this.serial(async () => {
      if (typeof relative !== 'string' || !isPdf(relative)) throw Error('文件名须以 .pdf 结尾');
      const parts = relative.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = await this.resolve(parts.slice(0, i).join('/'), { create: true });
        await fs.mkdir(dir).catch((e) => {
          if (e.code !== 'EEXIST') throw e;
        });
      }
      await fs.writeFile(await this.resolve(relative, { create: true }), data, { flag: 'wx' });
      return this.summary();
    });
  }
  async move({ from, to }) {
    return this.serial(async () => {
      if (!from || !to || from === to) throw Error('请输入不同的目标路径');
      const src = await this.resolve(from),
        dst = await this.resolve(to, { create: true });
      if (src === this.root) throw Error('不能移动项目根目录');
      if (dst.startsWith(src + path.sep)) throw Error('不能把文件夹移动到它自己或它的子文件夹中');
      if (await fs.stat(dst).catch(() => null)) throw Error('目标名称已存在');
      if (isHtml(from) && !isHtml(to)) throw Error('请保留 .html 或 .htm 扩展名');
      if (isPdf(from) && !isPdf(to)) throw Error('请保留 .pdf 扩展名');
      const store = isDocument(from)
        ? await documentStore.locate(this, src, hash(await fs.readFile(src)), atomicWrite)
        : null;
      if (store) {
        await documentStore.relocate(this, src, dst, store, atomicWrite);
        if (path.dirname(dst) !== this.root) {
          this.index.files[to] = {
            id: store.entry.id,
            hash: store.entry.hash,
            storage: 'adjacent',
          };
        }
      } else await fs.rename(src, dst);
      for (const key of Object.keys(this.index.files))
        if (key === from || key.startsWith(from + '/')) {
          this.index.files[to + key.slice(from.length)] = this.index.files[key];
          delete this.index.files[key];
        }
      if (this.index.session) {
        const movedPath = (p) =>
          p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p;
        this.index.session = {
          paths: this.index.session.paths.map(movedPath),
          active: movedPath(this.index.session.active),
          ...(this.index.session.split
            ? {
                split: {
                  left: movedPath(this.index.session.split.left),
                  right: movedPath(this.index.session.split.right),
                },
              }
            : {}),
        };
      }
      await this.persistIndex();
      return this.summary();
    });
  }
  async importFiles(payload) {
    return this.serial(() => require('./file-import.cjs').copyInto(this, payload));
  }
  // What Folio keeps in this project (设置 › 项目存储): its .html-reader folders, by kind; each
  // board with its sounds; and how much clearing old backups would free. The documents
  // themselves are the reader's and not counted.
  async storage(now = Date.now()) {
    return this.serial(async () => {
      if (!this.meta) throw Error('请先选择项目');
      const kinds = { backups: 0, boards: 0, noteImages: 0, ai: 0, documents: 0, other: 0 };
      const kindOf = {
        backups: 'backups',
        boards: 'boards',
        'note-images': 'noteImages',
        ai: 'ai',
        documents: 'documents',
      };
      // Notes and conversations sit beside their documents, in each folder's own .html-reader.
      for (const meta of await this.metaDirs())
        for (const entry of await fs.readdir(meta, { withFileTypes: true }).catch(() => []))
          kinds[kindOf[entry.name] || 'other'] += await sizeOf(path.join(meta, entry.name));
      const boards = [];
      for (const b of await this.boardIndex())
        boards.push({
          id: b.id,
          title: b.title,
          source: b.source || '',
          updatedAt: b.updatedAt,
          size: (await sizeOf(this.boardPath(b.id))) + (await sizeOf(this.boardSounds(b.id))),
        });
      // Each document's newest backup always stays; the rest can go by age.
      const old = { count: 0, free: { 0: 0, 1: 0, 7: 0 } };
      const root = path.join(this.meta, 'backups');
      for (const dir of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!dir.isDirectory()) continue;
        const [, ...older] = await backups.list(path.join(root, dir.name));
        for (const e of older) {
          old.count++;
          for (const days of [0, 1, 7])
            if (now - e.time > days * 86_400_000) old.free[days] += e.size;
        }
      }
      const total = Object.values(kinds).reduce((a, b) => a + b, 0);
      const unused = {};
      for (const [kind, files] of Object.entries(await this.unused())) {
        let size = 0;
        for (const file of files) size += await sizeOf(file);
        unused[kind] = { count: files.length, size };
      }
      return { total, kinds, boards, backups: old, unused };
    });
  }
  // Clears what unused() finds, worked out again now.
  async clearUnused() {
    return this.serial(async () => {
      let freed = 0;
      for (const files of Object.values(await this.unused()))
        for (const file of files) {
          freed += await sizeOf(file);
          await fs.rm(file, { recursive: true, force: true });
        }
      return { freed };
    });
  }
  // Every .html-reader in the project: the root's, and the one beside the documents of each
  // folder that has one.
  async metaDirs() {
    const dirs = [this.meta];
    const walk = async (nodes) => {
      for (const n of nodes)
        if (n.kind === 'folder') {
          const meta = path.join(this.root, ...n.path.split('/'), '.html-reader');
          if (await fs.stat(meta).catch(() => null)) dirs.push(meta);
          await walk(n.children || []);
        }
    };
    await walk(await this.tree());
    return dirs;
  }
  // Data no document uses any more, by kind: the notes, conversations and backups of files
  // deleted or moved away outside Folio, and note pictures no kept note or conversation
  // shows. A file renamed outside Folio with its content unchanged finds its notes again
  // when opened (documentStore.locate), so what it left stays.
  async unused() {
    const metas = await this.metaDirs();
    const indexes = [{ base: this.root, files: this.index.files }];
    for (const meta of metas.slice(1))
      try {
        const local = JSON.parse(await fs.readFile(path.join(meta, 'workspace.json'), 'utf8'));
        if (local?.files) indexes.push({ base: path.dirname(meta), files: local.files });
      } catch {}
    const live = new Set();
    const gone = [];
    for (const { base, files } of indexes)
      for (const [relative, entry] of Object.entries(files)) {
        if (typeof entry?.id !== 'string') continue;
        const full = path.join(base, ...relative.split('/'));
        if (await fs.stat(full).catch(() => null)) live.add(entry.id);
        else gone.push({ dir: path.dirname(full), id: entry.id, hash: entry.hash });
      }
    const contents = new Map();
    for (const g of gone) {
      if (live.has(g.id) || !g.hash) continue;
      if (!contents.has(g.dir)) {
        const hashes = new Set();
        for (const e of await fs.readdir(g.dir, { withFileTypes: true }).catch(() => []))
          if (e.isFile() && isDocument(e.name))
            hashes.add(hash(await fs.readFile(path.join(g.dir, e.name))));
        contents.set(g.dir, hashes);
      }
      if (contents.get(g.dir).has(g.hash)) live.add(g.id);
    }
    const found = { documents: [], ai: [], backups: [], noteImages: [] };
    // What kept notes and conversations say, for the pictures in them.
    const kept = [];
    const keep = async (file) => kept.push(await fs.readFile(file, 'utf8').catch(() => ''));
    for (const meta of metas) {
      for (const name of await fs.readdir(path.join(meta, 'documents')).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(meta, 'documents', name);
        if (live.has(name.slice(0, -5))) await keep(file);
        else found.documents.push(file);
      }
      for (const name of await fs.readdir(path.join(meta, 'ai')).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(meta, 'ai', name);
        const stem = name.slice(0, -5);
        const pair = /^pair-(.+)\+(.+)$/.exec(stem);
        const ids =
          meta === this.meta && stem === 'project'
            ? []
            : pair
              ? [pair[1], pair[2]]
              : [stem.replace(/^edit-/, '')];
        if (ids.every((id) => live.has(id))) await keep(file);
        else found.ai.push(file);
      }
    }
    for (const name of await fs.readdir(path.join(this.meta, 'backups')).catch(() => []))
      if (!live.has(name)) found.backups.push(path.join(this.meta, 'backups', name));
    const said = kept.join('\n');
    for (const name of await fs.readdir(path.join(this.meta, 'note-images')).catch(() => []))
      if (!said.includes(name)) found.noteImages.push(path.join(this.meta, 'note-images', name));
    return found;
  }
  // Clears backups older than `days` days (0: all), keeping each document's newest one.
  async clearBackups({ days }, now = Date.now()) {
    return this.serial(async () => {
      if (![0, 1, 7].includes(days)) throw Error('无效的清理范围');
      const root = path.join(this.meta, 'backups');
      let freed = 0;
      for (const dir of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!dir.isDirectory()) continue;
        const folder = path.join(root, dir.name);
        const [, ...older] = await backups.list(folder);
        for (const e of older)
          if (now - e.time > days * 86_400_000) {
            await fs.rm(path.join(folder, e.name), { force: true });
            freed += e.size;
          }
      }
      return { freed };
    });
  }
  async trash({ path: relative }, trashItem) {
    return this.serial(async () => {
      if (!relative) throw Error('不能删除项目根目录');
      const full = await this.resolve(relative);
      await trashItem(full);
      // Keep annotations and index so restoring the file from Trash restores notes too.
      return this.summary();
    });
  }
  async asset(relative) {
    const full = await this.resolve(relative);
    if (!(await fs.stat(full)).isFile()) throw Error('不是文件');
    return full;
  }
}
module.exports = { Workspace, atomicWrite, hash, clone };
