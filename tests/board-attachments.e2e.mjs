// Exercise file selection, parsing and conversation persistence in real Electron.
// The project, settings and AI service are temporary; no personal data is used.
import { _electron as electron } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-board-files-'));
const project = path.join(temp, 'project');
const userData = path.join(temp, 'user-data');
const evidence = path.join(os.tmpdir(), 'folio-board-files-qa');
await fs.mkdir(project);
await fs.mkdir(userData);
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(project, 'start.html'), '<h1>白板附件测试</h1>');
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf
  .addPage([600, 800])
  .drawText('PDF attachment: variance is one.', { x: 30, y: 700, font, size: 16 });
pdf
  .addPage([600, 800])
  .drawText('Second page: scale the dot product.', { x: 30, y: 700, font, size: 16 });
const pdfBytes = Buffer.from(await pdf.save());
const scan = await PDFDocument.create();
for (let i = 0; i < 4; i++)
  scan.addPage([300, 400]).drawRectangle({ x: 40, y: 80, width: 160, height: 220 });
const scanBytes = Buffer.from(await scan.save());
const requests = [];
let failNextReading = false;
let holdNextReading = false;
let releaseReading;
const isReading = (request) =>
  request.messages.some((m) => m.role === 'system' && m.content.includes('白板资料阅读助手'));
const server = http.createServer(async (req, res) => {
  // Preserve multi-byte characters across HTTP chunks in large Chinese documents.
  req.setEncoding('utf8');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  }
  const request = JSON.parse(raw || '{}');
  requests.push(request);
  if (isReading(request) && holdNextReading) {
    holdNextReading = false;
    await new Promise((resolve) => (releaseReading = resolve));
    if (res.destroyed) return;
  }
  if (isReading(request) && failNextReading) {
    failNextReading = false;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '模拟分段读取失败' } }));
  }
  const reply = isReading(request)
    ? '阅读笔记：' +
      (
        JSON.stringify(request.messages).match(/开头标记|中间标记|全文末尾标记|PDF-END-51/g) || []
      ).join('；')
    : 'text t1 | 附件已读到\nsay 讲解完成。\n';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await fs.writeFile(
  path.join(userData, 'ai.json'),
  JSON.stringify({
    version: 1,
    providers: [
      {
        id: 'mock',
        preset: 'custom',
        kind: 'openai',
        name: '本地模拟',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: 'mock-model',
        context: 128000,
        maxOutput: 0,
        keyHint: 'mock',
        key: 'txt:' + Buffer.from('mock-key').toString('base64'),
      },
    ],
    active: 'mock',
    prefs: { consented: ['mock'] },
    uses: {},
    speech: {},
  }),
);
let app, page;
const errors = [];
const board = () => page.getByRole('dialog', { name: '白板讲解' });
const tray = () => board().getByLabel('待发送的附件');
const picker = () => board().locator('input[type=file]');
const file = (name, text, mimeType = 'text/plain') => ({
  name,
  mimeType,
  buffer: Buffer.from(text),
});
const lastUser = () =>
  requests
    .at(-1)
    .messages.filter((m) => m.role === 'user')
    .at(-1);
const messageText = (m) =>
  typeof m.content === 'string'
    ? m.content
    : m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
async function waitFor(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timeout: ' + label);
}
const ready = () =>
  waitFor(async () => (await tray().getAttribute('aria-busy')) === 'false', 'file reading');
