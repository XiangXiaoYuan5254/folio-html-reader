// Figures and tables cut out of the pages for 全文翻译, so a translation can be read without
// the PDF. Each starts from its caption ("Figure 2:", "Table 1."): a figure is what's drawn
// above it, a table usually what's below, up to the running text, a heading or the page's
// header. What's drawn comes from the page's operators (pictures and vector paths), so
// plots drawn as vectors are found as well as pictures.
import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfFigure } from '../ai/types';

type Box = { x0: number; y0: number; x1: number; y1: number };
type Line = Box & {
  s: string;
  y: number;
  h: number;
  n: number;
  rotated?: boolean;
  margin?: boolean;
  // The words it's made of, for reading a table's cells, and a word's font.
  words?: Line[];
  font?: string;
};
type Matrix = number[];

const mul = (m: Matrix, n: Matrix) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const union = (list: Box[]) =>
  list.reduce<Box>(
    (a, b) => ({
      x0: Math.min(a.x0, b.x0),
      y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1),
      y1: Math.max(a.y1, b.y1),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
const overlapX = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);

const painted = new Set([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintSolidColorImageMask,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObjectGroup,
]);
// Boxes of everything drawn that isn't text, in PDF space (y up).
async function graphics(page: PDFPageProxy) {
  const list = await page.getOperatorList();
  const boxes: Box[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (painted.has(fn)) boxes.push(boxOf(ctm, 0, 0, 1, 1));
    else if (fn === OPS.constructPath) {
      // [the operator that paints it, the path, its bounds]; a path that only clips paints
      // nothing.
      const [op, , minMax] = args;
      if (!minMax || op === OPS.endPath || !Number.isFinite(minMax[0])) continue;
      boxes.push(boxOf(ctm, minMax[0], minMax[1], minMax[2], minMax[3]));
    }
  }
  return boxes;
}

// The page's text as lines: words on one baseline, split where the gap is wider than about
// a letter's height, so a table's cells stay apart while running text holds together, and at
// any real gap across the middle of the page, which may be the gutter between two columns.
// Rotated words (axis labels) are kept apart, as they never belong to running text.
function lines(items: unknown[], middle: number) {
  const words: Line[] = [];
  const rotated: Line[] = [];
  for (const it of items as {
    str?: string;
    transform: number[];
    width: number;
    height: number;
    fontName?: string;
  }[]) {
    if (!it.str?.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const h = Math.hypot(c, d) || it.height;
    if (Math.abs(b) > Math.abs(a) * 0.3) {
      const k = Math.hypot(a, b) || 1;
      const box = boxOf([a / k, b / k, c / h, d / h, e, f], 0, -h * 0.25, it.width, h * 0.85);
      rotated.push({ ...box, s: it.str, y: f, h, n: it.str.length, rotated: true });
      continue;
    }
    words.push({
      s: it.str,
      x0: e,
      x1: e + it.width,
      y: f,
      y0: 0,
      y1: 0,
      h,
      n: it.str.length,
      font: it.fontName,
    });
  }
  // Rows first, by baseline, a superscript or subscript joining the row it sits on; then each
  // row is cut where its words are far apart.
  words.sort((p, q) => q.y - p.y);
  const rows: { y: number; h: number; words: Line[] }[] = [];
  for (const w of words) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - w.y) < Math.max(row.h, w.h) * 0.4) {
      row.words.push(w);
      if (w.h > row.h) [row.y, row.h] = [w.y, w.h];
    } else rows.push({ y: w.y, h: w.h, words: [w] });
  }
  const out: Line[] = [];
  for (const row of rows) {
    let line: Line | undefined;
    for (const w of row.words.sort((p, q) => p.x0 - q.x0)) {
      const h = Math.max(line?.h || 0, w.h);
      const gap = line ? w.x0 - line.x1 : Infinity;
      if (line && gap < h && !(gap > h * 0.6 && line.x1 < middle && w.x0 > middle - 2)) {
        line.s += (gap > w.h * 0.15 ? ' ' : '') + w.s;
        line.x1 = Math.max(line.x1, w.x1);
        line.n += w.n;
        line.words!.push(w);
        if (w.h > line.h) [line.y, line.h] = [w.y, w.h];
      } else {
        line = { ...w, words: [w] };
        out.push(line);
      }
    }
  }
  for (const l of out) {
    l.y0 = l.y - l.h * 0.25;
    l.y1 = l.y + l.h * 0.85;
  }
  return [...out, ...rotated];
}

