// Finding and downloading papers for the AI assistant. OpenAlex covers every field and links
// open-access PDFs; arXiv adds preprints in the sciences, which always have one; PubMed (through
// Europe PMC) adds medicine and the life sciences. None needs a key.
const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const titleKey = (title) =>
  clean(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (text) =>
  clean(
    String(text ?? '').replace(
      /&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,
      (_, name, dec, hex) =>
        dec
          ? String.fromCodePoint(Number(dec))
          : hex
            ? String.fromCodePoint(parseInt(hex, 16))
            : entities[name.toLowerCase()],
    ),
  );
// Words for a library that takes a query language: no operators, quotes or field names.
const keywords = (query) =>
  query
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .slice(0, 12);

// Libraries the user can name.
const LIBRARIES = { openalex: 'OpenAlex', pubmed: 'PubMed', arxiv: 'arXiv' };
// Fields as the assistant names them: OpenAlex field ids, the arXiv categories that cover them,
// and whether PubMed does. A field neither covers is searched in OpenAlex only.
const FIELDS = {
  computer_science: { openalex: [17], arxiv: ['cs.*', 'stat.ML', 'eess.*'] },
  mathematics: { openalex: [26], arxiv: ['math.*', 'stat.*'] },
  physics: {
    openalex: [31],
    arxiv: [
      'physics.*',
      'astro-ph',
      'astro-ph.*',
      'cond-mat.*',
      'quant-ph',
      'gr-qc',
      'hep-th',
      'hep-ph',
      'hep-ex',
      'hep-lat',
      'nucl-th',
      'nucl-ex',
      'nlin.*',
      'math-ph',
    ],
  },
  engineering: { openalex: [22, 21, 15], arxiv: ['eess.*', 'cs.RO', 'cs.SY', 'physics.app-ph'] },
  materials: { openalex: [25], arxiv: ['cond-mat.mtrl-sci', 'cond-mat.soft'] },
  chemistry: { openalex: [16] },
  earth_environment: { openalex: [19, 23] },
  biology: { openalex: [11, 13, 24], pubmed: true },
  medicine: { openalex: [27, 29, 30, 34, 35, 36], pubmed: true },
  neuroscience: { openalex: [28], pubmed: true },
  psychology: { openalex: [32], pubmed: true },
  economics: { openalex: [20, 18], arxiv: ['econ.*', 'q-fin.*'] },
  business: { openalex: [14] },
  social_sciences: { openalex: [33] },
  humanities: { openalex: [12] },
};

// An error carrying the HTTP status that caused it, when there was one.
const failure = (message, status) => Object.assign(Error(message), { status });

async function getText(fetch, url, what) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw failure(`${what} 连接失败（${e?.message || e}）`);
  }
  if (response.status === 429 || response.status === 503)
    throw failure(`${what} 暂时繁忙（HTTP ${response.status}），可以稍后再试`, response.status);
  if (!response.ok) throw failure(`${what} 返回 HTTP ${response.status}`, response.status);
  return response.text();
}

// Without a key, OpenAlex shares one small daily allowance among everyone on the same network
// address; the user's own free key has an allowance of its own.
const keyPlace = 'AI 设置的「论文检索」';
async function openAlexGet(fetch, kind, params, key) {
  if (key) params.set('api_key', key);
  try {
    return JSON.parse(
      await getText(fetch, `https://api.openalex.org/${kind}?${params}`, 'OpenAlex'),
    );
  } catch (e) {
    if (key && (e.status === 401 || e.status === 403))
      throw failure(`OpenAlex 不认这个 Key（HTTP ${e.status}），请到${keyPlace}里检查`, e.status);
    if (!key && e.status === 429)
      throw failure(
        `OpenAlex 暂时繁忙（HTTP 429）。不填 Key 时同一网络的人共用每天的免费额度，可能已经用完；可以在${keyPlace}里填一个免费的 OpenAlex Key`,
        429,
      );
    throw e;
  }
}

// Whether OpenAlex takes `key`: false when it refuses it, null when it can't be asked now.
async function checkOpenAlexKey(fetch, key) {
  try {
    await openAlexGet(fetch, 'works', new URLSearchParams({ 'per-page': '1', select: 'id' }), key);
    return true;
  } catch (e) {
    return e.status === 401 || e.status === 403 ? false : null;
  }
}

