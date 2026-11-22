// Code and plain text as a page of their own, read and annotated like HTML. Code keeps its
// lines (numbered in the margin, where they are neither selected nor read to AI); a .txt
// reads as prose; CSV and TSV become a table.
const labels = {
  plain: '纯文本',
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  yaml: 'YAML',
  ini: '配置',
  properties: 'Properties',
  xml: 'XML',
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  java: 'Java',
  kotlin: 'Kotlin',
  scala: 'Scala',
  groovy: 'Groovy',
  gradle: 'Gradle',
  c: 'C',
  cpp: 'C++',
  objectivec: 'Objective-C',
  csharp: 'C#',
  fsharp: 'F#',
  vbnet: 'Visual Basic',
  go: 'Go',
  rust: 'Rust',
  swift: 'Swift',
  dart: 'Dart',
  ruby: 'Ruby',
  php: 'PHP',
  perl: 'Perl',
  lua: 'Lua',
  r: 'R',
  julia: 'Julia',
  bash: 'Shell',
  powershell: 'PowerShell',
  dos: '批处理',
  sql: 'SQL',
  graphql: 'GraphQL',
  protobuf: 'Protobuf',
  latex: 'LaTeX',
  lisp: 'Lisp',
  clojure: 'Clojure',
  elixir: 'Elixir',
  erlang: 'Erlang',
  haskell: 'Haskell',
  ocaml: 'OCaml',
  nim: 'Nim',
  x86asm: '汇编',
  vim: 'Vim',
  cmake: 'CMake',
  makefile: 'Makefile',
  dockerfile: 'Dockerfile',
  diff: 'Diff',
};

// Past these, the page shows the start of the file: a browser page of a million lines
// is too slow to read or annotate. Highlighting stops earlier, as it costs the most.
// Only the first readLimit bytes of a file are read at all (formats.cjs).
const readLimit = 8 * 1024 * 1024;
const maxChars = 2 * 1024 * 1024;
const maxLines = 20000;
const maxRows = 5000;
const maxHighlight = 512 * 1024;

const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Text files come as UTF-8, UTF-16 with a BOM, or (often, from Chinese Windows) GB18030.
// Bytes with NULs that aren't UTF-16 are not text.
function decode(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

let hljs = null;
function highlight(text, language) {
  if (!hljs) hljs = require('highlight.js/lib/core');
  if (!hljs.getLanguage(language)) {
    try {
      hljs.registerLanguage(language, require(`highlight.js/lib/languages/${language}`));
    } catch {
      return escape(text);
    }
  }
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escape(text);
  }
}

// highlight.js's spans can run across lines (a long comment or string); each line gets
// its own, closed at its end and opened again on the next.
function splitLines(html) {
  const lines = [];
  const open = [];
  let line = '';
  for (const [token, cls] of html.matchAll(/<span class="([^"]*)">|<\/span>|\n|[^<\n]+/g)) {
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.map((c) => `<span class="${c}">`).join('');
    } else if (token === '</span>') {
      open.pop();
      line += token;
    } else {
      if (cls !== undefined) open.push(cls);
      line += token;
    }
  }
  lines.push(line);
  return lines;
}

// RFC 4180: quoted fields may hold the separator, quotes ("") and line breaks.
function parseTable(text, separator) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === separator) (row.push(field), (field = ''));
    else if (c === '\n') {
      (row.push(field), rows.push(row), (row = []), (field = ''));
      if (rows.length > maxRows) break;
    } else field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows;
}

