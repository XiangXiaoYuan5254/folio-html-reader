// 视频封面：本地起一个服务，用 Chrome 打开 cover.html，每一版按两种比例截图，再拼两张总览。
//
//   node scripts/promo-video/cover.mjs            全部 → out/封面/0-总介绍-16x9.png、1-白板讲解-16x9.png …、总览-16x9.png、总览-3x4.png
//   node scripts/promo-video/cover.mjs ai cute    只出这几版（不拼总览）
//
// 16x9 是 1920×1080（B 站 / YouTube），3x4 是 1080×1440（小红书 / 抖音），4x3 是 1440×1080（B 站另要的一张）。
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const outDir = path.join(here, 'out/封面');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png' };
const VERSIONS = [
  ['intro', '总介绍', ['16x9']],
  ['board', '白板讲解'],
  ['book', '像读一本书'],
  ['annotate', '随手批注'],
  ['ai', 'AI陪你读'],
  ['themes', '十套主题'],
  ['cute', '小页'],
  ['dark', '简洁A-暗色', ['16x9']],
  ['paper', '简洁B-纸页', ['16x9']],
  ['hook', '简洁C-讲题', ['16x9']],
  ['token', '简洁D-烧token', ['16x9', '4x3']],
  ['token-paper', '简洁E-烧token-纸', ['16x9']],
  ['token-term', '简洁F-烧token-终端', ['16x9']],
  ['token-pop', '简洁G-烧token-黄', ['16x9']],
  ['token-blue', '简洁H-烧token-蓝', ['16x9']],
  ['token-receipt', '烧token-小票', ['16x9']],
  ['token-flap', '烧token-翻牌', ['16x9']],
  ['token-cli', '烧token-终端窗口', ['16x9']],
  ['token-eq', '烧token-等式', ['16x9']],
  ['token-mascot', '烧token-小页', ['16x9']],
];
const SIZES = [['16x9', 1920, 1080], ['3x4', 1080, 1440], ['4x3', 1440, 1080]];
const only = process.argv.slice(2);

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = url.startsWith('/site/') ? path.join(root, 'website/assets', url.slice(6)) : path.join(here, url.slice(1));
  if (!existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await fs.mkdir(outDir, { recursive: true });
const name = (i, label, r) => `${i}-${label}-${r}.png`;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [i, [v, label, sizes]] of VERSIONS.entries()) {
    if (only.length && !only.includes(v)) continue;
    for (const [r, width, height] of SIZES) {
      if (sizes && !sizes.includes(r)) continue;
      const page = await browser.newPage({ viewport: { width, height } });
      page.on('pageerror', (e) => console.error(`${v} ${r} page error:`, e.message));
      await page.goto(`${base}/cover.html?v=${v}&r=${r}`);
      await page.waitForSelector('body[data-ready]');
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      const file = path.join(outDir, name(i, label, r));
      await page.locator('#cover').screenshot({ path: file });
      console.log(file);
      await page.close();
    }
  }
  if (!only.length) {
    // 总览：同一比例的几版排在一张图上，方便挑
    for (const [r, width, height] of SIZES.filter(([r]) => r !== '4x3')) {
      const w = r === '16x9' ? 600 : 300;
      const cols = r === '16x9' ? 3 : 6;
      const h = Math.round((w * height) / width);
      const page = await browser.newPage({ viewport: { width: cols * w + (cols + 1) * 24, height: 400 } });
      const imgs = VERSIONS.map(([, label, sizes], i) => (sizes && !sizes.includes(r) ? '' : `<figure><img src="${base}/out/封面/${encodeURIComponent(name(i, label, r))}" width="${w}" height="${h}"><figcaption>${i} ${label}</figcaption></figure>`)).join('');
      await page.setContent(
        `<style>body{margin:0;padding:24px;background:#e9e5dc;display:grid;grid-template-columns:repeat(${cols},${w}px);gap:24px;font:600 22px/1 'PingFang SC',sans-serif;color:#464e49}figure{margin:0}img{display:block;border-radius:10px;box-shadow:0 6px 20px -8px rgba(0,0,0,.35)}figcaption{margin-top:12px}</style>${imgs}`,
      );
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      const file = path.join(outDir, `总览-${r}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
