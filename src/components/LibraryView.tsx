import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookMarked,
  Check,
  ChevronDown,
  FileCode2,
  FileText,
  FileType,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { invoke } from '../api';
import {
  arxivIdIn,
  authorsShort,
  categoryOf,
  libraryApi,
  mainFile,
  statusName,
  useLibrary,
} from '../library';
import type { LibraryPaper, PaperCandidate, PaperPatch, PaperStatus } from '../library';
import { IconButton } from './IconButton';
import { belowButton, PopupMenu, type MenuAnchor, type MenuItem } from './PopupMenu';

const clean = (e: unknown) =>
  String((e as Error)?.message || e).replace(/Error invoking remote method '[^']+': Error: /, '');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fileIcon = (path: string) =>
  /\.pdf$/i.test(path) ? (
    <FileText className="tree-icon-pdf" size={14} />
  ) : /\.(md|markdown)$/i.test(path) ? (
    <FileType className="tree-icon-markdown" size={14} />
  ) : (
    <FileCode2 className="tree-icon-html" size={14} />
  );
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

type Notify = (text: string, error?: boolean, action?: { label: string; run: () => void }) => void;
type Sort = 'added' | 'read' | 'year' | 'title' | 'category';
const sortNames: Record<Sort, string> = {
  added: '最近添加',
  read: '最近读完',
  year: '年份',
  title: '标题',
  category: '按分类',
};

// What a candidate from OpenAlex or arXiv says, as fields of a paper.
const fromCandidate = (c: PaperCandidate): PaperPatch => ({
  title: c.title,
  authors: c.authors,
  year: c.year || 0,
  venue: c.venue || '',
  doi: c.doi || '',
  arxiv: c.arxiv || '',
  pmid: c.pmid || '',
  url: c.url || '',
  abstract: c.abstract || '',
  citations: c.citations || 0,
});
const lookupFor = (p: { title: string; doi?: string; arxiv?: string; files?: string[] }) => ({
  title: p.title,
  doi: p.doi || '',
  arxiv: p.arxiv || arxivIdIn(p.title) || (p.files || []).map(arxivIdIn).find(Boolean) || '',
});

