const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { search, checkOpenAlexKey, FIELDS } = require('../electron/papers.cjs');

const work = (title, extra = {}) => ({
  id: `https://openalex.org/W${title.length}`,
  title,
  doi: null,
  publication_year: 2020,
  cited_by_count: 10,
  authorships: [{ author: { display_name: 'Ada Lovelace' } }],
  primary_location: { source: { display_name: 'The Lancet' }, landing_page_url: 'https://x.org' },
  best_oa_location: null,
  locations: [],
  ...extra,
});
const epmc = (title, extra = {}) => ({
  id: '111',
  source: 'MED',
  pmid: '111',
  title: `${title}.`,
  pubYear: '2021',
  citedByCount: 5,
  authorList: { author: [{ fullName: 'Wong DA' }] },
  journalInfo: { journal: { title: 'Hemoglobin' } },
  abstractText: 'About <i>HBB</i> &amp; more.',
  isOpenAccess: 'N',
  ...extra,
});

// A network that answers each library from `replies` and records what was asked.
function network(replies = {}) {
  const asked = [];
  const fetch = async (url) => {
    const u = new URL(url);
    asked.push(u);
    const key = u.hostname.includes('openalex')
      ? u.pathname.includes('sources')
        ? 'sources'
        : 'openalex'
      : u.hostname.includes('ebi.ac.uk')
        ? 'pubmed'
        : 'arxiv';
    const reply = replies[key];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return { ok: false, status: reply, text: async () => '' };
    const body =
      key === 'arxiv'
        ? reply || '<feed></feed>'
        : JSON.stringify(
            reply || (key === 'pubmed' ? { resultList: { result: [] } } : { results: [] }),
          );
    return { ok: true, status: 200, text: async () => body };
  };
  const hosts = () =>
    [
      ...new Set(asked.map((u) => (u.pathname.includes('sources') ? 'sources' : u.hostname))),
    ].sort();
  return { fetch, asked, hosts };
}

test('不指定学科时照旧查 OpenAlex 和 arXiv', async () => {
  const net = network();
  const out = await search(net.fetch, { query: 'attention' });
  assert.deepEqual(out.searched, ['OpenAlex', 'arXiv']);
  assert.deepEqual(net.hosts(), ['api.openalex.org', 'export.arxiv.org']);
});

test('医学方向加查 PubMed、不查 arXiv，并按学科过滤 OpenAlex', async () => {
  const net = network();
  const out = await search(net.fetch, { query: 'sickle cell CRISPR', fields: ['medicine'] });
  assert.deepEqual(out.searched, ['OpenAlex', 'PubMed']);
  const oa = net.asked.find((u) => u.hostname === 'api.openalex.org');
  assert.match(oa.searchParams.get('filter'), /primary_topic\.field\.id:27\|29/);
  const pm = net.asked.find((u) => u.hostname.includes('ebi.ac.uk'));
  assert.match(pm.searchParams.get('query'), /^TITLE_ABS:\(sickle cell crispr\)/);
  assert.equal(pm.searchParams.get('sort'), 'CITED desc');
});

test('人文社科只查 OpenAlex', async () => {
  const net = network();
  const out = await search(net.fetch, { query: 'Ming dynasty trade', fields: ['humanities'] });
  assert.deepEqual(out.searched, ['OpenAlex']);
  assert.deepEqual(net.hosts(), ['api.openalex.org']);
});

