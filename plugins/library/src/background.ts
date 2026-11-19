// 文献库's background script: runs while the plugin is on and a project is open. It keeps the
// file tree's marks and menu items in step with the library, offers to mark a paper read when
// the reader reaches its end, ties a 精读笔记 or translation to the paper it was made from, and
// answers the library's tools for the AI assistant and, over MCP, other AI tools.
import {
  arxivIdIn,
  authorsShort,
  isPaperFile,
  statusName,
  titleFromPath,
  type Library,
  type LibraryPaper,
  type PaperPatch,
  type PaperStatus,
} from './shared';

let library: Library = { papers: [], lists: [] };
let byFile = new Map<string, LibraryPaper>();
const paperOf = (path: string) => byFile.get(path);

async function refresh() {
  try {
    library = await folio.library.list();
  } catch (e) {
    folio.warn('读文献库出错：', e);
    return;
  }
  byFile = new Map(
    library.papers.flatMap((p) =>
      p.files.filter((f) => !p.gone.includes(f)).map((f) => [f, p] as const),
    ),
  );
  // A paper being read or read shows on its files; one not started shows nothing.
  const badges: Record<string, { icon: 'check' | 'half'; title: string }> = {};
  const menus: Record<string, { id: string; label: string }[]> = {};
  for (const [file, p] of byFile) {
    if (p.status !== 'unread')
      badges[file] = {
        icon: p.status === 'done' ? 'check' : 'half',
        title: `${statusName[p.status]} · ${p.title}`,
      };
    menus[file] = [
      p.status === 'done' ? { id: 'unread', label: '标为未读' } : { id: 'done', label: '标为已读' },
      ...(p.status === 'unread' ? [{ id: 'reading', label: '标为在读' }] : []),
      { id: 'info', label: '文献信息…' },
    ];
  }
  await folio.tree.set({
    badges,
    menus,
    fileMenu: [{ id: 'add', label: '加入文献库…', kinds: ['pdf', 'html', 'markdown'] }],
    folderMenu: [{ id: 'add-folder', label: '里面的文档加入文献库' }],
  });
  const done = library.papers.filter((p) => p.status === 'done').length;
  await folio.setBadge(library.papers.length ? `${done}/${library.papers.length}` : '');
}
// Heard at once when it starts, and again each time the library changes.
folio.on('library', () => void refresh());

const run = (work: () => Promise<unknown>) =>
  void work().catch((e) => folio.notify(String(e?.message || e)).catch(() => {}));

// The file tree's menu items.
folio.on('menu', ({ id, path }) =>
  run(async () => {
    const paper = paperOf(path);
    if (id === 'info' && paper) return folio.showPage({ edit: paper.id });
    if ((id === 'done' || id === 'unread' || id === 'reading') && paper)
      return folio.library.update(paper.id, { status: id });
    if (id === 'add') {
      let title = titleFromPath(path);
      let arxiv = arxivIdIn(path);
      // A PDF often says more than its file name: its own title, and on an arXiv paper's first
      // page, its number.
      if (/\.pdf$/i.test(path))
        try {
          const doc = await folio.documents.read(path, { maxChars: 4000 });
          const named = doc.title.trim();
          const name = path.slice(path.lastIndexOf('/') + 1);
          if (named && named.length > 8 && named !== name && !/\.pdf$/i.test(named)) title = named;
          arxiv ||= doc.text.match(/arXiv:(\d{4}\.\d{4,5})/)?.[1] || '';
        } catch {}
      return folio.showPage({ add: { title, arxiv, files: [path] } });
    }
    if (id === 'add-folder') {
      const inside = (await folio.documents.list()).filter(
        (f) => isPaperFile(f.kind) && f.path.startsWith(`${path}/`) && !paperOf(f.path),
      );
      if (!inside.length) return folio.notify('这个文件夹里没有还没加入文献库的文档');
      const { created } = await folio.library.addMany(
        inside.map((f) => ({
          title: titleFromPath(f.path),
          arxiv: arxivIdIn(f.path),
          files: [f.path],
        })),
      );
      if (
        await folio.notify(`已把 ${created} 篇加入文献库，作者和年份可以在文献库里一键补全`, {
          action: '打开文献库',
        })
      )
        await folio.showPage();
    }
  }),
);

