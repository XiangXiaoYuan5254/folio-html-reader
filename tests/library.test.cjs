const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Workspace, atomicWrite } = require('../electron/workspace.cjs');
const { createLibrary, toBibtex, fromBibtex } = require('../electron/library.cjs');
const papers = require('../electron/papers.cjs');

async function setup(t, now = new Date(2026, 10, 15, 9)) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-library-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '论文'));
  await fs.writeFile(path.join(root, '论文', 'attention.pdf'), '%PDF-1.4 a');
  await fs.writeFile(path.join(root, '论文', 'bert.pdf'), '%PDF-1.4 b');
  await fs.writeFile(path.join(root, '伴读.html'), '<h1>伴读</h1><p>注意力就是全部。</p>');
  const w = new Workspace();
  await w.open(root);
  let clock = now;
  const library = createLibrary({ atomicWrite, now: () => clock });
  return { w, root, library, setNow: (d) => (clock = d) };
}
const attention = {
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer'],
  year: 2017,
  venue: 'Neural Information Processing Systems',
  doi: 'https://doi.org/10.5555/3295222.3295349',
  arxiv: 'arXiv:1706.03762v7',
};

test('一篇论文只记一次：按 DOI、arXiv 号、标题或文件认出同一篇，只补空着的', async (t) => {
  const { w, library } = await setup(t);
  const first = await library.add(w, { ...attention, files: ['论文/attention.pdf'] });
  assert.equal(first.created, true);
  assert.equal(first.paper.doi, '10.5555/3295222.3295349');
  assert.equal(first.paper.arxiv, '1706.03762');
  assert.equal(first.paper.status, 'unread');
  await library.update(w, first.paper.id, { summary: '我的理解', tags: ['Transformer'] });
  for (const again of [
    { title: '别的写法', doi: '10.5555/3295222.3295349', summary: '别人的总结', citations: 9 },
    { title: '另一个标题', arxiv: '1706.03762' },
    { title: 'attention is all you need.', tags: ['必读'] },
    { title: '文件名', files: ['论文/attention.pdf'] },
  ]) {
    const r = await library.add(w, again);
    assert.equal(r.created, false);
    assert.equal(r.paper.id, first.paper.id);
  }
  const { papers: all } = await library.list(w);
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'Attention Is All You Need');
  assert.equal(all[0].summary, '我的理解');
  assert.equal(all[0].citations, 9);
  assert.deepEqual(all[0].tags, ['Transformer', '必读']);
  const forced = await library.add(w, { ...attention, summary: '改写' }, { overwrite: true });
  assert.equal(forced.paper.summary, '改写');
  await assert.rejects(library.add(w, { authors: ['无题'] }), /需要标题/);
});

test('标为已读记下当天；改回未读清掉；导入可以给出日期或留空', async (t) => {
  const { w, library, setNow } = await setup(t);
  const { paper } = await library.add(w, attention);
  const done = await library.update(w, paper.id, { status: 'done' });
  assert.deepEqual([done.status, done.readAt], ['done', '2026-11-15']);
  setNow(new Date(2026, 10, 20));
  const still = await library.update(w, paper.id, { status: 'done', summary: 's' });
  assert.equal(still.readAt, '2026-11-15', 'already read: the day stays');
  const back = await library.update(w, paper.id, { status: 'reading' });
  assert.deepEqual([back.status, back.readAt], ['reading', '']);
  const dated = await library.add(w, { title: 'BERT', status: 'done', readAt: '2024-03-01' });
  assert.equal(dated.paper.readAt, '2024-03-01');
  const unknown = await library.add(w, { title: 'GPT-3', status: 'done', readAt: '' });
  assert.deepEqual([unknown.paper.status, unknown.paper.readAt], ['done', '']);
});

