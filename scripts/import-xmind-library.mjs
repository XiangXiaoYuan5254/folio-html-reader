// 把一张 XMind 脑图里的论文导入页间的文献库。
//
//   node scripts/import-xmind-library.mjs <项目文件夹> --xmind <脑图.xmind>
//        [--venues venues.json] [--read-log read_log.json] [--list 书单.json]… [--notes 伴读笔记-html]
//        [--paper-list 论文列表.md --ranking 排名.md --ranking-name "某某推荐的 Top 100"] [--dry-run]
//
// 脑图要长成这样（论文阅读仪表盘用的就是这种）：
//
//   中心主题
//   └─ 大类
//      └─ 子类
//         └─ 论文（节点名是简称；任务状态“已完成”= 已读；节点的链接指向它的伴读笔记）
//            ├─ 《English Title》⏎ 中文名（年份）[渠道|等级]      ← 第一个子节点
//            ├─ xx总结 → 每个子节点一段
//            └─ 笔记 → 子节点是一条条笔记，可以再分层
//
// 导入到 <项目文件夹>/.html-reader/library.json：大类/子类成为分类，简称和中文名成为别名，总结和
// 笔记照搬，链接指向的笔记文件（在 --notes 这个文件夹下，默认「伴读笔记-html」）成为论文的文件。
// 已经在文献库里的论文（标题相同）会被更新，不会重复。可以反复运行。
//
//   --venues    论文标题 → [渠道, 等级] 的 JSON；脑图里没写 [渠道] 的论文从这里取
//   --read-log  归一化标题 → 读完日期（或 null）的 JSON；没有的话已读论文的日期留空
//   --list      { "name"?, "criteria"?, "papers": [标题…] } 的 JSON，成为一个书单，可以给多个
//   --paper-list / --ranking  一份“编号. 标题”的论文列表和一份按 “- **编号.” 排名的 Markdown，
//               合起来成为一个书单（--ranking-name 是它的名字）
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readZip } = require('../electron/zip.cjs');
const { Workspace, atomicWrite } = require('../electron/workspace.cjs');
const { createLibrary } = require('../electron/library.cjs');

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const stripNo = (name) =>
  String(name || '')
    .replace(/^\d+[_.]\s*/, '')
    .trim();
const kids = (topic) => topic?.children?.attached || [];
const isDone = (topic) =>
  (topic.extensions || []).some(
    (e) => e.provider === 'org.xmind.ui.task' && e.content?.status === 'done',
  );
// 笔记子树 → 带缩进的 Markdown 列表（图片不搬）。
function notesOf(topic, depth = 0) {
  const lines = [];
  for (const c of kids(topic)) {
    const text = String(c.title || '').trim();
    if (text) lines.push(`${'  '.repeat(depth)}- ${text.replace(/\s*\n\s*/g, ' ')}`);
    lines.push(...notesOf(c, depth + 1));
  }
  return lines;
}
const inlineVenue = /[[【]\s*([^[\]【】|]+?)\s*(?:[|｜]\s*([ABC-]))?\s*[\]】]/;

