import type { Annotation } from '../types';
import type { AiHost } from './host';
import type { AgentPreview, DocText, Paper, ToolDef } from './types';
import { docBody, fileName } from './context';
import { annotationsList } from './prompts';
import { applyEdits } from './edits';

export const agentColors: Record<string, string> = {
  yellow: '#d49b00',
  red: '#d93b4b',
  teal: '#087f72',
  blue: '#2864d7',
  purple: '#7a5bd6',
  ink: '#172033',
};

export const agentTools: ToolDef[] = [
  {
    name: 'list_files',
    description: '列出项目中所有 HTML 和 PDF 文档的路径。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search',
    description:
      '在项目文档的正文中搜索关键词（多个词用空格分开，全部出现才算匹配），返回所在文档、页码和上下文片段。可以用 path 只搜一篇。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的关键词' },
        path: { type: 'string', description: '可选，只在这篇文档中搜索' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_document',
    description:
      '读取一篇文档的正文。长文档分段读取：offset 是起始字符位置，length 是字数（默认 12000，最多 30000）。PDF 也可以用 pages 指定页码范围，如 "3-5"。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 500, maximum: 30000 },
        pages: { type: 'string', description: '仅 PDF，例如 "1-3" 或 "7"' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_annotations',
    description: '读取用户在一篇文档中做的批注（高亮原文及笔记）和整篇文档的笔记。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_highlights',
    description:
      '在文档中添加高亮批注（需要用户确认）。quote 必须从文档逐字复制；note 是附在高亮上的笔记；color 可选。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              quote: { type: 'string' },
              note: { type: 'string' },
              color: { type: 'string', enum: Object.keys(agentColors) },
            },
            required: ['quote'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_note',
    description:
      '写入一篇文档的“文档笔记”（Markdown，需要用户确认）。mode 为 append（默认，追加到末尾）或 replace（替换全部）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['append', 'replace'] },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_html',
    description:
      '修改一个 HTML 文件（需要用户确认）。edits 中每项的 find 必须从文件逐字复制且只出现一次，replace 是替换后的内容。修改前先用 read_html_source 查看源码。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_html_source',
    description: '读取 HTML 文件的源码（含标签），用于修改前查看。offset/length 同 read_document。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 500, maximum: 40000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_html',
    description:
      '在项目中新建一个 HTML 文件（需要用户确认）。path 以 .html 结尾，文件不能已存在；content 是完整的 HTML。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_document',
    description: '在阅读区为用户打开一篇文档。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_papers',
    description:
      '在 OpenAlex（各学科的学术论文库）和 arXiv（预印本）中查找论文，返回标题、作者、年份、出处、被引次数、摘要和公开 PDF 链接。关键词用英文效果最好。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '主题或标题关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回几篇，默认 8' },
        from_year: { type: 'integer', description: '可选，只要这一年及以后发表的' },
        pdf_only: { type: 'boolean', description: '只要有公开 PDF 的论文，准备下载时用' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_pdf',
    description:
      '把论文的 PDF 下载到项目中（需要用户确认）。url 用 search_papers 给出的 PDF 链接；path 是项目内的目标路径，以 .pdf 结尾，文件夹不存在时会自动新建；title 是论文标题，给用户确认时看。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        path: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['url', 'path', 'title'],
      additionalProperties: false,
    },
  },
];

// The open document(s) only, for a long one the reading conversation holds just the start of.
export const readingTools: ToolDef[] = [
  {
    name: 'search',
    description:
      '在正在阅读的文档中搜索关键词（多个词用空格分开，全部出现才算匹配），返回页码和上下文片段。有多篇时可以用 path 只搜一篇。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的关键词' },
        path: { type: 'string', description: '可选，只在这篇文档中搜索' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_document',
    description:
      '读取正在阅读的文档的一部分。offset 是起始字符位置，length 是字数（默认 12000，最多 30000）。PDF 也可以用 pages 指定页码范围，如 "3-5"。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 500, maximum: 30000 },
        pages: { type: 'string', description: '仅 PDF，例如 "1-3" 或 "7"' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

export const writeTools = new Set([
  'add_highlights',
  'write_note',
  'edit_html',
  'create_html',
  'save_pdf',
]);

export type ToolOutcome = { content: string; isError?: boolean; detail?: string };
export type PreparedTool = {
  title: string;
  // Read tools run at once; write tools show a preview and wait for the user.
  preview?: AgentPreview;
  run: () => Promise<ToolOutcome>;
};
type Context = {
  host: AiHost;
  text: (path: string) => Promise<DocText>;
  progress: (detail: string) => void;
  // Looking things up in the open documents (readingTools), which has no list_files.
  reading?: boolean;
};

const fail = (content: string): ToolOutcome => ({ content, isError: true, detail: content });
function cleanPath(value: unknown) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '');
}
// A name the model picks for a new file, made one Windows can store: a colon there would
// write into a hidden stream of another file. “BERT: Pre-training” becomes “BERT - Pre-training”.
function newPath(value: unknown) {
  const path = cleanPath(value);
  if (window.folio?.platform !== 'win32') return path;
  return path
    .split('/')
    .map((name) =>
      name
        .replace(/\s*:\s*/g, ' - ')
        .replace(/[<>"|?*\x00-\x1f]/g, '')
        .replace(/[. ]+$/, ''),
    )
    .join('/');
}
function existing(host: AiHost, value: unknown, reading = false) {
  const path = cleanPath(value);
  const files = host.files();
  const hit = files.find((f) => f.path === path) || files.find((f) => fileName(f.path) === path);
  if (hit) return hit;
  const near = files
    .filter((f) => f.path.includes(fileName(path).replace(/\.\w+$/, '')))
    .slice(0, 5)
    .map((f) => f.path);
  const hint = near.length
    ? `你是不是指：${near.join('、')}？`
    : reading
      ? `正在阅读的文档是：${files.map((f) => f.path).join('、')}。`
      : '可以先用 list_files 查看路径。';
  throw Error(`找不到文档 ${path}。${hint}`);
}
const title = (path: string) => `《${fileName(path)}》`;
function pageRange(spec: string, total: number) {
  const m = String(spec).match(/^\s*(\d+)\s*(?:[-–~至]\s*(\d+))?\s*$/);
  if (!m) return null;
  const from = Math.max(1, Number(m[1]));
  const to = Math.min(total, Number(m[2] || m[1]));
  return from <= to ? { from, to } : null;
}

export function prepareTool(name: string, input: any, ctx: Context): PreparedTool {
  const { host } = ctx;
  if (input && typeof input === 'object' && '__invalid' in input)
    return {
      title: `调用 ${name}`,
      run: async () => fail('工具参数不是有效的 JSON，请重新生成参数。'),
    };
  switch (name) {
    case 'list_files':
      return {
        title: '查看文档列表',
        run: async () => {
          const files = host.files();
          return {
            content: files.length
              ? files.map((f) => `${f.path}（${f.kind.toUpperCase()}）`).join('\n')
              : '项目中没有 HTML 或 PDF 文档。',
            detail: `${files.length} 篇文档`,
          };
        },
      };
    case 'search': {
      const query = String(input?.query || '').trim();
      return {
        title: `搜索“${query.slice(0, 30)}”`,
        run: async () => {
          if (!query) return fail('请提供搜索关键词。');
          const scope = input?.path ? [existing(host, input.path, ctx.reading)] : host.files();
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const results: string[] = [];
          let docs = 0;
          for (const [i, f] of scope.entries()) {
            ctx.progress(`正在检索 ${i + 1}/${scope.length}：${fileName(f.path)}`);
            let doc: DocText;
            try {
              doc = await ctx.text(f.path);
            } catch {
              continue;
            }
            const hits = searchText(doc, words).slice(0, 5);
            if (hits.length) docs++;
            for (const hit of hits) results.push(`- ${f.path}${hit}`);
            if (results.length >= 40) break;
          }
          return {
            content: results.length
              ? `找到 ${results.length} 处（${docs} 篇文档）：\n${results.join('\n')}`
              : `没有找到包含“${query}”的内容。可以换个说法或只用一个关键词再试。`,
            detail: results.length ? `${docs} 篇文档中找到 ${results.length} 处` : '没有找到',
          };
        },
      };
    }
    case 'read_document': {
      return {
        title: `阅读${title(cleanPath(input?.path))}${input?.pages ? `第 ${input.pages} 页` : ''}`,
        run: async () => {
          const file = existing(host, input?.path, ctx.reading);
          ctx.progress('正在载入文档…');
          const doc = await ctx.text(file.path);
          let body = docBody(doc);
          let head = '';
          if (input?.pages && doc.pages) {
            const range = pageRange(input.pages, doc.pages.length);
            if (!range) return fail(`页码范围无效，这篇 PDF 共 ${doc.pages.length} 页。`);
            body = doc.pages
              .slice(range.from - 1, range.to)
              .map((p, i) => `[第 ${range.from + i} 页]\n${p}`)
              .join('\n\n');
            head = `《${doc.title || fileName(doc.path)}》第 ${range.from}–${range.to} 页（共 ${doc.pages.length} 页）。`;
            body = body.slice(0, 40_000);
          } else {
            const offset = Math.max(0, Number(input?.offset) || 0);
            const length = Math.min(30_000, Math.max(500, Number(input?.length) || 12_000));
            const end = Math.min(body.length, offset + length);
            head = `《${doc.title || fileName(doc.path)}》共 ${body.length} 字${doc.pages ? `、${doc.pages.length} 页` : ''}，本次为第 ${offset}–${end} 字${end < body.length ? `，后面还有内容，可用 offset=${end} 继续读取` : '（已到结尾）'}。`;
            body = body.slice(offset, end);
          }
          if (!body.trim())
            return {
              content: `${head}\n（没有可读取的文字。${doc.kind === 'pdf' ? '这可能是扫描版 PDF，没有文字层。' : ''}）`,
              detail: '没有文字',
            };
          return { content: `${head}\n\n${body}`, detail: head.replace(/^《[^》]*》/, '') };
        },
      };
    }
    case 'read_html_source':
      return {
        title: `查看${title(cleanPath(input?.path))}的源码`,
        run: async () => {
          const file = existing(host, input?.path);
          if (file.kind !== 'html') return fail('只有 HTML 文件有源码。');
          const { source } = await host.documentData(file.path);
          const offset = Math.max(0, Number(input?.offset) || 0);
          const length = Math.min(40_000, Math.max(500, Number(input?.length) || 20_000));
          const end = Math.min(source.length, offset + length);
          return {
            content: `${file.path} 源码共 ${source.length} 字符，本次为第 ${offset}–${end} 字符${end < source.length ? `，可用 offset=${end} 继续` : '（已到结尾）'}：\n\n${source.slice(offset, end)}`,
            detail: `${source.length} 字符`,
          };
        },
      };
    case 'read_annotations':
      return {
        title: `查看${title(cleanPath(input?.path))}的批注`,
        run: async () => {
          const file = existing(host, input?.path);
          const { data } = await host.documentData(file.path);
          const list = annotationsList(data.annotations);
          return {
            content:
              (list ? `批注：\n${list}` : '这篇文档还没有文字批注。') +
              (data.note.trim()
                ? `\n\n文档笔记：\n${data.note.slice(0, 20_000)}`
                : '\n\n（没有文档笔记）'),
            detail: `${data.annotations.length} 条批注`,
          };
        },
      };
    case 'search_papers': {
      const query = String(input?.query || '').trim();
      return {
        title: `查找论文“${query.length > 40 ? `${query.slice(0, 40)}…` : query}”`,
        run: async () => {
          if (!query) return fail('请提供搜索关键词。');
          ctx.progress('正在查找…');
          const { papers, notes } = await host.searchPapers({
            query,
            limit: Number(input?.limit) || undefined,
            fromYear: Number(input?.from_year) || undefined,
            pdfOnly: !!input?.pdf_only,
          });
          const note = notes.length ? `\n\n（${notes.join('；')}，只有另一个库的结果。）` : '';
          if (!papers.length)
            return {
              content: `没有找到相关论文。可以换用英文关键词或更宽泛的说法再试。${note}`,
              detail: '没有找到',
            };
          const withPdf = papers.filter((p) => p.pdf.length).length;
          return {
            content: `找到 ${papers.length} 篇（${withPdf} 篇有公开 PDF）：\n\n${paperList(papers)}${note}`,
            detail: `找到 ${papers.length} 篇，${withPdf} 篇有 PDF`,
          };
        },
      };
    }
    case 'open_document':
      return {
        title: `打开${title(cleanPath(input?.path))}`,
        run: async () => {
          const file = existing(host, input?.path);
          await host.open(file.path);
          return { content: `已在阅读区打开 ${file.path}。` };
        },
      };
    case 'add_highlights':
      return prepareHighlights(input, ctx);
    case 'write_note':
      return prepareNote(input, ctx);
    case 'edit_html':
      return prepareEdit(input, ctx);
    case 'create_html':
      return prepareCreate(input, ctx);
    case 'save_pdf':
      return prepareSave(input, ctx);
  }
  return { title: `未知工具 ${name}`, run: async () => fail(`没有名为 ${name} 的工具。`) };
}

function paperList(papers: Paper[]) {
  return papers
    .map((p, i) => {
      const authors =
        p.authors.length > 3 ? `${p.authors.slice(0, 3).join(', ')} 等` : p.authors.join(', ');
      const cited = p.citations === undefined ? '' : `被引 ${p.citations}`;
      const ids = [p.doi && `DOI ${p.doi}`, p.arxiv && `arXiv ${p.arxiv}`].filter(Boolean);
      const abstract = p.abstract.length > 400 ? `${p.abstract.slice(0, 400)}…` : p.abstract;
      return [
        `${i + 1}. ${p.title}`,
        `   ${[authors, p.year, p.venue, cited].filter(Boolean).join(' · ')}`,
        ids.length ? `   ${ids.join(' · ')}` : '',
        `   PDF：${p.pdf.length ? p.pdf.slice(0, 3).join(' ， ') : '没有公开 PDF'}`,
        `   页面：${p.url}`,
        abstract ? `   摘要：${abstract}` : '',
      ]
        .filter((line) => line.trim())
        .join('\n');
    })
    .join('\n\n');
}

function searchText(doc: DocText, words: string[]) {
  const hits: string[] = [];
  const segments = doc.pages
    ? doc.pages.flatMap((p, i) => p.split(/\n{2,}|\n(?=\S)/).map((s) => ({ s, page: i + 1 })))
    : doc.text.split('\n').map((s) => ({ s, page: 0 }));
  for (const { s, page } of segments) {
    const lower = s.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const at = lower.indexOf(words[0]);
    const start = Math.max(0, at - 70);
    const snippet =
      (start > 0 ? '…' : '') +
      s.slice(start, start + 200).replace(/\s+/g, ' ') +
      (start + 200 < s.length ? '…' : '');
    hits.push(`${page ? `（第 ${page} 页）` : ''}：${snippet}`);
  }
  return hits;
}

// A placeholder `run` until the preview is ready; prepare() resolves both.
type Deferred = PreparedTool & { prepare?: () => Promise<void> };

function prepareHighlights(input: any, ctx: Context): Deferred {
  const path = cleanPath(input?.path);
  const items: { quote: string; note: string; color: string }[] = (
    Array.isArray(input?.items) ? input.items : []
  )
    .filter((i: any) => typeof i?.quote === 'string' && i.quote.trim())
    .slice(0, 40)
    .map((i: any) => ({
      quote: i.quote.trim(),
      note: typeof i.note === 'string' ? i.note.trim() : '',
      color: agentColors[i.color] || agentColors.yellow,
    }));
  const tool: Deferred = {
    title: `在${title(path)}中添加 ${items.length} 处高亮`,
    run: async () => fail('没有可添加的高亮。'),
  };
  tool.prepare = async () => {
    const file = existing(ctx.host, path);
    if (!items.length) return;
    ctx.progress('正在定位原文…');
    const anchors = await ctx.host.anchors(
      file.path,
      items.map((i) => i.quote),
    );
    const found = items.map((item, i) => ({ ...item, found: !!anchors[i] }));
    tool.preview = { kind: 'highlights', path: file.path, items: found };
    const missing = found.filter((i) => !i.found);
    tool.run = async () => {
      const annotations: Annotation[] = [];
      anchors.forEach((anchor, i) => {
        if (anchor)
          annotations.push({
            id: crypto.randomUUID(),
            type: 'highlight',
            color: items[i].color,
            quote: anchor,
            note: items[i].note,
            createdAt: Date.now(),
            by: 'ai',
          });
      });
      if (!annotations.length)
        return fail(
          `所有原文都没有在文档中找到，请从 read_document 的结果中逐字复制句子：\n${missing.map((m) => `- ${m.quote}`).join('\n')}`,
        );
      await ctx.host.addAnnotations(file.path, annotations);
      return {
        content:
          `已添加 ${annotations.length} 处高亮。` +
          (missing.length
            ? `\n以下 ${missing.length} 处没有在原文中找到，未添加：\n${missing.map((m) => `- ${m.quote}`).join('\n')}`
            : ''),
        detail: `已添加 ${annotations.length} 处${missing.length ? `，${missing.length} 处未找到` : ''}`,
      };
    };
  };
  return tool;
}

function prepareNote(input: any, ctx: Context): Deferred {
  const path = cleanPath(input?.path);
  const content = typeof input?.content === 'string' ? input.content.trim() : '';
  const replace = input?.mode === 'replace';
  const tool: Deferred = {
    title: `${replace ? '改写' : '写入'}${title(path)}的笔记`,
    run: async () => fail('笔记内容为空。'),
  };
  tool.prepare = async () => {
    const file = existing(ctx.host, path);
    if (!content) return;
    const { data } = await ctx.host.documentData(file.path);
    const before = data.note;
    const after = replace || !before.trim() ? content : `${before.trimEnd()}\n\n${content}`;
    tool.preview = { kind: 'note', path: file.path, before, after };
    tool.run = async () => {
      await ctx.host.setNote(file.path, after);
      return { content: `已${replace ? '替换' : '追加'}文档笔记。`, detail: '笔记已更新' };
    };
  };
  return tool;
}

function prepareEdit(input: any, ctx: Context): Deferred {
  const path = cleanPath(input?.path);
  const edits = (Array.isArray(input?.edits) ? input.edits : []).filter(
    (e: any) => typeof e?.find === 'string' && typeof e?.replace === 'string',
  );
  const tool: Deferred = {
    title: `修改 ${fileName(path)}`,
    run: async () => fail('没有有效的修改。'),
  };
  tool.prepare = async () => {
    const file = existing(ctx.host, path);
    if (file.kind !== 'html') {
      tool.run = async () => fail('只能修改 HTML 文件。');
      return;
    }
    const { source } = await ctx.host.documentData(file.path);
    const result = applyEdits(source, edits);
    if (!result.applied) {
      tool.run = async () =>
        fail(
          `没有一处修改能对上原文件，请先用 read_html_source 查看源码，再逐字复制 find：\n${result.failed.join('\n')}`,
        );
      return;
    }
    tool.preview = { kind: 'source', path: file.path, before: source, after: result.source };
    tool.run = async () => {
      const { saved } = await ctx.host.setSource(file.path, result.source);
      return {
        content:
          `已修改 ${file.path}（${result.applied} 处）${saved ? '并保存，修改前的版本已自动备份' : '，已写入编辑器，尚未保存'}。` +
          (result.failed.length
            ? `\n以下修改没有对上原文，未应用：\n${result.failed.join('\n')}`
            : ''),
        detail: `${result.applied} 处修改${result.failed.length ? `，${result.failed.length} 处未对上` : ''}`,
      };
    };
  };
  return tool;
}

function prepareCreate(input: any, ctx: Context): Deferred {
  const path = newPath(input?.path);
  const content = typeof input?.content === 'string' ? input.content : '';
  const tool: Deferred = { title: `新建 ${path}`, run: async () => fail('内容为空。') };
  tool.prepare = async () => {
    if (!/\.html?$/i.test(path)) {
      tool.run = async () => fail('文件名必须以 .html 结尾。');
      return;
    }
    if (ctx.host.files().some((f) => f.path === path)) {
      tool.run = async () => fail(`${path} 已存在。请换一个文件名，或用 edit_html 修改它。`);
      return;
    }
    if (!content.trim()) return;
    tool.preview = { kind: 'create', path, content };
    tool.run = async () => {
      await ctx.host.createHtml(path, content);
      return { content: `已新建 ${path}。`, detail: '已新建' };
    };
  };
  return tool;
}

function prepareSave(input: any, ctx: Context): Deferred {
  const path = newPath(input?.path);
  const url = String(input?.url ?? '').trim();
  const tool: Deferred = { title: `保存 PDF 到 ${path}`, run: async () => fail('没有下载链接。') };
  tool.prepare = async () => {
    if (!/\.pdf$/i.test(path)) {
      tool.run = async () => fail('文件名必须以 .pdf 结尾。');
      return;
    }
    if (ctx.host.files().some((f) => f.path === path)) {
      tool.run = async () => fail(`${path} 已存在，请换一个文件名。`);
      return;
    }
    if (!/^https?:\/\//i.test(url)) return;
    tool.preview = { kind: 'download', path, url, title: String(input?.title ?? '').trim() };
    tool.run = async () => {
      ctx.progress('正在下载…');
      const bytes = await ctx.host.savePdf(url, path);
      const size = `${Math.max(0.1, bytes / 1048576).toFixed(1)} MB`;
      return { content: `已保存到 ${path}（${size}）。`, detail: `已保存，${size}` };
    };
  };
  return tool;
}
