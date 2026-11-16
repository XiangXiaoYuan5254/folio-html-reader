// 文献库：项目里的论文。每篇记着它是什么（标题、作者、年份、发表在哪）、读没读过、哪天读完的，
// 以及项目里属于它的文件（PDF、伴读笔记……）。存在项目的 .html-reader/library.json 里，和批注、
// 白板一样跟着项目走。一篇论文可以没有文件（想读、还没下载），也可以有好几个。
//
// 书单（lists）是排好顺序的一组论文，比如“入门必读 20 篇”。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDocument, kindOf } = require('./formats.cjs');

const STATUSES = ['unread', 'reading', 'done'];
const LIMIT = 20_000_000;
const libraryPath = (workspace) => path.join(workspace.meta, 'library.json');
const empty = () => ({ version: 1, papers: [], lists: [] });

const line = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const block = (value, max) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
// Names or tags given as a list, or as one string with ; 、 or new lines between them.
function strings(value, count, max) {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[;；、\n]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const s = line(item, max);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= count) break;
  }
  return out;
}
const titleKey = (title) =>
  line(title, 500)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
const cleanDoi = (value) =>
  line(value, 200)
    .replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '')
    .toLowerCase();
// 2301.12345, 2301.12345v2, hep-th/9901001, with or without arXiv: or a link in front.
const cleanArxiv = (value) =>
  line(value, 80)
    .replace(/^(https?:\/\/arxiv\.org\/(abs|pdf)\/|arxiv:\s*)/i, '')
    .replace(/\.pdf$/i, '')
    .replace(/v\d+$/i, '');
const day = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
// A document in the project, as the index writes it: no leading slash, no dot folders.
function docPath(value) {
  if (typeof value !== 'string') return '';
  const p = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.length > 1000 || !isDocument(p)) return '';
  if (p.split('/').some((part) => !part || part === '..' || part.startsWith('.'))) return '';
  return p;
}
const paths = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map(docPath))].filter(Boolean).slice(0, 20);

// What a paper may say about itself, each field as it is kept.
const FIELDS = {
  title: (v) => line(v, 500),
  // Another name it goes by: a translated title, or the short name people call it.
  alias: (v) => line(v, 300),
  authors: (v) => strings(v, 200, 120),
  year: (v) => {
    const n = Math.round(Number(v));
    return n >= 1000 && n <= 2100 ? n : 0;
  },
  venue: (v) => line(v, 200),
  doi: cleanDoi,
  arxiv: cleanArxiv,
  pmid: (v) => line(v, 20).replace(/\D/g, ''),
  url: (v) => (/^https?:\/\/\S+$/i.test(line(v, 2000)) ? line(v, 2000) : ''),
  abstract: (v) => block(v, 20_000),
  // The reader's (or the AI's) takeaway in a few sentences, and longer notes about the paper.
  summary: (v) => block(v, 5000),
  note: (v) => block(v, 50_000),
  tags: (v) => strings(v, 30, 60),
  // Where it sits among the others, levels divided by “/”: 大模型/Transformer.
  category: (v) =>
    line(v, 200)
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('/'),
  citations: (v) => {
    const n = Math.round(Number(v));
    return n > 0 ? n : 0;
  },
};

class LibraryError extends Error {}
const bad = (message) => {
  throw new LibraryError(message);
};

function validPaper(p) {
  return (
    p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    /^[\w-]{8,64}$/.test(p.id) &&
    typeof p.title === 'string'
  );
}
// A paper as kept: every field present, nothing else.
function normal(p) {
  const out = { id: p.id };
  for (const [key, clean] of Object.entries(FIELDS)) out[key] = clean(p[key]);
  out.status = STATUSES.includes(p.status) ? p.status : 'unread';
  out.readAt = out.status === 'done' && isDay(p.readAt) ? p.readAt : '';
  out.addedAt = Number.isFinite(p.addedAt) ? p.addedAt : 0;
  out.files = paths(p.files);
  return out;
}

