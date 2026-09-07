const path = require('node:path');
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
      '.mp4': 'video/mp4',
    }[path.extname(file).toLowerCase()] || 'application/octet-stream'
  );
}
module.exports = { renderDocument, mime };
