// The text of a PDF, page by page, read in this process with pdf.js's build for Node
// (dist/pdf-node, with the PDF reader's cmaps and fonts in dist/pdf; run from source before a
// build, node_modules). Plugins' fetch_url uses it, so a report published only as a PDF can be
// read like a web page.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const places = [
  {
    lib: path.join(__dirname, '../dist/pdf-node/pdf.mjs'),
    worker: path.join(__dirname, '../dist/pdf-node/pdf.worker.mjs'),
    data: path.join(__dirname, '../dist/pdf'),
  },
  {
    lib: path.join(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.mjs'),
    worker: path.join(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'),
    data: path.join(__dirname, '../node_modules/pdfjs-dist'),
  },
];
// pdf.js wants folders as URLs ending in "/"; in Node it reads them with fs.
const folder = (dir) => `${dir.split(path.sep).join('/')}/`;
let loading;
function load() {
  loading ||= (async () => {
    const place = places.find((p) => fs.existsSync(p.lib) && fs.existsSync(p.worker));
    if (!place) throw Error('页间缺少读取 PDF 的组件');
    const lib = await import(pathToFileURL(place.lib).href);
    // No worker threads here: pdf.js runs its worker code in this process.
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(place.worker).href;
    return {
      lib,
      cMapUrl: folder(path.join(place.data, 'cmaps')),
      standardFontDataUrl: folder(path.join(place.data, 'standard_fonts')),
    };
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

// A PDF starts with its header, give or take some bytes in front that readers allow.
const isPdf = (bytes) => bytes.subarray(0, 1024).includes('%PDF-');

// Pages until `limit` characters; `cut` when pages were left out. Throws with a reason a
// plugin's model can act on.
async function pdfText(bytes, limit = 2_000_000) {
  const { lib, cMapUrl, standardFontDataUrl } = await load();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    // Fonts are only measured for text, never compiled to code or loaded for drawing.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    if (e?.name === 'PasswordException') throw Error('这份 PDF 有密码，读不了');
    throw Error(`这份 PDF 读不了：${e?.message || e}`);
  }
  try {
    const info = (await doc.getMetadata().catch(() => null))?.info;
    const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
    const pages = [];
    let size = 0;
    for (let n = 1; n <= doc.numPages && size < limit; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      page.cleanup();
      let text = '';
      for (const item of content.items)
        if (typeof item.str === 'string') text += item.str + (item.hasEOL ? '\n' : '');
      text = text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      pages.push(text);
      size += text.length;
    }
    if (!pages.some(Boolean)) throw Error('这份 PDF 里没有文字，可能是扫描版');
    return { title, pages, total: doc.numPages, cut: pages.length < doc.numPages };
  } finally {
    await task.destroy().catch(() => {});
  }
}

module.exports = { pdfText, isPdf };
