// 把页间的文献库（folio.library.list()）整理成仪表盘各个视图要的数据。
// 一篇论文：标题、别名（中文名或简称）、分类（没填就按所在文件夹）、年份、出处、读没读过、哪天读完。
// 出处先认成渠道简称（venues.js），再由渠道得到发表类型；分级（插件设置的「渠道分级」）默认不分，
// 可以选 CCF（计算机方向），或只用读者自己写的等级表。
const stripNo = (name) => String(name || '').replace(/^\d+[_.\s]\s*/, '').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hasCjk = (s) => /[㐀-鿿]/.test(s);

// 渠道分级：none 不分级，ccf 用 CCF 目录（加上读者写的），custom 只用读者写的。
const RANKING = ['ccf', 'custom'].includes(folio.settings.ranking) ? folio.settings.ranking : 'none';
// 每种分级的档位，从高到低。
const TIERS = {
  ccf: ['CCF-A', 'CCF-B', 'CCF-C', '无CCF评级', '预印本', '未知'],
  custom: ['A 级', 'B 级', 'C 级', '未分级', '预印本', '未知'],
  none: [],
};
// 插件设置里写的渠道等级：一行一个 “渠道名=等级”，等级是 A、B、C 或 -。
function venueOverrides() {
  const out = {};
  for (const line of String(folio.settings.venues || '').split(/\n+/)) {
    const m = line.match(/^\s*(.+?)\s*[=＝:：]\s*([ABCabc\-－])\s*$/);
    if (m) out[norm(m[1])] = { name: m[1].trim(), rank: m[2].toUpperCase().replace('－', '-') };
  }
  return out;
}
const SHORT = Object.fromEntries(Object.keys(VENUE_RANK).map((k) => [norm(k), k]));
// 出处 → 渠道：补充的优先，然后是简称、整名、全称里的说法；都不是就用原名。
function venueOf(paper, overrides) {
  const raw = String(paper.venue || '').trim();
  if (!raw) return paper.arxiv ? 'arXiv' : '未知';
  const key = norm(raw);
  if (overrides[key]) return overrides[key].name;
  if (SHORT[key]) return SHORT[key];
  if (VENUE_EXACT[key]) return VENUE_EXACT[key];
  for (const [phrase, name] of VENUE_ALIASES) if (key.includes(phrase)) return name;
  // “… (NeurIPS 2017)”“Proc. of ICML”：全称里带着简称
  for (const word of raw.split(/[^A-Za-z]+/)) if (word.length >= 3 && SHORT[norm(word)] && word === word.toUpperCase()) return SHORT[norm(word)];
  return raw;
}
const typeOf = (venue) => (JOURNALS.has(venue) ? '期刊' : PREPRINTS.has(venue) ? '预印本' : '会议');
const bucketOf = (rank, type) =>
  RANKING === 'none'
    ? ''
    : ['A', 'B', 'C'].includes(rank)
      ? RANKING === 'ccf' ? 'CCF-' + rank : rank + ' 级'
      : type === '预印本' ? '预印本' : TIERS[RANKING][3];
// 像期刊的名字按期刊算（不在上面的表里时）。
const looksJournal = (venue) => /\b(journal|transactions|review|letters|annals|bulletin|magazine)\b/i.test(venue);

function agg(items, keyOf, order) {
  const m = new Map();
  for (const p of items) {
    const k = keyOf(p);
    if (!m.has(k)) m.set(k, { name: k, total: 0, read: 0 });
    const e = m.get(k);
    e.total++;
    if (p.done) e.read++;
  }
  const keys = [...(order || []).filter((k) => m.has(k)), ...[...m.keys()].filter((k) => !order || !order.includes(k))];
  return keys.map((k) => m.get(k));
}