// OpenAlex keeps abstracts as word → positions.
function abstractOf(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [word, places] of Object.entries(index))
    for (const at of Array.isArray(places) ? places : []) words[at] = word;
  return words.filter(Boolean).join(' ');
}

// Journal or conference names → the OpenAlex sources best matching them.
async function openAlexVenues(fetch, names, key) {
  return Promise.all(
    names.map(async (name) => {
      const params = new URLSearchParams({
        search: name,
        'per-page': '1',
        select: 'id,display_name',
      });
      const data = await openAlexGet(fetch, 'sources', params, key);
      const found = data.results?.[0];
      const id = String(found?.id || '').match(/S\d+$/)?.[0];
      return { name, id, display: clean(found?.display_name) || name };
    }),
  );
}

async function openAlex(fetch, { query, limit, fromYear, pdfOnly, fieldIds, venueIds, key }) {
  const filters = [
    fromYear ? `from_publication_date:${fromYear}-01-01` : '',
    pdfOnly ? 'has_pdf_url:true' : '',
    fieldIds?.length ? `primary_topic.field.id:${fieldIds.join('|')}` : '',
    venueIds?.length ? `primary_location.source.id:${venueIds.join('|')}` : '',
  ].filter(Boolean);
  const params = new URLSearchParams({
    search: query,
    'per-page': String(limit),
    select:
      'title,doi,publication_year,cited_by_count,authorships,primary_location,best_oa_location,locations,abstract_inverted_index,id',
  });
  if (filters.length) params.set('filter', filters.join(','));
  const data = await openAlexGet(fetch, 'works', params, key);
  return (data.results || []).map((w) => {
    const pdf = [w.best_oa_location?.pdf_url, ...(w.locations || []).map((l) => l?.pdf_url)];
    return {
      title: clean(w.title),
      authors: (w.authorships || []).map((a) => clean(a?.author?.display_name)).filter(Boolean),
      year: w.publication_year || undefined,
      venue: clean(w.primary_location?.source?.display_name) || undefined,
      citations: typeof w.cited_by_count === 'number' ? w.cited_by_count : undefined,
      doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : undefined,
      url: w.primary_location?.landing_page_url || w.doi || w.id,
      pdf: [...new Set(pdf.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))],
      abstract: abstractOf(w.abstract_inverted_index),
      source: 'OpenAlex',
    };
  });
}