// "Figure 2:", "Fig. 3.", "Table A.1 |"; IEEE's "TABLE IV" stands on a line of its own.
const captionStart =
  /^\s*(Figure|Fig\.?|Table|Tab\.?)\s*((?:S|[A-Z]\.?)?\d+(?:\.\d+)*|[IVXL]+)\s*[:.|：—–]/i;
const captionLine = /^\s*(TABLE|FIGURE)\s+([IVXL]+|\d+)\s*$/;
// A numbered heading: "3 Method", "4.2 Results", "A.1 Proofs", "IV. EXPERIMENTS", not a table
// cell such as "78 GB".
const numbered = /^(\d{1,2}(\.\d{1,2})*|[A-Z](\.\d{1,2})+|[A-Z]|[IVX]+)\.?\s+[A-Z][A-Za-z]{2,}/;

type Page = { page: PDFPageProxy; number: number; view: number[]; lines: Line[] };
type Caption = Box & {
  first: Line;
  lines: Line[];
  kind: PdfFigure['kind'];
  number: string;
  text: string;
};
// What's on one side of a caption, up to the text that stops it. `by`: the caption right past
// it, which may be the one it belongs to.
type Side = Box & { ink: number; gap: number; area: number; lo: number; hi: number; by?: Caption };
type Candidate = { cap: Caption; up: Side | null; down: Side | null; page: Page };