test('文件跟着论文：一个文件只属于一篇，移动、改名后还连着', async (t) => {
  const { w, root, library } = await setup(t);
  const a = await library.add(w, { title: 'A', files: ['论文/attention.pdf', '伴读.html'] });
  const b = await library.add(w, { title: 'B', files: ['论文/bert.pdf'] });
  await library.update(w, b.paper.id, { files: ['论文/bert.pdf', '伴读.html'] });
  let { papers: all } = await library.list(w);
  assert.deepEqual(all.find((p) => p.id === a.paper.id).files, ['论文/attention.pdf']);
  assert.deepEqual(all.find((p) => p.id === b.paper.id).files, ['论文/bert.pdf', '伴读.html']);
  // Moved in 页间.
  await w.move({ from: '论文', to: '已归档' });
  await library.moved(w, '论文', '已归档');
  ({ papers: all } = await library.list(w));
  assert.deepEqual(all.find((p) => p.id === a.paper.id).files, ['已归档/attention.pdf']);
  // Moved outside 页间: found again by its name; one that is gone is said to be.
  await fs.mkdir(path.join(root, '别处'));
  await fs.rename(
    path.join(root, '已归档', 'attention.pdf'),
    path.join(root, '别处', 'attention.pdf'),
  );
  await fs.rm(path.join(root, '已归档', 'bert.pdf'));
  ({ papers: all } = await library.list(w));
  const pa = all.find((p) => p.id === a.paper.id);
  const pb = all.find((p) => p.id === b.paper.id);
  assert.deepEqual([pa.files, pa.gone], [['别处/attention.pdf'], []]);
  assert.deepEqual(pb.gone, ['已归档/bert.pdf']);
  assert.deepEqual((await library.read(w)).papers[0].files, ['别处/attention.pdf'], 'kept');
  // Paths that are not documents of the project never get in.
  const odd = await library.add(w, {
    title: 'C',
    files: ['../外面.pdf', '/etc/passwd', '.html-reader/x.html', 'notes.txt'],
  });
  assert.deepEqual(odd.paper.files, []);
});

test('书单保持顺序；删论文时从书单里去掉', async (t) => {
  const { w, library } = await setup(t);
  const ids = [];
  for (const title of ['One paper', 'Two paper', 'Three paper'])
    ids.push((await library.add(w, { title })).paper.id);
  await library.setList(w, { name: '入门', note: '先读这些', papers: [ids[2], 'nope', ids[0]] });
  assert.deepEqual((await library.list(w)).lists, [
    { name: '入门', note: '先读这些', papers: [ids[2], ids[0]] },
  ]);
  assert.equal(await library.remove(w, [ids[2]]), 1);
  assert.deepEqual((await library.list(w)).lists[0].papers, [ids[0]]);
  await library.setList(w, { name: '入门', papers: [] });
  assert.deepEqual((await library.list(w)).lists, []);
});

test('一篇论文带上读者在它的文件里写下的东西', async (t) => {
  const { w, library } = await setup(t);
  const d = await w.document('伴读.html');
  await w.saveData({
    id: d.id,
    data: {
      ...d.data,
      note: '# 我的笔记',
      annotations: [
        { id: 'a', type: 'highlight', note: '关键', quote: { exact: '注意力就是全部' } },
        { id: 'b', type: 'sticky', note: '便签上的话' },
        { id: 'c', type: 'pen', note: '' },
      ],
    },
  });
  const { paper } = await library.add(w, { title: 'A', files: ['伴读.html', '论文/bert.pdf'] });
  const detail = await library.detail(w, paper.id);
  assert.equal(detail.documents.length, 2);
  assert.deepEqual(detail.documents[0], {
    path: '伴读.html',
    kind: 'html',
    note: '# 我的笔记',
    highlights: [{ text: '注意力就是全部', note: '关键' }],
    notes: ['便签上的话'],
    progress: 0,
  });
  assert.deepEqual(detail.documents[1], { path: '论文/bert.pdf', kind: 'pdf' });
});

test('损坏的文献库不会被覆盖；当天第一次修改前留一份备份', async (t) => {
  const { w, root, library, setNow } = await setup(t);
  await library.add(w, attention);
  setNow(new Date(2026, 10, 16, 9));
  await library.add(w, { title: 'BERT' });
  await library.add(w, { title: 'GPT-2' });
  const backup = JSON.parse(
    await fs.readFile(path.join(root, '.html-reader', 'library.backup.json'), 'utf8'),
  );
  assert.equal(backup.papers.length, 1);
  await fs.writeFile(path.join(root, '.html-reader', 'library.json'), '{oops');
  await assert.rejects(library.add(w, { title: 'GPT' }), /损坏/);
  assert.equal(await fs.readFile(path.join(root, '.html-reader', 'library.json'), 'utf8'), '{oops');
});