// Europe PMC holds PubMed, PubMed Central and the biomedical preprint servers. Its own PDF links
// sit behind a bot check, so the PDF offered is PubMed Central's open-access copy on AWS, which is
// published for programs to fetch; it exists for the open-access subset only.
async function pubmed(fetch, { query, limit, fromYear, pdfOnly, venues }) {
  const words = keywords(query);
  if (!words.length) return [];
  const journals = venues.map((v) => v.replace(/["\\]/g, ' ').trim()).filter(Boolean);
  const search =
    [
      `TITLE_ABS:(${words.join(' ')})`,
      fromYear ? `PUB_YEAR:[${fromYear} TO 2100]` : '',
      pdfOnly ? 'OPEN_ACCESS:y' : '',
      journals.length ? `(${journals.map((j) => `JOURNAL:"${j}"`).join(' OR ')})` : '',
    ]
      .filter(Boolean)
      .join(' AND ') + ' NOT PUB_TYPE:"Published Erratum"';
  // Its relevance order is newest first; most cited among the matches reads better.
  const params = new URLSearchParams({
    query: search,
    format: 'json',
    resultType: 'core',
    pageSize: String(limit),
    sort: 'CITED desc',
  });
  const data = JSON.parse(
    await getText(
      fetch,
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`,
      'PubMed（Europe PMC）',
    ),
  );
  if (!data.resultList)
    throw Error(`PubMed（Europe PMC）暂时不可用（${clean(data.errMsg) || '没有返回结果'}）`);
  return (data.resultList.result || []).map((r) => {
    const pmcid = /^PMC\d+$/.test(r.pmcid || '') ? r.pmcid : '';
    const authors = (r.authorList?.author || [])
      .map((a) => clean(a?.fullName || a?.collectiveName))
      .filter(Boolean);
    return {
      title: xmlText(String(r.title || '').replace(/<[^>]+>/g, '')).replace(/\.$/, ''),
      authors,
      year: Number(r.pubYear) || undefined,
      venue: clean(r.journalInfo?.journal?.title || r.bookOrReportDetails?.publisher) || undefined,
      citations: typeof r.citedByCount === 'number' ? r.citedByCount : undefined,
      doi: clean(r.doi) || undefined,
      pmid: clean(r.pmid) || undefined,
      url: r.pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`
        : `https://europepmc.org/article/${r.source}/${r.id}`,
      pdf:
        r.isOpenAccess === 'Y' && pmcid
          ? [`https://pmc-oa-opendata.s3.amazonaws.com/${pmcid}.1/${pmcid}.1.pdf`]
          : [],
      abstract: xmlText(String(r.abstractText || '').replace(/<[^>]+>/g, ' ')),
      source: 'PubMed',
    };
  });
}

async function arxiv(fetch, { query, limit, fromYear, categories }) {
  const words = keywords(query);
  if (!words.length) return [];
  const parts = [words.map((w) => `all:${w}`).join(' AND ')];
  if (categories.length) parts.push(`(${categories.map((c) => `cat:${c}`).join(' OR ')})`);
  if (fromYear) parts.push(`submittedDate:[${fromYear}01010000 TO 299912312359]`);
  const params = new URLSearchParams({
    search_query: parts.join(' AND '),
    start: '0',
    max_results: String(limit),
    sortBy: 'relevance',
  });
  const xml = await getText(fetch, `https://export.arxiv.org/api/query?${params}`, 'arXiv');
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const tag = (name) => entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
    const id = xmlText(tag('id')).replace(/^https?:\/\/arxiv\.org\/abs\//, '');
    return {
      title: xmlText(tag('title')),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => xmlText(m[1])),
      year: Number(xmlText(tag('published')).slice(0, 4)) || undefined,
      venue: xmlText(tag('arxiv:journal_ref')) || undefined,
      doi: xmlText(tag('arxiv:doi')) || undefined,
      arxiv: id,
      url: `https://arxiv.org/abs/${id}`,
      pdf: [`https://arxiv.org/pdf/${id}`],
      abstract: xmlText(tag('summary')),
      source: 'arXiv',
    };
  });
}

const list = (value, max) =>
  (Array.isArray(value) ? value : [])
    .map((v) => clean(v))
    .filter(Boolean)
    .slice(0, max);

// The libraries the user named, or the ones that suit the fields: OpenAlex always, arXiv for the
// sciences it holds (or when no field is given), PubMed for medicine and the life sciences.
function plan(fields, named, venues) {
  const notes = [];
  let chosen = named.length
    ? named
    : [
        'openalex',
        ...(fields.some((f) => FIELDS[f].pubmed) ? ['pubmed'] : []),
        ...(!fields.length || fields.some((f) => FIELDS[f].arxiv) ? ['arxiv'] : []),
      ];
  if (venues.length && chosen.includes('arxiv')) {
    chosen = chosen.filter((s) => s !== 'arxiv');
    if (named.includes('arxiv')) notes.push('arXiv 是预印本库，不能按期刊筛选，这次没有查 arXiv');
  }
  if (!chosen.length)
    throw Error(
      'arXiv 是预印本库，不能按期刊或会议筛选。请去掉期刊条件，或改查 OpenAlex、PubMed。',
    );
  return { chosen: Object.keys(LIBRARIES).filter((s) => chosen.includes(s)), notes };
}