// Each caption on the page with what could be its figure above it and below it.
function candidates(p: Page, g: Box[], body: number): Candidate[] {
  const ls = p.lines;
  const [px0, py0, px1, py1] = p.view;
  const W = px1 - px0;
  const H = py1 - py0;
  const flat = ls.filter((l) => !l.rotated);
  const bodySize = (l: Line) => !l.rotated && Math.abs(l.h - body) < body * 0.2;
  const long = flat.filter((l) => bodySize(l) && l.n > 30);
  const half = px0 + W / 2;
  const twoColumns =
    long.length > 6 && long.filter((l) => l.x1 - l.x0 < W * 0.48).length > long.length * 0.6;
  // The column a box is in: the whole width when it's wide or crosses the gutter.
  const columnOf = (b: Box): Box => {
    if (!twoColumns || b.x1 - b.x0 > W * 0.55 || (b.x0 < half - 6 && b.x1 > half + 6))
      return { x0: px0, x1: px1, y0: py0, y1: py1 };
    return (b.x0 + b.x1) / 2 < half
      ? { x0: px0, x1: half, y0: py0, y1: py1 }
      : { x0: half, x1: px1, y0: py0, y1: py1 };
  };
  const widths = new Map<number, number>();
  const lineWidth = (col: Box) => {
    if (widths.has(col.x0 + col.x1)) return widths.get(col.x0 + col.x1)!;
    const ws = long
      .filter((l) => overlapX(l, col) > (l.x1 - l.x0) * 0.8)
      .map((l) => l.x1 - l.x0)
      .sort((a, b) => a - b);
    const w = ws.length ? ws[Math.floor(ws.length * 0.8)] : (col.x1 - col.x0) * 0.8;
    widths.set(col.x0 + col.x1, w);
    return w;
  };
  // Running text: full lines in the text's size, and a paragraph's short last line under one.
  const full = new Set(
    flat.filter((l) => bodySize(l) && l.n > 25 && l.x1 - l.x0 > lineWidth(columnOf(l)) * 0.7),
  );
  const running = new Set(full);
  for (const l of flat)
    if (bodySize(l) && !full.has(l))
      for (const b of full)
        if (b.y > l.y && b.y - l.y < 1.6 * l.h && Math.abs(b.x0 - l.x0) < 3) running.add(l);
  // Text in a box drawn around it (a framed example) belongs to the figure.
  // The frame may be one rectangle or four lines: something tall on each side of the line.
  const tall = (b: Box, l: Line) => b.y0 <= l.y0 && b.y1 >= l.y1 && b.y1 - b.y0 > 2.5 * l.h;
  const framed = (l: Line) =>
    g.some((b) => tall(b, l) && b.x0 <= l.x0 + 1 && b.x1 >= l.x1 - 1) ||
    (g.some((b) => tall(b, l) && b.x1 <= l.x0 + 2 && l.x0 - b.x1 < 4 * l.h) &&
      g.some((b) => tall(b, l) && b.x0 >= l.x1 - 2 && b.x0 - l.x1 < 4 * l.h));
  // Drawn things right above and right below: a title inside a figure, not a heading.
  const inside = (l: Line) =>
    g.some((b) => overlapX(b, l) > 0 && b.y0 >= l.y1 - 1 && b.y0 - l.y1 < 1.5 * l.h) &&
    g.some((b) => overlapX(b, l) > 0 && b.y1 <= l.y0 + 1 && l.y0 - b.y1 < 1.5 * l.h);
  // A heading has its line to itself; a table's cell shares its row with others.
  const alone = (l: Line) => {
    const col = columnOf(l);
    return !flat.some((o) => o !== l && Math.abs(o.y - l.y) < l.h * 0.4 && overlapX(o, col) > 0);
  };
  const isHeading = (l: Line) =>
    !l.rotated &&
    l.n < 90 &&
    l.h >= body * 0.95 &&
    (numbered.test(l.s) || (l.h > body * 1.15 && !inside(l))) &&
    alone(l);

  const captions: Caption[] = [];
  for (let i = 0; i < flat.length; i++) {
    const line = flat[i];
    const m = line.s.match(captionStart) || line.s.match(captionLine);
    if (!m) continue;
    // Running text that happens to start a line with "Table 1." goes on from the line above.
    const above = flat
      .filter((l) => l !== line && l.y > line.y && overlapX(l, line) > 0)
      .sort((a, b) => a.y - b.y)[0];
    if (above && above.y - line.y < line.h * 1.45 && full.has(above) && full.has(line)) continue;
    const cap: Caption = {
      ...line,
      first: line,
      lines: [line],
      kind: /^t/i.test(m[1]) ? 'table' : 'figure',
      number: m[2].toUpperCase(),
      text: line.s,
    };
    let last = line;
    // The caption's other lines: close below, starting where it starts (or centred under
    // it), in the same size. A stray mark in small type (†) is passed over.
    for (const l of flat.slice(i + 1)) {
      if (l.y >= last.y || overlapX(l, last) <= 0) continue;
      if (last.y - l.y > last.h * 1.8) break;
      if (l.h < last.h * 0.85 && l.n <= 3) continue;
      const centred = Math.abs((l.x0 + l.x1) / 2 - (cap.x0 + cap.x1) / 2) < l.h;
      if (Math.abs(l.x0 - line.x0) > l.h * 1.5 && !centred) break;
      if (Math.abs(l.h - last.h) > last.h * 0.15) break;
      cap.x0 = Math.min(cap.x0, l.x0);
      cap.x1 = Math.max(cap.x1, l.x1);
      cap.y0 = l.y0;
      cap.text += ' ' + l.s;
      cap.lines.push(l);
      last = l;
    }
    captions.push(cap);
  }

  return captions.map((cap) => {
    // The column, or its share of it when other captions in it stand beside this one (figures
    // side by side).
    const column = columnOf(cap);
    let span = { ...column };
    for (const c of captions) {
      const theirs = columnOf(c);
      if (c === cap || theirs.x0 !== column.x0 || theirs.x1 !== column.x1) continue;
      if (c.y0 < cap.y1 && c.y1 > cap.y0 && overlapX(c, cap) <= 0) {
        if (c.x1 <= cap.x0) span.x0 = Math.max(span.x0, (c.x1 + cap.x0) / 2);
        else span.x1 = Math.min(span.x1, (cap.x1 + c.x0) / 2);
      }
    }
    const inSpan = (b: Box) => overlapX(b, span) > Math.min(b.x1 - b.x0, span.x1 - span.x0) * 0.5;
    // Another caption's lines: its first one may be where the region's figure starts.
    const captionAt = (l: Line) => captions.find((c) => c !== cap && c.lines.includes(l));
    const stopping = () =>
      flat.filter(
        (l) =>
          inSpan(l) && !framed(l) && (l.margin || running.has(l) || isHeading(l) || captionAt(l)),
      );
    let stops = stopping();
    // The region on one side of the caption: up (dir 1) or down (dir -1) to the first stop.
    const region = (dir: 1 | -1): Side | null => {
      const edge = dir > 0 ? cap.y1 : cap.y0;
      const beyond = (b: Box) => (dir > 0 ? b.y0 >= edge - 1 : b.y1 <= edge + 1);
      const near = (b: Box) => (dir > 0 ? b.y0 : -b.y1);
      const ahead = stops.filter(beyond).sort((a, b) => near(a) - near(b));
      let limit = ahead[0] ? (dir > 0 ? ahead[0].y0 : ahead[0].y1) : dir > 0 ? py1 : py0;
      let ruled = false;
      // A ruled table: the rules from the one next to the caption on, as long as no text comes
      // between them, or only running text when the next rule is as wide as the last (a table
      // whose cells are sentences). Never past a caption or a heading.
      const rules = g
        .filter(
          (b) =>
            inSpan(b) && b.y1 - b.y0 < 1.5 && b.x1 - b.x0 > (span.x1 - span.x0) * 0.3 && beyond(b),
        )
        .sort((a, b) => near(a) - near(b));
      if (
        cap.kind === 'table' &&
        rules.length &&
        Math.abs((dir > 0 ? rules[0].y0 : rules[0].y1) - edge) < 4 * body
      ) {
        let last = rules[0];
        for (const r of rules.slice(1)) {
          const text = ahead.filter((s) =>
            dir > 0 ? s.y0 > last.y1 && s.y1 < r.y0 : s.y1 < last.y0 && s.y0 > r.y1,
          );
          const same = Math.abs(r.x0 - last.x0) < 2 && Math.abs(r.x1 - last.x1) < 2;
          const plain = text.every((s) => running.has(s) && !captionAt(s) && !s.margin);
          if (text.length && !(plain && same && Math.abs(r.y0 - last.y0) < H * 0.5)) break;
          last = r;
        }
        limit = dir > 0 ? last.y1 : last.y0;
        ruled = true;
      }
      const within = (b: Box) =>
        dir > 0 ? b.y0 >= edge - 2 && b.y1 <= limit + 2 : b.y1 <= edge + 2 && b.y0 >= limit - 2;
      // Grown out from the caption, piece by piece, as long as the gaps stay small: text
      // farther off (the authors over a figure at the top of the first page) isn't its own.
      // Between a table's rules everything is the table's, its sentences too.
      const pieces = [
        ...g.filter((b) => inSpan(b) && within(b)).map((b) => ({ b, ink: true })),
        ...ls
          .filter(
            (l) =>
              inSpan(l) &&
              within(l) &&
              (!stops.includes(l) || (ruled && running.has(l) && !captionAt(l) && !l.margin)),
          )
          .map((b) => ({ b, ink: false })),
      ].sort((a, b) => near(a.b) - near(b.b));
      const ink: Box[] = [];
      const parts: Box[] = [];
      let reach = dir > 0 ? edge : -edge;
      for (const { b, ink: drawn } of pieces) {
        if (!ruled && near(b) - reach > (drawn ? 3.5 : 2.2) * body) break;
        reach = Math.max(reach, dir > 0 ? b.y1 : -b.y0);
        parts.push(b);
        if (drawn) ink.push(b);
      }
      if (!parts.length) return null;
      const r = union(parts);
      r.x0 = Math.max(r.x0, span.x0);
      r.x1 = Math.min(r.x1, span.x1);
      const gap = dir > 0 ? r.y0 - edge : edge - r.y1;
      const area = (r.x1 - r.x0) * (r.y1 - r.y0);
      if (gap >= 30 || r.x1 - r.x0 < 40 || r.y1 - r.y0 < 20) return null;
      if (!(ink.length && area > 1500) && area <= 3000) return null;
      // The caption right past the region, if there is one.
      const next = ahead.find((s) => (dir > 0 ? s.y0 >= limit - 1 : s.y1 <= limit + 1));
      const by =
        next && Math.abs((dir > 0 ? next.y0 : next.y1) - limit) < 3 * body
          ? captionAt(next)
          : undefined;
      return {
        ...r,
        ink: ink.length,
        gap,
        area,
        // Never past the caption or the text that stops it.
        lo: dir > 0 ? edge : limit,
        hi: dir > 0 ? limit : edge,
        by,
      };
    };
    let up = region(1);
    let down = region(-1);
    // A short caption in one column under a figure across both: what's drawn there crosses
    // the gutter, and the figure gets the page's width.
    const across = (r: Side | null) =>
      !!r &&
      g.some((b) => b.y0 >= r.y0 - 1 && b.y1 <= r.y1 + 1 && b.x0 < half - 6 && b.x1 > half + 6);
    if (twoColumns && span.x1 - span.x0 < W * 0.55 && (across(up) || across(down))) {
      const [a, b] = [across(up), across(down)];
      span = { x0: px0, x1: px1, y0: py0, y1: py1 };
      stops = stopping();
      if (a) up = region(1);
      if (b) down = region(-1);
    }
    return { cap, up, down, page: p };
  });
}

