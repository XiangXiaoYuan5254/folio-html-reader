const path = require('node:path');
const MarkdownIt = require('markdown-it');

// The files 页间 opens as documents. HTML and PDF have always been read here; Markdown and
// pictures are shown as a page of their own that the reader's runtime annotates like HTML.
const isHtml = (p) => /\.html?$/i.test(p);
const isPdf = (p) => /\.pdf$/i.test(p);
const isMarkdown = (p) => /\.(md|markdown)$/i.test(p);
const isImage = (p) => /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(p);
const kindOf = (p) =>
  isHtml(p) ? 'html' : isPdf(p) ? 'pdf' : isMarkdown(p) ? 'markdown' : isImage(p) ? 'image' : null;
const isDocument = (p) => kindOf(p) !== null;
// The documents with source to edit in 源码 mode.
const isEditable = (p) => isHtml(p) || isMarkdown(p);
const extensions = {
  html: ['html', 'htm'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'],
};

const escape = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

// Markdown is the writer's own file, read with the same trust as an HTML page: its inline
// HTML is kept, and the page runs in the same sandboxed frame.
const markdown = new MarkdownIt({ html: true, linkify: true });
const markdownStyle = `
:root{color-scheme:light}
html{background:#fff}
body{margin:0;color:#1f2328;font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.folio-markdown{box-sizing:border-box;max-width:860px;margin:0 auto;padding:48px 40px 96px;overflow-wrap:break-word}
.folio-markdown>:first-child{margin-top:0}
h1,h2,h3,h4,h5,h6{margin:1.6em 0 .6em;font-weight:600;line-height:1.3}
h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid #d8dee4}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid #d8dee4}
h3{font-size:1.25em}h4{font-size:1em}h5{font-size:.875em}h6{font-size:.85em;color:#59636e}
p,ul,ol,blockquote,pre,table,dl{margin:0 0 1em}
ul,ol{padding-left:2em}li+li{margin-top:.25em}
li.task{list-style:none;margin-left:-1.4em}li.task>input{margin:0 .5em 0 0;vertical-align:middle}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
blockquote{padding:0 1em;color:#59636e;border-left:.25em solid #d0d7de}
code,kbd,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875em}
code{padding:.2em .4em;background:rgba(129,139,152,.12);border-radius:6px}
pre{padding:16px;overflow:auto;line-height:1.5;background:#f6f8fa;border-radius:8px}
pre code{padding:0;background:none;border-radius:0;font-size:inherit}
kbd{padding:.15em .4em;border:1px solid #d0d7de;border-bottom-width:2px;border-radius:5px}
hr{height:1px;margin:1.6em 0;border:0;background:#d8dee4}
table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse}
th,td{padding:6px 13px;border:1px solid #d0d7de}th{font-weight:600;background:#f6f8fa}
tr:nth-child(2n) td{background:#f6f8fa}
img{max-width:100%;height:auto}
@media (max-width:640px){.folio-markdown{padding:28px 20px 64px}}
`;
// Front matter (--- yaml ---) is data for a site generator, not something to read.
const frontMatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/;
// `offsets`: for the 源码 preview, each block carries where its Markdown starts in `source`
// (data-folio-src, as markSourceOffsets does for HTML), so picking it finds the source.
function renderMarkdownPage(source, name, { offsets = false } = {}) {
  const text = source.replace(/^\uFEFF/, '').replace(frontMatter, '');
  const tokens = markdown.parse(text, {});
  if (offsets) {
    const skip = source.length - text.length;
    const lines = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines.push(i + 1);
    for (const t of tokens)
      if (t.map && t.nesting !== -1 && t.type !== 'inline')
        t.attrSet('data-folio-src', String(skip + lines[t.map[0]]));
  }
  const heading = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1');
  const title = (heading >= 0 && tokens[heading + 1]?.content.trim()) || name;
  // Task lists (- [ ] / - [x]) as boxes, as GitHub shows them.
  const body = markdown.renderer
    .render(tokens, markdown.options, {})
    .replace(
      /<li((?: [^>]*)?)>(\s*(?:<p[^>]*>)?)\[([ xX])\]\s/g,
      (_, attrs, open, mark) =>
        `<li class="task"${attrs}>${open}<input type="checkbox" disabled${mark === ' ' ? '' : ' checked'}> `,
    );
  return `<!doctype html><html lang="zh-CN" data-folio-format="markdown"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${markdownStyle}</style></head><body><article class="folio-markdown">${body}</article></body></html>`;
}

// A picture on a page of its own, at its own size and never wider than the window.
const imageStyle = `
:root{color-scheme:light}
html,body{margin:0;min-height:100%;background:#f3f3f2}
.folio-image{box-sizing:border-box;display:flex;min-height:100vh;padding:32px;align-items:center;justify-content:center}
.folio-image img{display:block;max-width:100%;height:auto;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
.folio-image img.vector{width:min(100%,960px)}
`;
function renderImagePage(relative) {
  const name = path.posix.basename(relative);
  const vector = /\.svg$/i.test(name) ? ' class="vector"' : '';
  return `<!doctype html><html lang="zh-CN" data-folio-format="image"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(name)}</title><style>${imageStyle}</style></head><body><main class="folio-image"><img src="${escape(encodeURIComponent(name))}" alt="${escape(name)}"${vector}></main></body></html>`;
}

module.exports = {
  isHtml,
  isPdf,
  isMarkdown,
  isImage,
  kindOf,
  isDocument,
  isEditable,
  extensions,
  renderMarkdownPage,
  renderImagePage,
};