async function buildData() {
  const lib = await folio.library.list();
  const overrides = venueOverrides();
  const ranks = {};
  for (const list of lib.lists || []) list.papers.forEach((id, i) => ((ranks[id] = ranks[id] || {})[list.name] = i + 1));
  const papers = lib.papers.map((p) => {
    const files = p.files.filter((f) => !p.gone.includes(f));
    // 先开笔记（HTML、Markdown），没有再开 PDF。
    const main = files.find((f) => !/\.pdf$/i.test(f)) || files[0] || '';
    const folder = main.includes('/') ? main.slice(0, main.lastIndexOf('/')) : '';
    const parts = (p.category || folder || '未分类').split('/').filter(Boolean);
    const cat = parts[0];
    const sub = parts.slice(1).join(' / ') || '（未细分）';
    // 别名里可以写“简称 · 中文名”，或只写其中一个。
    const names = p.alias.split(/\s*[·|｜]\s*/).filter(Boolean);
    const zh = names.find(hasCjk) || '';
    const label = names.find((n) => !hasCjk(n)) || '';
    const venue = venueOf(p, overrides);
    const type = venue === '未知' ? '未知' : looksJournal(venue) && !PREPRINTS.has(venue) ? '期刊' : typeOf(venue);
    const rank =
      RANKING === 'none' || venue === '未知'
        ? '?'
        : overrides[norm(venue)]?.rank || (RANKING === 'ccf' && VENUE_RANK[venue]) || '-';
    const authors = p.authors.length > 4 ? p.authors.slice(0, 4).join('、') + ' 等' : p.authors.join('、');
    return {
      id: p.id,
      label,
      title_en: p.title,
      title_zh: zh,
      year: p.year || null,
      cat, cat_disp: stripNo(cat),
      sub, sub_disp: stripNo(sub),
      done: p.status === 'done',
      reading: p.status === 'reading',
      read_date: p.readAt || null,
      note: main,
      files,
      note_time: p.addedAt || null,
      summary: p.summary ? [p.summary] : [],
      notes: p.note ? p.note.split(/\n+/).map((t) => ({ t: t.replace(/^[-*]\s+/, '') })) : [],
      authors,
      link: p.doi ? 'https://doi.org/' + p.doi : p.arxiv ? 'https://arxiv.org/abs/' + p.arxiv : p.url || '',
      venue, ccf: rank, vtype: type,
      ccfBucket: venue === '未知' ? '未知' : bucketOf(rank, type),
      ranks: ranks[p.id] || {},
    };
  });
  const by = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true });
  // 分类按名字排（带编号的按编号），「未分类」放最后。
  const last = (name) => (name === '未分类' ? 1 : 0);
  const catNames = [...new Set(papers.map((p) => p.cat))].sort((a, b) => last(a) - last(b) || by(a, b));
  const categories = catNames.map((name) => {
    const cp = papers.filter((p) => p.cat === name);
    const subs = [...new Set(cp.map((p) => p.sub))].sort(by).map((s) => {
      const sp = cp.filter((p) => p.sub === s);
      return { name: s, disp: stripNo(s), total: sp.length, read: sp.filter((p) => p.done).length };
    });
    return { name, disp: stripNo(name), total: cp.length, read: cp.filter((p) => p.done).length, subs };
  });
  const known = [...new Set(papers.map((p) => p.year).filter(Boolean))].sort((a, b) => a - b);
  const years = known.map((y) => {
    const yp = papers.filter((p) => p.year === y);
    return { year: y, total: yp.length, read: yp.filter((p) => p.done).length };
  });
  const undated = papers.filter((p) => !p.year);
  if (undated.length) years.push({ year: '未知', total: undated.length, read: undated.filter((p) => p.done).length });

  const ccf = RANKING === 'none' ? [] : agg(papers, (p) => p.ccfBucket, TIERS[RANKING]);
  const vtypes = agg(papers, (p) => p.vtype, ['会议', '期刊', '预印本', '未知']);
  const meta = {};
  for (const p of papers) meta[p.venue] = meta[p.venue] || { rank: p.ccf, vtype: p.vtype };
  for (const c of ccf) {
    const venues = agg(papers.filter((p) => p.ccfBucket === c.name), (p) => p.venue)
      .map((v) => ({ ...v, ...meta[v.name] }))
      .sort((a, b) => b.total - a.total);
    // 只有在收了 CCF 评级的论文时，才提示还没覆盖的核心顶会顶刊。
    if (RANKING === 'ccf' && c.name === 'CCF-A')
      for (const name of CORE_A)
        if (!venues.some((v) => v.name === name))
          venues.push({ name, total: 0, read: 0, rank: 'A', vtype: typeOf(name), uncovered: true });
    c.venues = venues;
  }
  const venuesAll = agg(papers, (p) => p.venue)
    .map((v) => ({ ...v, ...meta[v.name] }))
    .filter((v) => v.name !== '未知')
    .sort((a, b) => b.total - a.total);
  const read = papers.filter((p) => p.done).length;
  return {
    totals: { total: papers.length, read, unread: papers.length - read },
    categories, years, ccf, vtypes, venuesAll, papers,
    ranking: RANKING,
    lists: (lib.lists || []).map((l) => ({ name: l.name, note: l.note, count: l.papers.length })),
    // 文献库或渠道设置变了，这个就变。
    stamp: JSON.stringify([lib, folio.settings.venues || '', RANKING]),
  };
}