// Which side a document puts its figures or tables on: learnt from the captions with
// something on one side only. 1: above the caption, -1: below.
function sides(all: Candidate[]) {
  const side = (kind: PdfFigure['kind']) => {
    let n = 0;
    for (const c of all) if (c.cap.kind === kind && !c.up !== !c.down) n += c.up ? 1 : -1;
    return n > 0 ? 1 : n < 0 ? -1 : kind === 'figure' ? 1 : -1;
  };
  return { figure: side('figure'), table: side('table') };
}
// The region a caption gets: one side, or the side its document uses when there are two.
// A side that ends at another caption facing it shares the space with that caption's figure,
// and stops short of it; with none found there, the space is that caption's.
function choose(c: Candidate, all: Candidate[], facing: Record<PdfFigure['kind'], number>) {
  const own = (s: Side | null, dir: 1 | -1): Side | null => {
    if (!s?.by || facing[s.by.kind] !== -dir) return s;
    const other = all.find((o) => o.cap === s.by);
    const theirs = other && (dir > 0 ? other.down : other.up);
    if (!theirs) return null;
    const mine =
      dir > 0
        ? { ...s, y1: Math.min(s.y1, theirs.y0 - 1), hi: Math.min(s.hi, theirs.y0 - 1) }
        : { ...s, y0: Math.max(s.y0, theirs.y1 + 1), lo: Math.max(s.lo, theirs.y1 + 1) };
    return mine.y1 - mine.y0 >= 20 ? mine : null;
  };
  const up = own(c.up, 1);
  const down = own(c.down, -1);
  return up && down ? (facing[c.cap.kind] > 0 ? up : down) : up || down;
}