async function read(workspace) {
  if (!workspace.meta) bad('请先选择项目');
  let raw;
  try {
    raw = await fs.readFile(libraryPath(workspace), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw e;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    bad('文献库文件损坏，已保留原文件：.html-reader/library.json');
  }
  if (data?.version !== 1 || !Array.isArray(data.papers)) bad('不支持的文献库格式');
  const papers = data.papers.filter(validPaper).map(normal);
  const ids = new Set(papers.map((p) => p.id));
  const lists = (Array.isArray(data.lists) ? data.lists : [])
    .filter((l) => l && typeof l.name === 'string' && line(l.name, 80))
    .map((l) => ({
      name: line(l.name, 80),
      note: block(l.note, 2000),
      papers: [...new Set((Array.isArray(l.papers) ? l.papers : []).filter((id) => ids.has(id)))],
    }));
  return { version: 1, papers, lists };
}

async function write(workspace, data, atomicWrite) {
  const json = JSON.stringify(data, null, 1);
  if (json.length > LIMIT) bad('文献库太大，保存不了');
  await atomicWrite(libraryPath(workspace), json);
}

// The paper already in the library that `input` is: by id, by DOI, arXiv number or PubMed id,
// by title, or by a file they share.
function find(data, input) {
  if (typeof input.id === 'string') {
    const byId = data.papers.find((p) => p.id === input.id);
    if (byId) return byId;
  }
  const doi = cleanDoi(input.doi);
  const arxiv = cleanArxiv(input.arxiv);
  const pmid = FIELDS.pmid(input.pmid);
  const key = titleKey(input.title);
  const files = new Set(paths(input.files));
  return (
    (doi && data.papers.find((p) => p.doi === doi)) ||
    (arxiv && data.papers.find((p) => p.arxiv === arxiv)) ||
    (pmid && data.papers.find((p) => p.pmid === pmid)) ||
    (key.length >= 3 && data.papers.find((p) => titleKey(p.title) === key)) ||
    (files.size && data.papers.find((p) => p.files.some((f) => files.has(f)))) ||
    null
  );
}

// Marking a paper read notes the day; the day can also be given (an import), or left unknown.
function setStatus(paper, patch, now) {
  if (!STATUSES.includes(patch.status)) return;
  const was = paper.status;
  paper.status = patch.status;
  if (paper.status !== 'done') paper.readAt = '';
  else if ('readAt' in patch) paper.readAt = isDay(patch.readAt) ? patch.readAt : '';
  else if (was !== 'done' || !paper.readAt) paper.readAt = day(now);
}

// `patch`'s fields onto `paper`. With `fill`, only the fields the paper has nothing in.
function apply(paper, patch, { fill = false, now = new Date() } = {}) {
  for (const [key, clean] of Object.entries(FIELDS)) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const value = clean(patch[key]);
    if (key === 'tags') {
      paper.tags = fill ? strings([...paper.tags, ...value], 30, 60) : value;
      continue;
    }
    const blank = Array.isArray(paper[key]) ? !paper[key].length : !paper[key];
    if (fill && !blank) continue;
    if (key === 'title' && !value) continue;
    paper[key] = value;
  }
  // An arXiv paper's DOI carries its number.
  const numbered = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/.exec(paper.doi);
  if (numbered && !paper.arxiv) paper.arxiv = numbered[1];
  if ('status' in patch && (!fill || paper.status === 'unread')) setStatus(paper, patch, now);
  else if (!fill && 'readAt' in patch && paper.status === 'done')
    paper.readAt = isDay(patch.readAt) ? patch.readAt : '';
}

// A file belongs to one paper: given to this one, it leaves the others.
function claim(data, paper, files) {
  for (const other of data.papers)
    if (other !== paper) other.files = other.files.filter((f) => !files.includes(f));
  paper.files = paths([...paper.files, ...files]);
}