test('理工科查 arXiv 时只要对应分类', async () => {
  const net = network();
  await search(net.fetch, { query: 'entanglement', fields: ['physics'] });
  const ax = net.asked.find((u) => u.hostname === 'export.arxiv.org');
  const q = ax.searchParams.get('search_query');
  assert.match(q, /all:entanglement AND \(cat:physics\.\* OR /);
  assert.match(q, /cat:quant-ph/);
  assert.doesNotMatch(q, /cat:cs\./);
});

test('用户点名的库优先于学科', async () => {
  const net = network();
  const out = await search(net.fetch, {
    query: 'melanoma',
    fields: ['medicine'],
    sources: ['pubmed'],
    limit: 6,
  });
  assert.deepEqual(out.searched, ['PubMed']);
  const pm = net.asked.find((u) => u.hostname.includes('ebi.ac.uk'));
  assert.equal(pm.searchParams.get('pageSize'), '6');
});

test('按期刊筛选：OpenAlex 先查到期刊，PubMed 按刊名，arXiv 不查', async () => {
  const net = network({
    sources: { results: [{ id: 'https://openalex.org/S49861241', display_name: 'The Lancet' }] },
  });
  const out = await search(net.fetch, {
    query: 'malaria vaccine',
    sources: ['openalex', 'pubmed', 'arxiv'],
    venues: ['Lancet'],
  });
  assert.deepEqual(out.searched, ['OpenAlex', 'PubMed']);
  const oa = net.asked.find(
    (u) => u.hostname === 'api.openalex.org' && u.pathname.endsWith('/works'),
  );
  assert.match(oa.searchParams.get('filter'), /primary_location\.source\.id:S49861241/);
  const pm = net.asked.find((u) => u.hostname.includes('ebi.ac.uk'));
  assert.match(pm.searchParams.get('query'), /\(JOURNAL:"Lancet"\)/);
  assert.ok(out.notes.some((n) => n.includes('The Lancet')));
  assert.ok(out.notes.some((n) => n.includes('arXiv 是预印本库')));
});

test('只要 arXiv 又要按期刊筛选时说明原因', async () => {
  const net = network();
  await assert.rejects(
    search(net.fetch, { query: 'x', sources: ['arxiv'], venues: ['NeurIPS'] }),
    /arXiv 是预印本库/,
  );
});

test('找不到期刊时不悄悄放宽条件', async () => {
  const net = network({ sources: { results: [] } });
  const out = await search(net.fetch, { query: 'x', venues: ['不存在的期刊'] });
  assert.equal(out.papers.length, 0);
  assert.ok(!net.asked.some((u) => u.pathname.endsWith('/works')));
  assert.ok(out.notes.some((n) => n.includes('没有找到期刊或会议')));
});

test('PubMed 结果：开放获取的给 PMC 的 PDF，标题和摘要去掉标记', async () => {
  const net = network({
    pubmed: {
      resultList: {
        result: [
          epmc('Open one', { id: '1', pmid: '1', pmcid: 'PMC123', isOpenAccess: 'Y' }),
          epmc('Closed one', { id: '2', pmid: '2', pmcid: 'PMC456', isOpenAccess: 'N' }),
        ],
      },
    },
  });
  const { papers } = await search(net.fetch, { query: 'x', sources: ['pubmed'] });
  assert.equal(papers[0].title, 'Open one');
  assert.deepEqual(papers[0].pdf, [
    'https://pmc-oa-opendata.s3.amazonaws.com/PMC123.1/PMC123.1.pdf',
  ]);
  assert.equal(papers[0].abstract, 'About HBB & more.');
  assert.equal(papers[0].url, 'https://pubmed.ncbi.nlm.nih.gov/1/');
  assert.equal(papers[0].source, 'PubMed');
  assert.deepEqual(papers[1].pdf, []);
});

test('同一篇论文按标题或 DOI 合并，保留两边的信息', async () => {
  const net = network({
    openalex: {
      results: [
        work('Gene therapy for sickle cell', { doi: 'https://doi.org/10.1/ABC' }),
        work('Another paper'),
      ],
    },
    pubmed: {
      resultList: {
        result: [
          epmc('Gene Therapy for Sickle Cell', {
            pmid: '9',
            pmcid: 'PMC9',
            isOpenAccess: 'Y',
          }),
          epmc('Different title', { pmid: '8', doi: '10.1/abc' }),
        ],
      },
    },
  });
  const { papers } = await search(net.fetch, { query: 'x', fields: ['medicine'] });
  assert.equal(papers.length, 2);
  assert.equal(papers[0].pmid, '9');
  assert.equal(papers[0].source, 'OpenAlex、PubMed');
  assert.ok(papers[0].pdf[0].includes('PMC9'));
});

test('一个库失败时给出其他库的结果和说明，全部失败才报错', async () => {
  const net = network({ openalex: 503, pubmed: { resultList: { result: [epmc('Only')] } } });
  const out = await search(net.fetch, { query: 'x', fields: ['medicine'] });
  assert.equal(out.papers.length, 1);
  assert.ok(out.notes.some((n) => n.includes('OpenAlex 暂时繁忙')));
  const down = network({ openalex: 429, pubmed: 500 });
  await assert.rejects(search(down.fetch, { query: 'x', fields: ['medicine'] }), /OpenAlex/);
});

test('不认识的学科和库被忽略', async () => {
  const net = network();
  const out = await search(net.fetch, { query: 'x', fields: ['astrology'], sources: ['cnki'] });
  assert.deepEqual(out.searched, ['OpenAlex', 'arXiv']);
});

test('界面里的学科列表和后端一致', () => {
  const ts = fs.readFileSync(path.join(__dirname, '../src/ai/types.ts'), 'utf8');
  const block = ts.match(/PAPER_FIELDS = \[([\s\S]*?)\]/)[1];
  const listed = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed, Object.keys(FIELDS));
});

