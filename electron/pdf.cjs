const path = require('node:path');
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
function renderPDFDocument(url, assets, name) {
  return `<!doctype html><html lang="zh-CN" data-folio-pdf="true"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(name)}</title><link rel="stylesheet" href="${escape(assets)}pdf.css"></head><body data-pdf-url="${escape(url)}" data-pdf-assets="${escape(assets)}"><main id="pdf-pages" aria-label="PDF 页面"></main><div id="pdf-message" data-folio-ui="pdf-message" role="status">正在打开 PDF…</div><script type="module" src="${escape(assets)}pdf.js"></script></body></html>`;
}
function pdfAssetPath(dist, relative) {
  const base = path.resolve(dist, 'pdf');
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) throw Error('无效的 PDF 资源');
  return file;
}
module.exports = { renderPDFDocument, pdfAssetPath };