function createLibrary({ atomicWrite, now = () => new Date() }) {
  // The library as it was before the day's first change stays beside it, in case a bulk
  // change (an import, an AI tidying up) goes wrong.
  const backedUp = new Map();
  async function backup(workspace) {
    const today = day(now());
    if (backedUp.get(workspace.root) === today) return;
    backedUp.set(workspace.root, today);
    await fs
      .copyFile(libraryPath(workspace), path.join(workspace.meta, 'library.backup.json'))
      .catch(() => {});
  }
  const change = (workspace, fn) =>
    workspace.serial(async () => {
      const data = await read(workspace);
      const result = await fn(data);
      await backup(workspace);
      await write(workspace, data, atomicWrite);
      return result;
    });

  // Every document in the project, to tell which of a paper's files are still there.
  async function documents(workspace) {
    const found = [];
    const walk = (nodes) => {
      for (const n of nodes)
        if (n.kind === 'folder') walk(n.children || []);
        else if (isDocument(n.path)) found.push(n.path);
    };
    walk(await workspace.tree());
    return found;
  }

  // The library, each paper with the files it has lost (`gone`). A file moved or renamed
  // outside 页间 is found again when one document, and only one, still has its name.
  async function list(workspace) {
    const data = await read(workspace);
    if (!data.papers.length) return { papers: [], lists: data.lists };
    const docs = await documents(workspace);
    const there = new Set(docs);
    const taken = new Set(data.papers.flatMap((p) => p.files));
    const byName = new Map();
    for (const doc of docs) {
      const name = doc.slice(doc.lastIndexOf('/') + 1);
      byName.set(name, byName.has(name) ? null : doc);
    }
    let healed = false;
    for (const paper of data.papers)
      paper.files = paper.files.map((file) => {
        if (there.has(file)) return file;
        const moved = byName.get(file.slice(file.lastIndexOf('/') + 1));
        if (!moved || taken.has(moved)) return file;
        taken.add(moved);
        healed = true;
        return moved;
      });
    if (healed)
      await workspace
        .serial(async () => {
          // Read again under the lock: only the links found are written back.
          const fresh = await read(workspace);
          const links = new Map(data.papers.map((p) => [p.id, p.files]));
          for (const p of fresh.papers) if (links.has(p.id)) p.files = links.get(p.id);
          await write(workspace, fresh, atomicWrite);
        })
        .catch(() => {});
    return {
      papers: data.papers.map((p) => ({ ...p, gone: p.files.filter((f) => !there.has(f)) })),
      lists: data.lists,
    };
  }

  // Adds a paper, or adds what `input` knows to the one already there (same DOI, arXiv
  // number, title or file). What the reader already wrote is kept unless `overwrite`.
  function add(workspace, input, { overwrite = false } = {}) {
    if (!input || typeof input !== 'object') bad('无效的论文');
    return change(workspace, (data) => upsert(data, input, overwrite));
  }
  function upsert(data, input, overwrite) {
    const files = paths(input.files);
    let paper = find(data, input);
    const created = !paper;
    if (!paper) {
      const title = FIELDS.title(input.title);
      if (!title) bad('论文需要标题');
      if (data.papers.length >= 20_000) bad('文献库已满');
      paper = normal({ id: crypto.randomUUID(), title, addedAt: now().getTime() });
      data.papers.push(paper);
      apply(paper, input, { now: now() });
    } else apply(paper, input, { fill: !overwrite, now: now() });
    if (files.length) claim(data, paper, files);
    return { paper: { ...paper }, created };
  }
  // Several at once, written once.
  function addMany(workspace, inputs, options = {}) {
    if (!Array.isArray(inputs)) bad('无效的论文列表');
    return change(workspace, (data) => {
      let created = 0;
      const papers = [];
      for (const input of inputs.slice(0, 5000)) {
        if (!input || typeof input !== 'object') continue;
        if (!find(data, input) && !FIELDS.title(input.title)) continue;
        const r = upsert(data, input, !!options.overwrite);
        created += r.created ? 1 : 0;
        papers.push(r.paper);
      }
      return { papers, created, updated: papers.length - created };
    });
  }

  function update(workspace, id, patch) {
    if (!patch || typeof patch !== 'object') bad('无效的修改');
    return change(workspace, (data) => {
      const paper = data.papers.find((p) => p.id === id);
      if (!paper) bad('文献库里没有这篇论文');
      apply(paper, patch, { now: now() });
      if ('files' in patch) {
        paper.files = [];
        claim(data, paper, paths(patch.files));
      }
      return { ...paper };
    });
  }

  function remove(workspace, ids) {
    const gone = new Set(Array.isArray(ids) ? ids : [ids]);
    return change(workspace, (data) => {
      const before = data.papers.length;
      data.papers = data.papers.filter((p) => !gone.has(p.id));
      for (const l of data.lists) l.papers = l.papers.filter((id) => !gone.has(id));
      return before - data.papers.length;
    });
  }

  // A file or folder moved in 页间: the papers' files move with it.
  function moved(workspace, from, to) {
    return workspace.serial(async () => {
      const data = await read(workspace).catch(() => null);
      if (!data) return;
      let changed = false;
      for (const paper of data.papers)
        paper.files = paper.files.map((file) => {
          if (file !== from && !file.startsWith(from + '/')) return file;
          changed = true;
          return to + file.slice(from.length);
        });
      if (changed) await write(workspace, data, atomicWrite);
    });
  }

  // A reading list: its papers in order. An empty one is removed.
  function setList(workspace, { name, note, papers }) {
    const title = line(name, 80);
    if (!title) bad('书单需要名字');
    return change(workspace, (data) => {
      const ids = new Set(data.papers.map((p) => p.id));
      const kept = [...new Set((Array.isArray(papers) ? papers : []).filter((id) => ids.has(id)))];
      data.lists = data.lists.filter((l) => l.name !== title);
      if (kept.length) data.lists.push({ name: title, note: block(note, 2000), papers: kept });
      return kept.length;
    });
  }

  // What the reader left in a document: its note, and the passages marked with what was
  // written on them.
  async function marks(workspace, relative) {
    try {
      const full = await workspace.resolve(relative);
      let id = workspace.index.files[relative]?.id;
      const meta = path.join(path.dirname(full), '.html-reader');
      if (!id) {
        const local = JSON.parse(await fs.readFile(path.join(meta, 'workspace.json'), 'utf8'));
        id = local?.files?.[path.basename(full)]?.id;
      }
      if (!id || !/^[\w-]{8,64}$/.test(id)) return null;
      const data = JSON.parse(
        await fs.readFile(path.join(meta, 'documents', `${id}.json`), 'utf8'),
      );
      const annotations = Array.isArray(data.annotations) ? data.annotations : [];
      return {
        note: typeof data.note === 'string' ? data.note.slice(0, 60_000) : '',
        highlights: annotations
          .filter((a) => a?.quote?.exact)
          .slice(0, 400)
          .map((a) => ({
            text: String(a.quote.exact).slice(0, 2000),
            note: String(a.note || '').slice(0, 4000),
            ...(a.by === 'ai' ? { by: 'ai' } : {}),
          })),
        notes: annotations
          .filter((a) => !a?.quote?.exact && (a?.type === 'sticky' || a?.type === 'text') && a.note)
          .slice(0, 200)
          .map((a) => String(a.note).slice(0, 4000)),
        progress: Number.isFinite(data.scroll) ? data.scroll : 0,
      };
    } catch {
      return null;
    }
  }

  // One paper with what the reader wrote in its files.
  async function detail(workspace, id) {
    const { papers } = await list(workspace);
    const paper = papers.find((p) => p.id === id);
    if (!paper) bad('文献库里没有这篇论文');
    const files = [];
    for (const file of paper.files) {
      if (paper.gone.includes(file)) continue;
      files.push({ path: file, kind: kindOf(file), ...((await marks(workspace, file)) || {}) });
    }
    return { ...paper, documents: files };
  }

  return { list, add, addMany, update, remove, moved, setList, detail, read };
}