// Headers and footers: a page's outermost row of text, top or bottom, set off from the text
// next to it and found at the same height on other pages (running titles, page numbers).
// They stop a figure, never belong to one. A table at the top of its page is no header, though
// tables often sit at the same height: its first row is as close to the next as lines are.
function markMargins(pages: Page[]) {
  const rows = pages.map((p) => {
    const text = p.lines.filter(
      (l) => !l.rotated && !captionStart.test(l.s) && !captionLine.test(l.s),
    );
    const top = Math.max(...text.map((l) => l.y));
    const bottom = Math.min(...text.map((l) => l.y));
    const row = (side: 0 | 1) => {
      const y = side ? bottom : top;
      const lines = text.filter((l) => Math.abs(l.y - y) < 2);
      // The space to the nearest text under (over) each line of the row.
      const apart = lines.every((l) =>
        text.every(
          (o) =>
            lines.includes(o) ||
            overlapX(o, l) <= 0 ||
            (side ? o.y0 - l.y1 : l.y0 - o.y1) > l.h * 0.8,
        ),
      );
      return { y: apart ? y : NaN, lines };
    };
    return [row(0), row(1)];
  });
  const enough = Math.max(2, Math.ceil(pages.length * 0.3));
  for (const side of [0, 1])
    for (const page of rows) {
      const { y, lines } = page[side];
      if (Number.isNaN(y)) continue;
      const same = rows.filter((r) => Math.abs(r[side].y - y) < 2).length;
      if (same >= enough) for (const l of lines) l.margin = true;
    }
}

