import { invoke } from '../api';
import type { PreparedTool, ToolOutcome } from '../ai/agent-tools';
import type { ToolDef } from '../ai/types';

// The two tools a plugin reaches the web with. Only the sites its folio-plugin.json names can
// be read; electron/plugins.cjs checks every address, redirects included.
export const webTools: ToolDef[] = [
  {
    name: 'fetch_url',
    description:
      '读取一个网页或数据接口（只能访问插件允许的网站）。网页转成文字，链接写成 [文字](网址)；JSON 和 XML 原样返回。内容长时分段读取：offset 是起始字符位置，length 是字数（默认 12000，最多 30000）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https 网址' },
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 500, maximum: 30000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_feed',
    description:
      '读取 RSS 或 Atom 订阅（包括 arXiv API 的查询结果），按时间从新到旧返回条目的标题、链接、时间和摘要。只能访问插件允许的网站。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '订阅地址' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多几条，默认 20' },
        days: { type: 'integer', minimum: 1, maximum: 60, description: '可选，只要最近几天的' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

type Fetched = {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  text: string;
  cut: boolean;
};
export const pluginFetch = (id: string, url: string, accept = '') =>
  invoke<Fetched>('plugin-fetch', { id, url, accept });

const fail = (content: string): ToolOutcome => ({ content, isError: true, detail: content });
const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
};

const dropped =
  'script,style,noscript,svg,template,iframe,canvas,form,button,select,input,textarea,nav,footer,dialog';
const blocks = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'ASIDE',
  'UL',
  'OL',
  'LI',
  'TABLE',
  'TR',
  'BLOCKQUOTE',
  'PRE',
  'FIGURE',
  'FIGCAPTION',
  'DL',
  'DT',
  'DD',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
]);
// A page as text a model can read: headings marked, links kept with their addresses.
export function htmlToText(html: string, base: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(dropped).forEach((e) => e.remove());
  const title = doc.title.trim();
  const main =
    [...doc.querySelectorAll('article, main, [role=main]')].find(
      (e) => (e.textContent || '').trim().length > 400,
    ) || doc.body;
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push((node.textContent || '').replace(/\s+/g, ' '));
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName;
    if (tag === 'BR') return void out.push('\n');
    if (tag === 'IMG') {
      const alt = node.getAttribute('alt')?.trim();
      if (alt) out.push(`[图：${alt}]`);
      return;
    }
    const block = blocks.has(tag);
    if (block) out.push('\n');
    if (/^H[1-6]$/.test(tag)) out.push('#'.repeat(Number(tag[1])) + ' ');
    if (tag === 'LI') out.push('- ');
    if (tag === 'A') {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      let href = '';
      try {
        href = new URL(node.getAttribute('href') || '', base).toString();
      } catch {}
      if (text && /^https?:/.test(href)) out.push(`[${text}](${href})`);
      else if (text) out.push(text);
      return;
    }
    node.childNodes.forEach(walk);
    if (block) out.push('\n');
    if (tag === 'TD' || tag === 'TH') out.push(' | ');
  };
  if (main) walk(main);
  const body = out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, all) => l || (all[i - 1] ?? '') !== '')
    .join('\n')
    .trim();
  return { title, body };
}

type FeedItem = { title: string; link: string; date: number; summary: string; authors: string };
const plain = (html: string) =>
  new DOMParser()
    .parseFromString(html, 'text/html')
    .body.textContent?.replace(/\s+/g, ' ')
    .trim() || '';
// RSS 2.0, RSS 1.0 (RDF) and Atom, arXiv's API included.
export function parseFeed(xml: string, base: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw Error('不是有效的 RSS 或 Atom 订阅');
  const pick = (el: Element, ...names: string[]) => {
    for (const n of names) {
      const found = [...el.children].find((c) => c.localName === n);
      if (found?.textContent?.trim()) return found.textContent.trim();
    }
    return '';
  };
  const items: FeedItem[] = [];
  const entries = [...doc.getElementsByTagNameNS('*', 'entry')];
  for (const e of entries) {
    const links = [...e.children].filter((c) => c.localName === 'link');
    const alt =
      links.find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
    let link = alt?.getAttribute('href') || pick(e, 'id');
    try {
      link = new URL(link, base).toString();
    } catch {}
    items.push({
      title: plain(pick(e, 'title')),
      link,
      date: Date.parse(pick(e, 'published', 'updated')) || 0,
      summary: plain(pick(e, 'summary', 'content')),
      authors: [...e.children]
        .filter((c) => c.localName === 'author')
        .map((a) => pick(a, 'name'))
        .filter(Boolean)
        .slice(0, 4)
        .join(', '),
    });
  }
  if (!entries.length)
    for (const e of [...doc.getElementsByTagNameNS('*', 'item')]) {
      let link = pick(e, 'link') || e.getAttribute('rdf:about') || '';
      try {
        link = new URL(link, base).toString();
      } catch {}
      items.push({
        title: plain(pick(e, 'title')),
        link,
        date: Date.parse(pick(e, 'pubDate', 'date', 'published')) || 0,
        summary: plain(pick(e, 'description', 'encoded', 'summary')),
        authors: pick(e, 'creator', 'author'),
      });
    }
  const title =
    plain(
      [...doc.documentElement.children].find((c) => c.localName === 'title')?.textContent ||
        doc.querySelector('channel > title')?.textContent ||
        '',
    ) || host(base);
  return { title, items };
}

