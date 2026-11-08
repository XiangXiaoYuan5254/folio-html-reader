// The fonts people install themselves (设置 › 外观与阅读 › 界面字体). The system's own list,
// which the window reads, gives English family names and is read once per launch; the font
// files here give each family's Chinese name, and the families installed since.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

/** The folders installed fonts go to, for this user and for everyone on the computer. */
function fontDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.FOLIO_FONT_DIRS) return env.FOLIO_FONT_DIRS.split(path.delimiter).filter(Boolean);
  // Joined the way that platform writes paths, whichever one this runs on.
  const { join } = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return [join(home, 'Library/Fonts'), '/Library/Fonts'];
  if (platform === 'win32')
    return [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft/Windows/Fonts'),
      join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts'),
    ].filter(Boolean);
  return [join(home, '.local/share/fonts'), join(home, '.fonts'), '/usr/share/fonts'];
}

// Name IDs: 1 family, 16 typographic family, 21 WWS family; the system calls a family by one.
const familyIds = [1, 16, 21];
// Chinese, most wanted first: Windows language IDs, then the Mac's (33 simplified, 19 traditional).
const chinese = ['3:2052', '3:4100', '3:1028', '3:3076', '3:5124', '1:33', '1:19'];
const macEncodings = { 25: 'gbk', 2: 'big5' };

function decode(bytes, platform, encoding) {
  if (platform === 0 || platform === 3) {
    const swapped = Buffer.from(bytes);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (platform === 1 && encoding === 0) return bytes.toString('latin1');
  if (platform === 1 && macEncodings[encoding])
    return new TextDecoder(macEncodings[encoding]).decode(bytes);
  return '';
}
const clean = (s) =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);

/** A font's family names from its `name` table: each one, with its language. */
function familyNames(table) {
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  const names = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    if (r + 12 > table.length) break;
    const id = table.readUInt16BE(r + 6);
    if (!familyIds.includes(id)) continue;
    const platform = table.readUInt16BE(r);
    const encoding = table.readUInt16BE(r + 2);
    const start = strings + table.readUInt16BE(r + 10);
    const end = start + table.readUInt16BE(r + 8);
    if (end > table.length) continue;
    const value = clean(decode(table.subarray(start, end), platform, encoding));
    if (value) names.push({ id, lang: `${platform}:${table.readUInt16BE(r + 4)}`, value });
  }
  return names;
}

/** One face's names: the family the system lists it under, and its Chinese name per name. */
function describe(names) {
  const english = (id) =>
    (
      names.find((n) => n.id === id && (n.lang === '3:1033' || n.lang === '1:0')) ||
      names.find((n) => n.id === id && !chinese.includes(n.lang))
    )?.value;
  const zhOf = (id) =>
    chinese.map((lang) => names.find((n) => n.id === id && n.lang === lang)).find(Boolean)?.value;
  const zh = zhOf(16) || zhOf(1) || zhOf(21) || '';
  const family =
    english(16) || english(1) || names.find((n) => n.id === 16 || n.id === 1)?.value || '';
  const chineseNames = {};
  for (const n of names) chineseNames[n.value] ||= zhOf(n.id) || zh;
  return { family, aliases: [...new Set(names.map((n) => n.value))], names: chineseNames };
}

async function readAt(file, at, length) {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, at);
  if (bytesRead < length) throw Error('字体文件不完整');
  return bytes;
}
const sfnt = new Set([0x00010000, 0x4f54544f, 0x74727565]); // TrueType, 'OTTO', 'true'