// The cut-out without the white around it, as WebP: a few pixels of margin stay.
function trimmed(source: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const ctx = source.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(x, y, w, h).data;
  const ink = (i: number) => data[i] < 248 || data[i + 1] < 248 || data[i + 2] < 248;
  let [top, bottom, left, right] = [h, -1, w, -1];
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++)
      if (ink((row * w + col) * 4)) {
        if (row < top) top = row;
        if (row > bottom) bottom = row;
        if (col < left) left = col;
        if (col > right) right = col;
      }
  if (bottom < 0) return null;
  const pad = 8;
  const [cx, cy] = [Math.max(0, left - pad), Math.max(0, top - pad)];
  const [cw, ch] = [Math.min(w, right + pad + 1) - cx, Math.min(h, bottom + pad + 1) - cy];
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d')!.drawImage(source, x + cx, y + cy, cw, ch, 0, 0, cw, ch);
  const src = out.toDataURL('image/webp', 0.9);
  out.width = out.height = 0;
  return { src, width: cw, height: ch };
}

// A table's cells as read off the page, for the model to retype it with nothing shifted: rows
// by baseline, cells where the words are apart, columns where the rows with the most cells
// leave a gap between them. A cell across columns (a header over two) is marked so, an empty
// cell stays empty, and raised or lowered small type is written 10^19, d_model.
function grid(lines: Line[], box: Box, caption: Caption, bold: (font?: string) => boolean) {
  const cells: Line[] = [];
  for (const l of lines) {
    if (l.rotated || l.margin || caption.lines.includes(l) || !l.words) continue;
    if (l.x0 < box.x0 - 2 || l.x1 > box.x1 + 2 || l.y0 < box.y0 - 2 || l.y1 > box.y1 + 2) continue;
    let cell: Line | undefined;
    for (const w of l.words) {
      if (!cell || w.x0 - cell.x1 > l.h * 0.4) {
        cell = { ...l, x0: w.x0, x1: w.x1, s: '', words: [] };
        cells.push(cell);
      }
      cell.x1 = Math.max(cell.x1, w.x1);
      cell.words!.push(w);
    }
  }
  for (const cell of cells) {
    const base = cell.words!.reduce((a, b) => (b.h > a.h ? b : a));
    let end = -Infinity;
    for (const w of cell.words!) {
      const small = w.h < base.h * 0.85;
      const mark =
        small && w.y > base.y + base.h * 0.2
          ? '^'
          : small && w.y < base.y - base.h * 0.1
            ? '_'
            : '';
      const text = bold(w.font) ? `**${w.s.trim()}**` : w.s.trim();
      cell.s += (w.x0 - end > w.h * 0.15 && cell.s ? ' ' : '') + mark + text;
      end = w.x1;
    }
    // Bold words next to each other are one bold run; a bold number whose point or dot comes
    // from another font (3.3 · 10^18) is bold as a whole.
    cell.s = cell.s.replace(/\*\*(\s*)\*\*/g, '$1');
    if (cell.s.includes('**') && !/[A-Za-z0-9]/.test(cell.s.replace(/\*\*[^*]*\*\*/g, '')))
      cell.s = `**${cell.s.replaceAll('**', '')}**`;
  }
  const rows: Line[][] = [];
  for (const c of cells.sort((a, b) => b.y - a.y || a.x0 - b.x0)) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].y - c.y) < c.h * 0.5) row.push(c);
    else rows.push([c]);
  }
  if (rows.length < 2) return undefined;
  for (const row of rows) row.sort((a, b) => a.x0 - b.x0);
  // The rows with every cell filled (two at least), as a cell across columns would join them.
  const most = Math.max(...rows.map((r) => r.length));
  let full = rows.filter((r) => r.length === most);
  if (full.length < 2) full = rows.filter((r) => r.length >= Math.max(2, most - 1));
  const columns: number[][] = [];
  for (const c of full.flat().sort((a, b) => a.x0 - b.x0)) {
    const last = columns.at(-1);
    if (last && c.x0 <= last[1] + 1) last[1] = Math.max(last[1], c.x1);
    else columns.push([c.x0, c.x1]);
  }
  const middle = (c: number[]) => (c[0] + c[1]) / 2;
  return rows.map((row) => {
    const texts = columns.map(() => '');
    for (const c of row) {
      const over = columns
        .map((col, i) => ({ i, o: Math.min(col[1], c.x1) - Math.max(col[0], c.x0) }))
        .filter((col) => col.o > 0);
      // Between two columns: the nearer one.
      const i = over.length
        ? over[0].i
        : columns.reduce(
            (best, col, k) =>
              Math.abs(middle(col) - (c.x0 + c.x1) / 2) <
              Math.abs(middle(columns[best]) - (c.x0 + c.x1) / 2)
                ? k
                : best,
            0,
          );
      const span = over.length > 1 ? `（跨 ${over.length} 列）` : '';
      texts[i] = `${texts[i] ? texts[i] + ' ' : ''}${c.s}${span}`;
    }
    return texts;
  });
}

