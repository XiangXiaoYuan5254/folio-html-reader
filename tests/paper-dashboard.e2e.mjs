// 论文仪表盘 (plugins/paper-dashboard), end to end in the real Electron app: the official
// plugin's page draws the project's library (progress, the wall, categories, venues, years, the
// calendar, the paper browser) — with no ranking of venues until the reader picks one in its
// settings, then CCF's — shows a paper's summary and what the reader marked in it, marks it
// read, follows the library as it changes and opens a paper's document in the reader. No network.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-dashboard-e2e-'));
const project = path.join(temp, '论文库');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-dashboard-qa');
await fs.mkdir(path.join(project, '.html-reader'), { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(evidence, { recursive: true });

// A library of forty papers in three categories, a third of them read over the last weeks.
const venues = [
  'Neural Information Processing Systems',
  'International Conference on Machine Learning',
  'ICLR',
  'Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics',
  'Nature',
  '',
  'arXiv (Cornell University)',
  'Journal of Machine Learning Research',
];
const cats = [
  '01_基础模型/Transformer',
  '01_基础模型/预训练',
  '02_智能体/规划',
  '02_智能体/工具使用',
  '03_强化学习',
];
const day = (ago) => {
  const d = new Date(Date.now() - ago * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const papers = [];
for (let i = 0; i < 40; i++) {
  const cat = cats[i % cats.length];
  const file = `${cat.split('/')[0]}/paper-${i + 1}.html`;
  await fs.mkdir(path.join(project, path.dirname(file)), { recursive: true });
  await fs.writeFile(
    path.join(project, file),
    `<!doctype html><html><meta charset="utf-8"><body><h1>Paper ${i + 1}</h1><p>这是第 ${i + 1} 篇的伴读笔记，讲了一个要点。</p></body></html>`,
  );
  const done = i % 3 === 0;
  papers.push({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: i === 0 ? 'Attention Is All You Need' : `A Study of Topic ${i + 1}`,
    alias: i === 0 ? 'Transformer · 注意力就是你所需要的一切' : '',
    authors: ['Ada Lovelace', 'Alan Turing'],
    year: 2015 + (i % 10),
    venue: venues[i % venues.length],
    arxiv: i % venues.length === 5 ? `2301.${String(10000 + i)}` : '',
    category: cat,
    tags: [],
    summary: i === 0 ? '只用注意力，不用循环和卷积。' : '',
    status: done ? 'done' : i % 3 === 1 ? 'reading' : 'unread',
    readAt: done ? (i === 0 ? '' : day(i)) : '',
    addedAt: 1_700_000_000_000 + i * 1000,
    files: [file],
  });
}
await fs.writeFile(
  path.join(project, '.html-reader', 'library.json'),
  JSON.stringify({
    version: 1,
    papers,
    lists: [
      {
        name: '入门十篇',
        note: '按影响力挑的',
        papers: papers
          .slice(0, 10)
          .map((p) => p.id)
          .reverse(),
      },
    ],
  }),
);
await fs.writeFile(
  path.join(userData, 'plugins.json'),
  JSON.stringify({
    version: 1,
    thirdParty: true,
    plugins: {
      library: {
        enabled: true,
        source: { type: 'folder', path: path.join(root, 'plugins', 'library') },
      },
      'paper-dashboard': {
        enabled: true,
        source: { type: 'folder', path: path.join(root, 'plugins', 'paper-dashboard') },
        settings: { venues: 'Nature=A' },
      },
    },
  }),
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await wait(150);
  }
  throw Error('Timeout: ' + label);
}
let app;
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
      FOLIO_DOCUMENTS: path.join(temp, 'Documents'),
      FOLIO_NO_SPEECH_HELPER: '1',
      FOLIO_APP_VERSION: '0.33.0',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.document-frame');
  const call = (action, payload) =>
    page.evaluate(
      async ([action, payload]) =>
        window.folio.invoke(action, payload, (await window.folio.invoke('workspace')).token),
      [action, payload],
    );
  const shot = (name) => page.screenshot({ path: path.join(evidence, `${name}.png`) });

  await page.locator('.page-shelf').getByRole('button', { name: '论文仪表盘' }).click();
  const dash = page.frameLocator('.plugin-page[data-plugin-page="paper-dashboard"] iframe');
  await dash.locator('#subtitle').getByText('共 40 篇 · 已读 14 篇 (35%) · 未读 26 篇').waitFor();
  // Categories keep their order and lose their numbers; a sub-category under each.
  assert.deepEqual(
    await dash
      .locator('#catRows .bname')
      .allInnerTexts()
      .then((t) => t.map((s) => s.replace('▶', '').trim())),
    ['基础模型', '智能体', '强化学习'],
  );
  // Venues are recognised from their full names. Not ranked unless the reader asks: nothing
  // of CCF anywhere, and the card it had says how many were read this year.
  const text = async (sel) => (await dash.locator(sel).allInnerTexts()).join('\n');
  await waitFor(async () => /NeurIPS/.test(await text('.vcard')), 'venues drawn');
  assert.equal(await dash.locator('.ccf-bucket').count(), 0);
  assert.doesNotMatch(await text('body'), /CCF-|无CCF评级|CCF 等级分布/);
  assert.match(await text('.section-head h2'), /按发表渠道/);
  await dash.locator('.kpi').getByText('今年读完').waitFor();
  await shot('0-unranked');
  // Ranked by CCF, picked in the plugin's settings (a select): the page loads again with it.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '插件' }).click();
  const card = settings.locator('.plugin-card').filter({ has: page.getByLabel('开启论文仪表盘') });
  await card.getByRole('button', { name: '展开论文仪表盘' }).click();
  await card.getByLabel('渠道分级').selectOption('ccf');
  await card.getByRole('button', { name: '保存设置' }).click();
  await page.keyboard.press('Escape');
  await waitFor(async () => (await dash.locator('.ccf-bucket').count()) > 0, 'ranked');
  // The reader's own ranks count too (Nature=A).
  const venuesCard = await text('.vcard');
  for (const name of ['NeurIPS', 'ICML', 'ICLR', 'NAACL', 'JMLR', 'Nature'])
    assert.match(venuesCard, new RegExp(name));
  assert.doesNotMatch(venuesCard, /Neural Information Processing Systems/);
  // A paper with an arXiv number and no venue is a preprint, not unknown.
  assert.match(
    await text('.ccf-bucket'),
    /CCF-A[\s\S]*9 \/ 25[\s\S]*CCF-B[\s\S]*2 \/ 5[\s\S]*预印本[\s\S]*3 \/ 10/,
  );
  // The calendar counts the papers with a day; the one read on a day unknown is said to be.
  assert.match(await text('.section-head'), /1 篇已读的日期不详/);
  await shot('1-dashboard-top');

  // The reading list: its ten papers, in its order.
  await dash.getByRole('button', { name: '入门十篇' }).click();
  assert.match(await dash.locator('#catMeta').innerText(), /「入门十篇」 10 篇/);
  await dash.getByRole('button', { name: '入门十篇' }).click();

  // The browser filters; a paper shows its summary and what was marked in its file.
  const doc = await call('document', { path: '01_基础模型/paper-1.html' });
  await call('save-data', {
    id: doc.id,
    data: {
      ...doc.data,
      note: '这篇是整个方向的起点。',
      annotations: [
        {
          id: 'a1',
          type: 'highlight',
          color: '#d49b00',
          createdAt: 1,
          note: '关键一句',
          quote: { exact: '讲了一个要点', prefix: '', suffix: '', start: 0, end: 6 },
        },
      ],
    },
  });
  await dash.locator('#fq').fill('attention');
  await dash.locator('#plist .prow').first().waitFor();
  assert.equal(await dash.locator('#plist .prow').count(), 1);
  await dash.locator('#plist .prow').first().click();
  const modal = dash.locator('#pmodalCard');
  await modal.getByText('只用注意力，不用循环和卷积。').waitFor();
  await modal.getByText('讲了一个要点').waitFor();
  await modal.getByText('这篇是整个方向的起点。').waitFor();
  assert.match(
    await modal.innerText(),
    /Transformer[\s\S]*注意力就是你所需要的一切|注意力就是你所需要的一切[\s\S]*Transformer/,
  );
  await dash
    .locator('.page, body')
    .first()
    .evaluate(() => window.scrollTo(0, 0));
  await shot('2-paper-preview');
  // Marked unread from the page: the library and the page's numbers follow.
  await modal.getByRole('button', { name: '改回未读' }).click();
  await dash.locator('#subtitle').getByText('已读 13 篇').waitFor();
  const saved = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader', 'library.json'), 'utf8'),
  );
  assert.equal(saved.papers[0].status, 'unread');
  // A change made elsewhere arrives too.
  await call('library-update', { id: papers[1].id, patch: { status: 'done' } });
  await dash.locator('#subtitle').getByText('已读 14 篇').waitFor();

  // A paper's document opens in the reader.
  await dash.locator('#fq').fill('attention');
  await dash.locator('#plist .note-jump').first().click();
  await waitFor(async () => await page.locator('.page-host').isHidden(), 'document opened');
  assert.match(await page.locator('.document-tab.selected').innerText(), /paper-1\.html/);

  // Back on the page, scrolled through for the record.
  await page.locator('.document-tab.page-tab', { hasText: '论文仪表盘' }).getByRole('tab').click();
  await dash.locator('#fq').fill('');
  for (const [name, sel] of [
    ['3-categories', '#catSection'],
    ['4-venues', '.vgrid'],
    ['5-browser', '.exp-card'],
    ['6-calendar', '.cal-card'],
  ]) {
    await dash.locator(sel).first().scrollIntoViewIfNeeded();
    await wait(500);
    await shot(name);
  }
  const log = await page.evaluate(() =>
    window.folio.invoke('plugin-log', { id: 'paper-dashboard' }),
  );
  assert.deepEqual(
    log.filter((e) => e.level === 'error').map((e) => e.text),
    [],
    'the page ran without errors',
  );
  assert.deepEqual(errors, []);
  console.log('paper dashboard e2e: ok');
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
