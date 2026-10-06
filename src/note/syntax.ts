import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import type { InlineContext, MarkdownConfig } from '@lezer/markdown';

// The note's Markdown, read the way notes have always been shown: formulas in $…$, $$…$$,
// \(…\) and \[…\]; bold and italic that hug Chinese punctuation (CommonMark's flanking rules
// leave 「**“引用”**文字」 unformatted); no setext headings or indented code, so a `---`
// under a line stays a divider and indenting a line doesn't turn it into code.

// Inline math is $…$ with no space just inside the dollars and no digit after the closing
// one, so prices ($5 and $10) stay text.
const inlineMath =
  /^(?:\$\$[^$\n]+?\$\$|\$(?=[^\s$])[^$\n]*?[^\s\\$]\$(?!\d)|\$[^\s$\\]\$(?!\d)|\\\([^\n]+?\\\))/;
// A line that starts a formula block: complete on its own line, or opened and closed later.
export function mathBlock(text: string): 'line' | 'open' | null {
  const rest = text.trimStart();
  const open = /^(\$\$|\\\[)/.exec(rest);
  if (!open) return null;
  if (/^(?:\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\])\s*$/.test(rest)) return 'line';
  return rest.slice(2).includes(open[1] === '$$' ? '$$' : '\\]') ? null : 'open';
}

const marks: [string, string, string, RegExp][] = [
  ['**', 'StrongEmphasis', 'EmphasisMark', /^\*\*(?!\s)(?:[^*\n]|\*(?!\*))*?[^\s*]\*\*/],
  ['__', 'StrongEmphasis', 'EmphasisMark', /^__(?!\s)(?:[^_\n]|_(?!_))*?[^\s_]__(?![\p{L}\p{N}])/u],
  ['~~', 'Strikethrough', 'StrikethroughMark', /^~~(?!\s)[^~\n]*?[^\s~]~~/],
  ['*', 'Emphasis', 'EmphasisMark', /^\*(?![\s*])(?:[^*\n]*?[^\s*])?\*(?!\*)/],
  ['_', 'Emphasis', 'EmphasisMark', /^_(?![\s_])(?:[^_\n]*?[^\s_])?_(?![\p{L}\p{N}])/u],
];
function emphasis(cx: InlineContext, next: number, pos: number) {
  if (next !== 42 && next !== 95 && next !== 126) return -1;
  const text = cx.slice(pos, cx.end);
  // An underscore inside a word (snake_case) is just a character.
  if (next === 95 && pos > cx.offset && /[\p{L}\p{N}]/u.test(cx.slice(pos - 1, pos))) return -1;
  for (const [mark, name, markName, pattern] of marks) {
    if (!text.startsWith(mark)) continue;
    const m = pattern.exec(text);
    if (!m) continue;
    const end = pos + m[0].length;
    const inner = cx.parser.parseInline(
      cx.slice(pos + mark.length, end - mark.length),
      pos + mark.length,
    );
    return cx.addElement(
      cx.elt(name, pos, end, [
        cx.elt(markName, pos, pos + mark.length),
        ...inner,
        cx.elt(markName, end - mark.length, end),
      ]),
    );
  }
  return -1;
}

const noteSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'BlockMath', block: true }],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== 36 && next !== 92) return -1;
        const m = inlineMath.exec(cx.slice(pos, cx.end));
        return m ? cx.addElement(cx.elt('InlineMath', pos, pos + m[0].length)) : -1;
      },
      before: 'Escape',
    },
    { name: 'NoteEmphasis', parse: emphasis, before: 'Emphasis' },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      parse(cx, line) {
        const kind = mathBlock(line.text.slice(line.pos));
        if (!kind) return false;
        const from = cx.lineStart + line.pos;
        const close = line.text.slice(line.pos).startsWith('$$') ? '$$' : '\\]';
        if (kind === 'open') while (cx.nextLine()) if (line.text.includes(close)) break;
        cx.nextLine();
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd()));
        return true;
      },
      endLeaf: (_, line) => !!mathBlock(line.text.slice(line.pos)),
    },
  ],
  remove: ['SetextHeading', 'IndentedCode'],
};

export const noteMarkdown = () =>
  markdown({ extensions: [GFM, noteSyntax], addKeymap: false, completeHTMLTags: false });