// Reaching the end of a paper not yet marked read offers to mark it, once for each paper; not
// at once for a page short enough to be all on screen, only after some time with it.
let reading = { path: '', since: Date.now() };
const offered = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
folio.on('document', ({ path }) => {
  if (path === reading.path) return;
  reading = { path, since: Date.now() };
  clearTimeout(timer);
});
folio.on('progress', ({ path, progress }) => {
  if (path !== reading.path || progress < 98) return clearTimeout(timer);
  const paper = paperOf(path);
  if (!paper || paper.status === 'done' || offered.has(paper.id)) return;
  clearTimeout(timer);
  timer = setTimeout(
    () =>
      run(async () => {
        const now = paperOf(path);
        if (!now || now.status === 'done' || reading.path !== path) return;
        offered.add(now.id);
        const name = now.alias || now.title;
        const marked = await folio.notify(
          `读到「${name.length > 26 ? `${name.slice(0, 26)}…` : name}」的结尾了`,
          { action: '标为已读' },
        );
        if (marked) await folio.library.update(now.id, { status: 'done' });
      }),
    Math.max(1500, 45_000 - (Date.now() - reading.since)),
  );
});

// A 精读笔记 or a translation made from a paper's file becomes one of its files too.
folio.on('created', ({ path, source, by }) => {
  if (by !== 'companion' && by !== 'translation') return;
  const paper = paperOf(source);
  if (paper && !paper.files.includes(path))
    run(() => folio.library.update(paper.id, { files: [...paper.files, path] }));
});

// ---- The AI's tools (folio-plugin.json's aiTools) ---------------------------------------

const shortId = (p: LibraryPaper) => p.id.slice(0, 8);
function paperById(papers: LibraryPaper[], value: unknown) {
  const id = String(value ?? '').trim();
  if (!id) return undefined;
  const exact = papers.find((p) => p.id === id);
  if (exact) return exact;
  const starts = papers.filter((p) => p.id.startsWith(id));
  return id.length >= 6 && starts.length === 1 ? starts[0] : undefined;
}

