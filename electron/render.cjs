const path = require('node:path');
const rawText = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
]);
// Tags every start tag with its offset in `source`, so the source editor can find
// the code behind an element picked in the preview.
function markSourceOffsets(source) {
  const lower = source.toLowerCase();
  const tag = /<([a-zA-Z][^\s/>]*)/y;
  let out = '',
    last = 0,
    i = 0;
  while ((i = source.indexOf('<', i)) !== -1) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    tag.lastIndex = i;
    const m = tag.exec(source);
    if (!m) {
      i++;
      continue;
    }
    const nameEnd = i + m[0].length;
    out += source.slice(last, nameEnd) + ` data-folio-src="${i}"`;
    last = nameEnd;
    let quote = '';
    for (i = nameEnd; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    i++;
    const name = m[1].toLowerCase();
    if (rawText.has(name)) {
      const close = lower.indexOf('</' + name, i);
      i = close === -1 ? source.length : close;
    }
  }
  return out + source.slice(last);
}
function renderDocument(source, base, runtime) {
  // A dedicated sandboxed frame owns document scripts; it has no filesystem bridge.
  const baseTag = `<base href="${base.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`;
  let html = source
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy|refresh)[^>]*>/gi, '');
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (m) => m + baseTag);
  else html = baseTag + html;
  const injected = `<script>${runtime.replace(/<\/script/gi, '<\\/script')}</script>`;
  return (
    html.replace(/<\/body\s*>/i, (m) => injected + m) + (/<\/body\s*>/i.test(html) ? '' : injected)
  );
}
function mime(file) {
  return (
    {
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.json': 'application/json',
      '.pdf': 'application/pdf',
      '.wasm': 'application/wasm',
      '.bcmap': 'application/octet-stream',
      '.mp4': 'video/mp4',
    }[path.extname(file).toLowerCase()] || 'application/octet-stream'
  );
}
module.exports = { renderDocument, markSourceOffsets, mime };