const style = `
:root{color-scheme:light}
html{background:#fff}
body{margin:0;color:#1f2328;font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.folio-file{box-sizing:border-box;padding:28px 32px 96px}
.folio-file>header{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:0 0 18px}
.folio-file>header h1{margin:0;font-size:17px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.folio-file>header span{color:#59636e;font-size:13px}
.folio-note{margin:16px 0 0;color:#59636e;font-size:13px}
pre.code{--gutter:calc(var(--digits) * 1ch + 32px);position:relative;margin:0;padding:12px 20px 12px var(--gutter);font:13.5px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,"PingFang SC",monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;background:#f6f8fa;border-radius:8px;counter-reset:line}
pre.code .l::before{counter-increment:line;content:counter(line);position:absolute;width:calc(var(--gutter) - 20px);margin-left:calc(-1 * var(--gutter));color:#8c959f;text-align:right;user-select:none}
.folio-file.prose{max-width:860px;margin:0 auto;padding:48px 40px 96px}
.folio-file.prose .text{margin:0;font:inherit;white-space:pre-wrap;overflow-wrap:break-word}
table{border-collapse:collapse;font-size:14px;line-height:1.5}
th,td{padding:6px 12px;border:1px solid #d0d7de;text-align:left;vertical-align:top;white-space:pre-wrap}
th{position:sticky;top:0;font-weight:600;background:#f6f8fa}
tr:nth-child(2n) td{background:#f9fafb}
.folio-empty{color:#59636e}
.hljs-comment,.hljs-quote{color:#6e7781;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-meta .hljs-keyword,.hljs-doctag,.hljs-section{color:#cf222e}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-meta .hljs-string{color:#0a3069}
.hljs-number,.hljs-literal,.hljs-variable.constant_,.hljs-symbol,.hljs-bullet{color:#0550ae}
.hljs-title,.hljs-title.function_,.hljs-title.class_{color:#8250df}
.hljs-attr,.hljs-attribute,.hljs-property,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable,.hljs-template-variable{color:#0550ae}
.hljs-built_in,.hljs-type,.hljs-params{color:#953800}
.hljs-name,.hljs-tag{color:#116329}
.hljs-meta{color:#6e7781}
.hljs-deletion{color:#82071e;background:#ffebe9}
.hljs-addition{background:#dafbe1}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:600}
@media (max-width:640px){.folio-file{padding:20px 16px 64px}.folio-file.prose{padding:28px 20px 64px}}
`;

const page = (name, body, className = '') =>
  `<!doctype html><html lang="zh-CN" data-folio-format="code"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(name)}</title><style>${style}</style></head><body><main class="folio-file${className}">${body}</main></body></html>`;

// `language`: from text-types.json — a highlight.js language, or text, plain, csv, tsv.
// `more`: the file goes on past `bytes`, which then end at a line break so that no
// character is cut in two.
function renderCodePage(bytes, name, language, more = false) {
  const end = more ? bytes.lastIndexOf(0x0a) : -1;
  if (end >= 0) bytes = bytes.subarray(0, end + 1);
  let text = decode(bytes);
  if (text === null)
    return page(name, `<p class="folio-empty">「${escape(name)}」不是文本文件，页间无法显示。</p>`);
  text = text.replace(/\r\n?/g, '\n');
  let cut = more || text.length > maxChars;
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const size = (n, unit) => `${n.toLocaleString('zh-CN')} ${unit}`;

  if (language === 'csv' || language === 'tsv') {
    const rows = parseTable(text, language === 'csv' ? ',' : '\t');
    if (rows.length > maxRows) ((rows.length = maxRows), (cut = true));
    const [head = [], ...rest] = rows;
    const width = Math.max(1, ...rows.map((r) => r.length));
    const cells = (r, tag) =>
      Array.from({ length: width }, (_, i) => `<${tag}>${escape(r[i] ?? '')}</${tag}>`).join('');
    const body = `<header><h1>${escape(name)}</h1><span>${labels[language]} · ${size(rows.length ? rows.length - 1 : 0, '行')}${cut ? '（只显示前一部分）' : ''}</span></header><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>`;
    return page(name, body);
  }

  let lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) return page(name, `<p class="folio-empty">「${escape(name)}」是空文件。</p>`);
  if (lines.length > maxLines) ((lines.length = maxLines), (cut = true));
  const note = cut
    ? `<p class="folio-note">文件较大，只显示了前 ${size(lines.length, '行')}。</p>`
    : '';
  if (language === 'text')
    return page(name, `<pre class="text">${escape(lines.join('\n'))}</pre>${note}`, ' prose');

  const source = lines.join('\n');
  const html =
    language === 'plain' || source.length > maxHighlight
      ? lines.map(escape)
      : splitLines(highlight(source, language));
  const digits = String(html.length).length;
  const label = labels[language] || labels.plain;
  const body = `<header><h1>${escape(name)}</h1><span>${label} · ${size(lines.length, '行')}</span></header><pre class="code" style="--digits:${digits}">${html.map((l) => `<span class="l">${l}\n</span>`).join('')}</pre>${note}`;
  return page(name, body);
}

module.exports = { renderCodePage, readLimit, splitLines, parseTable, decode };