async function send(question = '') {
  await board().getByLabel('向页老师提问').fill(question);
  const n = requests.length;
  await board().locator('.wb-send').click();
  await waitFor(() => requests.length > n, 'AI request');
  await waitFor(
    async () =>
      !(await board().locator('.wb-status').count()) &&
      !(await board().getByRole('button', { name: '暂停', exact: true }).isEnabled()),
    'lesson finished',
  );
}
async function filesEvent(event, files) {
  await board().evaluate(
    (el, { event, files }) => {
      const data = new DataTransfer();
      for (const f of files) data.items.add(new File([f.text], f.name, { type: 'text/plain' }));
      el.dispatchEvent(
        event === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    },
    { event, files },
  );
}
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_MEMBER: '1',
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
      FOLIO_NO_SPEECH_HELPER: '1',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.waitForSelector('.document-frame');
  await page.getByRole('button', { name: '新建空白白板', exact: true }).click();
  assert.match(await picker().getAttribute('accept'), /\.html/);
  const remote = [];
  page.on('request', (r) => {
    if (r.url().includes('invalid.example')) remote.push(r.url());
  });
  const html =
    '<title>HTML 教材</title><h1>章节标题</h1><p>HTML正文标记 &amp; 方差</p><ul><li>第一点</li></ul><table><tr><td>方差</td><td>1</td></tr></table><pre>const x = 1;\n  x + 2;</pre><img src="https://invalid.example/p.png" alt="示意图"><iframe src="https://invalid.example/f"></iframe><p hidden>隐藏内容不应发送</p><script>window.ATTACHMENT_EXECUTED=true</script>';
  await picker().setInputFiles([
    file('教材.HTML', html, 'text/html'),
    file('说明.txt', 'TXT正文标记'),
    file('笔记.md', '# Markdown正文标记'),
    file('讲义.pdf', pdfBytes, 'application/pdf'),
  ]);
  await ready();
  assert.equal(await tray().locator('.wb-attachment').count(), 4);
  assert.match(await tray().innerText(), /2 页/);
  assert.equal(await page.evaluate(() => window.ATTACHMENT_EXECUTED), undefined);
  assert.deepEqual(remote, []);
  await page.screenshot({ path: path.join(evidence, 'attachments-ready.png') });
  await send('结合四份资料讲解');
  const text = messageText(lastUser());
  for (const marker of [
    'HTML正文标记',
    'TXT正文标记',
    'Markdown正文标记',
    'PDF attachment: variance is one.',
    'Second page: scale the dot product.',
    '第 2 页',
    '章节标题',
    '第一点',
    'const x = 1;',
    '方差 | 1',
  ])
    assert.ok(text.includes(marker), marker);
  assert.ok(!text.includes('ATTACHMENT_EXECUTED') && !text.includes('隐藏内容不应发送'));
  assert.match(await board().locator('.wb-asked').first().innerText(), /教材.HTML/);
  assert.equal(await tray().count(), 0);
  console.log('PASS: four document formats reach the model; HTML is inert');
  await board().getByLabel('关闭白板', { exact: true }).click();
  const shelf = page.getByRole('region', { name: '白板' });
  await shelf.locator('.board-row').first().waitFor();
  const index = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/boards/index.json'), 'utf8'),
  );
  const saved = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/boards', index[0].id + '.json'), 'utf8'),
  );
  assert.match(JSON.stringify(saved.turns), /HTML正文标记/);
  await shelf.locator('.board-row-open').first().click();
  await send('第二页说了什么？');
  assert.match(JSON.stringify(requests.at(-1).messages), /Second page: scale the dot product/);
  console.log('PASS: saved attachments remain available after reopening');
  await filesEvent('drop', [
    { name: '拖入.htm', text: '<h2>拖入正文标记</h2>' },
    { name: '删除.txt', text: '不该发送的附件内容' },
  ]);
  await filesEvent('paste', [{ name: '粘贴.markdown', text: '# 粘贴正文标记' }]);
  await ready();
  await board().getByLabel('移除附件 删除.txt', { exact: true }).click();
  await send();
  assert.match(messageText(lastUser()), /拖入正文标记/);
  assert.match(messageText(lastUser()), /粘贴正文标记/);
  assert.match(messageText(lastUser()), /我的问题：请讲解附件的主要内容/);
  assert.ok(!messageText(lastUser()).includes('不该发送的附件内容'));
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const result = read.call(this);
      if (this.name !== 'slow.txt') return result;
      return new Promise((resolve) => {
        window.finishAttachmentRead = async () => resolve(await result);
      });
    };
  });
  await picker().setInputFiles(file('slow.txt', '移除后不应重新出现'));
  await waitFor(() => page.evaluate(() => !!window.finishAttachmentRead), 'delayed read');
  assert.equal(await board().locator('.wb-send').isDisabled(), true);
  await board().getByLabel('移除附件 slow.txt', { exact: true }).click();
  await page.evaluate(() => window.finishAttachmentRead());
  await picker().setInputFiles(file('after.txt', '继续添加有效'));
  await ready();
  assert.equal(await tray().locator('.wb-attachment').count(), 1);
  await send();
  assert.ok(!messageText(lastUser()).includes('移除后不应重新出现'));
  await filesEvent(
    'drop',
    Array.from({ length: 3 }, (_, i) => ({ name: `count${i}.txt`, text: 'count' })),
  );
  await filesEvent(
    'paste',
    Array.from({ length: 3 }, (_, i) => ({ name: `extra${i}.txt`, text: 'count' })),
  );
  await ready();
  assert.equal(await tray().locator('.wb-attachment').count(), 4);
  while (await tray().count()) await tray().getByRole('button').first().click();
  await picker().setInputFiles([
    file('长文.txt', '开头标记' + '字'.repeat(25000) + '全文末尾标记'),
    file(
      '编码.txt',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF16中文标记', 'utf16le')]),
    ),
  ]);
  await ready();
  assert.match(await tray().innerText(), /正文已完整读取/);
  await send();
  assert.match(messageText(lastUser()), /UTF16中文标记/);
  assert.match(messageText(lastUser()), /全文末尾标记/);
  console.log('PASS: drop, paste, removal during loading, limits and text encoding');
  for (const [bad, hint] of [
    [file('empty.txt', ''), '文件是空的'],
    [file('bad.pdf', 'not a pdf', 'application/pdf'), 'PDF 读取失败'],
    [file('binary.txt', '\0binary'), '不是可读取的文本'],
    [file('large.txt', 'x'.repeat(2 * 1024 * 1024 + 1)), '超过 2 MB'],
    [
      file('password.pdf', await fs.readFile('tests/fixtures/password.pdf'), 'application/pdf'),
      'PDF 有密码',
    ],
  ]) {
    await picker().setInputFiles(bad);
    await page.getByRole('alert').filter({ hasText: hint }).waitFor();
    assert.equal(await tray().count(), 0);
  }
  await filesEvent('drop', [{ name: 'unsupported.docx', text: 'bad' }]);
  await page
    .getByRole('alert')
    .filter({ hasText: '支持图片、PDF、TXT、Markdown 和 HTML' })
    .waitFor();
  await picker().setInputFiles(file('扫描.pdf', scanBytes, 'application/pdf'));
  await ready();
  assert.match(await tray().innerText(), /4 个无文字页面已全部附为图片/);
  await send('看扫描页里的图形');
  assert.equal(lastUser().content.filter((p) => p.type === 'image_url').length, 4);
  assert.match(messageText(lastUser()), /"page":4,"ref":"img4"/);
  assert.equal(await board().locator('.wb-picture').count(), 4);
  await board().evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    const blob = await new Promise((r) => canvas.toBlob(r));
    const data = new DataTransfer();
    data.items.add(new File([blob], '题目.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await ready();
  await send();
  assert.equal(lastUser().content.filter((p) => p.type === 'image_url').length, 1);
  console.log('PASS: invalid documents, scanned PDFs and existing image paste');

  async function freshBoard() {
    await board().getByLabel('关闭白板', { exact: true }).click();
    await page.getByRole('button', { name: '新建空白白板', exact: true }).click();
  }
  await freshBoard();
  const longPDF = await PDFDocument.create();
  const longFont = await longPDF.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 51; i++)
    longPDF
      .addPage([300, 400])
      .drawText(i === 51 ? 'PDF-END-51' : `Page ${i}`, { x: 20, y: 300, font: longFont, size: 12 });
  await picker().setInputFiles(
    file('全书.pdf', Buffer.from(await longPDF.save()), 'application/pdf'),
  );
  await ready();
  await send('最后一页是什么？');
  assert.match(messageText(lastUser()), /第 51 页/);
  assert.match(messageText(lastUser()), /PDF-END-51/);
  console.log('PASS: PDF text after page 50 is included');

  await freshBoard();
  await picker().setInputFiles(
    file(
      '长网页.html',
      '<h1>完整网页</h1><p>' + '文'.repeat(30000) + '</p><p>HTML-END-30000</p>',
      'text/html',
    ),
  );
  await ready();
  await send('讲解这份网页');
  assert.match(messageText(lastUser()), /HTML-END-30000/);
  assert.equal((messageText(lastUser()).match(/文{100,}/g) || []).join('').length, 30000);
  console.log('PASS: HTML text beyond 24000 characters is sent intact');

  await freshBoard();
  const whole =
    '开头标记\n' + '长'.repeat(90000) + '\n中间标记\n' + '长'.repeat(90000) + '\n全文末尾标记';
  await picker().setInputFiles(file('超长全文.txt', whole));
  await ready();
  let start = requests.length;
  await send('把全文所有章节和最后的标记都讲解一下');
  let readings = requests.slice(start).filter(isReading);
  assert.ok(readings.length > 2);
  const completeRead = readings
    .map((r) =>
      messageText(r.messages.at(-1))
        .split('<reading_part>\n')[1]
        .split('\n</reading_part>')[0]
        .replace(/^第 .*? 段：\n/, ''),
    )
    .join('');
  const readWhole = JSON.parse(
    completeRead.match(/<attachments>\n(.*?)\n<\/attachments>/s)[1],
  ).content;
  if (readWhole !== whole) {
    const different = [...whole].findIndex((c, i) => c !== readWhole[i]);
    throw Error(
      `Full-read mismatch: ${readWhole.length}/${whole.length}, first difference ${different}: ${JSON.stringify(readWhole.slice(different - 30, different + 70))}`,
    );
  }
  for (const marker of ['开头标记', '中间标记', '全文末尾标记'])
    assert.match(messageText(lastUser()), new RegExp(marker));
  await board().getByLabel('关闭白板', { exact: true }).click();
  const longEntry = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/boards/index.json'), 'utf8'),
  ).find((b) => b.title.includes('全文所有章节'));
  const longSaved = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/boards', longEntry.id + '.json'), 'utf8'),
  );
  const savedDoc = JSON.parse(
    longSaved.turns[0].content.match(/<attachments>\n(.*?)\n<\/attachments>/s)[1],
  );
  assert.equal(savedDoc.content, whole);
  await shelf.locator('.board-row-open').filter({ hasText: '全文所有章节' }).click();
  start = requests.length;
  await send('再说说最后的标记');
  readings = requests.slice(start).filter(isReading);
  assert.ok(readings.some((r) => messageText(r.messages.at(-1)).includes('全文末尾标记')));
  assert.match(messageText(lastUser()), /全文末尾标记/);
  console.log('PASS: long documents are read in full, persisted intact and reread on follow-up');

  failNextReading = true;
  await send('测试分段失败后重试');
  await board().locator('.wb-retry').waitFor();
  const failedAt = requests.length;
  await board().locator('.wb-retry').click();
  await waitFor(
    () => requests.length > failedAt && !isReading(requests.at(-1)),
    'retry final response',
  );
  await waitFor(
    async () =>
      !(await board().locator('.wb-status').count()) &&
      !(await board().getByRole('button', { name: '暂停', exact: true }).isEnabled()),
    'retry finished',
  );
  assert.match(messageText(lastUser()), /全文末尾标记/);
  console.log('PASS: a failed part is reported and can be retried');

  holdNextReading = true;
  start = requests.length;
  await board().getByLabel('向页老师提问').fill('先完整读取，测试中途关闭');
  await board().locator('.wb-send').click();
  await waitFor(() => !!releaseReading, 'reading suspended');
  assert.match(await board().innerText(), /正在完整阅读第/);
  await page.screenshot({ path: path.join(evidence, 'long-document-progress.png') });
  await board().getByLabel('关闭白板', { exact: true }).click();
  releaseReading();
  releaseReading = undefined;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(
    requests.slice(start).every(isReading),
    'cancelled reading must not start a final answer',
  );
  const interrupted = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/boards', longEntry.id + '.json'), 'utf8'),
  );
  assert.ok(interrupted.turns[0].content.includes('全文末尾标记'));
  await shelf.locator('.board-row-open').filter({ hasText: '全文所有章节' }).click();
  await send('重新完整读取后讲解末尾内容');
  assert.match(messageText(lastUser()), /全文末尾标记/);
  console.log(
    'PASS: closing during reading cancels processing, preserves source and allows continuation',
  );

  await freshBoard();
  const scans = await PDFDocument.create();
  for (let i = 0; i < 26; i++)
    scans.addPage([100, 120]).drawRectangle({ x: i + 1, y: 20, width: 30, height: 40 });
  await picker().setInputFiles(
    file('全部扫描页.pdf', Buffer.from(await scans.save()), 'application/pdf'),
  );
  await ready();
  start = requests.length;
  await send('按页讲解所有扫描页面');
  readings = requests.slice(start).filter(isReading);
  const imageCounts = readings.map(
    (r) =>
      r.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((p) => p.type === 'image_url').length,
  );
  assert.equal(
    imageCounts.reduce((a, b) => a + b, 0),
    26,
  );
  assert.ok(imageCounts.every((n) => n <= 6));
  assert.equal(await board().locator('.wb-picture').count(), 26);
  console.log('PASS: every scanned page reaches the model, including beyond the IPC limit of 24');
  assert.deepEqual(errors, []);
  console.log('BOARD ATTACHMENTS E2E PASS');
} catch (error) {
  console.error(error, errors);
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  releaseReading?.();
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      .catch(() => {});
    await app.close().catch(() => {});
  }
  server.closeAllConnections();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
