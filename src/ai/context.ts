import type { AiProvider, DocText } from './types';

// A rough count that errs high: CJK characters are about a token each, other text about
// four characters per token.
export function estimateTokens(text: string) {
  const cjk = (text.match(/[　-鿿가-힯豈-﫿＀-￯]/g) || []).length;
  return Math.ceil(cjk * 1.05 + (text.length - cjk) / 3.6);
}
// How much document text one request may carry. Very large windows are capped so a single
// question about a long book doesn't send the whole book every time.
export function documentBudget(provider: AiProvider | undefined, share = 0.55) {
  const context = provider?.context || 32_000;
  return Math.max(3_000, Math.min(Math.floor(context * share), 120_000));
}
export function charsLabel(text: string) {
  const n = text.length;
  return n >= 10_000 ? `约 ${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万字` : `${n} 字`;
}
export const fileName = (path: string) => path.split('/').at(-1) || path;

export type Chunk = { label: string; text: string; tokens: number; order: number };
// Splits a document into sections of about `target` tokens: PDFs by page, HTML at headings
// and paragraph breaks.
export function chunkDocument(doc: DocText, target = 5_000): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (label: string, text: string) => {
    if (text.trim())
      chunks.push({ label, text: text.trim(), tokens: estimateTokens(text), order: chunks.length });
  };
  if (doc.pages) {
    let from = 0;
    let text = '';
    doc.pages.forEach((page, i) => {
      const next = `[第 ${i + 1} 页]\n${page}\n\n`;
      if (text && estimateTokens(text + next) > target) {
        push(from === i - 1 ? `第 ${from + 1} 页` : `第 ${from + 1}–${i} 页`, text);
        from = i;
        text = '';
      }
      text += next;
    });
    push(
      from === doc.pages.length - 1 ? `第 ${from + 1} 页` : `第 ${from + 1}–${doc.pages.length} 页`,
      text,
    );
    return chunks;
  }
  let heading = '开头';
  let text = '';
  let label = heading;
  for (const line of doc.text.split('\n')) {
    const isHeading = /^#{1,6} /.test(line);
    const tooBig = estimateTokens(text) > target;
    if (text && ((isHeading && estimateTokens(text) > target * 0.35) || tooBig)) {
      push(label, text);
      text = '';
      label = heading;
    }
    if (isHeading) {
      heading = line.replace(/^#+ /, '').slice(0, 40);
      if (!text) label = heading;
    }
    // A single enormous line (minified text) is cut into pieces.
    if (estimateTokens(line) > target) {
      for (let i = 0; i < line.length; i += target * 2)
        push(heading, line.slice(i, i + target * 2));
      continue;
    }
    text += line + '\n';
  }
  push(label, text);
  return chunks;
}
export function docBody(doc: DocText) {
  return doc.pages ? doc.pages.map((p, i) => `[第 ${i + 1} 页]\n${p}`).join('\n\n') : doc.text;
}
// Character bigrams work for Chinese and English alike without a tokenizer.
function terms(text: string) {
  const words = text.toLowerCase().match(/[a-z0-9]+|[㐀-鿿]+/g) || [];
  const out = new Set<string>();
  for (const w of words) {
    if (/^[a-z0-9]+$/.test(w)) {
      if (w.length > 1) out.add(w);
    } else if (w.length === 1) out.add(w);
    else for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}
function score(chunk: Chunk, query: Set<string>) {
  const text = chunk.text.toLowerCase();
  let s = 0;
  for (const t of query) {
    let count = 0;
    let at = text.indexOf(t);
    while (at !== -1 && count < 8) {
      count++;
      at = text.indexOf(t, at + t.length);
    }
    s += count ? 1 + Math.log(count) : 0;
  }
  return s / Math.sqrt(1 + chunk.tokens / 1000);
}

export type DocContext = { text: string; partial: boolean; tokens: number };
// The document itself when it fits; otherwise its beginning plus the sections that best
// match the question (and the reader's selection), in reading order.
export function documentContext(doc: DocText, budget: number, query = ''): DocContext {
  const body = docBody(doc);
  const tokens = estimateTokens(body);
  if (tokens <= budget) return { text: body, partial: false, tokens };
  const chunks = chunkDocument(doc, Math.max(1_200, Math.min(5_000, Math.floor(budget / 6))));
  const q = terms(query);
  const ranked = [...chunks]
    .map((c) => ({ c, s: c.order === 0 ? Infinity : q.size ? score(c, q) : -c.order }))
    .sort((a, b) => b.s - a.s);
  const chosen: Chunk[] = [];
  let used = 0;
  for (const { c } of ranked) {
    if (used + c.tokens > budget) continue;
    chosen.push(c);
    used += c.tokens;
  }
  chosen.sort((a, b) => a.order - b.order);
  const text = chosen
    .map((c, i) => {
      const gap = i > 0 && chosen[i - 1].order !== c.order - 1 ? '……（中间部分省略）……\n\n' : '';
      return gap + (doc.pages ? c.text : `【${c.label}】\n${c.text}`);
    })
    .join('\n\n');
  return { text, partial: true, tokens: used };
}
// Text around a selection, for explaining it in context without sending the whole document.
export function surrounding(doc: DocText, selection: string, chars = 2_400) {
  return around(docBody(doc), selection, chars);
}
// The part of a text around a passage of it, whitespace folded.
export function around(body: string, selection: string, chars = 2_400) {
  const probe = selection.replace(/\s+/g, ' ').trim().slice(0, 40);
  const flat = body.replace(/\s+/g, ' ');
  const at = probe ? flat.indexOf(probe) : -1;
  if (at === -1) return flat.slice(0, chars);
  const start = Math.max(0, at - chars / 2);
  return (
    (start > 0 ? '…' : '') +
    flat.slice(start, start + chars) +
    (start + chars < flat.length ? '…' : '')
  );
}
// Where on the page something was framed or selected, as the reader reports it.
export type Where = { page?: number; inside?: string; visible?: string };
const cut = (text: string, tokens: number, fromEnd = false) => {
  const have = estimateTokens(text);
  if (have <= tokens) return text;
  const n = Math.floor((text.length * tokens) / have);
  return fromEnd ? '…' + text.slice(-n) : text.slice(0, n) + '…';
};
// The document for explaining one spot in it: the whole thing when it is short; otherwise
// its opening (what it is about, where terms are introduced) and the text around the spot,
// which is where the symbols in a formula or figure are usually defined.
export function spotContext(doc: DocText, where: Where, budget = 6_000) {
  const body = docBody(doc);
  if (estimateTokens(body) <= budget) return { opening: '', around: body };
  const opening = cut(body, Math.floor(budget * 0.2));
  const room = budget - estimateTokens(opening);
  const pages = doc.pages;
  if (pages && where.page && pages[where.page - 1] !== undefined) {
    // The page itself, then the end of the one before and the start of the one after.
    const p = where.page;
    const own = cut(`[第 ${p} 页]\n${pages[p - 1]}`, Math.floor(room * 0.6));
    const left = room - estimateTokens(own);
    const before = p > 1 ? cut(`[第 ${p - 1} 页]\n${pages[p - 2]}`, left * 0.6, true) : '';
    const after =
      p < pages.length ? cut(`[第 ${p + 1} 页]\n${pages[p]}`, left - estimateTokens(before)) : '';
    return {
      opening: p > 2 ? opening : '',
      around: [before, own, after].filter(Boolean).join('\n\n'),
    };
  }
  const flat = body.replace(/\s+/g, ' ');
  const find = (text = '') => {
    const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    return probe.length >= 6 ? flat.indexOf(probe) : -1;
  };
  const at = [where.inside, where.visible].map(find).find((i) => i !== -1) ?? -1;
  if (at === -1) return { opening, around: where.visible ? cut(where.visible, room) : '' };
  // Characters for the room, centered a little ahead of the spot: definitions come before.
  const chars = Math.floor((flat.length * room) / estimateTokens(flat));
  const start = Math.max(0, at - Math.floor(chars * 0.6));
  const around =
    (start > 0 ? '…' : '') +
    flat.slice(start, start + chars) +
    (start + chars < flat.length ? '…' : '');
  return { opening: start > opening.length ? opening : '', around };
}
// Short passages that best match a question, leaving out ones already in `sent`. Words
// count by how rare they are in the document: ones it lacks (a Chinese question about an
// English paper) or has everywhere tell nothing, so a question sharing no rare word with the
// document finds nothing.
export function related(doc: DocText, question: string, budget: number, sent = '') {
  const q = terms(question);
  if (!q.size) return [];
  const chunks = chunkDocument(doc, 700).map((c) => ({ c, text: c.text.toLowerCase() }));
  const weight = new Map<string, number>();
  for (const t of q) {
    const df = chunks.filter((x) => x.text.includes(t)).length;
    if (df && df <= Math.max(1, chunks.length / 3))
      weight.set(t, Math.log(chunks.length / df) + 0.5);
  }
  if (!weight.size) return [];
  const seen = sent.replace(/\s+/g, ' ');
  const ranked = chunks
    .map(({ c, text }) => {
      let s = 0;
      for (const [t, w] of weight) if (text.includes(t)) s += w;
      return { c, s };
    })
    .filter(({ c, s }) => {
      if (!s) return false;
      const flat = c.text.replace(/\s+/g, ' ');
      return !seen.includes(flat.slice(Math.min(20, flat.length >> 2)).slice(0, 60));
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  const out: Chunk[] = [];
  let used = 0;
  for (const { c } of ranked) {
    if (used + c.tokens > budget) continue;
    out.push(c);
    used += c.tokens;
  }
  return out.sort((a, b) => a.order - b.order);
}
export function mostlyChinese(text: string) {
  const letters = text.match(/[㐀-鿿A-Za-z]/g) || [];
  const cjk = text.match(/[㐀-鿿]/g) || [];
  return letters.length > 0 && cjk.length / letters.length > 0.3;
}
