import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// Renders model output as React elements, never as HTML: the app window can reach the file
// system bridge, so model text must not become markup. <cite> is the one tag understood.
// Formulas are the exception: KaTeX writes their markup, with its commands that could link
// or run anything (\href, \htmlData…) turned off.
export type CiteRenderer = (cite: { n: number; doc: string; quote: string }) => ReactNode;
type Props = {
  text: string;
  streaming?: boolean;
  renderCite?: CiteRenderer;
  onLink?: (url: string) => void;
  // Links to a saved whiteboard (folio-board:id), which only the document note has.
  onBoard?: (id: string) => void;
  // Where a note's own picture (note-image:name) is, and what clicking one does. Without it,
  // pictures show as their description: model text doesn't get to load anything.
  image?: (name: string) => string;
  onImage?: (src: string) => void;
};
const marker = '\u0001';

// A cite tag still being written would otherwise flash as raw text.
function stable(text: string, streaming?: boolean) {
  if (!streaming) return text;
  const open = text.lastIndexOf('<cite');
  if (open > text.lastIndexOf('</cite>')) return text.slice(0, open);
  const tail = text.match(/<\/?c?i?t?e?[^>]*$/);
  return tail && '<cite'.startsWith(tail[0].slice(0, 5)) ? text.slice(0, tail.index) : text;
}

export function Markdown({ text, streaming, renderCite, onLink, onBoard, image, onImage }: Props) {
  const cites: { n: number; doc: string; quote: string }[] = [];
  const numbers = new Map<string, number>();
  const source = stable(text, streaming).replace(
    /<cite(?:\s+doc="([^"]*)")?\s*>([\s\S]*?)<\/cite>/g,
    (_, doc = '', quote: string) => {
      const key = `${doc}\u0000${quote.trim()}`;
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
      cites.push({ n: numbers.get(key)!, doc, quote: quote.trim() });
      return `${marker}${cites.length - 1}${marker}`;
    },
  );
  const ctx: Inline = { cites, renderCite, onLink, onBoard, image, onImage };
  return <div className="ai-markdown">{blocks(source, ctx)}</div>;
}

type Inline = {
  cites: { n: number; doc: string; quote: string }[];
  renderCite?: CiteRenderer;
  onLink?: (url: string) => void;
  onBoard?: (id: string) => void;
  image?: (name: string) => string;
  onImage?: (src: string) => void;
};

