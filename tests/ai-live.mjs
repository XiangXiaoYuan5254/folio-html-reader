// Tries the AI features against the real service configured in the app (AI 设置), on a
// temporary copy of the settings and a temporary project. Not part of CI: it needs a real
// API key, the network, and costs a little. The key is never printed.
//   npm run build && node tests/ai-live.mjs
import { _electron as electron } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve('.');
const appData =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', '页间')
    : path.join(os.homedir(), 'Library/Application Support/页间');
const config = process.env.FOLIO_AI_CONFIG || path.join(appData, 'ai.json');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-live-'));
const project = path.join(temp, '真实测试');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-ai-live');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
// FOLIO_AI_LIVE=codex sets up “Codex” through the settings dialog instead of
// copying the saved settings, FOLIO_AI_LIVE=kimi “Kimi Code” with the app's own Kimi sign-in.
// FOLIO_AI_LIVE_STEPS limits the run, e.g. "ask,highlights".
const codexMode = process.env.FOLIO_AI_LIVE === 'codex';
const kimiMode = process.env.FOLIO_AI_LIVE === 'kimi';
const steps = new Set(
  (process.env.FOLIO_AI_LIVE_STEPS || 'ask,highlights,summary,translate,source,agent,pdf').split(
    ',',
  ),
);
// The sign-in is linked, not copied: Kimi replaces its refresh token on every renewal.
if (kimiMode) await fs.symlink(path.join(appData, 'kimi-code'), path.join(userData, 'kimi-code'));
if (!codexMode && !kimiMode) {
  await fs.copyFile(config, path.join(userData, 'ai.json'));
  const settings = JSON.parse(await fs.readFile(config, 'utf8'));
  const active = settings.providers.find((p) => p.id === settings.active) || settings.providers[0];
  console.log(`Service: ${active.name} · ${active.model} · ${active.baseUrl}`);
}