test('BibTeX：导出能被读回，Zotero 式的条目也读得了', async () => {
  const bib = toBibtex([
    { ...attention, doi: '10.5555/3295222.3295349', arxiv: '1706.03762', url: '' },
    {
      title: 'Language Models are Few-Shot Learners',
      authors: ['Tom Brown'],
      year: 2020,
      venue: '',
      doi: '',
      arxiv: '2005.14165',
      url: '',
    },
    {
      title: 'Deep learning & nature_50%',
      authors: ['LeCun, Yann'],
      year: 2015,
      venue: 'Nature',
      doi: '10.1038/nature14539',
      arxiv: '',
      url: '',
    },
  ]);
  assert.match(bib, /@inproceedings\{vaswani2017attention,/);
  assert.match(bib, /booktitle = \{Neural Information Processing Systems\}/);
  assert.match(bib, /@misc\{brown2020language,/);
  assert.match(bib, /@article\{lecun2015deep,/);
  assert.match(bib, /title = \{\{Deep learning \\& nature\\_50\\%\}\}/);
  const back = fromBibtex(bib);
  assert.deepEqual(
    back.map((p) => [p.title, p.authors[0], p.year, p.venue, p.arxiv]),
    [
      [
        'Attention Is All You Need',
        'Ashish Vaswani',
        '2017',
        'Neural Information Processing Systems',
        '1706.03762',
      ],
      ['Language Models are Few-Shot Learners', 'Tom Brown', '2020', '', '2005.14165'],
      ['Deep learning & nature_50%', 'Yann LeCun', '2015', 'Nature', ''],
    ],
  );
  const zotero = fromBibtex(`
@comment{jabref-meta: x}
@article{devlin_bert_2019,
  title = {{BERT}: {Pre}-training of {Deep} {Bidirectional} {Transformers}},
  author = {Devlin, Jacob and Chang, Ming-Wei},
  journal = "Proceedings of {NAACL}",
  year = 2019,
  keywords = {nlp, pretraining; bert},
  file = {Full Text:/Users/someone/Zotero/storage/ABC/bert.pdf:application/pdf}
}
@book{broken`);
  assert.equal(zotero.length, 1);
  assert.deepEqual(zotero[0].authors, ['Jacob Devlin', 'Ming-Wei Chang']);
  assert.equal(zotero[0].title, 'BERT: Pre-training of Deep Bidirectional Transformers');
  assert.equal(zotero[0].venue, 'Proceedings of NAACL');
  assert.deepEqual(zotero[0].tags, ['nlp', 'pretraining', 'bert']);
});

test('自动补全：按 arXiv 号找到论文，再按标题补上发表的会议和被引次数', async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(String(url));
    const reply = (body) => ({ ok: true, status: 200, text: async () => body });
    if (String(url).includes('export.arxiv.org'))
      return reply(`<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id>
        <title>Attention Is All You Need</title><published>2017-06-12T00:00:00Z</published>
        <author><name>Ashish Vaswani</name></author><summary>We propose the Transformer.</summary>
        </entry></feed>`);
    return reply(
      JSON.stringify({
        results: [
          {
            title: 'Attention is all you need',
            publication_year: 2017,
            cited_by_count: 100000,
            doi: 'https://doi.org/10.5555/3295222.3295349',
            authorships: [{ author: { display_name: 'Ashish Vaswani' } }],
            primary_location: { source: { display_name: 'Neural Information Processing Systems' } },
            id: 'https://openalex.org/W1',
          },
          { title: 'Attention is not all you need', publication_year: 2021, id: 'W2' },
        ],
      }),
    );
  };
  const { papers: found } = await papers.lookup(fetch, { arxiv: 'arXiv:1706.03762v7' });
  assert.ok(requests[0].includes('id_list=1706.03762'));
  assert.equal(found[0].title, 'Attention Is All You Need');
  assert.equal(found[0].match, 1);
  assert.equal(found[0].arxiv, '1706.03762');
  assert.equal(found[0].venue, 'Neural Information Processing Systems');
  assert.equal(found[0].citations, 100000);
  assert.ok(found[1].match < 1, 'a near miss comes after');
});

test('其他 AI 工具通过 MCP 读文献库：要对上地址里的口令，能查能记，改不了阅读状态', async (t) => {
  const { createLibraryMcp } = require('../electron/library-mcp.cjs');
  const { w, library } = await setup(t);
  const d = await w.document('伴读.html');
  await w.saveData({
    id: d.id,
    data: {
      ...d.data,
      note: '起点。',
      annotations: [
        { id: 'a', type: 'highlight', note: '关键', quote: { exact: '注意力就是全部' } },
      ],
    },
  });
  const { paper } = await library.add(w, { ...attention, files: ['伴读.html'], status: 'done' });
  let changes = 0;
  const mcp = createLibraryMcp({
    library,
    workspace: w,
    version: '1.0.0',
    onChange: () => changes++,
  });
  // A port of the test's own, so a 页间 that is running isn't in the way.
  const port = await mcp.start({
    secret: 'secret-token',
    preferred: 47400 + Math.floor(Math.random() * 400),
  });
  t.after(() => mcp.stop());
  assert.equal(mcp.url(), `http://127.0.0.1:${port}/mcp/secret-token`);
  const post = (url, body, headers = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const rpc = async (method, params) =>
    (await post(mcp.url(), { jsonrpc: '2.0', id: 1, method, params })).json();
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;

  // Not without the secret, not by another name for this computer, not by GET.
  assert.equal((await post(`http://127.0.0.1:${port}/mcp/wrong-token`, {})).status, 404);
  assert.equal((await post(`http://127.0.0.1:${port}/mcp/`, {})).status, 404);
  assert.equal((await fetch(mcp.url())).status, 405);
  const rebound = await new Promise((resolve) => {
    const req = require('node:http').request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp/secret-token',
        method: 'POST',
        headers: { Host: 'evil.example.com' },
      },
      (res) => resolve(res.statusCode),
    );
    req.end('{}');
  });
  assert.equal(rebound, 404);

  const hello = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(hello.result.serverInfo.name, 'folio-library');
  assert.equal(
    (await post(mcp.url(), { jsonrpc: '2.0', method: 'notifications/initialized' })).status,
    202,
  );
  const { tools } = (await rpc('tools/list')).result;
  assert.deepEqual(
    tools.map((x) => x.name),
    ['list_papers', 'get_paper', 'add_paper', 'update_paper'],
  );
  assert.ok(
    tools.every(
      (x) => !JSON.stringify(x.inputSchema).includes('"status"') || x.name === 'list_papers',
    ),
  );

  const listed = (await tool('list_papers', {})).content[0].text;
  assert.match(listed, /Library: 1 papers — 1 read/);
  assert.match(
    listed,
    new RegExp(
      `\\[${paper.id.slice(0, 8)}\\] Attention Is All You Need — Ashish Vaswani, Noam Shazeer · 2017`,
    ),
  );
  assert.match(listed, /已读 2026-11-15/);
  const got = (await tool('get_paper', { id: paper.id.slice(0, 8) })).content[0].text;
  assert.match(got, /Highlighted by the reader:\n- "注意力就是全部"\n  note: 关键/);
  assert.match(got, /Document note:\n起点。/);

  // A paper it found goes in; the status it tries to set does not.
  const added = await tool('add_paper', {
    title: 'BERT',
    year: 2019,
    files: [require('node:path').join(w.root, '论文', 'bert.pdf')],
    status: 'done',
  });
  assert.match(
    added.content[0].text,
    /Added to the library: \[\w{8}\] BERT \(files: 论文\/bert\.pdf\)/,
  );
  const updated = await tool('update_paper', {
    id: paper.id,
    summary: '只用注意力。',
    status: 'unread',
  });
  assert.match(updated.content[0].text, /^Updated:/);
  const after = (await library.list(w)).papers;
  assert.deepEqual(
    after.map((p) => [p.title, p.status]),
    [
      ['Attention Is All You Need', 'done'],
      ['BERT', 'unread'],
    ],
  );
  assert.equal(after[0].summary, '只用注意力。');
  assert.equal(changes, 2);
  const missing = await tool('get_paper', { id: 'nope-nope' });
  assert.equal(missing.isError, true);
  assert.equal((await rpc('resources/list')).error.code, -32601);

  await mcp.stop();
  assert.equal(mcp.url(), '');
  await assert.rejects(post(`http://127.0.0.1:${port}/mcp/secret-token`, {}));
});
