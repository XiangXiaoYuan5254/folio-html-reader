// Drawings in AI replies. A ```svg block is cleaned to plain shapes the way the whiteboard
// cleans what the model draws; a ```plot block is worked out here from formulas, so the
// model writes "plot x^2" and "area x^2 | 0 2" instead of computing points. Both reuse the
// whiteboard's code, and its colors, which read in light and dark themes alike.
import {
  areaShapes,
  axesShapes,
  boardColor,
  compile,
  dotShapes,
  graphShapes,
  svgShapes,
  textShapes,
  type Axes,
  type ShapeSpec,
} from './board-figure';

export type ChatFigure = {
  box: [number, number, number, number];
  shapes: ShapeSpec[];
  errors: string[];
};
export const figureLanguages = new Set(['svg', 'plot']);

// Figures already worked out, as a streaming reply draws the same ones over and over.
const made = new Map<string, ChatFigure>();
// `partial`: the block is still being written, so its last line may be cut off.
export function chatFigure(lang: string, source: string, partial = false): ChatFigure {
  const id = `${lang}\u0000${partial ? 1 : 0}\u0000${source}`;
  let fig = made.get(id);
  if (!fig) {
    fig = lang === 'plot' ? plotFigure(source, partial) : svgFigure(source);
    if (made.size > 100) made.clear();
    made.set(id, fig);
  }
  return fig;
}