/** The faces in a .ttf, .otf or .ttc file; only the bytes of its `name` tables are read. */
async function readFontFile(filePath) {
  const file = await fs.open(filePath, 'r');
  try {
    const head = await readAt(file, 0, 12);
    let starts = [0];
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const count = Math.min(head.readUInt32BE(8), 64);
      const offsets = await readAt(file, 12, 4 * count);
      starts = Array.from({ length: count }, (_, i) => offsets.readUInt32BE(4 * i));
    }
    const faces = [];
    for (const start of starts) {
      const header = start ? await readAt(file, start, 12) : head;
      if (!sfnt.has(header.readUInt32BE(0))) continue;
      const tables = header.readUInt16BE(4);
      const directory = await readAt(file, start + 12, 16 * tables);
      for (let i = 0; i < tables; i++) {
        if (directory.toString('latin1', 16 * i, 16 * i + 4) !== 'name') continue;
        const length = Math.min(directory.readUInt32BE(16 * i + 12), 1 << 20);
        const face = describe(
          familyNames(await readAt(file, directory.readUInt32BE(16 * i + 8), length)),
        );
        if (face.family) faces.push(face);
      }
    }
    return faces;
  } finally {
    await file.close();
  }
}

const fontFile = /\.(ttf|otf|ttc|otc)$/i;
async function fontFiles(dir, depth = 0, found = []) {
  if (found.length >= 5000) return found;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) await fontFiles(full, depth + 1, found);
    else if (entry.isFile() && fontFile.test(entry.name)) found.push(full);
  }
  return found;
}

/** Reads the installed fonts' names; a file is read again only once it has changed. */
function createFonts(dirs = () => fontDirs()) {
  const seen = new Map();
  async function facesOf(filePath) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return [];
    const known = seen.get(filePath);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.faces;
    const faces = await readFontFile(filePath).catch(() => []);
    seen.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, faces });
    return faces;
  }
  return {
    /** Each installed family, with every name the system may list it by, and Chinese names. */
    async installed() {
      const files = [];
      for (const dir of dirs()) await fontFiles(dir, 0, files);
      for (const known of seen.keys()) if (!files.includes(known)) seen.delete(known);
      const faces = [];
      for (let i = 0; i < files.length; i += 16)
        faces.push(...(await Promise.all(files.slice(i, i + 16).map(facesOf))).flat());
      const families = new Map();
      const names = {};
      for (const face of faces) {
        const family = families.get(face.family) || { family: face.family, aliases: [] };
        family.aliases = [...new Set([...family.aliases, ...face.aliases])];
        families.set(face.family, family);
        for (const [name, zh] of Object.entries(face.names)) if (zh) names[name] ||= zh;
      }
      return { families: [...families.values()], names };
    },
    /**
     * For the font list: the Chinese names, and the families installed since the window
     * read the system's list (`listed`), kept only if `shows` finds text shows in them.
     */
    async forList(listed, shows) {
      const { families, names } = await this.installed();
      const known = new Set(
        (Array.isArray(listed) ? listed : []).map((f) => String(f).toLowerCase()),
      );
      const unlisted = families
        .filter((f) => !f.aliases.some((a) => known.has(a.toLowerCase())))
        .map((f) => f.family)
        .slice(0, 300);
      return { names, added: unlisted.length ? await shows(unlisted).catch(() => []) : [] };
    },
  };
}

// Run in a page: whether text in each family measures unlike both fallbacks alone.
function measure(families) {
  const c = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli WW 永和九年岁在癸丑';
  return families.map((family) =>
    ['monospace', 'serif'].some((generic) => {
      c.font = `40px ${generic}`;
      const plain = c.measureText(sample).width;
      c.font = `40px "${family.replace(/["\\]/g, '\\$&')}", ${generic}`;
      return c.measureText(sample).width !== plain;
    }),
  );
}
/**
 * The families text shows in, measured in a hidden page of its own: a page keeps a family it
 * didn't find as missing, so the window, had it asked before the font was enabled, never would.
 */
async function familiesThatShow(families, BrowserWindow) {
  const page = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  let timer;
  try {
    await page.loadURL('about:blank');
    const shown = await Promise.race([
      page.webContents.executeJavaScript(`(${measure})(${JSON.stringify(families)})`),
      new Promise((_, fail) => (timer = setTimeout(() => fail(Error('字体检查超时')), 8000))),
    ]);
    return families.filter((_, i) => Array.isArray(shown) && shown[i] === true);
  } finally {
    clearTimeout(timer);
    page.destroy();
  }
}

module.exports = { createFonts, familiesThatShow, fontDirs, readFontFile };