await fs.writeFile(
  path.join(project, '01_注意力机制.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>注意力机制简介</title>
<style>body{font:18px/1.9 system-ui;padding:40px 60px;color:#253342;max-width:860px}</style></head><body>
<h1>注意力机制简介</h1>
<p><span id="s1">注意力机制让模型在处理每个词时，都能直接参考句子里的其他所有词。</span>这是它和早期循环网络最大的不同：循环网络只能按顺序一个词一个词地传递信息，距离越远的词，信息越容易丢失。</p>
<h2>为什么训练更快</h2>
<p>与循环网络相比，这种结构更容易并行计算，训练速度明显更快。在大规模数据上，这一点尤其重要：同样的算力下，可以用更多数据训练更大的模型。</p>
<h2>顺序从哪里来</h2>
<p>注意力本身不区分词的先后。位置编码为每个位置加上一组正弦和余弦信号，弥补了结构本身不区分顺序的缺点。不同频率的信号组合起来，模型就能分辨相对位置。</p>
<h2>多头注意力</h2>
<p>多头注意力把表示拆成几组，分别计算注意力，再拼接起来。每一组可以关注不同的关系，比如语法关系或指代关系。实验表明，使用 8 个头时翻译质量最好，头数过多或过少都会下降。</p>
<h2>代价</h2>
<p>注意力的计算量与序列长度的平方成正比。处理很长的文档时，这会成为主要的瓶颈，因此后来出现了许多稀疏注意力和线性注意力的改进方法。</p>
</body></html>`,
);
await fs.writeFile(
  path.join(project, '02_读书笔记.html'),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>读书笔记</title><body><h1>读书笔记</h1><p>循环网络按顺序处理文本，难以并行。卷积网络可以并行，但捕捉远距离关系需要很多层。</p></body></html>',
);
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page1 = pdf.addPage([600, 800]);
const lines = [
  'Attention Is All You Need (excerpt)',
  '',
  'The dominant sequence transduction models are based on complex recurrent',
  'or convolutional neural networks. We propose a new simple network',
  'architecture, the Transformer, based solely on attention mechanisms,',
  'dispensing with recurrence and convolutions entirely. Experiments on two',
  'machine translation tasks show these models to be superior in quality',
  'while being more parallelizable and requiring significantly less time to train.',
];
lines.forEach((text, i) =>
  page1.drawText(text, { x: 50, y: 740 - i * 26, size: i ? 13 : 20, font }),
);
await fs.writeFile(path.join(project, '03_paper.pdf'), Buffer.from(await pdf.save()));

let app, page;
const errors = [];
const log = (label, text) =>
  console.log(`\n── ${label} ──\n${String(text).trim().slice(0, 1500)}\n`);
async function waitFor(fn, label, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Timeout: ' + label);
}
async function dataFor(relative) {
  const index = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/workspace.json'), 'utf8'),
  );
  const id = index.files[relative].id;
  return JSON.parse(
    await fs.readFile(path.join(project, '.html-reader/documents', id + '.json'), 'utf8'),
  );
}
async function frame() {
  const src = await page.locator('.document-frame').first().getAttribute('src');
  let f;
  await waitFor(async () => (f = page.frames().find((x) => x.url() === src)), 'frame', 15000);
  await f.locator('[data-folio-ui=overlay]').waitFor({ state: 'attached' });
  return f;
}
const panel = () => page.locator('.assistant-panel');
const lastAnswer = () => panel().locator('.chat-answer').last();
async function consent() {
  const dialog = page.getByRole('dialog', { name: /发送给/ });
  if (await dialog.isVisible().catch(() => false))
    await dialog.getByRole('button', { name: '同意并继续' }).click();
}
async function answer(label) {
  const started = Date.now();
  await waitFor(async () => {
    await consent();
    const cls = (await lastAnswer().getAttribute('class')) || '';
    if (cls.includes('error')) throw Error(label + ': ' + (await lastAnswer().innerText()));
    return cls.includes('done') || cls.includes('stopped');
  }, label);
  const text = await lastAnswer().locator('.ai-markdown').allInnerTexts();
  // What the reply used, from the tip clicking the model under it opens.
  const meta = await lastAnswer()
    .locator('.chat-meta')
    .click()
    .then(() => page.locator('.usage-tooltip').innerText())
    .catch(() => '');
  await page.keyboard.press('Escape');
  console.log(
    `${label}: ${((Date.now() - started) / 1000).toFixed(1)} 秒 · ${meta?.replace(/\n/g, ' · ')}`,
  );
  return text.join('\n');
}
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_MEMBER: '1',
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.waitForSelector('.document-frame');
  await frame();
  await page.getByLabel('AI 助手', { exact: true }).click();
  if (codexMode) {
    await panel().getByRole('button', { name: '配置 AI 服务', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'AI 设置' });
    await settings.getByRole('button', { name: /^Codex/ }).click();
    await settings.getByText(/已通过这台电脑上的 Codex 登录 ChatGPT/).waitFor({ timeout: 30000 });
    await waitFor(
      async () => !!(await settings.getByLabel('模型', { exact: true }).inputValue()),
      'default model',
      30000,
    );
    console.log(
      `Service: Codex · ${await settings.getByLabel('模型', { exact: true }).inputValue()}`,
    );
    let started = Date.now();
    await settings.getByRole('button', { name: '测试连接' }).click();
    await settings.getByText(/连接成功/).waitFor({ timeout: 90000 });
    console.log(`测试连接：${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    await page.screenshot({ path: path.join(evidence, 'live-codex-settings.png') });
    await settings.getByRole('button', { name: '添加', exact: true }).click();
    await settings.getByText('已保存').waitFor();
    await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  }
  if (kimiMode) {
    await panel().getByRole('button', { name: '配置 AI 服务', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'AI 设置' });
    await settings.getByRole('button', { name: /^Kimi Code/ }).click();
    await settings
      .getByText(/已通过这台电脑上的 Kimi Code 登录 Kimi 账号/)
      .waitFor({ timeout: 60000 });
    const model = settings.getByLabel('模型', { exact: true });
    console.log(`Service: Kimi Code · ${await model.inputValue()}`);
    let started = Date.now();
    await settings.getByRole('button', { name: '测试连接' }).click();
    await settings.getByText(/连接成功/).waitFor({ timeout: 90000 });
    console.log(`测试连接：${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    await page.screenshot({ path: path.join(evidence, 'live-kimi-settings.png') });
    await settings.getByRole('button', { name: '添加', exact: true }).click();
    await settings.getByText('已保存').waitFor();
    await settings.getByRole('button', { name: '关闭 AI 设置' }).click();
  }

  // 1. A question with citations.
  if (steps.has('ask')) {
    await panel().getByLabel('向 AI 提问').fill('为什么这种结构训练更快？位置信息又是怎么补上的？');
    await panel().getByLabel('向 AI 提问').press('Enter');
    log('问答', await answer('问答'));
    await waitFor(
      async () => (await panel().locator('.cite-chip').count()) > 0,
      'citations',
      20000,
    ).catch(() => {});
    const cites = await panel().locator('.cite-chip').count();
    const missing = await panel().locator('.cite-chip.missing').count();
    console.log(`引用：${cites} 处，未在原文中找到 ${missing} 处`);
    if (cites) {
      await panel().locator('.cite-chip:not(.missing)').first().click();
      const f = await frame();
      await f
        .locator('[data-folio-cite] rect')
        .first()
        .waitFor({ state: 'attached', timeout: 10000 });
      await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: path.join(evidence, 'live-answer.png') });
  }

  // 2. AI highlights.
  if (steps.has('highlights')) {
    await panel()
      .locator('.assistant-tasks, .assistant-chips')
      .first()
      .getByRole('button', { name: 'AI 划重点' })
      .click();
    log('划重点', await answer('划重点'));
    const highlights = (await dataFor('01_注意力机制.html')).annotations.filter(
      (a) => a.by === 'ai',
    );
    console.log(`AI 高亮：${highlights.length} 处`);
    for (const h of highlights) console.log(`  · ${h.quote.exact}  —  ${h.note}`);
    assert.ok(highlights.length >= 2, 'highlights placed');
    await page.screenshot({ path: path.join(evidence, 'live-highlights.png') });
  }

  // 3. Summary.
  if (steps.has('summary')) {
    await panel()
      .locator('.assistant-tasks, .assistant-chips')
      .first()
      .getByRole('button', { name: '总结全文' })
      .click();
    log('总结', await answer('总结'));
  }

  // 4. Translate a selection.
  if (steps.has('translate')) {
    const f = await frame();
    const box = await f.locator('#s1').evaluate((e) => e.getBoundingClientRect().toJSON());
    const parent = await page.locator('.document-frame').first().boundingBox();
    const scale = await page
      .locator('.document-frame')
      .first()
      .evaluate((e) => e.getBoundingClientRect().width / e.clientWidth);
    await page.mouse.move(
      parent.x + (box.x + 2) * scale,
      parent.y + (box.y + box.height / 2) * scale,
    );
    await page.mouse.down();
    await page.mouse.move(
      parent.x + (box.x + box.width - 4) * scale,
      parent.y + (box.y + box.height / 2) * scale,
      { steps: 12 },
    );
    await page.mouse.up();
    let started = Date.now();
    await page.locator('.selection-toolbar').getByRole('button', { name: '翻译' }).click();
    await waitFor(async () => {
      await consent();
      return page.locator('.ai-card').getByRole('button', { name: '复制' }).isVisible();
    }, 'translation');
    console.log(`翻译：${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    log('翻译', await page.locator('.ai-card-body').innerText());
    await page.locator('.ai-card').getByRole('button', { name: '关闭 AI 卡片' }).click();
  }

  // 5. Source edit.
  if (steps.has('source')) {
    await page.getByRole('button', { name: '源码', exact: true }).click();
    await page.locator('.cm-content').waitFor();
    await page.getByRole('button', { name: 'AI 修改' }).click();
    await page.getByLabel('修改要求').fill('给每个 h2 标题加上浅灰色的下边框，并把正文行距改成 2');
    let started = Date.now();
    await page.getByRole('button', { name: '生成修改' }).click();
    await waitFor(
      async () =>
        (await page.locator('.ai-source .diff-view').isVisible()) ||
        (await page.locator('.ai-source .chat-error').isVisible()),
      'source edit',
    );
    console.log(`源码修改：${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    if (await page.locator('.ai-source .chat-error').isVisible())
      throw Error('源码修改失败：' + (await page.locator('.ai-source .chat-error').innerText()));
    log('源码修改', await page.locator('.ai-source-proposal').innerText());
    await page.screenshot({ path: path.join(evidence, 'live-source-edit.png') });
    await page.getByRole('button', { name: '应用修改' }).click();
    await waitFor(
      async () =>
        /border-bottom/.test(await fs.readFile(path.join(project, '01_注意力机制.html'), 'utf8')),
      'edit saved',
      15000,
    );
    await page.getByRole('button', { name: '阅读', exact: true }).click();
  }

  // 6. Project agent, approving every change.
  if (steps.has('agent')) {
    await panel().getByRole('tab', { name: '整个项目' }).click();
    await panel()
      .getByLabel('向 AI 提问')
      .fill('读一下《02_读书笔记.html》和那篇 PDF，给它们各写三句话摘要，追加到各自的笔记里。');
    await panel().getByLabel('向 AI 提问').press('Enter');
    const started = Date.now();
    await waitFor(
      async () => {
        await consent();
        const waiting = panel().locator('.agent-step.waiting');
        if (await waiting.count())
          await waiting.first().getByRole('button', { name: '应用', exact: true }).click();
        const cls = (await lastAnswer().getAttribute('class')) || '';
        if (cls.includes('error')) throw Error('Agent: ' + (await lastAnswer().innerText()));
        return cls.includes('done');
      },
      'agent',
      300_000,
    );
    console.log(`Agent：${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    const steps = await panel()
      .locator('.chat-answer')
      .last()
      .locator('.agent-step')
      .allInnerTexts();
    log('Agent 步骤', steps.join('\n'));
    log('Agent 回答', (await lastAnswer().locator('.ai-markdown').allInnerTexts()).join('\n'));
    log('读书笔记的笔记', (await dataFor('02_读书笔记.html')).note);
    log('PDF 的笔记', (await dataFor('03_paper.pdf')).note);
    await page.screenshot({ path: path.join(evidence, 'live-agent.png') });
  }

  // 7. PDF highlights.
  if (steps.has('pdf')) {
    await page
      .getByRole('navigation', { name: '项目文件' })
      .getByRole('button', { name: '03_paper.pdf', exact: true })
      .click();
    await waitFor(
      async () =>
        (await page.locator('.document-frame').getAttribute('src')).includes('03_paper.pdf'),
      'pdf',
      15000,
    );
    await panel().getByRole('tab', { name: '本文' }).click();
    const tasks = panel().locator('.assistant-tasks, .assistant-chips').first();
    await tasks.getByRole('button', { name: 'AI 划重点' }).click();
    log('PDF 划重点', await answer('PDF 划重点'));
    const pdfHighlights = (await dataFor('03_paper.pdf')).annotations.filter((a) => a.by === 'ai');
    console.log(
      `PDF AI 高亮：${pdfHighlights.length} 处（带页面坐标：${pdfHighlights.filter((a) => a.quote.pdfRects?.length).length}）`,
    );
    await page.screenshot({ path: path.join(evidence, 'live-pdf.png') });
  }
  console.log(errors.length ? `界面错误：\n${errors.join('\n')}` : '界面没有错误');
  console.log(`截图：${evidence}`);
} finally {
  await app?.close().catch(() => {});
  await fs.rm(path.join(userData, 'ai.json'), { force: true });
}