function svgFigure(source: string): ChatFigure {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const svg = doc.querySelector('svg');
  const view = (svg?.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let box: ChatFigure['box'] = [0, 0, 400, 300];
  if (view.length === 4 && view.every(Number.isFinite) && view[2] > 0 && view[3] > 0)
    box = view as ChatFigure['box'];
  else {
    const w = parseFloat(svg?.getAttribute('width') || '');
    const h = parseFloat(svg?.getAttribute('height') || '');
    if (w > 0 && h > 0) box = [0, 0, w, h];
  }
  box = [box[0], box[1], Math.min(box[2], 2000), Math.min(box[3], 2000)];
  return { box, shapes: svgShapes(svg ? svg.innerHTML : source), errors: [] };
}

const W = 420;
const pad = 68; // both margins the whiteboard leaves around a graph
const palette = [
  'var(--board-blue)',
  'var(--board-red)',
  'var(--board-green)',
  'var(--board-orange)',
];
const colorWords = /\s+(red|blue|green|orange|purple|yellow|gray|grey)\s*$/i;
const ops = ['axes', 'axes3d', 'plot', 'curve3d', 'surface3d', 'area', 'dot', 'text'] as const;
type Op = (typeof ops)[number];
type Line = { n: number; op: Op; body: string; color?: string };

// One instruction a line: "axes -3 3 -1 9", "plot x^2", "area x^2 | 0 2", "dot 1 1 | A".
// A color can end any line; a line with no instruction word is a curve.
function plotFigure(source: string, partial: boolean): ChatFigure {
  const rows = source.split('\n');
  if (partial) rows.pop();
  const lines: Line[] = [];
  rows.forEach((row, i) => {
    let text = row.trim();
    if (!text || /^(#|\/\/)/.test(text)) return;
    const color = text.match(colorWords)?.[1];
    if (color) text = text.slice(0, -color.length).replace(/\s*[|｜]?\s*$/, '');
    const word = text.match(/^([a-z0-9]+)\b\s*[:：]?\s*(.*)$/i);
    const op = ops.find((o) => o === word?.[1].toLowerCase());
    lines.push({ n: i + 1, op: op || 'plot', body: op ? word![2] : text, color });
  });
  const errors: string[] = [];
  const fail = (line: Line, e: unknown) =>
    errors.push(`第 ${line.n} 行：${e instanceof Error ? e.message : String(e)}`);

  // The axes: as written, or room for what is drawn.
  let axes: Axes | undefined;
  for (const line of lines) {
    if (line.op !== 'axes' && line.op !== 'axes3d') continue;
    const n = line.body
      .replace(/[[\]()（）]/g, ' ')
      .split(/\s*(?:\.\.|,|，|~|\bto\b)\s*|\s+/)
      .filter((s) => s && s.toLowerCase() !== 'equal')
      .map((s) => {
        try {
          return compile(s.replace(/^[xyz][:=]/i, ''), [])({});
        } catch {
          return NaN;
        }
      })
      .filter(Number.isFinite);
    const range = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
    if (line.op === 'axes' && n.length >= 4 && n[0] !== n[1] && n[2] !== n[3])
      axes = {
        kind: '2d',
        x: range(n[0], n[1]),
        y: range(n[2], n[3]),
        equal: /\bequal\b/i.test(line.body),
      };
    else if (line.op === 'axes3d' && n.length >= 6)
      axes = { kind: '3d', x: range(n[0], n[1]), y: range(n[2], n[3]), z: range(n[4], n[5]) };
    else
      fail(
        line,
        Error(line.op === 'axes' ? '要写 x最小 x最大 y最小 y最大' : '要写 x、y、z 的范围'),
      );
  }
  const solid = lines.some((l) => l.op === 'curve3d' || l.op === 'surface3d');
  if (!axes || (axes.kind === '3d') !== solid)
    axes = solid ? { kind: '3d', x: [-2, 2], y: [-2, 2], z: [0, 3] } : fitAxes(lines);

  let h = axes.kind === '3d' ? 340 : 300;
  if (axes.kind === '2d' && axes.equal) {
    const ratio = (axes.y[1] - axes.y[0]) / (axes.x[1] - axes.x[0]);
    h = Math.round(Math.min(420, Math.max(180, ratio * (W - pad) + pad)));
  }
  const under: ShapeSpec[] = [];
  const over: ShapeSpec[] = [];
  let curves = 0;
  let firstCurve: string | undefined;
  for (const line of lines) {
    const tint = boardColor(line.color);
    try {
      switch (line.op) {
        case 'axes':
        case 'axes3d':
          break;
        case 'plot':
        case 'curve3d':
        case 'surface3d': {
          const color = tint || palette[curves++ % palette.length];
          firstCurve ??= color;
          over.push(...graphShapes(line.op, line.body, axes, W, h, color));
          break;
        }
        case 'area':
          under.push(...areaShapes(line.body, axes, W, h, tint || firstCurve || palette[0]));
          break;
        case 'dot':
          over.push(...dotShapes(line.body, axes, W, h, tint || 'var(--board-red)'));
          break;
        case 'text':
          over.push(...textShapes(line.body, axes, W, h, tint));
      }
    } catch (e) {
      fail(line, e);
    }
  }
  // Axes alone are a drawing too, unless everything else on them went wrong.
  const show = under.length + over.length > 0 || (lines.length > 0 && !errors.length);
  return {
    box: [0, 0, W, h],
    shapes: show ? [...axesShapes(axes, W, h), ...under, ...over] : [],
    errors,
  };
}

// Axes for graphs written without them: x from -5 to 5 unless the drawing says otherwise,
// y wide enough for the curves, leaving out where they shoot off (1/x near 0).
function fitAxes(lines: Line[]): Axes {
  const xs: number[] = [];
  const ys: number[] = [];
  const value = (s: string) => compile(s, [])({});
  for (const line of lines) {
    try {
      const [head, spec = ''] = line.body.split(/[|｜]/).map((s) => s.trim());
      if (line.op === 'dot' || line.op === 'text') {
        const [x, y] = head
          .split(/[\s,，()（）]+/)
          .filter(Boolean)
          .map(value);
        xs.push(x);
        ys.push(y);
      } else if (line.op === 'area') {
        const bits = spec
          .replace(/^[A-Za-z]\s*[:=∈]?\s*/, '')
          .split(/[\s,，]+/)
          .filter(Boolean);
        if (bits.length >= 2) xs.push(value(bits[0]), value(bits[1]));
      }
    } catch {
      // Reported when the line is drawn.
    }
  }
  let x: [number, number] = [-5, 5];
  const known = xs.filter(Number.isFinite);
  if (known.length) {
    const [lo, hi] = [Math.min(...known), Math.max(...known)];
    const span = hi - lo || 2;
    x = [Math.min(lo - span * 0.25, 0), Math.max(hi + span * 0.25, 0)];
  }
  const vars: Record<string, number> = {};
  for (const line of lines) {
    if (line.op !== 'plot' && line.op !== 'area') continue;
    try {
      const [head, spec] = line.body.split(/[|｜]/);
      const parts = head
        .replace(/^\s*[a-z]\s*(\([^)]*\))?\s*=\s*/i, '')
        .split(/[,，;；]/)
        .filter((s) => s.trim());
      if (line.op === 'plot' && parts.length === 2) {
        // A parametric curve: its own x and y.
        const m = spec?.trim().match(/^([A-Za-z])\s*[:=∈]?\s*(.*)$/);
        const name = m?.[1] || 't';
        const [t0, t1] = (m?.[2] || '0 2*pi')
          .split(/[\s,，]+/)
          .filter(Boolean)
          .map(value);
        const [fx, fy] = parts.map((p) => compile(p.replace(/^\s*[xy]\s*=\s*/i, ''), [name]));
        for (let i = 0; i <= 100; i++) {
          vars[name] = t0 + ((t1 - t0) * i) / 100;
          xs.push(fx(vars));
          ys.push(fy(vars));
        }
        continue;
      }
      for (const part of parts) {
        const f = compile(part, ['x']);
        for (let i = 0; i <= 100; i++) {
          vars.x = x[0] + ((x[1] - x[0]) * i) / 100;
          ys.push(f(vars));
        }
      }
    } catch {
      // Reported when the line is drawn.
    }
  }
  const curveXs = xs.filter(Number.isFinite);
  if (curveXs.length > known.length) {
    const [lo, hi] = [Math.min(...curveXs), Math.max(...curveXs)];
    const span = hi - lo || 2;
    x = [Math.min(x[0], lo - span * 0.1), Math.max(x[1], hi + span * 0.1)];
  }
  const sorted = ys.filter(Number.isFinite).sort((a, b) => a - b);
  let y: [number, number] = [-5, 5];
  if (sorted.length) {
    const lo = Math.min(sorted[Math.floor(sorted.length * 0.03)], 0);
    const hi = Math.max(sorted[Math.ceil(sorted.length * 0.97) - 1], 0);
    const span = hi - lo || 2;
    y = [lo - span * 0.1, hi + span * 0.1];
  }
  return { kind: '2d', x, y, equal: false };
}
