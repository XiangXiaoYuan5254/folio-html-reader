const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writeZip } = require('../folio-plugins/cli/lib/zip.cjs');

// A mind map as the paper dashboard keeps it: category → sub-category → paper.
const topic = (title, children = [], extra = {}) => ({
  title,
  ...(children.length ? { children: { attached: children } } : {}),
  ...extra,
});
const done = { extensions: [{ provider: 'org.xmind.ui.task', content: { status: 'done' } }] };
const map = [
  {
    rootTopic: topic('论文阅读情况', [
      topic('01_基础模型', [
        topic('01_Transformer', [
          topic(
            '01_Transformer',
            [
              topic('《Attention Is All\nYou Need》\n注意力就是你所需要的一切（2017）[NeurIPS|A]'),
              topic('claude总结', [topic('只用注意力。'), topic('并行训练。')]),
              topic('笔记', [
                topic('多头注意力', [topic('每个头看不同的关系')]),
                topic('位置编码'),
              ]),
            ],
            {
              ...done,
              href: 'file:///Users/someone/%E8%AE%BA%E6%96%87/%E4%BC%B4%E8%AF%BB%E7%AC%94%E8%AE%B0-html/01_%E5%9F%BA%E7%A1%80/attention.html',
            },
          ),
          topic(
            '02_BERT',
            [
              topic(
                '《BERT: Pre-training of Deep Bidirectional Transformers》\nBERT（Devlin，2019）',
              ),
            ],
            {
              ...done,
              href: 'file:///x/伴读笔记-html/01_基础/missing.html',
            },
          ),
        ]),
      ]),
      topic('02_智能体', [
        topic('01_规划', [
          topic('03_ReAct', [
            topic('《ReAct: Synergizing Reasoning and Acting》\n推理与行动（2023）【ICLR】'),
          ]),
        ]),
      ]),
    ]),
  },
];

test('脑图里的论文进文献库：分类、别名、已读和日期、总结、笔记、渠道、文件、书单', async (t) => {
  const { parseXmind, plan, rankedTitles } = await import('../scripts/import-xmind-library.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-xmind-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const xmind = writeZip([{ name: 'content.json', data: Buffer.from(JSON.stringify(map)) }]);
  const parsed = parseXmind(xmind);
  assert.deepEqual(
    parsed.map((p) => [
      p.title,
      p.label,
      p.zh,
      p.year,
      p.category,
      p.done,
      p.venue,
      p.rank,
      p.file,
    ]),
    [
      [
        'Attention Is All You Need',
        'Transformer',
        '注意力就是你所需要的一切',
        2017,
        '01_基础模型/01_Transformer',
        true,
        'NeurIPS',
        'A',
        '伴读笔记-html/01_基础/attention.html',
      ],
      [
        'BERT: Pre-training of Deep Bidirectional Transformers',
        'BERT',
        'BERT（Devlin，2019）',
        2019,
        '01_基础模型/01_Transformer',
        true,
        '',
        '',
        '伴读笔记-html/01_基础/missing.html',
      ],
      [
        'ReAct: Synergizing Reasoning and Acting',
        'ReAct',
        '推理与行动',
        2023,
        '02_智能体/01_规划',
        false,
        'ICLR',
        '',
        '',
      ],
    ],
  );
  assert.equal(parsed[0].summary, '只用注意力。\n\n并行训练。');
  assert.equal(parsed[0].note, '- 多头注意力\n  - 每个头看不同的关系\n- 位置编码');
  const planned = plan(parsed, {
    venues: { 'BERT: Pre-training of Deep Bidirectional Transformers': ['NAACL', 'B'] },
    readLog: {
      'attention is all you need': '2026-10-01',
      'bert pre training of deep bidirectional transformers': null,
    },
    existing: (f) => f.endsWith('attention.html'),
  });
  assert.deepEqual(
    planned.papers.map((p) => [p.alias, p.venue, p.status, p.readAt, p.files]),
    [
      [
        'Transformer · 注意力就是你所需要的一切',
        'NeurIPS',
        'done',
        '2026-10-01',
        ['伴读笔记-html/01_基础/attention.html'],
      ],
      ['BERT · BERT（Devlin，2019）', 'NAACL', 'done', '', []],
      ['ReAct · 推理与行动', 'ICLR', 'unread', undefined, []],
    ],
  );
  assert.deepEqual(planned.missingFiles, ['伴读笔记-html/01_基础/missing.html']);
  assert.deepEqual(
    [...planned.ranks],
    [
      ['NeurIPS', 'A'],
      ['NAACL', 'B'],
    ],
  );
  assert.deepEqual(
    rankedTitles(
      '1. First paper（Vaswani，2017）\n2. Second paper\n3. Third',
      '- **3.** why\n- **1.** why\n- **9.** gone',
    ),
    ['Third', 'First paper'],
  );

  // The whole thing, from the command line, twice: nothing is doubled.
  const project = path.join(dir, '论文库');
  await fs.mkdir(path.join(project, '伴读笔记-html', '01_基础'), { recursive: true });
  await fs.writeFile(
    path.join(project, '伴读笔记-html', '01_基础', 'attention.html'),
    '<h1>注意力</h1>',
  );
  await fs.writeFile(path.join(dir, 'map.xmind'), xmind);
  await fs.writeFile(
    path.join(dir, 'top.json'),
    JSON.stringify({
      name: '入门',
      criteria: '影响力',
      papers: [
        'ReAct: Synergizing Reasoning and Acting',
        'Attention is all you need',
        '不在脑图里',
      ],
    }),
  );
  const run = () =>
    promisify(execFile)(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'import-xmind-library.mjs'),
      project,
      '--xmind',
      path.join(dir, 'map.xmind'),
      '--list',
      path.join(dir, 'top.json'),
    ]);
  const first = await run();
  assert.match(first.stdout, /新增 3 篇，更新 0 篇/);
  assert.match(first.stdout, /书单「入门」：2 篇（1 篇不在脑图里）/);
  const second = await run();
  assert.match(second.stdout, /新增 0 篇，更新 3 篇/);
  const saved = JSON.parse(
    await fs.readFile(path.join(project, '.html-reader', 'library.json'), 'utf8'),
  );
  assert.equal(saved.papers.length, 3);
  const [a] = saved.papers;
  assert.deepEqual(
    [a.title, a.alias, a.category, a.status, a.readAt, a.venue, a.files],
    [
      'Attention Is All You Need',
      'Transformer · 注意力就是你所需要的一切',
      '01_基础模型/01_Transformer',
      'done',
      '',
      'NeurIPS',
      ['伴读笔记-html/01_基础/attention.html'],
    ],
  );
  assert.deepEqual(saved.lists, [
    { name: '入门', note: '影响力', papers: [saved.papers[2].id, saved.papers[0].id] },
  ]);
});