// Formulas already drawn, as streaming answers draw the same ones over and over.
const drawn = new Map<string, string>();
export function mathHtml(tex: string, display: boolean) {
  const id = (display ? 'D' : 'I') + tex;
  let html = drawn.get(id);
  if (html === undefined) {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
    if (drawn.size > 400) drawn.clear();
    drawn.set(id, html);
  }
  return html;
}
function math(tex: string, display: boolean, key: number) {
  const html = mathHtml(tex, display);
  return display ? (
    <div key={key} className="md-math" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span key={key} className="md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <pre>
        <code>{code}</code>
      </pre>
      <button
        className="md-code-copy"
        title="复制代码"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

function blocks(source: string, ctx: Inline): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(<CodeBlock key={key()} code={body.join('\n')} />);
      continue;
    }
    // $$ … $$ or \[ … \] on a line of its own, or over several lines.
    const one = line.match(/^\s*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])\s*$/);
    if (one) {
      out.push(math(one[1] ?? one[2], true, key()));
      i++;
      continue;
    }
    const open = line.match(/^\s*(\$\$|\\\[)(.*)$/);
    if (open && !open[2].includes(open[1] === '$$' ? '$$' : '\\]')) {
      const close = open[1] === '$$' ? '$$' : '\\]';
      const body = [open[2]];
      i++;
      while (i < lines.length && !lines[i].includes(close)) body.push(lines[i++]);
      if (i < lines.length) body.push(lines[i++].split(close)[0]);
      out.push(math(body.join('\n'), true, key()));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2) as 3 | 4 | 5 | 6;
      const Tag = `h${level}` as const;
      out.push(<Tag key={key()}>{inline(heading[2].replace(/\s+#+\s*$/, ''), ctx)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key()}>{blocks(body.join('\n'), ctx)}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const row = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split(/(?<!\\)\|/)
          .map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(
        <div className="ai-table" key={key()}>
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, ctx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {head.map((_, k) => (
                    <td key={k}>{inline(r[k] || '', ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+[.)]/.test(line);
      const indent = line.match(/^\s*/)![0].length;
      const lead = (l: string) => l.match(/^\s*/)![0].length;
      while (i < lines.length) {
        const l = lines[i];
        const item = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        const between =
          !l.trim() &&
          /^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1] || '') &&
          lead(lines[i + 1]) >= indent;
        if (item && lead(l) <= indent + 1) items.push(item[3]);
        // Indented lines belong to the item above (nested lists, continued text).
        else if (items.length && l.trim() && lead(l) >= indent + 2)
          items[items.length - 1] += '\n' + l.slice(Math.min(lead(l), indent + 2));
        // A blank line between items keeps the list going.
        else if (!between) break;
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      const first = Number(line.match(/^\s*(\d+)/)?.[1] || 1);
      out.push(
        <List key={key()} start={ordered && first !== 1 ? first : undefined}>
          {items.map((item, j) => (
            <li key={j}>{item.includes('\n') ? blocks(item, ctx) : inline(item, ctx)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|```|~~~|\$\$|\\\[|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
      !(/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || ''))
    )
      para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(
      <p key={key()}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j ? <br /> : null}
            {inline(l, ctx)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

// Inline math is $…$ with no space just inside the dollars and no digit after the closing
// one, so prices ($5 and $10) stay text; $$…$$ and \(…\) work inline too.
const tokens =
  /(`[^`]+`)|(\$\$[^$\n]+?\$\$|\$(?=[^\s$])[^$\n]*?[^\s\\$]\$(?!\d)|\$[^\s$\\]\$(?!\d)|\\\([^\n]+?\\\))|(!\[[^\]]*\]\([^)\s]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(\u0001\d+\u0001)|(https?:\/\/[^\s<>()（）]+)/g;
function inline(text: string, ctx: Inline): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(tokens)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [whole, code, tex, picture, bold, italic, del, link, cite, url] = m;
    const k = out.length;
    if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
    else if (tex)
      out.push(
        math(
          tex.startsWith('$$')
            ? tex.slice(2, -2)
            : tex.startsWith('$')
              ? tex.slice(1, -1)
              : tex.slice(2, -2),
          false,
          k,
        ),
      );
    else if (picture) out.push(imageNode(picture, ctx, k));
    else if (bold) out.push(<strong key={k}>{inline(bold.slice(2, -2), ctx)}</strong>);
    else if (italic) out.push(<em key={k}>{inline(italic.slice(1, -1), ctx)}</em>);
    else if (del) out.push(<del key={k}>{inline(del.slice(2, -2), ctx)}</del>);
    else if (link) {
      const [, label, href] = link.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(linkNode(href, inline(label, ctx), ctx, k));
    } else if (cite) {
      const c = ctx.cites[Number(cite.slice(1, -1))];
      out.push(
        c ? (
          <Fragment key={k}>{ctx.renderCite ? ctx.renderCite(c) : `「${c.quote}」`}</Fragment>
        ) : null,
      );
    } else if (url) out.push(linkNode(url, url, ctx, k));
    else out.push(whole);
    last = m.index! + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function imageNode(source: string, ctx: Inline, key: number) {
  const [, alt, src] = source.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/)!;
  const name = src.match(/^note-image:([\w.-]+)$/)?.[1];
  const url = name && ctx.image?.(name);
  if (!url) return <span key={key}>{`［图片${alt ? `：${alt}` : ''}］`}</span>;
  return (
    <img
      key={key}
      className="md-image"
      src={url}
      alt={alt}
      title={alt || undefined}
      loading="lazy"
      onClick={() => ctx.onImage?.(url)}
    />
  );
}
function linkNode(href: string, label: ReactNode, ctx: Inline, key: number) {
  const board = href.match(/^folio-board:([\w-]+)$/)?.[1];
  if (board && ctx.onBoard)
    return (
      <a
        key={key}
        href={href}
        className="board-link"
        onClick={(e) => {
          e.preventDefault();
          ctx.onBoard?.(board);
        }}
      >
        {label}
      </a>
    );
  if (!/^https?:\/\//i.test(href)) return <span key={key}>{label}</span>;
  return (
    <a
      key={key}
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        ctx.onLink?.(href);
      }}
    >
      {label}
    </a>
  );
}
