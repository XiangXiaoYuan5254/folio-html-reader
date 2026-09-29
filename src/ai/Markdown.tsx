import { Fragment } from 'react';
import type { ReactNode } from 'react';

// Renders model output as React elements, never as HTML: the app window can reach the file
// system bridge, so model text must not become markup. <cite> is the one tag understood.
export type CiteRenderer = (cite: { n: number; doc: string; quote: string }) => ReactNode;
type Props = {
  text: string;
  streaming?: boolean;
  renderCite?: CiteRenderer;
  onLink?: (url: string) => void;
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

export function Markdown({ text, streaming, renderCite, onLink }: Props) {
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
  const ctx: Inline = { cites, renderCite, onLink };
  return <div className="ai-markdown">{blocks(source, ctx)}</div>;
}

type Inline = {
  cites: { n: number; doc: string; quote: string }[];
  renderCite?: CiteRenderer;
  onLink?: (url: string) => void;
};

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
      out.push(
        <pre key={key()}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
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
      !/^\s*(#{1,6}\s|>|```|~~~|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
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

const tokens =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(\u0001\d+\u0001)|(https?:\/\/[^\s<>()（）]+)/g;
function inline(text: string, ctx: Inline): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(tokens)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [whole, code, bold, italic, del, link, cite, url] = m;
    const k = out.length;
    if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
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
function linkNode(href: string, label: ReactNode, ctx: Inline, key: number) {
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
