// A Word document (.docx) as a page of its own, read and annotated like HTML. mammoth keeps
// its structure (headings, lists, tables, pictures, notes), not its page layout.
let mammoth = null;

const escape = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const styleMap = [
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='Subtitle'] => p.subtitle:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  'u => u',
  'strike => s',
];
// mammoth drops alignment; centred and right-aligned paragraphs (a title, a signature, a
// date) keep it through a style of their own, as a class.
const aligned = { center: 'center', right: 'right', end: 'right' };
for (const side of new Set(Object.values(aligned))) {
  styleMap.push(`p.FolioTitle-${side} => h1.title.${side}:fresh`);
  for (let n = 1; n <= 6; n++) styleMap.push(`p.FolioH${n}-${side} => h${n}.${side}:fresh`);
  styleMap.push(`p.FolioP-${side} => p.${side}:fresh`);
}
function alignParagraph(p) {
  const side = aligned[p.alignment];
  if (!side || p.numbering) return p;
  const name = (p.styleName || '').toLowerCase();
  const heading = /^heading ([1-6])$/.exec(name);
  const id = heading
    ? `FolioH${heading[1]}-${side}`
    : name === 'title'
      ? `FolioTitle-${side}`
      : /note text|quote|subtitle/.test(name)
        ? null
        : `FolioP-${side}`;
  return id ? { ...p, styleId: id, styleName: null } : p;
}

const style = `
:root{color-scheme:light}
html{background:#f3f3f2}
body{margin:0;color:#1f2328;font:16px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.folio-word{box-sizing:border-box;max-width:860px;margin:32px auto 64px;padding:64px 72px 80px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);overflow-wrap:break-word}
.folio-word>:first-child{margin-top:0}
h1,h2,h3,h4,h5,h6{margin:1.5em 0 .6em;font-weight:600;line-height:1.35}
h1{font-size:1.8em}h2{font-size:1.45em}h3{font-size:1.2em}h4{font-size:1.05em}h5,h6{font-size:1em}
h1.title{font-size:2em;margin-bottom:.4em}
p.subtitle{color:#59636e;font-size:1.15em}
p,ul,ol,blockquote,table{margin:0 0 .9em}
ul,ol{padding-left:2em}li+li{margin-top:.2em}li>p{margin:0}
.center{text-align:center}.right{text-align:right}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
blockquote{margin-left:0;padding:0 1em;color:#59636e;border-left:.25em solid #d0d7de}
table{border-collapse:collapse;max-width:100%}
th,td{padding:6px 10px;border:1px solid #c9d1d9;vertical-align:top}
th{font-weight:600;background:#f6f8fa}
td>p:last-child,th>p:last-child{margin-bottom:0}
img{max-width:100%;height:auto}
sup,sub{line-height:0}
hr{height:1px;margin:1.6em 0;border:0;background:#d8dee4}
ol:last-child>li[id^="footnote-"],ol:last-child>li[id^="endnote-"]{font-size:.9em;color:#59636e}
.folio-empty{color:#59636e}
@media (max-width:720px){.folio-word{margin:0;padding:28px 20px 64px;box-shadow:none}}
`;

async function renderWordPage(bytes, name) {
  if (!mammoth) mammoth = require('mammoth');
  let html;
  try {
    ({ value: html } = await mammoth.convertToHtml(
      { buffer: bytes },
      { styleMap, transformDocument: mammoth.transforms.paragraph(alignParagraph) },
    ));
  } catch {
    throw Error(`无法读取「${name}」，文件可能已损坏，或不是 .docx 格式`);
  }
  // mammoth's text is escaped already; the file name is not.
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const title = heading?.[1].replace(/<[^>]+>/g, '').trim() || escape(name);
  const body = html.trim() || `<p class="folio-empty">这个文档没有文字内容。</p>`;
  return `<!doctype html><html lang="zh-CN" data-folio-format="word"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${style}</style></head><body><article class="folio-word">${body}</article></body></html>`;
}

module.exports = { renderWordPage };