// 脑图 → 论文。`notesDir` 是伴读笔记所在的文件夹名：链接里它后面的部分就是笔记的路径。
export function parseXmind(buffer, { notesDir = '伴读笔记-html' } = {}) {
  const content = readZip(buffer, { maxEntries: 200_000 }).find((e) => e.name === 'content.json');
  if (!content)
    throw Error('这个 .xmind 里没有 content.json（旧版 XMind 8 的文件请先用新版 XMind 另存）');
  // A mind map with pictures in it can be large; its content.json is what counts.
  const root = JSON.parse(content.read(200_000_000).toString('utf8'))[0]?.rootTopic;
  if (!root) throw Error('脑图是空的');
  const papers = [];
  for (const cat of kids(root))
    for (const sub of kids(cat))
      for (const p of kids(sub)) {
        const parts = kids(p);
        const full = String(parts[0]?.title || '');
        const en = full.match(/《([\s\S]+?)》/);
        const title = (en ? en[1] : p.title || '').replace(/\s+/g, ' ').trim();
        if (!title) continue;
        let tail = en ? full.slice(en.index + en[0].length) : full;
        const v = tail.match(inlineVenue);
        if (v) tail = tail.slice(0, v.index) + tail.slice(v.index + v[0].length);
        const year = (tail || full).match(/[（(][^（）()]*?((?:19|20)\d{2})[^（）()]*?[）)]/);
        const zh =
          tail
            .replace(/[（(]\d{4}[）)]/g, '')
            .split('\n')
            .map((s) => s.trim())
            .find(Boolean) || '';
        let summary = '';
        let note = '';
        for (const c of parts.slice(1)) {
          const name = String(c.title || '');
          if (name.includes('总结'))
            summary = kids(c)
              .map((g) => String(g.title || '').trim())
              .filter(Boolean)
              .join('\n\n');
          else if (name.includes('笔记')) note = notesOf(c).join('\n');
        }
        // The link to its notes: file:…/伴读笔记-html/大类/某篇.html, percent-encoded or not.
        let file = '';
        const href = String(p.href || '');
        for (const text of [href, safeDecode(href)]) {
          const at = text.indexOf(`${notesDir}/`);
          if (at >= 0) {
            file = safeDecode(text.slice(at)).split(/[?#]/)[0];
            break;
          }
        }
        const label = stripNo(p.title);
        papers.push({
          title,
          label: label && label !== title ? label : '',
          zh,
          year: year ? Number(year[1]) : 0,
          category: [cat.title, sub.title]
            .map((s) => String(s || '').trim())
            .filter(Boolean)
            .join('/'),
          done: isDone(p),
          summary,
          note,
          file,
          venue: v ? v[1].trim() : '',
          rank: v?.[2] || '',
        });
      }
  return papers;
}
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// “编号. 标题（…）” 的论文列表和按 “- **编号.” 排名的 Markdown → 按名次排的标题。
export function rankedTitles(paperList, ranking) {
  const numbered = new Map();
  for (const line of String(paperList).split('\n')) {
    const m = line.trimEnd().match(/^(\d+)\.\s+(.+?)(?:（[^（）]*）)?\s*$/);
    if (m) numbered.set(Number(m[1]), m[2].trim());
  }
  const titles = [];
  for (const line of String(ranking).split('\n')) {
    const m = line.match(/^-\s+\*\*(\d+)\./);
    if (m && numbered.has(Number(m[1]))) titles.push(numbered.get(Number(m[1])));
  }
  return titles;
}

// What goes into the library, and what couldn't be matched.
export function plan(parsed, { venues = {}, readLog = null, existing = () => true } = {}) {
  const byTitle = new Map(Object.entries(venues).map(([k, v]) => [norm(k), v]));
  const missingFiles = [];
  const unknownVenues = [];
  // Venues whose rank comes from the reader's own table, not the dashboard's built-in one.
  const ranks = new Map();
  const papers = parsed.map((p) => {
    const listed = byTitle.get(norm(p.title));
    const venue = p.venue || listed?.[0] || '';
    const rank = p.rank || listed?.[1] || '';
    if (!venue) unknownVenues.push(p.title);
    else if (/^[ABC-]$/.test(rank)) ranks.set(venue, rank);
    const hasFile = p.file && existing(p.file);
    if (p.file && !hasFile) missingFiles.push(p.file);
    const date = readLog ? readLog[norm(p.title)] : undefined;
    return {
      title: p.title,
      alias: [p.label, p.zh].filter(Boolean).join(' · '),
      year: p.year,
      venue,
      category: p.category,
      summary: p.summary,
      note: p.note,
      status: p.done ? 'done' : 'unread',
      // A day the log knows; otherwise read on a day unknown.
      ...(p.done ? { readAt: typeof date === 'string' ? date : '' } : {}),
      files: hasFile ? [p.file] : [],
    };
  });
  return { papers, missingFiles, unknownVenues, ranks };
}

async function main(argv) {
  const args = { list: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--list') args.list.push(argv[++i]);
    else if (a.startsWith('--'))
      args[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else rest.push(a);
  }
  const project = rest[0];
  if (!project || !args.xmind) {
    console.error(
      '用法：node scripts/import-xmind-library.mjs <项目文件夹> --xmind <脑图.xmind> [--venues venues.json] [--read-log read_log.json] [--list 书单.json] [--dry-run]',
    );
    process.exit(2);
  }
  const json = async (file) => (file ? JSON.parse(await fs.readFile(file, 'utf8')) : null);
  const notesDir = args.notes || '伴读笔记-html';
  const parsed = parseXmind(await fs.readFile(args.xmind), { notesDir });
  const root = await fs.realpath(project);
  const there = new Set();
  await Promise.all(
    [...new Set(parsed.map((p) => p.file).filter(Boolean))].map(async (f) => {
      if (await fs.stat(path.join(root, f)).catch(() => null)) there.add(f);
    }),
  );
  const { papers, missingFiles, unknownVenues, ranks } = plan(parsed, {
    venues: (await json(args.venues)) || {},
    readLog: await json(args.readLog),
    existing: (f) => there.has(f),
  });
  const lists = [];
  for (const file of args.list) {
    const raw = await json(file);
    lists.push({
      name: raw.name || path.basename(file, path.extname(file)),
      note: raw.criteria || raw.note || '',
      titles: raw.papers || [],
    });
  }
  if (args.paperList && args.ranking)
    lists.push({
      name: args.rankingName || path.basename(args.ranking, path.extname(args.ranking)),
      note: '',
      titles: rankedTitles(
        await fs.readFile(args.paperList, 'utf8'),
        await fs.readFile(args.ranking, 'utf8'),
      ),
    });

  const done = papers.filter((p) => p.status === 'done');
  console.log(
    `脑图里有 ${papers.length} 篇论文，已读 ${done.length} 篇（${done.filter((p) => p.readAt).length} 篇有读完的日期）。`,
  );
  console.log(
    `找到笔记文件的 ${papers.filter((p) => p.files.length).length} 篇${missingFiles.length ? `；${missingFiles.length} 篇的笔记不在项目里，例如 ${missingFiles.slice(0, 3).join('、')}` : ''}。`,
  );
  if (unknownVenues.length)
    console.log(
      `${unknownVenues.length} 篇没有发表渠道，例如 ${unknownVenues.slice(0, 3).join('、')}。`,
    );
  if (args.dryRun) return console.log('（--dry-run：没有写入）');

  const workspace = new Workspace();
  await workspace.open(root);
  const library = createLibrary({ atomicWrite });
  const result = await library.addMany(workspace, papers, { overwrite: true });
  console.log(`文献库：新增 ${result.created} 篇，更新 ${result.updated} 篇。`);
  const ids = new Map(result.papers.map((p) => [norm(p.title), p.id]));
  for (const list of lists) {
    const found = list.titles.map((t) => ids.get(norm(t))).filter(Boolean);
    await library.setList(workspace, { name: list.name, note: list.note, papers: found });
    console.log(
      `书单「${list.name}」：${found.length} 篇${found.length < list.titles.length ? `（${list.titles.length - found.length} 篇不在脑图里）` : ''}。`,
    );
  }
  if (ranks.size) {
    console.log('\n论文仪表盘内置了常见渠道的 CCF 等级。要沿用你自己标的等级，把下面这些贴进');
    console.log(
      '设置 › 插件 › 论文仪表盘 ›「补充或更正渠道等级」（内置表里已有且相同的可以不贴）：\n',
    );
    console.log([...ranks].map(([venue, rank]) => `${venue}=${rank}`).join('\n'));
  }
  console.log(
    `\n写好了：${path.join(root, '.html-reader', 'library.json')}。在页间里打开这个文件夹就能看到。`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
