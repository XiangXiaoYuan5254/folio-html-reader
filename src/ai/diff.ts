// Line diff (Myers) for previewing AI edits to HTML and notes.
export type DiffLine = { type: 'same' | 'add' | 'del'; text: string; a?: number; b?: number };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim the common head and tail so large files with small edits stay cheap.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const n = x.length;
  const m = y.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = max === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let i =
        k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])
          ? v[max + k + 1]
          : v[max + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[max + k] = i;
      if (i >= n && j >= m) {
        found = true;
        break;
      }
    }
    // Very different texts: fall back to "remove all, add all" rather than use lots of memory.
    if (!found && (d + 2) * v.length > 16_000_000) {
      trace.length = 0;
      break;
    }
  }
  const middle: DiffLine[] = [];
  if (!trace.length && max) {
    x.forEach((text) => middle.push({ type: 'del', text }));
    y.forEach((text) => middle.push({ type: 'add', text }));
  } else {
    let i = n;
    let j = m;
    for (let d = trace.length - 1; d >= 0 && (i > 0 || j > 0); d--) {
      const vd = trace[d];
      const k = i - j;
      const prevK = k === -d || (k !== d && vd[max + k - 1] < vd[max + k + 1]) ? k + 1 : k - 1;
      const prevI = vd[max + prevK];
      const prevJ = prevI - prevK;
      while (i > prevI && j > prevJ) (middle.push({ type: 'same', text: x[--i] }), j--);
      if (d > 0) {
        if (i === prevI) middle.push({ type: 'add', text: y[--j] });
        else middle.push({ type: 'del', text: x[--i] });
      }
    }
    middle.reverse();
  }
  const lines: DiffLine[] = [
    ...a.slice(0, head).map((text) => ({ type: 'same' as const, text })),
    ...middle,
    ...a.slice(a.length - tail).map((text) => ({ type: 'same' as const, text })),
  ];
  let ai = 1;
  let bi = 1;
  for (const line of lines) {
    if (line.type !== 'add') line.a = ai++;
    if (line.type !== 'del') line.b = bi++;
  }
  return lines;
}

export type Hunk = { lines: DiffLine[]; skippedBefore: number };
// Changed lines with a few lines of context; long unchanged stretches are folded.
export function hunks(lines: DiffLine[], context = 3): Hunk[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++)
      keep[j] = true;
  });
  const out: Hunk[] = [];
  let skipped = 0;
  let current: Hunk | null = null;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++;
      current = null;
      return;
    }
    if (!current) {
      current = { lines: [], skippedBefore: skipped };
      out.push(current);
      skipped = 0;
    }
    current.lines.push(l);
  });
  return out;
}
export function diffStats(lines: DiffLine[]) {
  return {
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
  };
}
// The changed lines with a little context as plain text, shortened past `limit` characters.
export function diffText(before: string, after: string, limit = 8000) {
  const text = hunks(diffLines(before, after), 2)
    .map((g) =>
      g.lines
        .map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)
        .join('\n'),
    )
    .join('\n⋯\n');
  return text.length > limit ? text.slice(0, limit) + '\n⋯（后面的改动略）' : text;
}
