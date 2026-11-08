// Applies the edits an AI model proposes for an HTML or Markdown file: either search/replace
// blocks or a complete new file in a code block.
export type Edit = { find: string; replace: string };
export type EditResult = { source: string; applied: number; failed: string[]; explanation: string };

const block =
  /<{5,9} ?SEARCH[^\n]*\n([\s\S]*?)\n?={5,9}[^\n]*\n([\s\S]*?)\n?>{5,9} ?REPLACE[^\n]*/g;

export function parseEdits(
  reply: string,
  kind: 'html' | 'markdown' = 'html',
): {
  edits: Edit[];
  full: string | null;
  explanation: string;
} {
  const edits: Edit[] = [];
  for (const m of reply.matchAll(block)) edits.push({ find: m[1], replace: m[2] });
  // A whole Markdown file comes in a ```markdown block. Its own code blocks have fences too,
  // so it runs to the last fence like the opening one.
  const open = kind === 'markdown' && /(^|\n)(`{3,}|~{3,})(?:markdown|md)[^\S\n]*\n/i.exec(reply);
  if (!edits.length && open) {
    const start = open.index + open[0].length;
    const end = reply.lastIndexOf(open[2]);
    if (end > start)
      return {
        edits,
        full: reply.slice(start, end),
        explanation: `${reply.slice(0, open.index)}\n${reply.slice(end + open[2].length)}`.trim(),
      };
  }
  const explanation = reply
    .replace(block, '')
    .replace(/```[a-z]*\n[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (edits.length) return { edits, full: null, explanation };
  if (kind === 'markdown') return { edits, full: null, explanation };
  const fenced = [...reply.matchAll(/```(?:html|htm)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  const full = fenced.find((f) => /<html|<!doctype|<body/i.test(f)) || null;
  return { edits, full, explanation };
}

// Exact match first; then match line by line ignoring indentation and trailing spaces.
function locate(source: string, find: string): { start: number; end: number } | null | 'many' {
  if (!find) return null;
  const at = source.indexOf(find);
  if (at !== -1) {
    if (source.indexOf(find, at + 1) !== -1) return 'many';
    return { start: at, end: at + find.length };
  }
  const lines = source.split('\n');
  const wanted = find.split('\n').map((l) => l.trim());
  while (wanted.length && !wanted[0]) wanted.shift();
  while (wanted.length && !wanted.at(-1)) wanted.pop();
  if (!wanted.length) return null;
  const offsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1;
  }
  const hits: number[] = [];
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < wanted.length && ok; j++) ok = lines[i + j].trim() === wanted[j];
    if (ok) hits.push(i);
  }
  if (hits.length > 1) return 'many';
  if (!hits.length) return null;
  const first = hits[0];
  const last = first + wanted.length - 1;
  return { start: offsets[first], end: offsets[last] + lines[last].length };
}

export function applyEdits(source: string, edits: Edit[]): EditResult {
  let next = source;
  let applied = 0;
  const failed: string[] = [];
  for (const edit of edits) {
    const where = locate(next, edit.find);
    if (!where || where === 'many') {
      failed.push(
        (where === 'many' ? '（出现多次）' : '（未找到）') +
          edit.find.trim().split('\n')[0].slice(0, 80),
      );
      continue;
    }
    next = next.slice(0, where.start) + edit.replace + next.slice(where.end);
    applied++;
  }
  return { source: next, applied, failed, explanation: '' };
}

export function applyReply(
  source: string,
  reply: string,
  kind: 'html' | 'markdown' = 'html',
): EditResult {
  const { edits, full, explanation } = parseEdits(reply, kind);
  if (edits.length) return { ...applyEdits(source, edits), explanation };
  if (full) return { source: full.replace(/\s+$/, '\n'), applied: 1, failed: [], explanation };
  return { source, applied: 0, failed: [], explanation: explanation || reply.trim() };
}
