// 生成官网截图：用 fixtures/ 里的示范项目启动页间，添加批注、使用 AI 功能、切换主题后截图，
// 裁剪压缩为 website/assets/*.webp，并生成分享图 og.png。AI 的回答来自 mock-ai.mjs
// 里的本地模拟服务，不联网。
//
//   npm run website:shots
//
// 论文 PDF 不进版本库，需要先放到
//   scripts/website-shots/fixtures/Transformer/Attention Is All You Need.pdf
// （arXiv:1706.03762）。原始 PNG 截图保存在系统临时目录，路径会打印出来。
// 只想重新裁剪时，把那个目录传给 FOLIO_SHOTS_RAW，跳过拍摄：
//   FOLIO_SHOTS_RAW=/tmp/folio-shots-xxx/raw npm run website:shots
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KEY, QUESTION, TRANSLATE_SOURCE, startMockAi } from './mock-ai.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const assets = path.join(root, 'website/assets');
const PDF = 'Attention Is All You Need.pdf';
const NOTE = 'Attention 伴读笔记.html';
const COMPANION = 'Attention Is All You Need-精读笔记.html';
// 与 src/theme.ts 的主题列表一致
const THEMES = [
  ['default', '青岚：默认 · 清爽青绿'],
  ['paper', '宣纸：暖白纸色 · 朱砂点染'],
  ['sky', '晴空：通透天蓝 · 渐变按钮'],
  ['blossom', '桃夭：柔和樱粉 · 温润不刺眼'],
  ['brutal', '新粗野：粗黑描边 · 硬投影撞色'],
  ['editorial', '报刊：报纸版式 · 黑白朱红'],
  ['night', '夜读：深蓝灰 · 青绿微光'],
  ['ink', '墨金：墨色沉静 · 鎏金点缀'],
  ['terminal', '终端：荧光绿 · 等宽扫描线'],
  ['aurora', '极光：极光渐变 · 毛玻璃浮层'],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let raw = process.env.FOLIO_SHOTS_RAW;
if (!raw) {
  try {
    await fs.access(path.join(here, 'fixtures/Transformer', PDF));
  } catch {
    console.error(`缺少论文 PDF：scripts/website-shots/fixtures/Transformer/${PDF}`);
    process.exit(1);
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-shots-'));
  raw = path.join(tmp, 'raw');
  await fs.mkdir(raw);
  await shootAll(tmp);
}
await encode();
console.log('原始截图：' + raw);

async function shootAll(tmp) {
  const ws = path.join(tmp, '论文精读');
  await fs.cp(path.join(here, 'fixtures'), ws, { recursive: true });
  const mock = await startMockAi();
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
  try {
    await scenes(app, ws, mock.url);
  } catch (e) {
    await (await app.firstWindow()).screenshot({ path: path.join(raw, 'error.png') });
    console.error('出错时的画面：' + path.join(raw, 'error.png'));
    throw e;
  } finally {
    await app.close();
    mock.server.close();
  }
}

async function scenes(app, ws, aiUrl) {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.center();
  });
  await page.waitForSelector('.document-frame');
  await page.locator('.reader-loading').first().waitFor({ state: 'hidden' });

  // ---------- helpers ----------
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
  // Frame coordinates to window coordinates, accounting for the frame's CSS scale.
  async function toScreen({ el }, x, y) {
    const b = await el.boundingBox();
    const s = await el.evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
    return { x: b.x + x * s, y: b.y + y * s };
  }
  async function drag(points, steps = 4) {
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps });
    await page.mouse.up();
    await sleep(350);
  }
  async function tool(label) {
    await page.getByLabel(label, { exact: true }).first().click();
    await sleep(150);
  }
  async function color(name) {
    await page.getByLabel(name, { exact: true }).first().click();
    await sleep(120);
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
      await page.getByLabel('显示或隐藏批注栏', { exact: true }).click();
    await sleep(500);
  }
  async function inspectorTab(name) {
    await inspector(true);
    await page.locator('.inspector-tabs button', { hasText: name }).click();
    await sleep(400);
  }
  // The first request to a service asks whether the document may be sent to it.
  async function consent() {
    const dialog = page.getByRole('dialog', { name: /发送给/ });
    try {
      await dialog.waitFor({ timeout: 2500 });
      await dialog.getByRole('button', { name: '同意并继续' }).click();
    } catch {}
  }
  async function answered(count) {
    for (let i = 0; i < 300; i++) {
      if ((await panel().locator('.chat-answer.done').count()) >= count) return sleep(600);
      await sleep(100);
    }
    throw Error('no answer');
  }
  // Client rects of a phrase inside `rootSel`, ignoring whitespace (PDF lines are separate spans).
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
  async function dragPhrase(doc, rootSel, text) {
    const rs = await phrase(doc, rootSel, text);
    const a = rs[0];
    const z = rs.at(-1);
    const p1 = await toScreen(doc, a.left + 1, a.top + a.height / 2);
    const p2 = await toScreen(doc, z.right - 1, z.top + z.height / 2);
    await drag([p1, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, p2], 8);
    return rs;
  }
  // HTML: the highlight/underline tool marks the dragged text directly.
  async function htmlMark(doc, text, how, colorName) {
    await tool(how);
    await color(colorName);
    return dragPhrase(doc, 'main', text);
  }
  // PDF: select text, then use the selection toolbar.
  async function pdfHighlight(doc, n, text, colorName) {
    await tool('选择文字');
    const rs = await dragPhrase(doc, `.pdf-page[data-pdf-page="${n}"]`, text);
    await page.locator('.selection-toolbar').waitFor();
    await color(colorName);
    await page
      .locator('.selection-toolbar')
      .getByRole('button', { name: '高亮', exact: true })
      .click();
    await sleep(500);
    return rs;
  }
  // Native clicks at the element's position; PDF text layers sit above the popup for Playwright's hit test.
  async function clickIn(doc, locator) {
    const r = await locator.evaluate((e) => e.getBoundingClientRect().toJSON());
    const p = await toScreen(doc, r.left + r.width / 2, r.top + r.height / 2);
    await page.mouse.click(p.x, p.y);
    await sleep(200);
  }
  async function addNote(doc, rect, text) {
    await tool('选择文字');
    const p = await toScreen(doc, rect.left + 12, rect.top + rect.height / 2);
    await page.mouse.click(p.x, p.y);
    const popup = doc.f.getByRole('group', { name: '批注笔记编辑', exact: true });
    await popup.waitFor();
    await clickIn(doc, popup.getByRole('button', { name: '添加笔记', exact: true }));
    await page.keyboard.insertText(text);
    await clickIn(doc, popup.getByRole('button', { name: '完成笔记', exact: true }));
    await sleep(300);
  }
  function ellipsePoints(box, [px, py], map) {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const pts = [];
    for (let i = 0; i <= 30; i++) {
      const t = (i / 27) * Math.PI * 2 - 0.5;
      pts.push(map(cx + (box.width / 2 + px) * Math.cos(t), cy + (box.height / 2 + py) * Math.sin(t)));
    }
    return pts;
  }
  async function ellipse(doc, box, pad = [10, 7]) {
    const pts = await Promise.all(ellipsePoints(box, pad, (x, y) => toScreen(doc, x, y)));
    await drag(pts, 2);
  }
  async function star(doc, cx, cy, R = 15) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? R * 0.42 : R;
      pts.push(await toScreen(doc, cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
    await drag(pts, 3);
  }
  // New notes reuse the last size and are nudged to fit, so resize first, then drag into place.
  async function sticky(doc, x, y, text, [w, h]) {
    await tool('便签');
    await color('黄色');
    const p = await toScreen(doc, x, y);
    await page.mouse.click(p.x, p.y);
    const card = doc.f.getByRole('group', { name: '页面便签', exact: true }).last();
    await card.waitFor();
    await page.keyboard.insertText(text);
    await sleep(500);
    const rect = () => card.evaluate((e) => e.getBoundingClientRect().toJSON());
    const handle = await card
      .getByLabel('调整便签大小', { exact: true })
      .evaluate((e) => e.getBoundingClientRect().toJSON());
    let r = await rect();
    const s1 = await toScreen(doc, handle.x + handle.width / 2, handle.y + handle.height / 2);
    const s2 = await toScreen(
      doc,
      handle.x + handle.width / 2 + w - r.width,
      handle.y + handle.height / 2 + h - r.height,
    );
    await drag([s1, s2], 10);
    r = await rect();
    const head = await card.locator('.head').evaluate((e) => e.getBoundingClientRect().toJSON());
    const m1 = await toScreen(doc, head.x + 30, head.y + head.height / 2);
    const m2 = await toScreen(doc, head.x + 30 + x - r.left, head.y + head.height / 2 + y - r.top);
    await drag([m1, m2], 10);
    await tool('选择文字');
    return rect();
  }
  async function textNote(doc, x, y, text, colorName) {
    await tool('文本注释');
    await color(colorName);
    const p = await toScreen(doc, x, y);
    await page.mouse.click(p.x, p.y);
    const card = doc.f.getByRole('group', { name: '页面文本注释', exact: true }).last();
    await card.waitFor();
    await card.getByLabel('文本注释内容', { exact: true }).fill(text);
    await sleep(300);
    await tool('选择文字');
  }
  async function pdfPage(doc, n) {
    return doc.f.evaluate(
      (n) =>
        document.querySelector(`.pdf-page[data-pdf-page="${n}"]`).getBoundingClientRect().toJSON(),
      n,
    );
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
  async function settle(escape = true) {
    const select = page.getByLabel('选择文字', { exact: true }).first();
    if (await select.isVisible()) await select.click();
    if (escape) await page.keyboard.press('Escape');
    await page.mouse.move(5, 500);
    await sleep(700);
  }
  async function shot(name, escape = true) {
    if (escape !== null) await settle(escape);
    await page.screenshot({ path: path.join(raw, name + '.png') });
    console.log('shot', name);
  }

  // ---------- scenes ----------
  await page
    .getByLabel(/^关闭 /)
    .first()
    .click(); // 首次启动自动打开的第一篇
  await sleep(500);
  let pdf = await openFile(PDF);
  let note = await openFile(NOTE);

  // AI 服务：DeepSeek 类型，接口地址指向本地模拟服务
  await page.getByLabel('AI 助手', { exact: true }).click();
  await panel().getByRole('button', { name: '配置 AI 服务', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'AI 设置' });
  await settings.getByRole('button', { name: /^DeepSeek/ }).click();
  await settings.getByLabel('API Key').fill(KEY);
  await settings.getByRole('button', { name: /高级设置/ }).click();
  await settings.getByLabel('接口地址').fill(aiUrl);
  await settings.getByRole('button', { name: '获取列表' }).click();
  await settings.getByRole('option', { name: 'deepseek-chat', exact: true }).click();
  await settings.getByRole('button', { name: '添加', exact: true }).click();
  await settings.getByText('已保存').waitFor();
  await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  await inspector(false);
  note = await current();

  // 伴读笔记：锚定在文字上的标记（任何宽度下都跟着原文走）
  await htmlMark(note, '去掉了 RNN 的循环结构，让序列建模可以高度并行', '高亮', '黄色');
  await addNote(
    note,
    (await phrase(note, 'main', '去掉了 RNN 的循环结构'))[0],
    '并行 = 训练快，这是后来能把模型做大的前提。',
  );
  await htmlMark(note, '自注意力让任意两个位置直接相连，最长路径只有 O(1)。', '高亮', '青色');
  await htmlMark(note, '序列内部没法并行', '下划线', '蓝色');
  await htmlMark(note, '自注意力反而比循环网络更省', '高亮', '黄色');

  // 源码模式，以及 AI 修改的对比与预览（看完放弃，不写入）
  await scrollHtml(note, 'main', 0);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await sleep(2000);
  await shot('source');
  await page.getByRole('button', { name: 'AI 修改' }).click();
  await page.getByLabel('修改要求').fill('让“一句话总结”更醒目一些，和正文拉开层次');
  await page.getByRole('button', { name: '生成修改' }).click();
  await consent();
  await page.locator('.ai-source .diff-view').waitFor();
  await sleep(1500);
  await shot('ai-source');
  await page.locator('.ai-source').getByRole('button', { name: '放弃' }).click();
  await page.getByLabel('关闭 AI 修改', { exact: true }).click();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await sleep(1200);
  note = await current();

  // 专注阅读
  await scrollHtml(note, '#sec-formula', 40);
  await page.getByLabel('专注阅读', { exact: true }).first().click();
  await sleep(2000);
  await shot('focus', false); // Esc 会退出专注模式
  await page.keyboard.press('Escape');
  await sleep(1200);

  // 论文：第 1 页摘要、第 4 页公式。
  // 高亮都选单行文字，批注栏里的摘录更整齐。
  pdf = await selectTab(PDF);
  await inspectorTab('批注');
  pdf = await current();
  await scrollPdf(pdf, 1, 150);
  {
    const abs = await pdfHighlight(
      pdf,
      1,
      'based solely on attention mechanisms, dispensing with recurrence and convolutions',
      '黄色',
    );
    await addNote(pdf, abs[0], '核心主张：只用注意力，彻底不要 RNN 和 CNN。');
    await pdfHighlight(pdf, 1, '3.5 days on eight GPUs', '青色');
    const bleu = await phrase(pdf, '.pdf-page[data-pdf-page="1"]', '28.4 BLEU');
    await tool('画笔');
    await color('珊瑚色');
    await ellipse(pdf, bleu[0], [9, 6]);
    const title = await phrase(pdf, '.pdf-page[data-pdf-page="1"]', 'Attention Is All You Need');
    await star(pdf, title[0].left - 34, title[0].top + title[0].height / 2, 14);
    const pg = await pdfPage(pdf, 1);
    const head = await phrase(pdf, '.pdf-page[data-pdf-page="1"]', 'Abstract');
    const c = await sticky(
      pdf,
      pg.left + pg.width * 0.775,
      head[0].top - 10,
      '先读 3.2 节和图 2',
      [176, 116],
    );
    await tool('箭头');
    await color('珊瑚色');
    const a1 = await toScreen(pdf, c.left + 26, c.bottom + 6);
    const a2 = await toScreen(pdf, abs[0].right + 6, abs[0].top + abs[0].height / 2);
    await drag([a1, a2]);
  }

  await scrollPdf(pdf, 4, 380);
  {
    await pdfHighlight(
      pdf,
      4,
      'We call our particular attention "Scaled Dot-Product Attention"',
      '黄色',
    );
    const pg = await pdfPage(pdf, 4);
    const eq = await phrase(pdf, '.pdf-page[data-pdf-page="4"]', 'Attention(');
    await tool('画笔');
    await color('珊瑚色');
    await ellipse(
      pdf,
      { left: eq[0].left - 4, top: eq[0].top - 14, width: pg.width * 0.3, height: 44 },
      [14, 8],
    );
    await textNote(pdf, pg.left + pg.width * 0.17, eq[0].top - 4, '核心公式', '珊瑚色');
  }
  await scrollPdf(pdf, 1, 150);
  await shot('annotate');

  // 双栏：左伴读笔记，右论文第 4 页
  note = await selectTab(NOTE);
  await inspector(false);
  await page.getByRole('button', { name: '双栏阅读' }).click();
  await sleep(2000);
  {
    const left = await pane('left');
    const right = await pane('right');
    await scrollHtml(left, '#sec-formula', 30);
    await scrollPdf(right, 4, 40);
  }
  await shot('split');
  await page.getByRole('button', { name: '退出双栏' }).click();
  await sleep(1200);

  // AI 划重点：论文第 2 页
  pdf = await selectTab(PDF);
  await inspectorTab('助手');
  let asked = await panel().locator('.chat-answer.done').count();
  await panel().getByRole('button', { name: 'AI 划重点' }).first().click();
  await consent();
  await answered(++asked);
  pdf = await current();
  await scrollPdf(pdf, 2, 140);
  await shot('ai-highlights');

  // 划词翻译：同一页的另一句
  pdf = await current();
  await tool('选择文字');
  await dragPhrase(pdf, '.pdf-page[data-pdf-page="2"]', TRANSLATE_SOURCE);
  await page.locator('.selection-toolbar').getByRole('button', { name: '翻译' }).click();
  await page.locator('.ai-card').getByText(/transduction/).waitFor();
  await sleep(800);
  await page.mouse.move(5, 500);
  await shot('ai-translate', null);
  await page.getByLabel('关闭 AI 卡片', { exact: true }).click();
  await page.keyboard.press('Escape');

  // 主图：伴读笔记开头，右侧助手回答问题，引用原文
  note = await selectTab(NOTE);
  await scrollHtml(note, 'main', 0);
  await inspectorTab('助手');
  asked = await panel().locator('.chat-answer.done').count();
  await panel().getByLabel('向 AI 提问').fill(QUESTION);
  await panel().getByLabel('向 AI 提问').press('Enter');
  await consent();
  await answered(asked + 1);
  await shot('hero');

  // 同一画面，十套主题
  for (const [id, label] of THEMES) {
    await page.getByLabel('界面主题', { exact: true }).click();
    await page.getByRole('dialog', { name: '界面主题' }).getByLabel(label, { exact: true }).click();
    await page.keyboard.press('Escape');
    await sleep(1200);
    await shot('theme-' + id, false);
  }
  await page.getByLabel('界面主题', { exact: true }).click();
  await page
    .getByRole('dialog', { name: '界面主题' })
    .getByLabel(THEMES[0][1], { exact: true })
    .click();
  await page.keyboard.press('Escape');
  await sleep(800);

  // 白板：讲“为什么要除以 √dk”，讲完后学生圈出没懂的地方
  note = await current();
  await scrollHtml(note, '#why', 360);
  {
    const r = await note.f.locator('#why').evaluate((e) => e.getBoundingClientRect().toJSON());
    await drag(
      [await toScreen(note, r.left + 22, r.top + 18), await toScreen(note, r.right - 30, r.bottom - 18)],
      12,
    );
  }
  await page.locator('.selection-toolbar').getByRole('button', { name: '白板' }).click();
  const board = page.getByRole('dialog', { name: '白板讲解' });
  await board.getByRole('button', { name: '直接讲' }).click();
  await board.locator('.wb-speed').click();
  await board.locator('.wb-speed').click();
  await board.locator('.wb-caption-text', { hasText: '圈出来问我' }).waitFor({ timeout: 120000 });
  await sleep(2500);
  {
    const t = await board
      .locator('.wb-text')
      .last()
      .evaluate((e) => e.getBoundingClientRect().toJSON());
    const box = { left: t.left + t.width * 0.48, top: t.top, width: t.width * 0.3, height: t.height };
    await drag(ellipsePoints(box, [12, 10], (x, y) => ({ x, y })), 2);
  }
  await board.getByLabel('向页老师提问').fill('softmax “饱和”是什么意思？');
  await page.mouse.move(5, 500);
  await sleep(600);
  await shot('board', null);
  await board.getByLabel('关闭白板', { exact: true }).click();
  await sleep(800);

  // 批注：伴读笔记开头。自由位置的批注（星标、圈注、便签、箭头）只在这个最终宽度下添加。
  await inspector(false);
  note = await current();
  await scrollHtml(note, 'main', 0);
  {
    const main = await note.f.locator('main').evaluate((e) => e.getBoundingClientRect().toJSON());
    const h1 = await note.f.locator('h1').evaluate((e) => e.getBoundingClientRect().toJSON());
    const path = await phrase(note, 'main', '自注意力让任意两个位置直接相连，最长路径只有 O(1)。');
    await tool('画笔');
    await color('珊瑚色');
    await star(note, h1.left - 30, h1.top + h1.height / 2, 15);
    await ellipse(note, (await phrase(note, 'main', '28.4 BLEU'))[0], [9, 6]);
    const end = path.at(-1);
    const y = end.top + end.height / 2;
    const c = await sticky(
      note,
      main.right + 16,
      y - 80,
      '对照原文表 1：循环网络的最长路径是 O(n)。',
      [250, 140],
    );
    // 水平箭头：第二行高亮之后是空白，不会压到正文
    await tool('箭头');
    await color('珊瑚色');
    await drag([await toScreen(note, c.left - 8, y), await toScreen(note, end.right + 12, y)]);
  }
  await scrollHtml(note, 'main', 0);
  await shot('reading');

  // 精读笔记：写在论文旁边，并排打开。放在最后，前面的截图里文件树还没有它。
  pdf = await selectTab(PDF);
  await inspectorTab('助手');
  await panel().getByRole('button', { name: '制作精读笔记' }).first().click();
  await page
    .locator('.reading-column')
    .nth(1)
    .locator('.pane-document-title', { hasText: COMPANION })
    .waitFor({ timeout: 30000 });
  await sleep(1500);
  await inspector(false);
  await scrollPdf(await pane('left'), 1, 60);
  await shot('ai-note');
}

// ---------- 裁剪、压缩 ----------
async function encode() {
  // 裁剪框 [x, y, 宽, 高] 以窗口 CSS 像素计（窗口 1600×1000）；专注模式截的是整个屏幕，按比例裁中间。
  const full = [0, 0, 1600, 1000];
  const jobs = [
    { name: 'hero', crop: full, width: 2400 },
    { name: 'reading', crop: full, width: 2400 },
    { name: 'split', crop: full, width: 2400 },
    { name: 'annotate', crop: [430, 142, 1170, 858], width: 2000 },
    { name: 'source', crop: [236, 90, 1364, 910], width: 2000 },
    { name: 'focus', crop: 'center', width: 1600 },
    { name: 'board', crop: [200, 20, 1200, 960], width: 2400 },
    { name: 'hero', crop: [1216, 150, 384, 430], out: 'ai-ask', width: 768 },
    { name: 'ai-note', crop: [236, 140, 1364, 860], width: 2200 },
    { name: 'ai-highlights', crop: [400, 200, 1200, 700], width: 2000 },
    { name: 'ai-translate', crop: [400, 290, 640, 650], width: 1280 },
    { name: 'ai-source', crop: [236, 140, 1364, 700], width: 2200 },
    ...THEMES.map(([id]) => ({ name: 'theme-' + id, crop: full, out: `themes/${id}`, width: 2000 })),
  ];
  await fs.mkdir(path.join(assets, 'themes'), { recursive: true });
  const encoder = await electron.launch({
    args: [path.join(here, 'encode.cjs')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const win = await encoder.firstWindow();
  for (const j of jobs) {
    const b64 = (await fs.readFile(path.join(raw, j.name + '.png'))).toString('base64');
    const out = await win.evaluate(
      async ({ b64, crop, width }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        let [x, y, w, h] = crop === 'center' ? [0, 0, 0, 0] : crop;
        const k = crop === 'center' ? 1 : img.naturalWidth / 1600;
        if (crop === 'center') {
          w = img.naturalWidth * 0.46;
          h = w * 0.68;
          x = (img.naturalWidth - w) / 2;
          y = img.naturalHeight * 0.03;
        }
        const c = document.createElement('canvas');
        c.width = width;
        c.height = Math.round((h * k * width) / (w * k));
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, x * k, y * k, w * k, h * k, 0, 0, c.width, c.height);
        return { data: c.toDataURL('image/webp', 0.86), w: c.width, h: c.height };
      },
      { b64, crop: j.crop, width: j.width },
    );
    await fs.writeFile(
      path.join(assets, (j.out || j.name) + '.webp'),
      Buffer.from(out.data.split(',')[1], 'base64'),
    );
    console.log(`${j.out || j.name}.webp ${out.w}×${out.h}`);
  }
  // 分享图：渲染 og.html（引用刚生成的 hero.webp），缩到 1200×630
  await win.goto('file://' + path.join(here, 'og.html'));
  await encoder.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1200, 630),
  );
  await sleep(800);
  await win.screenshot({ path: path.join(raw, 'og@2x.png') });
  {
    const b64 = (await fs.readFile(path.join(raw, 'og@2x.png'))).toString('base64');
    const data = await win.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 630;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, 1200, 630);
      return c.toDataURL('image/png');
    }, b64);
    await fs.writeFile(path.join(assets, 'og.png'), Buffer.from(data.split(',')[1], 'base64'));
    console.log('og.png 1200×630');
  }
  await encoder.close();
}