// The chosen libraries at once; one failing still gives the others' results, with a note.
// `keys` come from the settings, never from the window's request.
async function search(fetch, payload, { openalexKey = '' } = {}) {
  const query = clean(payload?.query).slice(0, 300);
  if (!query) throw Error('请提供搜索关键词');
  const limit = Math.min(20, Math.max(1, Math.round(Number(payload?.limit)) || 8));
  const year = Math.round(Number(payload?.fromYear));
  const fields = [...new Set(list(payload?.fields, 3).filter((f) => FIELDS[f]))];
  const named = [...new Set(list(payload?.sources, 3).filter((s) => LIBRARIES[s]))];
  const venues = list(payload?.venues, 3).map((v) => v.slice(0, 100));
  const { chosen, notes } = plan(fields, named, venues);
  const options = {
    query,
    fromYear: year >= 1900 && year <= 2100 ? year : 0,
    pdfOnly: !!payload?.pdfOnly,
  };
  // OpenAlex gives the full count; with it, the others add a few each.
  const share = chosen.length === 1 ? limit : Math.ceil(limit / 2);
  const runs = {
    openalex: async () => {
      let venueIds;
      if (venues.length) {
        const found = await openAlexVenues(fetch, venues, openalexKey);
        const missing = found.filter((v) => !v.id).map((v) => `“${v.name}”`);
        if (missing.length) notes.push(`OpenAlex 里没有找到期刊或会议 ${missing.join('、')}`);
        venueIds = found.filter((v) => v.id).map((v) => v.id);
        if (!venueIds.length) return [];
        notes.push(
          `OpenAlex 按期刊筛选：${found
            .filter((v) => v.id)
            .map((v) => v.display)
            .join('、')}`,
        );
      }
      const fieldIds = fields.flatMap((f) => FIELDS[f].openalex);
      return openAlex(fetch, { ...options, limit, fieldIds, venueIds, key: openalexKey });
    },
    pubmed: () => pubmed(fetch, { ...options, limit: share, venues }),
    arxiv: () =>
      arxiv(fetch, {
        ...options,
        limit: share,
        categories: [...new Set(fields.flatMap((f) => FIELDS[f].arxiv || []))],
      }),
  };
  const settled = await Promise.allSettled(chosen.map((s) => runs[s]()));
  const failed = settled.filter((r) => r.status === 'rejected');
  if (failed.length === settled.length)
    throw Error(failed.map((r) => r.reason?.message || String(r.reason)).join('；'));
  notes.push(...failed.map((r) => r.reason?.message || String(r.reason)));
  // The same paper from two libraries (a published paper and its arXiv or PubMed record): keep
  // the first record, add what the other knows.
  const papers = [];
  const byTitle = new Map();
  const byDoi = new Map();
  for (const paper of settled.flatMap((r) => r.value || [])) {
    if (!paper.title) continue;
    const doi = paper.doi?.toLowerCase();
    const same = byTitle.get(titleKey(paper.title)) || (doi && byDoi.get(doi));
    if (same) {
      same.arxiv ||= paper.arxiv;
      same.pmid ||= paper.pmid;
      same.doi ||= paper.doi;
      same.citations ??= paper.citations;
      same.abstract ||= paper.abstract;
      same.pdf = [...new Set([...same.pdf, ...paper.pdf])];
      if (!same.source.split('、').includes(paper.source)) same.source += `、${paper.source}`;
      continue;
    }
    byTitle.set(titleKey(paper.title), paper);
    if (doi) byDoi.set(doi, paper);
    papers.push(paper);
  }
  return { papers, notes, searched: chosen.map((s) => LIBRARIES[s]) };
}

// Fetches a PDF; a page in its place (a paywall, a sign-in, a bot check) is refused.
async function download(fetch, url, limit = 200 * 1024 * 1024) {
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url.trim()))
    throw Error('只能下载 http(s) 链接');
  let response;
  try {
    response = await fetch(url.trim(), {
      headers: { Accept: 'application/pdf,*/*;q=0.8' },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw Error(`下载失败（${e?.message || e}）`);
  }
  if (!response.ok) throw Error(`下载失败：HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > limit) throw Error('文件超过 200 MB');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > limit) throw Error('文件超过 200 MB');
  if (!data.subarray(0, 1024).toString('latin1').includes('%PDF-'))
    throw Error('这个链接打开的不是 PDF（可能是网页、需要登录或被网站拦截），请换一个链接。');
  return data;
}

module.exports = { search, download, checkOpenAlexKey, FIELDS, LIBRARIES };
