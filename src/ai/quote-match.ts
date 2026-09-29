// Finds text an AI model quoted inside the document. Models copy quotes from a readable
// rendering of the page, so line breaks, spacing, full-width forms and curly quotes may
// differ from the DOM text; PDF text also loses spaces between lines and keeps
// end-of-line hyphens. Matching ignores those differences and maps back to DOM offsets.

const skipped = /[\s​-‍⁠﻿­]/;
const hyphens = /[-‐‑‒–­]/;
const replacements: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '「': '"',
  '」': '"',
  '…': '...',
  '—': '-',
};

type Normalized = { text: string; start: number[]; end: number[] };

export function normalize(source: string, dropHyphens = false): Normalized {
  let text = '';
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < source.length;) {
    const code = source.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const next = i + ch.length;
    if (!skipped.test(ch) && !(dropHyphens && hyphens.test(ch))) {
      const mapped = (replacements[ch] ?? ch.normalize('NFKC')).toLowerCase();
      for (const c of mapped) {
        if (skipped.test(c) || (dropHyphens && hyphens.test(c))) continue;
        text += c;
        start.push(i);
        end.push(next);
      }
    }
    i = next;
  }
  return { text, start, end };
}

// Strips markup a model may wrap around a quote.
export function cleanQuote(quote: string) {
  return quote
    .trim()
    .replace(/^[>*_`"'“”「」『』\s]+|[*_`"'“”「」『』\s]+$/g, '')
    .replace(/^(\.\.\.|…)+|(\.\.\.|…)+$/g, '')
    .trim();
}

function occurrences(haystack: string, needle: string) {
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1 && found.length < 50) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

function pick(found: number[], near?: number, start?: number[]) {
  if (!found.length) return -1;
  if (near === undefined || !start) return found[0];
  return found.reduce((best, at) =>
    Math.abs(start[at] - near) < Math.abs(start[best] - near) ? at : best,
  );
}

// Several quotes are usually located in the same text, so keep its normalized form.
let cache: { source: string; forms: (Normalized | undefined)[] } = { source: '', forms: [] };
function cached(source: string, dropHyphens: boolean) {
  if (cache.source !== source) cache = { source, forms: [] };
  const slot = dropHyphens ? 1 : 0;
  return (cache.forms[slot] ||= normalize(source, dropHyphens));
}

function vote(text: string, q: string) {
  const size = Math.max(4, Math.min(8, Math.floor(q.length / 5)));
  const hits: { start: number; end: number; offset: number }[] = [];
  let pieces = 0;
  for (let offset = 0; offset + size <= q.length; offset += size) {
    pieces++;
    for (const at of occurrences(text, q.slice(offset, offset + size)))
      hits.push({ start: at - offset, end: at + q.length - offset, offset });
  }
  const tolerance = Math.max(4, Math.round(q.length * 0.15));
  let best: typeof hits = [];
  for (const hit of hits) {
    const group = hits.filter((h) => Math.abs(h.start - hit.start) <= tolerance);
    const agreeing = new Set(group.map((h) => h.offset)).size;
    if (agreeing > new Set(best.map((h) => h.offset)).size) best = group;
  }
  if (new Set(best.map((h) => h.offset)).size < Math.max(2, Math.ceil(pieces * 0.45))) return null;
  // The earliest and latest agreeing pieces fix the edges.
  const first = best.reduce((a, b) => (b.offset < a.offset ? b : a));
  const last = best.reduce((a, b) => (b.offset > a.offset ? b : a));
  const start = Math.max(0, first.start);
  const end = Math.min(text.length, last.end);
  return end > start ? { start, end } : null;
}

/**
 * Returns DOM offsets [start, end) of `quote` in `source`, or null. `near` prefers the
 * occurrence closest to an offset when a phrase repeats.
 */
export function findQuote(source: string, quote: string, near?: number) {
  const wanted = cleanQuote(quote);
  if (!wanted) return null;
  for (const dropHyphens of [false, true]) {
    const doc = cached(source, dropHyphens);
    const q = normalize(wanted, dropHyphens).text;
    if (q.length < 2) return null;
    const at = pick(occurrences(doc.text, q), near, doc.start);
    if (at >= 0) return { start: doc.start[at], end: doc.end[at + q.length - 1] };
    // A long quote with a slip somewhere (a changed word, a dropped comma): short pieces of
    // it vote on where it starts, and enough agreeing pieces place it.
    if (q.length >= 16) {
      const fuzzy = vote(doc.text, q);
      if (fuzzy) return { start: doc.start[fuzzy.start], end: doc.end[fuzzy.end - 1] };
    }
  }
  return null;
}
