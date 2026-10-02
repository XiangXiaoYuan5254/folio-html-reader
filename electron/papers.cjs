// Finding and downloading papers for the AI assistant. OpenAlex covers every field and
// links open-access PDFs; arXiv adds preprints, which always have one. Neither needs a key.
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

async function getText(fetch, url, what) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw Error(`${what} 连接失败（${e?.message || e}）`);
  }
  if (!response.ok) throw Error(`${what} 返回 HTTP ${response.status}`);
  return response.text();
}

// OpenAlex keeps abstracts as word → positions.
function abstractOf(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [word, places] of Object.entries(index))
    for (const at of Array.isArray(places) ? places : []) words[at] = word;
  return words.filter(Boolean).join(' ');
}

async function openAlex(fetch, { query, limit, fromYear, pdfOnly }) {
  const filters = [
    fromYear ? `from_publication_date:${fromYear}-01-01` : '',
    pdfOnly ? 'has_pdf_url:true' : '',
  ].filter(Boolean);
  const params = new URLSearchParams({
    search: query,
    'per-page': String(limit),
    select:
      'title,doi,publication_year,cited_by_count,authorships,primary_location,best_oa_location,locations,abstract_inverted_index,id',
  });
  if (filters.length) params.set('filter', filters.join(','));
  const data = JSON.parse(
    await getText(fetch, `https://api.openalex.org/works?${params}`, 'OpenAlex'),
  );
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

async function arxiv(fetch, { query, limit, fromYear }) {
  const words = query
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length) return [];
  const search = words.map((w) => `all:${w}`).join(' AND ');
  const params = new URLSearchParams({
    search_query: fromYear
      ? `${search} AND submittedDate:[${fromYear}01010000 TO 299912312359]`
      : search,
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

// Both libraries at once; one failing still gives the other's results, with a note.
async function search(fetch, payload) {
  const query = clean(payload?.query).slice(0, 300);
  if (!query) throw Error('请提供搜索关键词');
  const limit = Math.min(20, Math.max(1, Math.round(Number(payload?.limit)) || 8));
  const year = Math.round(Number(payload?.fromYear));
  const options = {
    query,
    limit,
    fromYear: year >= 1900 && year <= 2100 ? year : 0,
    pdfOnly: !!payload?.pdfOnly,
  };
  const [fromOpenAlex, fromArxiv] = await Promise.allSettled([
    openAlex(fetch, options),
    arxiv(fetch, { ...options, limit: Math.ceil(limit / 2) }),
  ]);
  const failed = [fromOpenAlex, fromArxiv].filter((r) => r.status === 'rejected');
  if (failed.length === 2) throw failed[0].reason;
  const papers = [];
  const seen = new Map();
  for (const paper of [...(fromOpenAlex.value || []), ...(fromArxiv.value || [])]) {
    if (!paper.title) continue;
    const same = seen.get(titleKey(paper.title));
    if (same) {
      // The arXiv copy of a published paper: keep the published record, add its PDF.
      same.arxiv ||= paper.arxiv;
      same.pdf = [...new Set([...same.pdf, ...paper.pdf])];
      continue;
    }
    seen.set(titleKey(paper.title), paper);
    papers.push(paper);
  }
  return { papers, notes: failed.map((r) => r.reason?.message || String(r.reason)) };
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

module.exports = { search, download };