// ---- BibTeX ---------------------------------------------------------------------------

const texEscape = (s) =>
  String(s)
    .replace(/([&%$#_])/g, '\\$1')
    .replace(/[{}]/g, '');
const conference =
  /\b(conference|proceedings|symposium|workshop|meeting of the|neural information processing|neurips|nips|icml|iclr|aaai|ijcai|acl|emnlp|naacl|cvpr|iccv|eccv|sigir|kdd|www|osdi|sosp|chi|uist)\b/i;
function citeKey(paper, used) {
  const first = (paper.authors[0] || '').trim();
  // “Vaswani, Ashish” and “Ashish Vaswani” both give vaswani.
  const last = (first.includes(',') ? first.split(',')[0] : first.split(/\s+/).at(-1) || '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
  const word =
    paper.title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .find(
        (w) => w.length > 3 && !/^(with|from|that|this|what|when|into|over|your|their)$/.test(w),
      ) || '';
  const base = `${last || 'anon'}${paper.year || ''}${word}` || 'paper';
  let key = base;
  for (let n = 0; used.has(key); n++)
    key = base + String.fromCharCode(97 + (n % 26)) + (n >= 26 ? n : '');
  used.add(key);
  return key;
}
function toBibtex(papers) {
  const used = new Set();
  return papers
    .map((p) => {
      const preprint = !p.venue || /^(arxiv|biorxiv|medrxiv|ssrn)\b/i.test(p.venue);
      const type = preprint ? 'misc' : conference.test(p.venue) ? 'inproceedings' : 'article';
      const fields = [
        ['title', `{${texEscape(p.title)}}`],
        ['author', p.authors.map(texEscape).join(' and ')],
        ['year', p.year ? String(p.year) : ''],
        [type === 'inproceedings' ? 'booktitle' : 'journal', preprint ? '' : texEscape(p.venue)],
        ['doi', p.doi],
        ['eprint', p.arxiv],
        ['archivePrefix', p.arxiv ? 'arXiv' : ''],
        ['url', p.url || (p.arxiv ? `https://arxiv.org/abs/${p.arxiv}` : '')],
      ].filter(([, value]) => value);
      return `@${type}{${citeKey(p, used)},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')}\n}`;
    })
    .join('\n\n')
    .concat(papers.length ? '\n' : '');
}

const texPlain = (s) =>
  String(s)
    .replace(/\\(?:textbf|textit|emph|textrm|mathrm|text)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\['"`^~=.uvHckb]\s*\{?([a-zA-Z])\}?/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// “Vaswani, Ashish” → “Ashish Vaswani”.
const personName = (s) => {
  const parts = texPlain(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : parts.join(', ');
};
// The entries of a .bib file as papers. Tolerant: what it can't read is skipped.
function fromBibtex(text) {
  const src = String(text);
  const papers = [];
  const at = /@([a-zA-Z]+)\s*[{(]/g;
  let m;
  while ((m = at.exec(src))) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    let i = at.lastIndex;
    // The entry runs to the brace that closes it.
    let depth = 1;
    let end = i;
    for (; end < src.length && depth > 0; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}') depth--;
    }
    const body = src.slice(i, end - 1);
    at.lastIndex = end;
    const fields = {};
    const comma = body.indexOf(',');
    let rest = comma < 0 ? '' : body.slice(comma + 1);
    const field = /^\s*([a-zA-Z_][\w-]*)\s*=\s*/;
    let guard = 0;
    while (rest && guard++ < 200) {
      const f = field.exec(rest);
      if (!f) break;
      rest = rest.slice(f[0].length);
      let value = '';
      if (rest[0] === '{') {
        let d = 0;
        let j = 0;
        for (; j < rest.length; j++) {
          if (rest[j] === '{') d++;
          else if (rest[j] === '}' && --d === 0) break;
        }
        value = rest.slice(1, j);
        rest = rest.slice(j + 1);
      } else if (rest[0] === '"') {
        let j = 1;
        let d = 0;
        for (; j < rest.length; j++) {
          if (rest[j] === '{') d++;
          else if (rest[j] === '}') d--;
          else if (rest[j] === '"' && d === 0) break;
        }
        value = rest.slice(1, j);
        rest = rest.slice(j + 1);
      } else {
        const j = rest.search(/[,\n]/);
        value = j < 0 ? rest : rest.slice(0, j);
        rest = j < 0 ? '' : rest.slice(j);
      }
      fields[f[1].toLowerCase()] = value;
      rest = rest.replace(/^\s*,/, '');
    }
    const title = texPlain(fields.title || '');
    if (!title) continue;
    const eprint = texPlain(fields.eprint || fields.arxivid || '');
    const isArxiv =
      /arxiv/i.test(fields.archiveprefix || fields.eprinttype || '') ||
      /^\d{4}\.\d{4,5}(v\d+)?$/.test(eprint);
    papers.push({
      title,
      authors: String(fields.author || '')
        .split(/\s+and\s+/i)
        .map(personName)
        .filter(Boolean),
      year: (texPlain(fields.year || fields.date || '').match(/\d{4}/) || [''])[0],
      venue: texPlain(fields.journal || fields.booktitle || fields.publisher || ''),
      doi: texPlain(fields.doi || ''),
      arxiv: isArxiv ? eprint : '',
      url: texPlain(fields.url || ''),
      abstract: texPlain(fields.abstract || ''),
      tags: texPlain(fields.keywords || '')
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return papers;
}

module.exports = {
  createLibrary,
  LibraryError,
  STATUSES,
  titleKey,
  cleanArxiv,
  cleanDoi,
  toBibtex,
  fromBibtex,
  libraryPath,
};