folio.tools.handle('list_library', async (input: any) => {
  const { papers, lists } = await folio.library.list();
  if (!papers.length)
    return '文献库还是空的。用 save_pdf 下载的论文会自动记进来；项目里已有的论文，可以用 update_library 记进来（files 写它的文件）。';
  const count = (s: PaperStatus) => papers.filter((p) => p.status === s).length;
  const query = String(input?.query || '')
    .trim()
    .toLowerCase();
  const tag = String(input?.tag || '')
    .trim()
    .toLowerCase();
  const status = ['unread', 'reading', 'done'].includes(input?.status) ? input.status : '';
  const matched = papers.filter((p) => {
    if (status && p.status !== status) return false;
    if (tag && !p.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (!query) return true;
    const hay = [
      p.title,
      p.alias,
      p.authors.join(' '),
      p.venue,
      p.tags.join(' '),
      p.category,
      p.summary,
    ]
      .join('\n')
      .toLowerCase();
    return query.split(/\s+/).every((word) => hay.includes(word));
  });
  const offset = Math.max(0, Math.round(Number(input?.offset)) || 0);
  const limit = Math.min(200, Math.max(1, Math.round(Number(input?.limit)) || 60));
  const shown = matched.slice(offset, offset + limit);
  const lines = shown.map((p, i) => {
    const facts = [p.year || '', p.venue].filter(Boolean).join('，');
    const read =
      p.status === 'done' ? `已读${p.readAt ? ` ${p.readAt}` : ''}` : statusName[p.status];
    const more = [
      p.tags.length ? `标签：${p.tags.join('、')}` : '',
      p.category ? `分类：${p.category}` : '',
      p.doi ? `DOI ${p.doi}` : '',
      p.arxiv ? `arXiv ${p.arxiv}` : '',
    ].filter(Boolean);
    const files = p.files.filter((f) => !p.gone.includes(f));
    return [
      `${offset + i + 1}. [${shortId(p)}] ${p.title}${p.alias ? `（${p.alias}）` : ''}${facts ? ` — ${facts}` : ''}${p.authors.length ? ` — ${authorsShort(p)}` : ''} · ${read}`,
      more.length ? `   ${more.join(' · ')}` : '',
      files.length ? `   文件：${files.join('、')}` : '   （项目里没有它的文件）',
      p.summary ? `   总结：${p.summary.replace(/\s+/g, ' ').slice(0, 300)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  const listLines = lists.map(
    (l) =>
      `- 书单「${l.name}」（${l.papers.length} 篇）：${l.papers
        .map((id) => papers.find((p) => p.id === id))
        .filter(Boolean)
        .slice(0, 30)
        .map((p) => `[${shortId(p!)}]`)
        .join(' ')}`,
  );
  const rest = matched.length - offset - shown.length;
  return [
    `文献库共 ${papers.length} 篇：已读 ${count('done')}，在读 ${count('reading')}，未读 ${count('unread')}。${
      matched.length === papers.length ? '' : `符合条件的 ${matched.length} 篇。`
    }`,
    '',
    ...lines,
    rest > 0 ? `\n……还有 ${rest} 篇，用 offset: ${offset + shown.length} 继续看。` : '',
    listLines.length ? `\n${listLines.join('\n')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
});

folio.tools.handle('get_paper', async (input: any) => {
  const { papers } = await folio.library.list();
  const found = paperById(papers, input?.id);
  if (!found) throw Error(`文献库里没有 id 为 ${input?.id} 的论文，先用 list_library 看 id`);
  const p = await folio.library.get(found.id);
  const read = p.status === 'done' ? `已读${p.readAt ? ` ${p.readAt}` : ''}` : statusName[p.status];
  return [
    `[${shortId(p)}] ${p.title}${p.alias ? `（${p.alias}）` : ''}`,
    [p.authors.join(', '), p.year || '', p.venue].filter(Boolean).join(' · ') || '还没有作者和年份',
    `阅读状态：${read}`,
    p.tags.length ? `标签：${p.tags.join('、')}` : '',
    p.category ? `分类：${p.category}` : '',
    p.doi ? `DOI：${p.doi}` : '',
    p.arxiv ? `arXiv：${p.arxiv}` : '',
    p.url ? `链接：${p.url}` : '',
    p.summary ? `\n总结：${p.summary}` : '',
    p.abstract ? `\n摘要：${p.abstract}` : '',
    p.note ? `\n读者的笔记：${p.note}` : '',
    ...p.documents.map((d) =>
      [
        `\n文件 ${d.path}`,
        d.highlights?.length
          ? `读者划的重点：\n${d.highlights.map((h) => `- “${h.text}”${h.note ? `\n  批注：${h.note}` : ''}`).join('\n')}`
          : '没有划重点。',
        d.notes?.length ? `便签：\n${d.notes.map((n) => `- ${n}`).join('\n')}` : '',
        d.note?.trim() ? `文档笔记：\n${d.note.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ]
    .filter(Boolean)
    .join('\n');
});

const fieldNames: Record<string, string> = {
  title: '标题',
  alias: '别名',
  authors: '作者',
  year: '年份',
  venue: '出处',
  doi: 'DOI',
  arxiv: 'arXiv',
  url: '链接',
  tags: '标签',
  category: '分类',
  summary: '总结',
  status: '阅读状态',
  files: '文件',
};
// update_library, read and checked once: what it will do, the problems, and the doing of it.
async function plan(input: any, via: 'assistant' | 'mcp') {
  const { papers } = await folio.library.list();
  const docs = new Set((await folio.documents.list()).map((f) => f.path));
  const items: { label: string; detail: string }[] = [];
  const errors: string[] = [];
  const upserts: (PaperPatch & { id?: string })[] = [];
  const removals: string[] = [];
  for (const raw of Array.isArray(input?.papers) ? input.papers.slice(0, 200) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, remove, ...fields } = raw;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(fieldNames))
      if (fields[key] !== undefined) patch[key] = fields[key];
    // Whether a paper was read is the reader's to say, not another program's.
    if (via === 'mcp' && patch.status !== undefined) {
      delete patch.status;
      errors.push('阅读状态只能由读者自己改');
    }
    if (Array.isArray(patch.files)) {
      const paths = (patch.files as unknown[]).map((f) =>
        String(f || '')
          .trim()
          .replace(/\\/g, '/')
          .replace(/^\.?\//, ''),
      );
      const missing = paths.filter((f) => !docs.has(f));
      if (missing.length) {
        errors.push(`项目里没有这些文件：${missing.join('、')}`);
        continue;
      }
      patch.files = paths;
    }
    const names = Object.keys(patch).map((key) => fieldNames[key]);
    if (id !== undefined) {
      const paper = paperById(papers, id);
      if (!paper) {
        errors.push(`文献库里没有 id 为 ${id} 的论文`);
        continue;
      }
      if (remove) {
        if (via === 'mcp') {
          errors.push('其他 AI 工具不能把论文移出文献库');
          continue;
        }
        removals.push(paper.id);
        items.push({ label: paper.title, detail: '移出文献库' });
      } else if (names.length) {
        // New files are added to the paper's, not put in their place.
        if (Array.isArray(patch.files))
          patch.files = [...new Set([...paper.files, ...(patch.files as string[])])];
        upserts.push({ ...patch, id: paper.id });
        const status = patch.status as PaperStatus | undefined;
        items.push({
          label: paper.title,
          detail:
            status && names.length === 1 ? `标为${statusName[status]}` : `修改${names.join('、')}`,
        });
      }
    } else if (String(patch.title || '').trim()) {
      upserts.push(patch);
      items.push({ label: String(patch.title).trim(), detail: '新增' });
    } else errors.push('新增的论文需要 title');
  }
  let list: { name: string; note?: string; papers: string[] } | null = null;
  if (input?.list && String(input.list.name || '').trim()) {
    const ids: string[] = [];
    for (const id of Array.isArray(input.list.ids) ? input.list.ids : []) {
      const paper = paperById(papers, id);
      if (paper) ids.push(paper.id);
      else errors.push(`书单里的 ${id} 不在文献库里`);
    }
    list = { name: String(input.list.name).trim(), note: input.list.note, papers: ids };
    items.push({
      label: `书单「${list.name}」`,
      detail: ids.length ? `${ids.length} 篇，按顺序` : '删除',
    });
  }
  const problems = errors.length ? `\n没有处理的：${errors.join('；')}。` : '';
  return {
    items,
    async apply() {
      if (!items.length) throw Error(`没有可以修改的内容。${problems}`);
      // An id makes it that paper whatever its title becomes; a new one may turn out to be
      // there already (same DOI or title), and is then filled in rather than doubled.
      const changed = upserts.filter((p) => p.id);
      const added = upserts.filter((p) => !p.id);
      if (changed.length) await folio.library.addMany(changed, { overwrite: true });
      const made = added.length ? await folio.library.addMany(added) : null;
      if (removals.length) await folio.library.remove(removals);
      if (list) await folio.library.setList(list);
      const done = [
        made?.created ? `新增 ${made.created} 篇` : '',
        made?.updated ? `${made.updated} 篇已在文献库里，补上了空着的信息` : '',
        changed.length ? `修改 ${changed.length} 篇` : '',
        removals.length ? `移出 ${removals.length} 篇` : '',
        list
          ? `书单「${list.name}」${list.papers.length ? `${list.papers.length} 篇` : '已删除'}`
          : '',
      ].filter(Boolean);
      return `文献库已更新：${done.join('，')}。${problems}`;
    },
  };
}
folio.tools.handle('update_library', {
  preview: async (input: any) => {
    const { items } = await plan(input, 'assistant');
    return { title: `修改文献库（${items.length} 项）`, items };
  },
  run: async (input: any, how?: { via: 'assistant' | 'mcp' }) =>
    (await plan(input, how?.via || 'assistant')).apply(),
});