test('填了 OpenAlex Key 时随请求发出，期刊查找也带上', async () => {
  const net = network({
    sources: { results: [{ id: 'https://openalex.org/S1', display_name: 'Nature' }] },
  });
  await search(net.fetch, { query: 'x', venues: ['Nature'] }, { openalexKey: 'k-123' });
  const openalex = net.asked.filter((u) => u.hostname === 'api.openalex.org');
  assert.equal(openalex.length, 2);
  for (const u of openalex) assert.equal(u.searchParams.get('api_key'), 'k-123');
  assert.ok(
    !net.asked.some((u) => u.hostname !== 'api.openalex.org' && u.search.includes('k-123')),
  );
  const bare = network();
  await search(bare.fetch, { query: 'x' });
  assert.ok(bare.asked.every((u) => !u.searchParams.has('api_key')));
});

test('额度用完时提示去设置里填 Key，Key 无效时说明', async () => {
  const busy = network({ openalex: 429 });
  const out = await search(busy.fetch, { query: 'x' });
  assert.ok(out.notes.some((n) => n.includes('「论文检索」') && n.includes('免费的 OpenAlex Key')));
  const bad = network({ openalex: 401 });
  const again = await search(bad.fetch, { query: 'x' }, { openalexKey: 'wrong' });
  assert.ok(again.notes.some((n) => n.includes('OpenAlex 不认这个 Key')));
});

test('保存前核对 Key：被拒、可用、连不上', async () => {
  assert.equal(await checkOpenAlexKey(network({ openalex: 401 }).fetch, 'k'), false);
  assert.equal(await checkOpenAlexKey(network().fetch, 'k'), true);
  assert.equal(await checkOpenAlexKey(network({ openalex: Error('offline') }).fetch, 'k'), null);
});

test('OpenAlex Key 加密保存，设置里只看到提示，可以删除', async (t) => {
  const { createAi } = require('../electron/ai.cjs');
  const { atomicWrite } = require('../electron/workspace.cjs');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'folio-papers-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ai.json');
  const options = {
    file,
    fetch,
    atomicWrite,
    protect: (k) => 'enc:' + Buffer.from(k).reverse().toString('base64'),
    unprotect: (v) => Buffer.from(v.slice(4), 'base64').reverse().toString(),
  };
  const ai = createAi(options);
  assert.deepEqual((await ai.config()).papers.openalex, { hasKey: false, keyHint: '' });
  const saved = await ai.savePaperKey({ key: ' abcdefgh1234 ' });
  assert.deepEqual(saved.papers.openalex, { hasKey: true, keyHint: 'abc…1234' });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('abcdefgh1234'));
  assert.deepEqual(await createAi(options).paperKeys(), { openalexKey: 'abcdefgh1234' });
  await assert.rejects(ai.savePaperKey({ key: 'two words' }), /格式不正确/);
  await ai.savePaperKey({ key: '' });
  assert.deepEqual(await ai.paperKeys(), { openalexKey: '' });
});
