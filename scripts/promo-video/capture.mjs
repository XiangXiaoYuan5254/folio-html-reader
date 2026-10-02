// 宣传视频素材：用 website-shots 的示范项目和模拟 AI 启动页间，照着脚本一步步操作，
// 同时连续截图（窗口 1600×1000，截图 3200×2000）并记下鼠标轨迹。截图里没有系统光标，
// video.html 按记下的轨迹自己画。
//
// 截图只有每秒 15～25 帧，所以操作和 AI 输出都按 SLOW 倍放慢来录，视频里再按同样倍数快放，
// 看起来就是每秒 30～50 帧。白板按页间自己的 1× 讲解速度录，视频里另外加速。
//
//   node scripts/promo-video/capture.mjs            录全部片段
//   node scripts/promo-video/capture.mjs ask board  只录这几段（其余照常操作，不截图）
//
// 素材写到 系统临时目录/folio-promo/，每个片段一个目录，内有逐帧 JPEG 和 meta.json。
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { KEY, QUESTION, TRANSLATE_SOURCE, startMockAi } from '../website-shots/mock-ai.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const shots = path.join(root, 'scripts/website-shots');
const OUT = path.join(os.tmpdir(), 'folio-promo');
const PDF = 'Attention Is All You Need.pdf';
const NOTE = 'Attention 伴读笔记.html';
const SLOW = 2;
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pacing inside a clip, played back SLOW times faster.
const pause = (ms) => sleep(ms * SLOW);
const now = () => performance.now();