// Every figure and table that could be placed, in page order. Pages are rendered at twice the
// reader's size, so the pictures stay sharp on a high-density screen.
export async function findFigures(proxies: PDFPageProxy[]): Promise<PdfFigure[]> {
  const pages: Page[] = [];
  for (const page of proxies) {
    const content = await page.getTextContent();
    const [x0, , x1] = page.view;
    pages.push({
      page,
      number: page.pageNumber,
      view: page.view,
      lines: lines(content.items, (x0 + x1) / 2),
    });
  }
  markMargins(pages);
  // The running text's size: the document's most common one, counted in letters.
  const sizes = new Map<number, number>();
  for (const p of pages)
    for (const l of p.lines) {
      const k = Math.round(l.h * 2) / 2;
      if (!l.rotated) sizes.set(k, (sizes.get(k) || 0) + l.n);
    }
  const body = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const all: Candidate[] = [];
  for (const p of pages)
    if (p.lines.some((l) => captionStart.test(l.s) || captionLine.test(l.s)))
      all.push(...candidates(p, await graphics(p.page), body));
  const facing = sides(all);
  const out: PdfFigure[] = [];
  for (const p of pages) {
    const found = all
      .filter((c) => c.page === p)
      .map((c) => ({ cap: c.cap, r: choose(c, all, facing) }))
      .filter((f): f is { cap: Caption; r: Side } => !!f.r);
    if (!found.length) continue;
    const [, , , py1] = p.view;
    const H = p.view[3] - p.view[1];
    const css = 4 / 3;
    const base = p.page.getViewport({ scale: 1 });
    const scale = Math.min(css * 2, Math.sqrt(16_000_000 / (base.width * base.height)));
    const viewport = p.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    try {
      await p.page.render({ canvas, viewport }).promise;
      const t = viewport.transform;
      // Bold type, from the font's name (Times-Bold, NimbusRomNo9L-Medi, LaTeX's CMBX10), which
      // the page's fonts carry once it's drawn.
      const bold = (font?: string) => {
        if (!font || !p.page.commonObjs.has(font)) return false;
        const name = (p.page.commonObjs.get(font) as { name?: string } | null)?.name || '';
        return /bold|black|heavy|semibold|demi|medi|cmbx|\bbx/i.test(name);
      };
      for (const { cap, r } of found) {
        const pad = 4;
        const [ax, ay] = apply(t, r.x0 - pad, Math.min(r.y1 + pad, r.hi - 2));
        const [bx, by] = apply(t, r.x1 + pad, Math.max(r.y0 - pad, r.lo + 2));
        const x = Math.max(0, Math.round(Math.min(ax, bx)));
        const y = Math.max(0, Math.round(Math.min(ay, by)));
        const w = Math.min(canvas.width - x, Math.round(Math.abs(bx - ax)));
        const h = Math.min(canvas.height - y, Math.round(Math.abs(by - ay)));
        if (w < 20 || h < 20) continue;
        const cut = trimmed(canvas, x, y, w, h);
        if (!cut) continue;
        out.push({
          kind: cap.kind,
          number: cap.number,
          page: p.number,
          top: Math.max(0, Math.min(1, (py1 - Math.min(r.y1, r.hi)) / H)),
          caption: cap.text.replace(/\s+/g, ' ').trim().slice(0, 600),
          src: cut.src,
          width: Math.round((cut.width / scale) * css),
          height: Math.round((cut.height / scale) * css),
          rows: cap.kind === 'table' ? grid(p.lines, r, cap, bold) : undefined,
        });
      }
    } finally {
      canvas.width = canvas.height = 0;
      p.page.cleanup();
    }
  }
  return out;
}