// 文献库, a tab in the reading area: the project's papers to search, filter, open and mark
// read; their records to fill in and export.
export function LibraryView(p: {
  onOpen: (path: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
  notify: Notify;
  // Plugin pages that show the library their own way (a dashboard), a click away.
  pages: { id: string; title: string }[];
  onOpenPage: (id: string) => void;
}) {
  const { papers, lists } = useLibrary();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PaperStatus | ''>('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [list, setList] = useState('');
  const [sort, setSort] = useState<Sort>(() => {
    try {
      const saved = localStorage.getItem('folio.library-sort') as Sort;
      return saved in sortNames ? saved : 'added';
    } catch {
      return 'added';
    }
  });
  const [menu, setMenu] = useState<{ kind: string; at: MenuAnchor; paper?: LibraryPaper } | null>(
    null,
  );
  const [filling, setFilling] = useState<{ done: number; total: number; filled: number } | null>(
    null,
  );
  const [sharing, setSharing] = useState(false);
  const stopFill = useRef(false);

  const count = (s: PaperStatus) => papers.filter((x) => x.status === s).length;
  const done = count('done');
  const categories = useMemo(
    () =>
      [...new Set(papers.map((x) => categoryOf(x).split('/')[0]).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, 'zh-CN', { numeric: true }),
      ),
    [papers],
  );
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const x of papers) for (const t of x.tags) n.set(t, (n.get(t) || 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [papers]);
  const picked = lists.find((l) => l.name === list);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rank = picked ? new Map(picked.papers.map((id, i) => [id, i])) : null;
    const rows = papers.filter((x) => {
      if (status && x.status !== status) return false;
      if (rank && !rank.has(x.id)) return false;
      if (category && categoryOf(x).split('/')[0] !== category) return false;
      if (tag && !x.tags.includes(tag)) return false;
      if (!words.length) return true;
      const hay = [
        x.title,
        x.alias,
        x.authors.join(' '),
        x.venue,
        x.year || '',
        x.tags.join(' '),
        categoryOf(x),
        x.summary,
      ]
        .join('\n')
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const by: Record<Sort, (a: LibraryPaper, b: LibraryPaper) => number> = {
      added: (a, b) => b.addedAt - a.addedAt,
      read: (a, b) =>
        (b.readAt || (b.status === 'done' ? '0' : '')).localeCompare(
          a.readAt || (a.status === 'done' ? '0' : ''),
        ) || b.addedAt - a.addedAt,
      year: (a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title),
      title: (a, b) => a.title.localeCompare(b.title, 'zh-CN'),
      category: (a, b) =>
        categoryOf(a).localeCompare(categoryOf(b), 'zh-CN', { numeric: true }) ||
        (b.year || 0) - (a.year || 0),
    };
    // A reading list keeps its own order.
    return rank ? rows.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!) : rows.sort(by[sort]);
  }, [papers, query, status, category, tag, picked, sort]);

  function chooseSort(next: Sort) {
    setSort(next);
    try {
      localStorage.setItem('folio.library-sort', next);
    } catch {}
  }
  const act = (run: () => Promise<unknown>) => void run().catch((e) => p.notify(clean(e), true));
  const mark = (paper: LibraryPaper, next: PaperStatus) =>
    act(() => libraryApi.update(paper.id, { status: next }));

  // Papers that say little of themselves (no authors or no year) are looked up one by one;
  // only a title that fits is taken, and only what the paper has nothing in is filled.
  const bare = papers.filter((x) => !x.authors.length || !x.year);
  async function fillAll() {
    stopFill.current = false;
    let filled = 0;
    setFilling({ done: 0, total: bare.length, filled });
    for (let i = 0; i < bare.length && !stopFill.current; i++) {
      const paper = bare[i];
      try {
        const { papers: found } = await libraryApi.lookup(lookupFor(paper));
        const best = found[0];
        if (best && best.match >= 0.9) {
          const { title: _title, ...rest } = fromCandidate(best);
          await libraryApi.addMany([{ id: paper.id, ...rest }]);
          filled++;
        }
      } catch (e) {
        // The libraries asked too often: no use going on.
        if (/429|繁忙|额度/.test(clean(e))) {
          p.notify(clean(e), true);
          break;
        }
      }
      setFilling({ done: i + 1, total: bare.length, filled });
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    setFilling(null);
    p.notify(
      filled
        ? `补全了 ${filled} 篇的信息${filled < bare.length ? `，另外 ${bare.length - filled} 篇没有找到对得上的` : ''}`
        : '没有找到标题对得上的论文，可以在「文献信息」里手动查找',
    );
  }

  const rowMenu = (paper: LibraryPaper): MenuItem[] => [
    ...(['unread', 'reading', 'done'] as PaperStatus[])
      .filter((s) => s !== paper.status)
      .map((s) => ({ label: `标为${statusName[s]}`, onSelect: () => mark(paper, s) })),
    { label: '文献信息…', onSelect: () => p.onEdit(paper.id) },
    ...(paper.doi || paper.arxiv || paper.url
      ? [
          {
            label: '在浏览器里打开',
            onSelect: () =>
              act(() =>
                invokeExternal(
                  paper.doi
                    ? `https://doi.org/${paper.doi}`
                    : paper.arxiv
                      ? `https://arxiv.org/abs/${paper.arxiv}`
                      : paper.url,
                ),
              ),
          },
        ]
      : []),
    {
      label: '导出这一篇的 BibTeX…',
      onSelect: () => act(() => libraryApi.exportBibtex([paper.id])),
    },
    {
      label: '移出文献库',
      danger: true,
      onSelect: () =>
        act(async () => {
          await libraryApi.remove([paper.id]);
          p.notify(`已把「${paper.title}」移出文献库，文件没有动`);
        }),
    },
  ];
  const moreMenu: MenuItem[] = [
    {
      label: '导入 BibTeX…',
      help: 'Zotero、EndNote、Google Scholar 都能导出 .bib 文件',
      onSelect: () =>
        act(async () => {
          const r = await libraryApi.importBibtex();
          if (r)
            p.notify(`导入了 ${r.created} 篇${r.updated ? `，${r.updated} 篇已在文献库里` : ''}`);
        }),
    },
    {
      label: shown.length < papers.length ? `导出筛选出的 ${shown.length} 篇…` : '导出 BibTeX…',
      disabled: !shown.length,
      onSelect: () =>
        act(async () => {
          const n = await libraryApi.exportBibtex(shown.map((x) => x.id));
          if (n) p.notify(`已导出 ${n} 篇`);
        }),
    },
    {
      label: '让其他 AI 工具读文献库…',
      help: 'OpenScience、Claude Code 等支持 MCP 的工具',
      onSelect: () => setSharing(true),
    },
    ...(bare.length
      ? [
          {
            label: `补全 ${bare.length} 篇的作者、年份和出处`,
            help: '按标题到 OpenAlex 和 arXiv 查，只填空着的',
            onSelect: () => void fillAll(),
          },
        ]
      : []),
  ];

  let lastGroup = '';
  return (
    <section className="library-view" aria-label="文献库">
      <header className="library-head">
        <div className="library-title">
          <h1>文献库</h1>
          {papers.length ? (
            <p>
              共 {papers.length} 篇 · 已读 {done}
              {count('reading') ? ` · 在读 ${count('reading')}` : ''}
              <span className="library-progress" aria-hidden="true">
                <i style={{ width: `${(done / papers.length) * 100}%` }} />
              </span>
              {Math.round((done / papers.length) * 100)}%
            </p>
          ) : null}
        </div>
        <div className="library-actions">
          {p.pages.map((page) => (
            <button
              key={page.id}
              type="button"
              className="secondary-button"
              onClick={() => p.onOpenPage(page.id)}
            >
              <LayoutDashboard size={14} />
              {page.title}
            </button>
          ))}
          <button type="button" className="secondary-button" onClick={p.onNew}>
            <Plus size={14} />
            添加论文
          </button>
          <IconButton
            label="导入、导出和补全"
            aria-haspopup="menu"
            onClick={(e) => setMenu({ kind: 'more', at: belowButton(e.currentTarget) })}
          >
            <MoreHorizontal size={16} />
          </IconButton>
        </div>
      </header>
      {filling ? (
        <div className="library-filling" role="status">
          正在补全信息 {filling.done}/{filling.total}，已补全 {filling.filled} 篇
          <button type="button" onClick={() => (stopFill.current = true)}>
            停止
          </button>
        </div>
      ) : null}
      {papers.length ? (
        <>
          <div className="library-filters">
            <label className="library-search">
              <Search size={14} />
              <input
                aria-label="搜索文献"
                placeholder="搜索标题、作者、出处、标签…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query ? (
                <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}>
                  <X size={13} />
                </button>
              ) : null}
            </label>
            <div className="library-status" role="tablist" aria-label="阅读状态">
              {(['', 'unread', 'reading', 'done'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={status === s}
                  className={status === s ? 'selected' : ''}
                  onClick={() => setStatus(s)}
                >
                  {s ? statusName[s] : '全部'}
                  <span>{s ? count(s) : papers.length}</span>
                </button>
              ))}
            </div>
            {categories.length > 1 ? (
              <select
                aria-label="分类"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">全部分类</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : null}
            {tags.length ? (
              <select aria-label="标签" value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">全部标签</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : null}
            {lists.length ? (
              <select aria-label="书单" value={list} onChange={(e) => setList(e.target.value)}>
                <option value="">书单</option>
                {lists.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}（{l.papers.length}）
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className="library-sort"
              aria-haspopup="menu"
              disabled={!!picked}
              onClick={(e) => setMenu({ kind: 'sort', at: belowButton(e.currentTarget) })}
            >
              {picked ? '书单顺序' : sortNames[sort]}
              <ChevronDown size={13} />
            </button>
          </div>
          {picked?.note ? <p className="library-list-note">{picked.note}</p> : null}
          <div className="library-list" role="list">
            {shown.map((paper, i) => {
              const file = mainFile(paper);
              const group = sort === 'category' && !picked ? categoryOf(paper) || '未分类' : '';
              const heading = group && group !== lastGroup ? group : '';
              lastGroup = group;
              const facts = [authorsShort(paper), paper.year || '', paper.venue].filter(Boolean);
              return (
                <div key={paper.id} role="listitem">
                  {heading ? <h2 className="library-group">{heading}</h2> : null}
                  <div className={`library-row ${paper.status}`} data-paper={paper.id}>
                    <button
                      type="button"
                      className="library-mark"
                      aria-label={paper.status === 'done' ? '标为未读' : '标为已读'}
                      title={
                        paper.status === 'done'
                          ? `已读${paper.readAt ? ` · ${paper.readAt}` : ''}，点击改回未读`
                          : '标为已读'
                      }
                      onClick={() => mark(paper, paper.status === 'done' ? 'unread' : 'done')}
                    >
                      {paper.status === 'done' ? <Check size={13} strokeWidth={3} /> : null}
                    </button>
                    <button
                      type="button"
                      className="library-main"
                      title={file ? `打开 ${file}` : '项目里还没有它的文件，点击查看文献信息'}
                      onClick={() => (file ? p.onOpen(file) : p.onEdit(paper.id))}
                    >
                      <span className="library-paper-title">
                        {picked ? <b>{i + 1}</b> : null}
                        {paper.title}
                        {paper.alias ? <em>{paper.alias}</em> : null}
                      </span>
                      <span className="library-paper-meta">
                        {facts.join(' · ') || '还没有作者和年份'}
                        {paper.status === 'reading' ? <i className="reading">在读</i> : null}
                        {paper.tags.slice(0, 4).map((t) => (
                          <i key={t}>{t}</i>
                        ))}
                        {!file ? <i className="nofile">没有文件</i> : null}
                      </span>
                    </button>
                    <span className="library-files">
                      {paper.files
                        .filter((f) => !paper.gone.includes(f))
                        .slice(0, 3)
                        .map((f) => (
                          <button
                            key={f}
                            type="button"
                            title={`打开 ${f}`}
                            aria-label={`打开 ${fileName(f)}`}
                            onClick={() => p.onOpen(f)}
                          >
                            {fileIcon(f)}
                          </button>
                        ))}
                    </span>
                    <IconButton
                      label={`「${paper.title}」的操作`}
                      aria-haspopup="menu"
                      onClick={(e) =>
                        setMenu({ kind: 'row', at: belowButton(e.currentTarget), paper })
                      }
                    >
                      <MoreHorizontal size={15} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
            {!shown.length ? <p className="library-none">没有符合条件的论文</p> : null}
          </div>
        </>
      ) : (
        <div className="library-empty">
          <BookMarked size={34} />
          <h2>文献库还是空的</h2>
          <p>
            在左边右键一篇文档或一个文件夹，选「加入文献库」；让 AI
            助手找论文并下载，也会自动记进来。
          </p>
          <div>
            <button type="button" className="primary-button" onClick={p.onNew}>
              <Plus size={15} />
              添加论文
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => moreMenu[0].onSelect()}
            >
              导入 BibTeX…
            </button>
          </div>
        </div>
      )}
      {sharing ? <LibraryMcpDialog onClose={() => setSharing(false)} notify={p.notify} /> : null}
      {menu ? (
        <PopupMenu
          at={menu.at}
          label={menu.kind === 'sort' ? '排序' : menu.paper?.title || '文献库'}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'sort'
              ? (Object.keys(sortNames) as Sort[]).map((s) => ({
                  label: (
                    <span className="library-sort-item">
                      {sortNames[s]}
                      {s === sort ? <Check size={13} /> : null}
                    </span>
                  ),
                  onSelect: () => chooseSort(s),
                }))
              : menu.paper
                ? rowMenu(menu.paper)
                : moreMenu
          }
        />
      ) : null}
    </section>
  );
}
const invokeExternal = (url: string) => invoke('external', { url });

// 文献信息: one paper's record, to fill in by hand or from what OpenAlex and arXiv know.
// `target` is a paper of the library, or a new one being added (not kept until saved).
export type PaperTarget =
  { id: string } | { draft: PaperPatch & { title: string; files?: string[] } };
export function PaperDialog(p: {
  target: PaperTarget;
  // The project's documents, to tie more files to the paper.
  files: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
  notify: Notify;
}) {
  const { papers } = useLibrary();
  const existing =
    'id' in p.target ? papers.find((x) => x.id === (p.target as { id: string }).id) : null;
  const start = existing || ('draft' in p.target ? p.target.draft : null);
  const [form, setForm] = useState(() => ({
    title: start?.title || '',
    alias: start?.alias || '',
    authors: (Array.isArray(start?.authors) ? start.authors : []).join('; '),
    year: start?.year ? String(start.year) : '',
    venue: start?.venue || '',
    doi: start?.doi || '',
    arxiv: start?.arxiv || '',
    url: start?.url || '',
    category: start?.category || '',
    tags: (Array.isArray(start?.tags) ? start.tags : []).join('、'),
    summary: start?.summary || '',
    status: (start?.status || 'unread') as PaperStatus,
    readAt: start?.readAt || '',
    files: [...(start?.files || [])],
  }));
  // What a chosen candidate knows beyond the form: its abstract and citations.
  const extra = useRef<PaperPatch>({});
  const [candidates, setCandidates] = useState<PaperCandidate[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const taken = new Set(papers.filter((x) => x.id !== existing?.id).flatMap((x) => x.files));
  const free = p.files.filter((f) => !form.files.includes(f) && !taken.has(f));

  async function lookup() {
    setLooking(true);
    setError('');
    try {
      const { papers: found } = await libraryApi.lookup(lookupFor(form));
      setCandidates(found.slice(0, 4));
      if (!found.length) setError('OpenAlex 和 arXiv 里没有找到这篇，可以换个写法再查，或手动填写');
      return found;
    } catch (e) {
      setError(clean(e));
      return [];
    } finally {
      setLooking(false);
    }
  }
  function use(c: PaperCandidate) {
    const { abstract, citations, ...fields } = fromCandidate(c);
    extra.current = { abstract, citations };
    set({
      title: c.title,
      authors: c.authors.join('; '),
      year: c.year ? String(c.year) : form.year,
      venue: fields.venue || form.venue,
      doi: fields.doi || form.doi,
      arxiv: fields.arxiv || form.arxiv,
      url: fields.url || form.url,
    });
    setCandidates(null);
  }
  // A new paper from a file is looked up at once; a sure match fills the form.
  useEffect(() => {
    if (existing || !form.title.trim()) return;
    void lookup().then((found) => {
      if (found[0] && found[0].match >= 0.9) use(found[0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    const title = form.title.trim();
    if (!title) return setError('需要一个标题');
    const patch: PaperPatch = {
      title,
      alias: form.alias,
      authors: form.authors.split(/[;；\n]+/),
      year: Number(form.year) || 0,
      venue: form.venue,
      doi: form.doi,
      arxiv: form.arxiv,
      url: form.url,
      category: form.category,
      tags: form.tags.split(/[,，、;；]+/),
      summary: form.summary,
      status: form.status,
      ...(form.status === 'done' ? { readAt: form.readAt } : {}),
      ...extra.current,
      files: form.files,
    };
    setBusy(true);
    try {
      if (existing) await libraryApi.update(existing.id, patch);
      else {
        const { created, paper } = await libraryApi.add({ ...patch, title });
        p.notify(
          created ? `已加入文献库：${paper.title}` : `文献库里已有这一篇，已更新：${paper.title}`,
        );
      }
      p.onClose();
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  }
  const field = (
    key: 'alias' | 'authors' | 'venue' | 'doi' | 'arxiv' | 'url' | 'category' | 'tags',
    label: string,
    placeholder = '',
  ) => (
    <label className={`paper-field ${key}`}>
      <span>{label}</span>
      <input
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) p.onClose();
      }}
    >
      <form
        className="dialog paper-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paper-dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) p.onClose();
        }}
      >
        <div className="dialog-heading">
          <h2 id="paper-dialog-title">{existing ? '文献信息' : '加入文献库'}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={p.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="paper-form">
          <label className="paper-field title">
            <span>标题</span>
            <div className="paper-title-row">
              <input
                autoFocus
                value={form.title}
                onChange={(e) => set({ title: e.target.value })}
              />
              <button
                type="button"
                className="secondary-button"
                disabled={looking || !form.title.trim()}
                title="按标题、DOI 或 arXiv 号到 OpenAlex 和 arXiv 查这篇论文"
                onClick={() => void lookup()}
              >
                <Sparkles size={14} />
                {looking ? '正在查…' : '自动补全'}
              </button>
            </div>
          </label>
          {candidates?.length ? (
            <ul className="paper-candidates" aria-label="查到的论文">
              {candidates.map((c, i) => (
                <li key={i}>
                  <button type="button" onClick={() => use(c)}>
                    <strong>{c.title}</strong>
                    <span>
                      {[authorsShort(c), c.year, c.venue, c.citations ? `被引 ${c.citations}` : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {field('authors', '作者', '用分号隔开')}
          <div className="paper-pair">
            <label className="paper-field year">
              <span>年份</span>
              <input
                inputMode="numeric"
                value={form.year}
                onChange={(e) => set({ year: e.target.value.replace(/\D/g, '').slice(0, 4) })}
              />
            </label>
            {field('venue', '出处', '会议或期刊')}
          </div>
          <div className="paper-pair">
            {field('doi', 'DOI')}
            {field('arxiv', 'arXiv', '如 1706.03762')}
          </div>
          {field('alias', '别名', '中文译名或通用简称')}
          <div className="paper-pair">
            {field('category', '分类', '层级用 / 分开；不填就按所在文件夹')}
            {field('tags', '标签', '用顿号隔开')}
          </div>
          <label className="paper-field summary">
            <span>一句话总结</span>
            <textarea
              rows={2}
              value={form.summary}
              onChange={(e) => set({ summary: e.target.value })}
            />
          </label>
          <div className="paper-field">
            <span>阅读状态</span>
            <div className="paper-status">
              {(['unread', 'reading', 'done'] as PaperStatus[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={form.status === s ? 'selected' : ''}
                  onClick={() =>
                    set({ status: s, readAt: s === 'done' ? form.readAt || today() : '' })
                  }
                >
                  {statusName[s]}
                </button>
              ))}
              {form.status === 'done' ? (
                <input
                  type="date"
                  aria-label="读完的日期"
                  value={form.readAt}
                  max={today()}
                  onChange={(e) => set({ readAt: e.target.value })}
                />
              ) : null}
            </div>
          </div>
          <div className="paper-field">
            <span>文件</span>
            <ul className="paper-files">
              {form.files.map((f) => (
                <li key={f} className={existing?.gone.includes(f) ? 'gone' : ''}>
                  <button
                    type="button"
                    title={existing?.gone.includes(f) ? '这个文件已经不在项目里了' : `打开 ${f}`}
                    onClick={() => {
                      p.onOpen(f);
                      p.onClose();
                    }}
                  >
                    {fileIcon(f)}
                    {f}
                  </button>
                  <IconButton
                    label={`不再关联 ${fileName(f)}`}
                    onClick={() => set({ files: form.files.filter((x) => x !== f) })}
                  >
                    <X size={13} />
                  </IconButton>
                </li>
              ))}
              {free.length ? (
                <li>
                  <select
                    aria-label="关联项目里的文件"
                    value=""
                    onChange={(e) =>
                      e.target.value && set({ files: [...form.files, e.target.value] })
                    }
                  >
                    <option value="">关联项目里的文件…</option>
                    {free.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </li>
              ) : !form.files.length ? (
                <li className="none">项目里还没有它的文件</li>
              ) : null}
            </ul>
          </div>
        </div>
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          {existing ? (
            <button
              type="button"
              className="paper-remove"
              disabled={busy}
              onClick={async () => {
                if (!confirmRemove) return setConfirmRemove(true);
                await libraryApi.remove([existing.id]).catch((e) => p.notify(clean(e), true));
                p.onClose();
              }}
            >
              {confirmRemove ? '再点一次移出（文件不动）' : '移出文献库'}
            </button>
          ) : null}
          <button type="button" className="secondary-button" disabled={busy} onClick={p.onClose}>
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? '保存中…' : existing ? '保存' : '加入文献库'}
          </button>
        </div>
      </form>
    </div>
  );
}

// 让其他 AI 工具读文献库: the library over MCP for tools on this computer, off until turned on
// here (electron/library-mcp.cjs).
function LibraryMcpDialog(p: { onClose: () => void; notify: Notify }) {
  const [state, setState] = useState<{ enabled: boolean; url: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = (payload: { enabled?: boolean; renew?: boolean } = {}) => {
    setBusy(true);
    // The switch moves at once; the address comes when the answer does.
    if (typeof payload.enabled === 'boolean')
      setState((now) => (now ? { ...now, enabled: payload.enabled!, url: '', error: '' } : now));
    invoke<{ enabled: boolean; url: string; error: string }>('library-mcp', payload)
      .then(setState)
      .catch((e) => p.notify(clean(e), true))
      .finally(() => setBusy(false));
  };
  useEffect(() => ask(), []);
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => p.notify(`已复制${what}`),
      () => p.notify('没有复制成功', true),
    );
  const url = state?.url || '';
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div
        className="dialog library-mcp"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-mcp-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') p.onClose();
        }}
      >
        <div className="dialog-heading">
          <h2 id="library-mcp-title">让其他 AI 工具读文献库</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={p.onClose}>
            <X size={18} />
          </button>
        </div>
        <p>
          打开后，这台电脑上支持 MCP 的 AI 工具（OpenScience、Claude Code
          等）可以查你的文献库：有哪些论文、读没读过、你划的重点和笔记；也可以把它们找到的论文记进来。它们改不了阅读状态。
        </p>
        <label className="library-mcp-switch">
          <input
            type="checkbox"
            checked={!!state?.enabled}
            disabled={busy || !state}
            onChange={(e) => ask({ enabled: e.target.checked })}
          />
          允许这台电脑上的其他 AI 工具读文献库
        </label>
        {state?.error ? (
          <p className="dialog-error" role="alert">
            {state.error}
          </p>
        ) : null}
        {state?.enabled && url ? (
          <>
            <div className="library-mcp-url">
              <code>{url}</code>
              <button type="button" className="secondary-button" onClick={() => copy(url, '地址')}>
                复制
              </button>
            </div>
            <p className="library-mcp-how">
              在那个工具里添加一个 MCP 服务器，类型选 HTTP（Streamable
              HTTP），地址填上面这个。Claude Code 里是：
            </p>
            <div className="library-mcp-url">
              <code>claude mcp add --transport http folio {url}</code>
              <button
                type="button"
                className="secondary-button"
                onClick={() => copy(`claude mcp add --transport http folio ${url}`, '命令')}
              >
                复制
              </button>
            </div>
            <p className="library-mcp-how">
              页间开着、并且打开了项目时才查得到。地址只在这台电脑上有效，别发给别人；
              <button type="button" disabled={busy} onClick={() => ask({ renew: true })}>
                换一个地址
              </button>
              后旧的立刻失效。
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