await fs.mkdir(path.join(OUT, 'clips'), { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-promo-run-'));
const ws = path.join(tmp, '论文精读');
await fs.cp(path.join(shots, 'fixtures'), ws, { recursive: true });
// 普通回答每 28ms 出 3 个字（再乘 SLOW），录下来能看到逐字输出
const mock = await startMockAi({ pace: 28 * SLOW, size: 3 });
const app = await electron.launch({
  args: [root],
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    FOLIO_USER_DATA: path.join(tmp, 'user-data'),
    FOLIO_WORKSPACE: ws,
  },
});
const page = await app.firstWindow();
try {
  await run();
} catch (e) {
  await page.screenshot({ path: path.join(OUT, 'error.png') });
  console.error('出错时的画面：' + path.join(OUT, 'error.png'));
  throw e;
} finally {
  await app.close();
  mock.server.close();
}

async function run() {
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.center();
  });
  await page.waitForSelector('.document-frame');
  await page.locator('.reader-loading').first().waitFor({ state: 'hidden' });
  const cdp = await page.context().newCDPSession(page);

  // ---------- 录屏 ----------
  let rec = null;
  const pointer = { x: 800, y: 560, kind: 'arrow', down: false };
  function log() {
    if (rec) rec.cursor.push({ t: now() - rec.t0, ...pointer });
  }
  async function start(name, slow = SLOW) {
    if (only.length && !only.includes(name)) return;
    const dir = path.join(OUT, 'clips', name);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    rec = { name, dir, slow, t0: now(), frames: [], cursor: [], marks: [], writes: [], on: true };
    log();
    rec.loop = (async (r) => {
      for (let i = 0; r.on; i++) {
        const t = now();
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 92,
          optimizeForSpeed: true,
        });
        const file = `f${String(i).padStart(5, '0')}.jpg`;
        r.frames.push({ t: (t + now()) / 2 - r.t0, file });
        r.writes.push(fs.writeFile(path.join(r.dir, file), Buffer.from(data, 'base64')));
      }
    })(rec);
    await pause(250);
  }
  function mark(name) {
    if (rec) rec.marks.push({ t: now() - rec.t0, name });
  }
  async function stop() {
    if (!rec) return;
    await pause(250);
    const r = rec;
    rec = null;
    r.on = false;
    await r.loop;
    await Promise.all(r.writes);
    const dur = (r.frames.at(-1).t - r.frames[0].t) / 1000;
    const { name, slow, frames, cursor, marks } = r;
    await fs.writeFile(
      path.join(r.dir, 'meta.json'),
      JSON.stringify({ name, slow, frames, cursor, marks }),
    );
    console.log(
      `clip ${name}: ${frames.length} 帧，${dur.toFixed(1)} 秒，${(frames.length / dur).toFixed(1)} 帧/秒`,
    );
  }
  async function still(name) {
    if (only.length && !only.includes(name)) return;
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('still', name);
  }

  // ---------- 鼠标与键盘：真实事件，同时记录光标 ----------
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  async function glide(x, y, ms = 550) {
    ms *= SLOW;
    const x0 = pointer.x;
    const y0 = pointer.y;
    const n = Math.max(1, Math.round(ms / 16));
    const t0 = now();
    for (let i = 1; i <= n; i++) {
      const k = easeInOut(i / n);
      pointer.x = x0 + (x - x0) * k;
      pointer.y = y0 + (y - y0) * k;
      await page.mouse.move(pointer.x, pointer.y);
      log();
      const wait = t0 + (i * ms) / n - now();
      if (wait > 0) await sleep(wait);
    }
  }
  // Constant speed along a polyline, for strokes and drags.
  async function trace(points, ms) {
    ms *= SLOW;
    const seg = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
    const total = seg.reduce((a, b) => a + b, 0);
    const n = Math.max(2, Math.round(ms / 16));
    const t0 = now();
    for (let i = 1; i <= n; i++) {
      let d = (total * i) / n;
      let j = 0;
      while (j < seg.length - 1 && d > seg[j]) d -= seg[j++];
      const a = points[j];
      const b = points[j + 1];
      const k = seg[j] ? Math.min(1, d / seg[j]) : 1;
      pointer.x = a.x + (b.x - a.x) * k;
      pointer.y = a.y + (b.y - a.y) * k;
      await page.mouse.move(pointer.x, pointer.y);
      log();
      const wait = t0 + (i * ms) / n - now();
      if (wait > 0) await sleep(wait);
    }
  }
  async function press() {
    await page.mouse.down();
    pointer.down = true;
    log();
  }
  async function release() {
    await page.mouse.up();
    pointer.down = false;
    log();
  }
  async function drag(points, ms, approach = 500) {
    await glide(points[0].x, points[0].y, approach);
    await pause(90);
    await press();
    await trace(points, ms);
    await pause(60);
    await release();
  }
  async function click(x, y, ms = 550) {
    await glide(x, y, ms);
    await pause(110);
    await press();
    await pause(70);
    await release();
    await pause(120);
  }
  async function clickOn(locator, ms = 550) {
    const b = await locator.boundingBox();
    await click(b.x + b.width / 2, b.y + b.height / 2, ms);
  }
  function cursor(kind) {
    pointer.kind = kind;
    log();
  }
  // Chinese arrives a word at a time from the input method; spaces and Latin a letter at a time.
  async function type(text, perChar = 75) {
    const parts = text.match(/[一-鿿，。、：；？！“”（）]{1,2}|./gu);
    for (const p of parts) {
      await page.keyboard.insertText(p);
      await pause(perChar * p.length * (0.8 + (0.4 * ((p.charCodeAt(0) * 7) % 10)) / 10));
    }
  }
  async function rest(x, y, ms = 700) {
    await glide(x, y, ms);
  }

  // ---------- 页间里的位置 ----------
  const frames = () => page.locator('.document-frame');
  const panel = () => page.locator('.assistant-panel');
  async function frameOf(el) {
    for (let i = 0; i < 100; i++) {
      const f = await (await el.elementHandle()).contentFrame();
      if (f && (await f.locator('[data-folio-ui=overlay]').count())) return f;
      await sleep(100);
    }
    throw Error('document frame not ready');
  }
  async function current() {
    await sleep(400);
    await page.locator('.reader-loading').first().waitFor({ state: 'hidden' });
    const el = frames().first();
    return { el, f: await frameOf(el) };
  }
  async function pane(side) {
    const el = page.locator(`[data-pane=${side}] .document-frame`);
    return { el, f: await frameOf(el) };
  }
  async function toScreen({ el }, x, y) {
    const b = await el.boundingBox();
    const s = await el.evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
    return { x: b.x + x * s, y: b.y + y * s };
  }
  async function phrase(doc, rootSel, text) {
    const rects = await doc.f.evaluate(
      ([rootSel, text]) => {
        const rootEl = document.querySelector(rootSel);
        const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
        const chars = [];
        while (walker.nextNode()) {
          const n = walker.currentNode;
          for (let i = 0; i < n.data.length; i++) if (!/\s/.test(n.data[i])) chars.push([n, i]);
        }
        const hay = chars.map(([n, i]) => n.data[i]).join('');
        const at = hay.indexOf(text.replace(/\s/g, ''));
        if (at < 0) return null;
        const [a, ai] = chars[at];
        const [b, bi] = chars[at + text.replace(/\s/g, '').length - 1];
        const r = document.createRange();
        r.setStart(a, ai);
        r.setEnd(b, bi + 1);
        return [...r.getClientRects()].filter((q) => q.width > 1).map((q) => q.toJSON());
      },
      [rootSel, text],
    );
    if (!rects) throw Error('phrase not found: ' + text);
    return rects;
  }
  // Drags across a phrase from its first to its last character, line by line.
  async function dragPhrase(doc, rootSel, text, ms = 900) {
    const rs = await phrase(doc, rootSel, text);
    const pts = [];
    for (const [i, r] of rs.entries()) {
      const y = r.top + r.height / 2;
      if (i === 0) pts.push(await toScreen(doc, r.left + 1, y));
      pts.push(await toScreen(doc, r.right - 1, y));
    }
    await drag(pts, ms);
    return rs;
  }
  async function tool(label, ms = 450) {
    await clickOn(page.getByLabel(label, { exact: true }).first(), ms);
  }
  async function color(name, ms = 380) {
    await clickOn(page.getByLabel(name, { exact: true }).first(), ms);
  }
  async function openFile(name) {
    await page
      .getByRole('navigation', { name: '项目文件' })
      .getByRole('button', { name, exact: true })
      .click();
    await sleep(1200);
    return current();
  }
  async function selectTab(name) {
    await page.getByRole('tab', { name, exact: true }).click();
    await sleep(1200);
    return current();
  }
  async function inspector(visible) {
    if ((await page.locator('.inspector').isVisible()) !== visible)
      await page.getByLabel('显示或隐藏批注栏', { exact: true }).first().click();
    await sleep(500);
  }
  async function inspectorTab(name) {
    await inspector(true);
    await page.locator('.inspector-tabs button', { hasText: name }).click();
    await sleep(400);
  }
  async function consent() {
    const dialog = page.getByRole('dialog', { name: /发送给/ });
    try {
      await dialog.waitFor({ timeout: 2500 });
      await dialog.getByRole('button', { name: '同意并继续' }).click();
    } catch {}
  }
  async function answered(count) {
    for (let i = 0; i < 1200; i++) {
      if ((await panel().locator('.chat-answer.done').count()) >= count) return;
      await sleep(100);
    }
    throw Error('no answer');
  }
  function ellipsePoints(box, [px, py], map) {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const pts = [];
    for (let i = 0; i <= 34; i++) {
      const t = (i / 30) * Math.PI * 2 - 0.6;
      pts.push(map(cx + (box.width / 2 + px) * Math.cos(t), cy + (box.height / 2 + py) * Math.sin(t)));
    }
    return pts;
  }
  async function ellipse(doc, box, pad, ms = 750) {
    const pts = await Promise.all(ellipsePoints(box, pad, (x, y) => toScreen(doc, x, y)));
    await drag(pts, ms);
  }
  async function star(doc, cx, cy, R = 15, ms = 650) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? R * 0.42 : R;
      pts.push(await toScreen(doc, cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
    await drag(pts, ms);
  }
  async function scrollPdf(doc, n, y) {
    await doc.f.evaluate(
      ([n, y]) => {
        const el = document.querySelector(`.pdf-page[data-pdf-page="${n}"]`);
        scrollTo(0, el.getBoundingClientRect().top + scrollY + y);
      },
      [n, y],
    );
    await sleep(1200);
  }
  async function scrollHtml(doc, sel, offset) {
    await doc.f.evaluate(
      ([sel, offset]) =>
        scrollTo(0, document.querySelector(sel).getBoundingClientRect().top + scrollY - offset),
      [sel, offset],
    );
    await sleep(500);
  }
  // Smooth wheel scrolling under the pointer.
  async function wheel(dy, ms = 900) {
    ms *= SLOW;
    const n = Math.round(ms / 16);
    let done = 0;
    for (let i = 1; i <= n; i++) {
      const to = Math.round(dy * easeInOut(i / n));
      await page.mouse.wheel(0, to - done);
      done = to;
      await sleep(16);
    }
  }
  async function settle() {
    await page.keyboard.press('Escape');
    await page.mouse.move(5, 500);
    pointer.x = 5;
    pointer.y = 500;
    await sleep(700);
  }

  // ---------- 准备：打开两篇，配置 AI（不录） ----------
  await page
    .getByLabel(/^关闭 /)
    .first()
    .click();
  await sleep(500);
  let pdf = await openFile(PDF);
  let note = await openFile(NOTE);
  await page.getByLabel('AI 助手', { exact: true }).first().click();
  await panel().getByRole('button', { name: '配置 AI 服务', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 设置' });
  await settings.getByRole('button', { name: /^DeepSeek/ }).click();
  await settings.getByLabel('API Key').fill(KEY);
  await settings.getByRole('button', { name: /高级设置/ }).click();
  await settings.getByLabel('接口地址').fill(mock.url);
  await settings.getByRole('button', { name: '获取列表' }).click();
  await settings.getByRole('option', { name: 'deepseek-chat', exact: true }).click();
  await settings.getByRole('button', { name: '添加', exact: true }).click();
  await settings.getByText('已保存').waitFor();
  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  // 第一次用这个服务会先征求同意：在阅读清单里问一句，把这一步留在录像之外
  await openFile('阅读清单.html');
  await inspectorTab('助手');
  await panel().getByLabel('向 AI 提问').fill('这份清单里有几篇？');
  await panel().getByLabel('向 AI 提问').press('Enter');
  await consent();
  await answered(1);
  await page.getByLabel('关闭 阅读清单.html', { exact: true }).click();
  await sleep(600);
  await inspector(false);
  note = await selectTab(NOTE);
  await scrollHtml(note, 'main', 0);
  await settle();
  await still('clean-note');

  // 自由位置的批注（手绘、便签）按页面坐标保存，布局一变窄就会压到正文，
  // 所以伴读笔记上的批注片段放在双栏、助手、源码这些片段之后录。

  // ---------- 片段：把论文从文件树拖进阅读区，组成双栏 ----------
  await start('split');
  {
    const src = await page.locator(`.tree-row[data-file-path="Transformer/${PDF}"]`).boundingBox();
    const target = await page.locator('.document-workbench').boundingBox();
    const x = target.x + target.width * 0.78;
    const y = target.y + 300;
    await glide(src.x + 70, src.y + src.height / 2, 700);
    await pause(150);
    await press();
    cursor('grab');
    await trace([{ ...pointer }, { x: src.x + 95, y: src.y + src.height / 2 + 6 }], 120);
    mark('drag');
    await glide(x, y, 1100);
    await page.mouse.move(x + 1, y + 1);
    await page.locator('.reading-drop-preview.hovered').waitFor();
    await pause(500);
    mark('drop');
    await release();
    cursor('arrow');
    await page.locator('.reading-drop-overlay').waitFor({ state: 'hidden' });
    for (let i = 0; i < 100 && (await frames().count()) < 2; i++) await sleep(100);
    await pause(1300);
    // 两栏各自滚到公式
    const left = await pane('left');
    await glide(560, 560, 500);
    mark('scroll');
    await wheel(
      await left.f.evaluate(
        () => document.querySelector('#sec-formula').getBoundingClientRect().top - 30,
      ),
      1100,
    );
    const right = await pane('right');
    await glide(1180, 560, 500);
    await wheel(
      await right.f.evaluate(
        () =>
          document.querySelector('.pdf-page[data-pdf-page="4"]').getBoundingClientRect().top + 40,
      ),
      1300,
    );
    await pause(900);
  }
  await stop();
  await page.getByRole('button', { name: '退出双栏' }).click();
  await sleep(1200);

  // ---------- 片段：PDF 上选字高亮、圈注 ----------
  pdf = await selectTab(PDF);
  await inspector(false);
  pdf = await current();
  await scrollPdf(pdf, 1, 150);
  await page.getByLabel('黄色', { exact: true }).first().click();
  await settle();
  await start('pdf');
  {
    await rest(900, 600, 300);
    cursor('ibeam');
    mark('select');
    await dragPhrase(
      pdf,
      '.pdf-page[data-pdf-page="1"]',
      'based solely on attention mechanisms, dispensing with recurrence and convolutions',
      1000,
    );
    cursor('arrow');
    await page.locator('.selection-toolbar').waitFor();
    await pause(250);
    mark('highlight');
    await clickOn(
      page.locator('.selection-toolbar').getByRole('button', { name: '高亮', exact: true }),
      600,
    );
    await pause(400);
    await tool('画笔', 700);
    await color('珊瑚色');
    cursor('pen:#d93b4b');
    mark('circle');
    await ellipse(
      pdf,
      (await phrase(pdf, '.pdf-page[data-pdf-page="1"]', '28.4 BLEU'))[0],
      [9, 6],
      800,
    );
    cursor('arrow');
    await tool('选择文字', 650);
    await rest(1100, 880, 600);
    await pause(500);
  }
  await stop();
  await settle();

  // ---------- 片段：问这篇文档，回答带原文引用 ----------
  note = await selectTab(NOTE);
  await inspector(false);
  note = await current();
  await scrollHtml(note, 'main', 0);
  await settle();
  await start('ask');
  {
    await rest(1000, 560, 300);
    mark('open');
    await clickOn(page.getByLabel('AI 助手', { exact: true }).first(), 800);
    await panel().getByLabel('向 AI 提问').waitFor();
    await pause(500);
    await clickOn(panel().getByLabel('向 AI 提问'), 650);
    cursor('ibeam');
    mark('type');
    await type(QUESTION, 85);
    await pause(250);
    mark('send');
    await page.keyboard.press('Enter');
    cursor('arrow');
    await rest(1300, 760, 900);
    await answered(1);
    mark('done');
    await pause(900);
    const chip = panel().locator('.chat-answer.done').last().locator('.cite-chip').nth(2);
    mark('cite');
    await clickOn(chip, 800);
    await pause(2200);
  }
  await stop();
  await settle();
  await inspector(false);

  // ---------- 片段：AI 划重点 ----------
  pdf = await selectTab(PDF);
  await inspectorTab('助手');
  pdf = await current();
  await scrollPdf(pdf, 2, 140);
  await settle();
  await start('highlights');
  {
    let asked = await panel().locator('.chat-answer.done').count();
    await rest(1000, 560, 300);
    mark('click');
    await clickOn(panel().getByRole('button', { name: 'AI 划重点' }).first(), 900);
    await rest(1250, 640, 800);
    await answered(++asked);
    mark('done');
    await pause(2500);
  }
  await stop();
  await settle();

  // ---------- 片段：划词翻译 ----------
  pdf = await current();
  await start('translate');
  {
    await rest(700, 300, 300);
    cursor('ibeam');
    mark('select');
    await dragPhrase(pdf, '.pdf-page[data-pdf-page="2"]', TRANSLATE_SOURCE, 1100);
    cursor('arrow');
    await page.locator('.selection-toolbar').waitFor();
    await pause(300);
    mark('translate');
    await clickOn(page.locator('.selection-toolbar').getByRole('button', { name: '翻译' }), 700);
    await page.locator('.ai-card').getByText(/transduction/).waitFor();
    for (let i = 0; i < 300; i++) {
      if (await page.locator('.ai-card').getByText('相隔多远').count()) break;
      await sleep(100);
    }
    mark('done');
    await rest(1000, 900, 700);
    await pause(1500);
  }
  await stop();
  await page.getByLabel('关闭 AI 卡片', { exact: true }).click();
  await settle();
  await inspector(false);

  // ---------- 片段：白板讲解，讲完学生圈出没懂的地方（按页间的 1× 速度录） ----------
  note = await selectTab(NOTE);
  await inspector(false);
  note = await current();
  await scrollHtml(note, '#why', 360);
  await settle();
  await start('board');
  {
    const r = await note.f.locator('#why').evaluate((e) => e.getBoundingClientRect().toJSON());
    await rest(900, 500, 300);
    cursor('ibeam');
    mark('select');
    await drag(
      [
        await toScreen(note, r.left + 22, r.top + 18),
        await toScreen(note, r.right - 30, r.bottom - 18),
      ],
      900,
    );
    cursor('arrow');
    await page.locator('.selection-toolbar').waitFor();
    await pause(300);
    mark('open');
    await clickOn(page.locator('.selection-toolbar').getByRole('button', { name: '白板' }), 700);
    const board = page.getByRole('dialog', { name: '白板讲解' });
    await board.getByRole('button', { name: '直接讲' }).waitFor();
    await pause(500);
    mark('start');
    await clickOn(board.getByRole('button', { name: '直接讲' }), 700);
    await rest(1450, 700, 900);
    await board.locator('.wb-caption-text', { hasText: '圈出来问我' }).waitFor({ timeout: 240000 });
    mark('ask');
    await pause(1500);
    const t = await board
      .locator('.wb-text')
      .last()
      .evaluate((e) => e.getBoundingClientRect().toJSON());
    const box = { left: t.left + t.width * 0.48, top: t.top, width: t.width * 0.3, height: t.height };
    cursor('pen:#7c5cff');
    mark('circle');
    await drag(ellipsePoints(box, [12, 10], (x, y) => ({ x, y })), 900, 800);
    cursor('arrow');
    await clickOn(board.getByLabel('向页老师提问'), 700);
    cursor('ibeam');
    mark('type');
    await type('softmax “饱和”是什么意思？', 80);
    cursor('arrow');
    await rest(1500, 980, 600);
    await pause(1200);
  }
  await stop();
  await page.getByRole('dialog', { name: '白板讲解' }).getByLabel('关闭白板', { exact: true }).click();
  await sleep(800);
  await settle();

  // ---------- 片段：源码模式，AI 修改：看对比，预览修改前后 ----------
  note = await current();
  await scrollHtml(note, 'main', 0);
  await inspector(false);
  await settle();
  await start('source');
  {
    await rest(900, 500, 300);
    mark('source');
    await clickOn(page.getByRole('button', { name: '源码', exact: true }), 800);
    await pause(1400);
    mark('ai');
    await clickOn(page.getByRole('button', { name: 'AI 修改' }), 750);
    await pause(400);
    await clickOn(page.getByLabel('修改要求'), 600);
    cursor('ibeam');
    mark('type');
    await type('让“一句话总结”更醒目一些，和正文拉开层次', 70);
    cursor('arrow');
    await pause(250);
    mark('generate');
    await clickOn(page.getByRole('button', { name: '生成修改' }), 650);
    await page.locator('.ai-source .diff-view').waitFor();
    mark('diff');
    await rest(1180, 420, 900);
    await pause(1300);
    const before = page.locator('.ai-source').getByText('预览修改前');
    mark('before');
    await clickOn(before, 800);
    await pause(1300);
    mark('after');
    await clickOn(before, 400);
    await rest(1180, 560, 700);
    await pause(1200);
  }
  await stop();
  await page.locator('.ai-source').getByRole('button', { name: '放弃' }).click();
  await page.getByLabel('关闭 AI 修改', { exact: true }).click();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await sleep(1200);
  await settle();

  // ---------- 片段：HTML 上高亮、手绘、便签、箭头 ----------
  note = await current();
  await scrollHtml(note, 'main', 0);
  await inspector(false);
  await settle();
  await start('annotate');
  {
    await rest(980, 560, 300);
    await tool('高亮');
    await color('黄色');
    cursor('ibeam');
    mark('hl1');
    await dragPhrase(note, 'main', '去掉了 RNN 的循环结构，让序列建模可以高度并行', 1000);
    cursor('arrow');
    await color('青色', 650);
    cursor('ibeam');
    mark('hl2');
    const path2 = await dragPhrase(
      note,
      'main',
      '自注意力让任意两个位置直接相连，最长路径只有 O(1)。',
      1000,
    );
    cursor('arrow');
    await tool('画笔', 650);
    await color('珊瑚色');
    cursor('pen:#d93b4b');
    mark('circle');
    await ellipse(note, (await phrase(note, 'main', '28.4 BLEU'))[0], [9, 6], 800);
    const h1 = await note.f.locator('h1').evaluate((e) => e.getBoundingClientRect().toJSON());
    mark('star');
    await star(note, h1.left - 30, h1.top + h1.height / 2, 15, 700);
    cursor('arrow');
    await tool('便签', 650);
    await color('黄色');
    cursor('cross');
    const main = await note.f.locator('main').evaluate((e) => e.getBoundingClientRect().toJSON());
    const end = path2.at(-1);
    const y = end.top + end.height / 2;
    const at = await toScreen(note, main.right + 16, y - 80);
    mark('sticky');
    await click(at.x, at.y, 650);
    cursor('ibeam');
    const card = note.f.getByRole('group', { name: '页面便签', exact: true }).last();
    await card.waitFor();
    await pause(250);
    await type('对照原文表 1：循环网络的最长路径是 O(n)。', 70);
    await pause(300);
    const c = await card.evaluate((e) => e.getBoundingClientRect().toJSON());
    cursor('arrow');
    await tool('箭头', 650);
    await color('珊瑚色');
    cursor('cross');
    mark('arrow');
    await drag(
      [await toScreen(note, c.left - 8, y), await toScreen(note, end.right + 12, y)],
      500,
      600,
    );
    cursor('arrow');
    await tool('选择文字', 650);
    await rest(1180, 860, 700);
    await pause(600);
  }
  await stop();
  await settle();
  await still('annotated-note');

  // ---------- 片段：制作精读笔记，在右栏并排打开 ----------
  pdf = await selectTab(PDF);
  await inspectorTab('助手');
  pdf = await current();
  await scrollPdf(pdf, 1, 60);
  await settle();
  await start('companion');
  {
    await rest(1000, 560, 300);
    mark('click');
    await clickOn(panel().getByRole('button', { name: '制作精读笔记' }).first(), 900);
    await rest(1250, 700, 800);
    await page
      .locator('.reading-column')
      .nth(1)
      .locator('.pane-document-title', { hasText: '精读笔记' })
      .waitFor({ timeout: 60000 });
    mark('open');
    await pause(1500);
    mark('close-inspector');
    await clickOn(page.getByLabel('显示或隐藏批注栏', { exact: true }).first(), 800);
    await pause(800);
    await glide(1150, 600, 600);
    mark('scroll');
    await wheel(620, 1400);
    await pause(1200);
  }
  await stop();
}
