// 文献库对外：这台电脑上的其他 AI 工具（OpenScience、Claude Code、Codex……）通过 MCP 读页间的
// 文献库。它们本来就能读项目文件夹里的文件；页间多告诉它们的，是只有页间知道的东西：哪些论文
// 读过、哪天读完的、读者在上面划了什么、写了什么。它们也可以把找到的论文记进文献库、补充信息，
// 但改不了阅读状态：读没读过只由读者自己说。
//
// 默认关闭。打开后只监听 127.0.0.1，地址里带一段随机口令（存在页间的设置里，重启不变，这样别的
// 工具里填一次就行）。用的是 MCP 的 Streamable HTTP：一个 POST 一问一答，不保持连接。
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const FIRST_PORT = 47318;
const statusName = { unread: '未读', reading: '在读', done: '已读' };

const TOOLS = [
  {
    name: 'list_papers',
    description:
      "List the papers in the library of the project open in Folio (页间): title, authors, year, venue, reading status (and the day it was finished), tags, category, the reader's one-line summary, and its files in the project folder. Use it to see what the reader has, has read, or has not read yet. Filter by `query` (words in title, authors, venue, tags, category, summary), `status` or `tag`.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        status: { type: 'string', enum: ['unread', 'reading', 'done'] },
        tag: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 60' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_paper',
    description:
      "One paper of the library in full: its record, abstract, the reader's summary and notes, and for each of its files the passages the reader highlighted (with what they wrote on them) and the document note. `id` is the one list_papers shows.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_paper',
    description:
      "Record a paper in the library, e.g. one you found or downloaded into the project folder. If it is already there (same DOI, arXiv number or title) only its empty fields are filled. `files` are paths of documents (PDF, HTML, Markdown) inside the project folder. The reading status cannot be set: that is the reader's to say.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        authors: { type: 'array', items: { type: 'string' } },
        year: { type: 'integer' },
        venue: { type: 'string' },
        doi: { type: 'string' },
        arxiv: { type: 'string' },
        url: { type: 'string' },
        abstract: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string', description: 'Levels divided by "/"' },
        summary: { type: 'string', description: 'A few sentences on what it shows' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_paper',
    description:
      'Change the record of a paper already in the library: only the fields given are replaced. `files` adds documents of the project folder to the paper (a report you wrote about it, say). The reading status cannot be changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        authors: { type: 'array', items: { type: 'string' } },
        year: { type: 'integer' },
        venue: { type: 'string' },
        doi: { type: 'string' },
        arxiv: { type: 'string' },
        url: { type: 'string' },
        abstract: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string' },
        summary: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
const FIELDS = [
  'title',
  'authors',
  'year',
  'venue',
  'doi',
  'arxiv',
  'url',
  'abstract',
  'tags',
  'category',
  'summary',
];

function createLibraryMcp({ library, workspace, version, onChange }) {
  let server = null;
  let port = 0;
  let token = '';

  const project = () => {
    if (!workspace.root) throw Error('No project is open in Folio (页间). Open one there first.');
    return workspace;
  };
  // A file as the library keeps it: relative to the project, "/" between folders.
  const relative = (file) => {
    const text = String(file || '');
    const full = path.isAbsolute(text) ? text : path.join(workspace.root, text);
    return path.relative(workspace.root, full).split(path.sep).join('/');
  };
  const pick = (args) => {
    const out = {};
    for (const key of FIELDS) if (args?.[key] !== undefined) out[key] = args[key];
    return out;
  };
  async function byId(value) {
    const id = String(value || '').trim();
    const { papers } = await library.list(project());
    const found =
      papers.find((p) => p.id === id) ||
      (id.length >= 6 && papers.filter((p) => p.id.startsWith(id)).length === 1
        ? papers.find((p) => p.id.startsWith(id))
        : null);
    if (!found)
      throw Error(`No paper with id ${id} in the library. Use list_papers to see the ids.`);
    return found;
  }
  const line = (p) => {
    const read =
      p.status === 'done' ? `已读${p.readAt ? ` ${p.readAt}` : ''}` : statusName[p.status];
    const files = p.files.filter((f) => !p.gone.includes(f));
    return [
      `[${p.id.slice(0, 8)}] ${p.title}${p.alias ? `（${p.alias}）` : ''} — ${[p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : ''), p.year || '', p.venue].filter(Boolean).join(' · ') || 'no authors or year yet'} — ${read}`,
      [
        p.tags.length ? `tags: ${p.tags.join(', ')}` : '',
        p.category ? `category: ${p.category}` : '',
        p.doi ? `doi: ${p.doi}` : '',
        p.arxiv ? `arXiv: ${p.arxiv}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      files.length ? `files: ${files.join(', ')}` : 'no file in the project',
      p.summary ? `summary: ${p.summary.replace(/\s+/g, ' ').slice(0, 400)}` : '',
    ]
      .filter(Boolean)
      .join('\n   ');
  };

  async function call(name, args) {
    switch (name) {
      case 'list_papers': {
        const { papers, lists } = await library.list(project());
        const count = (s) => papers.filter((p) => p.status === s).length;
        const words = String(args?.query || '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const tag = String(args?.tag || '').toLowerCase();
        const matched = papers.filter((p) => {
          if (args?.status && p.status !== args.status) return false;
          if (tag && !p.tags.some((t) => t.toLowerCase() === tag)) return false;
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
          return words.every((w) => hay.includes(w));
        });
        const offset = Math.max(0, Math.round(Number(args?.offset)) || 0);
        const limit = Math.min(200, Math.max(1, Math.round(Number(args?.limit)) || 60));
        const shown = matched.slice(offset, offset + limit);
        const rest = matched.length - offset - shown.length;
        return [
          `Project "${path.basename(workspace.root)}" at ${workspace.root}`,
          `Library: ${papers.length} papers — ${count('done')} read (已读), ${count('reading')} being read (在读), ${count('unread')} unread (未读).${matched.length === papers.length ? '' : ` ${matched.length} match.`}`,
          '',
          ...shown.map((p, i) => `${offset + i + 1}. ${line(p)}`),
          rest > 0 ? `\n… ${rest} more: call again with offset ${offset + shown.length}.` : '',
          ...lists.map(
            (l) =>
              `\nReading list "${l.name}" (${l.papers.length}, in order): ${l.papers.map((id) => `[${id.slice(0, 8)}]`).join(' ')}`,
          ),
        ]
          .filter((s) => s !== '')
          .join('\n');
      }
      case 'get_paper': {
        const detail = await library.detail(project(), (await byId(args?.id)).id);
        const docs = detail.documents.map((d) =>
          [
            `File ${d.path}`,
            d.highlights?.length
              ? `Highlighted by the reader:\n${d.highlights.map((h) => `- "${h.text}"${h.note ? `\n  note: ${h.note}` : ''}`).join('\n')}`
              : 'Nothing highlighted in it.',
            d.notes?.length ? `Sticky notes:\n${d.notes.map((n) => `- ${n}`).join('\n')}` : '',
            d.note?.trim() ? `Document note:\n${d.note.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return [
          `Project folder: ${workspace.root}`,
          line(detail),
          detail.url ? `url: ${detail.url}` : '',
          detail.abstract ? `\nAbstract:\n${detail.abstract}` : '',
          detail.note ? `\nThe reader's notes on the paper:\n${detail.note}` : '',
          ...docs.map((d) => `\n${d}`),
        ]
          .filter(Boolean)
          .join('\n');
      }
      case 'add_paper': {
        project();
        const { paper, created } = await library.add(workspace, {
          ...pick(args),
          files: (Array.isArray(args?.files) ? args.files : []).map(relative),
        });
        onChange?.();
        return `${created ? 'Added to the library' : 'Already in the library; its empty fields were filled'}: [${paper.id.slice(0, 8)}] ${paper.title}${paper.files.length ? ` (files: ${paper.files.join(', ')})` : ''}`;
      }
      case 'update_paper': {
        const paper = await byId(args?.id);
        const patch = pick(args);
        if (Array.isArray(args?.files)) patch.files = [...paper.files, ...args.files.map(relative)];
        if (!Object.keys(patch).length) throw Error('Nothing to change: give at least one field.');
        const updated = await library.update(workspace, paper.id, patch);
        onChange?.();
        return `Updated: [${updated.id.slice(0, 8)}] ${updated.title}`;
      }
    }
    throw Error(`Unknown tool: ${name}`);
  }

  async function serve(req, res) {
    const given = String(req.url || '').match(/^\/mcp\/([\w-]+)\/?$/)?.[1] || '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    // Only this computer's own name for itself: a web page elsewhere made to resolve here
    // (DNS rebinding) is refused, as is anyone without the address's secret part.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (
      !['127.0.0.1', 'localhost'].includes(host) ||
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    )
      return void res.writeHead(404).end();
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end();
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) return void res.writeHead(413).end();
    }
    let m;
    try {
      m = JSON.parse(body);
    } catch {
      return void res.writeHead(400).end();
    }
    // Notifications need no answer.
    if (!m || typeof m !== 'object' || m.id === undefined) return void res.writeHead(202).end();
    const reply = (message) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...message }));
    };
    switch (m.method) {
      case 'initialize':
        return reply({
          result: {
            protocolVersion: m.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'folio-library', title: '页间 Folio · 文献库', version },
            instructions:
              "The reader's paper library in Folio (页间), a reading app: which papers they have, which they have read, and what they highlighted and noted while reading. Read it before reviewing literature for them; record papers you find with add_paper.",
          },
        });
      case 'ping':
        return reply({ result: {} });
      case 'tools/list':
        return reply({ result: { tools: TOOLS } });
      case 'tools/call':
        try {
          const text = await call(m.params?.name, m.params?.arguments || {});
          return reply({ result: { content: [{ type: 'text', text }] } });
        } catch (e) {
          return reply({
            result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true },
          });
        }
    }
    return reply({ error: { code: -32601, message: `Method not found: ${m.method}` } });
  }

  // Listens with this secret: on the port asked for, or the first free one after it.
  async function start({ secret, preferred = FIRST_PORT }) {
    await stop();
    token = secret;
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = preferred + attempt;
      const listening = http.createServer(
        (req, res) => void serve(req, res).catch(() => res.writeHead(500).end()),
      );
      const ok = await new Promise((resolve) => {
        listening.once('error', () => resolve(false));
        listening.listen(candidate, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        server = listening;
        port = candidate;
        return port;
      }
    }
    throw Error('没有找到可用的端口');
  }
  async function stop() {
    const closing = server;
    server = null;
    port = 0;
    if (closing) await new Promise((resolve) => closing.close(resolve));
  }
  return {
    start,
    stop,
    url: () => (server ? `http://127.0.0.1:${port}/mcp/${token}` : ''),
    // For tests.
    call,
  };
}

module.exports = { createLibraryMcp, TOOLS, FIRST_PORT };