// A data interface's reply cut down to what a model reads: no links to other API calls
// (GitHub's *_url), internal ids, empty values or very long text, and long lists shortened.
// Hugging Face's daily papers go from about 330,000 characters to a small part of that.
export function slimJson(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    const max = depth < 2 ? 40 : 6;
    const kept = value
      .slice(0, max)
      .map((v) => slimJson(v, depth + 1))
      .filter((v) => v !== undefined);
    if (value.length > max) kept.push(`……还有 ${value.length - max} 项`);
    return kept.length ? kept : undefined;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith('_') || key === 'node_id' || (key.endsWith('_url') && key !== 'html_url'))
        continue;
      const kept = slimJson(v, depth + 1);
      if (kept !== undefined) out[key] = kept;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  }
  return value === null ? undefined : value;
}

// A page as read once in a run; reading on from an offset uses it again.
type Page = { url: string; head: string; body: string; cut: boolean };
const day = 86_400_000;
// fetch_url and read_feed for one plugin's run; `pages` keeps what the run has read.
export function prepareWebTool(
  pluginId: string,
  name: string,
  input: any,
  progress: (detail: string) => void,
  pages: Map<string, Promise<Page>> = new Map(),
): PreparedTool | undefined {
  const url = String(input?.url ?? '').trim();
  if (name === 'fetch_url')
    return {
      title: Number(input?.offset) > 0 ? `接着读 ${host(url)}` : `读取 ${host(url)}`,
      run: async () => {
        if (!/^https:\/\//i.test(url)) return fail('只能读取 https 网址。');
        let pending = pages.get(url);
        if (!pending) {
          progress('正在读取…');
          pending = pluginFetch(pluginId, url).then((got) => {
            if (!got.ok) throw Error(`${host(got.url)} 返回了 ${got.status}。`);
            const type = got.contentType.toLowerCase();
            if (type.includes('html')) {
              const page = htmlToText(got.text, got.url);
              return {
                url: got.url,
                head: page.title ? `《${page.title}》` : '',
                body: page.body,
                cut: got.cut,
              };
            }
            let body = got.text;
            if (type.includes('json'))
              try {
                body = JSON.stringify(slimJson(JSON.parse(got.text)) ?? null);
              } catch {}
            return { url: got.url, head: '', body, cut: got.cut };
          });
          pages.set(url, pending);
          pending.catch(() => pages.delete(url));
        }
        const { url: at, head, body, cut } = await pending;
        const got = { url: at, cut };
        const offset = Math.max(0, Number(input?.offset) || 0);
        const length = Math.min(30_000, Math.max(500, Number(input?.length) || 12_000));
        const end = Math.min(body.length, offset + length);
        return {
          content: `${got.url} ${head}共 ${body.length} 字，本次为第 ${offset}–${end} 字${end < body.length ? `，可用 offset=${end} 继续读取` : '（已到结尾）'}${got.cut ? '（网页太大，只取了前一部分）' : ''}：\n\n${body.slice(offset, end)}`,
          detail: `${body.length.toLocaleString()} 字`,
        };
      },
    };
  if (name === 'read_feed')
    return {
      title: `读取订阅 ${host(url)}`,
      run: async () => {
        if (!/^https:\/\//i.test(url)) return fail('只能读取 https 订阅地址。');
        progress('正在读取…');
        const got = await pluginFetch(
          pluginId,
          url,
          'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
        );
        if (!got.ok) return fail(`${host(got.url)} 返回了 ${got.status}。`);
        const feed = parseFeed(got.text, got.url);
        const days = Number(input?.days) || 0;
        const limit = Math.min(50, Math.max(1, Number(input?.limit) || 20));
        const items = feed.items
          .filter((i) => !days || !i.date || i.date >= Date.now() - days * day)
          .sort((a, b) => b.date - a.date)
          .slice(0, limit);
        if (!items.length)
          return { content: `订阅「${feed.title}」里没有符合条件的条目。`, detail: '没有条目' };
        const lines = items.map((i, n) =>
          [
            `${n + 1}. ${i.title}`,
            `   ${[i.date ? new Date(i.date).toISOString().slice(0, 10) : '', i.authors].filter(Boolean).join(' · ')}`,
            `   链接：${i.link}`,
            i.summary
              ? `   摘要：${i.summary.length > 360 ? `${i.summary.slice(0, 360)}…` : i.summary}`
              : '',
          ]
            .filter((l) => l.trim())
            .join('\n'),
        );
        return {
          content: `订阅「${feed.title}」的 ${items.length} 条（共 ${feed.items.length} 条）：\n\n${lines.join('\n\n')}`,
          detail: `${items.length} 条`,
        };
      },
    };
  return undefined;
}
