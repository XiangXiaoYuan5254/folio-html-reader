// 渲染宣传视频：本地起一个服务，用 Chrome 打开 video.html，逐帧 seek 再截图，交给 ffmpeg。
// 几个标签页并行渲染各自的一段，最后拼起来，有 music.wav 就一起混进去。
//
//   node scripts/promo-video/render.mjs                    渲染整片 → out/页间宣传视频.mp4（带配乐）
//                                                          和 out/页间宣传视频-无配乐.mp4
//   node scripts/promo-video/render.mjs --stills 3,12.5    只截这几秒的画面（看效果用）
//   node scripts/promo-video/render.mjs --from 20 --to 30  只渲染这一段
//   node scripts/promo-video/render.mjs --music            只按时间轴重新生成配乐 out/music.wav
//                                                          （有配音的页面另出一条只有配音和音效的 out/voice-<版本>.wav）
//   node scripts/promo-video/render.mjs --serve            只开服务，浏览器打开 /video.html?preview
//   以上都可以加 --page cute，换成手绘可爱版（cute.html → out/页间可爱版.mp4）
//   或 --page whiteboard，白板讲解单独一支，竖屏 3:4 发小红书（whiteboard.html → out/页间白板讲解.mp4）
//   或 --page chalk，白板讲解的黑板粉笔版，带页老师的配音（先用 narrate.mjs 录好）
//
// 素材先用 capture.mjs 录好（系统临时目录/folio-promo）。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeMusic } from './music.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const media = path.join(os.tmpdir(), 'folio-promo');
const outDir = path.join(here, 'out');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? null : (args[i + 1] ?? true);
};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = url.startsWith('/media/')
    ? path.join(media, url.slice(7))
    : url.startsWith('/site/')
      ? path.join(root, 'website/assets', url.slice(6))
      : path.join(here, url === '/' ? 'video.html' : url.slice(1));
  if (!existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(Number(opt('port')) || 0, '127.0.0.1', r));
const version = opt('page') || 'video';
const PAGES = {
  video: ['页间宣传视频', 1920, 1080],
  cute: ['页间可爱版', 1920, 1080],
  whiteboard: ['页间白板讲解', 1080, 1440],
  chalk: ['页间白板讲解-黑板版', 1080, 1440],
};
const [title, W, H] = PAGES[version];
const base = `http://127.0.0.1:${server.address().port}/${version}.html`;

if (opt('serve')) {
  console.log(base + '?preview');
} else {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    if (opt('stills')) await stills(browser, String(opt('stills')).split(',').map(Number));
    else if (opt('music')) await music(browser);
    else await video(browser);
  } finally {
    await browser.close();
    server.close();
  }
}

async function open(browser) {
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  if (opt('stills')) page.on('console', (m) => console.log(m.text()));
  await page.goto(base);
  await page.waitForFunction(() => window.READY, null, { timeout: 60000 });
  const cdp = await context.newCDPSession(page);
  return { page, cdp };
}

async function stills(browser, times) {
  const dir = path.join(outDir, 'stills', version);
  await fs.mkdir(dir, { recursive: true });
  const { page, cdp } = await open(browser);
  for (const t of times) {
    await page.evaluate((t) => window.seek(t), t);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    const file = path.join(dir, `t${t.toFixed(2)}.jpg`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log(file);
  }
}

// The soundtrack follows the timeline the page exports: scene times, clicks, transitions.
// A page with narration also gets a track of just the voice and the sound effects.
async function music(browser) {
  await fs.mkdir(outDir, { recursive: true });
  const { page } = await open(browser);
  const ev = await page.evaluate(() => window.EVENTS);
  await page.context().close();
  await fs.writeFile(path.join(outDir, `timeline-${version}.json`), JSON.stringify(ev, null, 1));
  const file = path.join(outDir, `music-${version}.wav`);
  const { gain } = await makeMusic(ev, file);
  console.log(file);
  if (!ev.voice?.length) return { file };
  const voiceOnly = path.join(outDir, `voice-${version}.wav`);
  await makeMusic(ev, voiceOnly, { music: false, gain });
  console.log(voiceOnly);
  return { file, voiceOnly };
}

async function video(browser) {
  await fs.mkdir(outDir, { recursive: true });
  const partial = opt('from') || opt('to');
  const track = partial ? null : await music(browser);
  const probe = await open(browser);
  const { duration, fps } = await probe.page.evaluate(() => ({
    duration: window.DURATION,
    fps: window.FPS,
  }));
  await probe.page.context().close();
  const from = Math.round(Number(opt('from') || 0) * fps);
  const to = Math.round(Math.min(Number(opt('to') || duration), duration) * fps);
  const workers = Number(opt('workers')) || 5;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-promo-render-'));
  const per = Math.ceil((to - from) / workers);
  const started = Date.now();
  let done = 0;
  const parts = [];
  await Promise.all(
    Array.from({ length: workers }, async (_, w) => {
      const a = from + w * per;
      const b = Math.min(to, a + per);
      if (a >= b) return;
      const file = path.join(tmp, `part${w}.mp4`);
      parts[w] = file;
      const { page, cdp } = await open(browser);
      const ff = spawn(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png']
          .concat(['-i', '-', '-c:v', 'libx264', '-preset', 'fast', '-crf', '8'])
          .concat(['-pix_fmt', 'yuv420p', '-r', String(fps), file]),
        { stdio: ['pipe', 'inherit', 'inherit'] },
      );
      const exited = new Promise((r) => ff.on('close', r));
      for (let f = a; f < b; f++) {
        await page.evaluate((t) => window.seek(t), f / fps);
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          optimizeForSpeed: true,
        });
        if (!ff.stdin.write(Buffer.from(data, 'base64')))
          await new Promise((r) => ff.stdin.once('drain', r));
        if (++done % 120 === 0) {
          const s = (Date.now() - started) / 1000;
          console.log(`${done}/${to - from} 帧，${s.toFixed(0)} 秒`);
        }
      }
      ff.stdin.end();
      await exited;
      await page.context().close();
    }),
  );
  const list = path.join(tmp, 'parts.txt');
  await fs.writeFile(list, parts.filter(Boolean).map((p) => `file '${p}'`).join('\n'));
  const ff = (args) =>
    new Promise((resolve, reject) =>
      spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' }).on(
        'close',
        (c) => (c ? reject(Error('ffmpeg ' + c)) : resolve()),
      ),
    );
  const silent = path.join(outDir, partial ? `${title}-${from / fps}-${to / fps}.mp4` : `${title}-无配乐.mp4`);
  await ff(['-f', 'concat', '-safe', '0', '-i', list]
    .concat(['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p'])
    .concat(['-profile:v', 'high', '-movflags', '+faststart', silent]));
  console.log(silent);
  const mux = async (audio, out) => {
    await ff(['-i', silent, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k']
      .concat(['-shortest', '-movflags', '+faststart', out]));
    console.log(out);
  };
  if (track) await mux(track.file, path.join(outDir, `${title}.mp4`));
  if (track?.voiceOnly) await mux(track.voiceOnly, path.join(outDir, `${title}-仅配音.mp4`));
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒`);
}
