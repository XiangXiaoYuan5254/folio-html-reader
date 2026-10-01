// Drawings on the whiteboard: SVG the model writes, cleaned up, and graphs worked out here
// from formulas, so the model can say “x = cos t, y = sin t, z = t/4” instead of computing
// hundreds of points.

export type ShapeTag =
  'path' | 'line' | 'polyline' | 'polygon' | 'rect' | 'circle' | 'ellipse' | 'text';
// One element of a drawing, before it is given its place in the lesson's timing.
export type ShapeSpec = {
  tag: ShapeTag;
  attrs: Record<string, string>;
  text?: string;
  ref?: string;
  // Faded in rather than drawn along its length: words, and dashed lines, whose dashes
  // the drawing animation would replace.
  fade?: boolean;
  // How much drawing it is, relative to one ordinary stroke.
  weight?: number;
};
export type Axes =
  | { kind: '2d'; x: [number, number]; y: [number, number]; equal: boolean }
  | { kind: '3d'; x: [number, number]; y: [number, number]; z: [number, number] };

const ink = 'var(--board-ink)';
const named: Record<string, string> = {
  red: 'var(--board-red)',
  crimson: 'var(--board-red)',
  blue: 'var(--board-blue)',
  navy: 'var(--board-blue)',
  green: 'var(--board-green)',
  teal: 'var(--board-green)',
  orange: 'var(--board-orange)',
  yellow: 'var(--board-yellow)',
  gold: 'var(--board-yellow)',
  purple: 'var(--board-blue)',
  black: ink,
  ink,
  currentcolor: ink,
  gray: 'var(--board-muted)',
  grey: 'var(--board-muted)',
  white: 'var(--board-bg)',
};
// Colors that read on both the whiteboard and the blackboard: the board's own palette, and
// dark or near-white colors turned into chalk and board.
export function boardColor(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return 'none';
  if (named[v]) return named[v];
  const hex = v.match(/^#([\da-f]{3}|[\da-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (light < 0.25) return ink;
    if (light > 0.93) return 'var(--board-bg)';
    return v;
  }
  if (/^rgba?\([\d\s.,%]+\)$/.test(v) || /^[a-z]+$/.test(v)) return v;
  return undefined;
}

const drawn = new Set(['path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text']);
const kept = [
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'points',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'opacity',
  'fill-opacity',
];
const safe = (v: string) => !/url\s*\(|javascript:|expression|[<>"]/i.test(v);
const safeTransform = (v: string) => /^[\w\s().,+\-]*$/.test(v);
const nums = (s: string) => (s.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) || []).map(Number);

function arrowHead(tip: [number, number], from: [number, number], size = 11) {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const p = (s: number): [number, number] => [
    tip[0] - size * Math.cos(a + s),
    tip[1] - size * Math.sin(a + s),
  ];
  const [l, r] = [p(-0.45), p(0.45)];
  return `M${l[0].toFixed(1)} ${l[1].toFixed(1)} L${tip[0].toFixed(1)} ${tip[1].toFixed(1)} L${r[0].toFixed(1)} ${r[1].toFixed(1)}`;
}
const polyD = (points: [number, number][]) =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

// SVG elements the model wrote on one line, reduced to shapes that are safe to put in the
// page: only drawing elements and plain attributes, no scripts, links, styles or filters.
// <arrow x1 y1 x2 y2/> and <arrow points="…"/> draw a line with an arrowhead.
export function svgShapes(markup: string): ShapeSpec[] {
  const doc = new DOMParser().parseFromString(`<svg>${markup}</svg>`, 'text/html');
  const root = doc.querySelector('svg');
  if (!root) return [];
  const out: ShapeSpec[] = [];
  type Context = { transform: string; stroke?: string; fill?: string; width?: string };
  const walk = (parent: Element, ctx: Context) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
      const own = el.getAttribute('transform') || '';
      const transform = [ctx.transform, safeTransform(own) ? own : ''].filter(Boolean).join(' ');
      const stroke = boardColor(el.getAttribute('stroke')) ?? ctx.stroke;
      const fill = boardColor(el.getAttribute('fill')) ?? ctx.fill;
      const width = el.getAttribute('stroke-width') ?? ctx.width;
      if (tag === 'g') {
        walk(el, { transform, stroke, fill, width: width ?? undefined });
        continue;
      }
      const id = el.getAttribute('id') || undefined;
      const ref = id && /^[A-Za-z][\w-]*$/.test(id) ? id : undefined;
      if (tag === 'arrow') {
        const points: [number, number][] = [];
        const list = el.getAttribute('points');
        if (list) {
          const n = nums(list);
          for (let i = 0; i + 1 < n.length; i += 2) points.push([n[i], n[i + 1]]);
        } else {
          const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => Number(el.getAttribute(k)));
          if ([x1, y1, x2, y2].every(Number.isFinite)) points.push([x1, y1], [x2, y2]);
        }
        if (points.length < 2) continue;
        out.push({
          tag: 'path',
          attrs: {
            d: `${polyD(points)} ${arrowHead(points[points.length - 1], points[points.length - 2])}`,
            stroke: stroke && stroke !== 'none' ? stroke : ink,
            fill: 'none',
            'stroke-width': width || '2.5',
            ...(transform ? { transform } : {}),
          },
          ref,
        });
        continue;
      }
      if (!drawn.has(tag)) continue;
      const attrs: Record<string, string> = {};
      for (const name of kept) {
        const v = el.getAttribute(name);
        if (v != null && safe(v)) attrs[name] = v.slice(0, 20_000);
      }
      if (transform) attrs.transform = transform;
      if (tag === 'text') {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) continue;
        attrs.fill = fill && fill !== 'none' ? fill : stroke && stroke !== 'none' ? stroke : ink;
        attrs['font-size'] ||= '18';
        out.push({ tag, attrs, text, ref, fade: true, weight: 0.3 + text.length * 0.05 });
        continue;
      }
      attrs.stroke = stroke ?? ink;
      attrs.fill = fill ?? 'none';
      attrs['stroke-width'] ||= width || '2.5';
      out.push({
        tag: tag as ShapeTag,
        attrs,
        ref,
        fade: !!attrs['stroke-dasharray'] || attrs.stroke === 'none',
      });
    }
  };
  walk(root, { transform: '' });
  return out;
}

// Formulas: + - * / ^, implicit multiplication (2x, 3(t+1)), the usual functions, pi and e.
type Fn = (vars: Record<string, number>) => number;
const functions: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (x) => 1 / Math.tan(x),
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  asin: Math.asin,
  arcsin: Math.asin,
  acos: Math.acos,
  arccos: Math.acos,
  atan: Math.atan,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  lg: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};
const constants: Record<string, number> = { pi: Math.PI, e: Math.E };
export function compile(source: string, variables: string[]): Fn {
  const src = source
    .replace(/π/g, 'pi')
    .replace(/√/g, 'sqrt')
    .replace(/[·×]/g, '*')
    .replace(/[−–]/g, '-')
    .replace(/\*\*/g, '^');
  const tokens = src.match(/\d*\.?\d+(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*/^(),]/gi) || [];
  if (tokens.join('') !== src.replace(/\s+/g, '')) throw Error(`看不懂的表达式：${source}`);
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    if (t && tokens[i] !== t) throw Error(`表达式缺少 ${t}：${source}`);
    return tokens[i++];
  };
  const startsPrimary = (t?: string) =>
    !!t && (/^[\d.]/.test(t) || /^[A-Za-z_]/.test(t) || t === '(');
  function expr(): Fn {
    let left = term();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      const a = left;
      const b = term();
      left = op === '+' ? (v) => a(v) + b(v) : (v) => a(v) - b(v);
    }
    return left;
  }
  function term(): Fn {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t === '*' || t === '/') {
        take();
        const a = left;
        const b = unary();
        left = t === '*' ? (v) => a(v) * b(v) : (v) => a(v) / b(v);
      } else if (startsPrimary(t)) {
        const a = left;
        const b = power();
        left = (v) => a(v) * b(v);
      } else return left;
    }
  }
  function unary(): Fn {
    if (peek() === '-') {
      take();
      const a = unary();
      return (v) => -a(v);
    }
    if (peek() === '+') {
      take();
      return unary();
    }
    return power();
  }
  function power(): Fn {
    const base = primary();
    if (peek() !== '^') return base;
    take();
    const exponent = unary();
    return (v) => Math.pow(base(v), exponent(v));
  }
  function primary(): Fn {
    const t = take();
    if (t === undefined) throw Error(`表达式不完整：${source}`);
    if (/^[\d.]/.test(t)) {
      const n = Number(t);
      return () => n;
    }
    if (t === '(') {
      const inner = expr();
      take(')');
      return inner;
    }
    const name = t.toLowerCase();
    if (functions[name]) {
      const f = functions[name];
      if (peek() === '(') {
        take('(');
        const args = [expr()];
        while (peek() === ',') {
          take();
          args.push(expr());
        }
        take(')');
        return (v) => f(...args.map((a) => a(v)));
      }
      // sin x
      const arg = power();
      return (v) => f(arg(v));
    }
    if (variables.includes(t)) return (v) => v[t];
    if (name in constants) {
      const c = constants[name];
      return () => c;
    }
    throw Error(`表达式里有不认识的名字 ${t}：${source}`);
  }
  const fn = expr();
  if (i < tokens.length) throw Error(`看不懂的表达式：${source}`);
  return fn;
}

const pad = 34;
type Map2 = (x: number, y: number) => [number, number];
function frame2(a: Extract<Axes, { kind: '2d' }>, w: number, h: number): Map2 {
  let sx = (w - 2 * pad) / (a.x[1] - a.x[0]);
  let sy = (h - 2 * pad) / (a.y[1] - a.y[0]);
  if (a.equal) sx = sy = Math.min(sx, sy);
  const ox = (w - sx * (a.x[1] - a.x[0])) / 2;
  const oy = (h - sy * (a.y[1] - a.y[0])) / 2;
  return (x, y) => [ox + (x - a.x[0]) * sx, h - (oy + (y - a.y[0]) * sy)];
}
// The textbook drawing of space: y to the right, z up, x towards the reader drawn down to
// the left at half length.
const k = 0.5 * Math.SQRT1_2;
type Map3 = (x: number, y: number, z: number) => [number, number];
function frame3(a: Extract<Axes, { kind: '3d' }>, w: number, h: number): Map3 {
  const flat = (x: number, y: number, z: number) => [y - k * x, z - k * x];
  const corners = a.x.flatMap((x) => a.y.flatMap((y) => a.z.map((z) => flat(x, y, z))));
  // The axes run a little past the box.
  corners.push(flat(a.x[1] * 1.2, 0, 0), flat(0, a.y[1] * 1.2, 0), flat(0, 0, a.z[1] * 1.2));
  const us = corners.map((c) => c[0]);
  const vs = corners.map((c) => c[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const s = Math.min((w - 2 * pad) / (u1 - u0 || 1), (h - 2 * pad) / (v1 - v0 || 1));
  const ou = (w - s * (u1 - u0)) / 2;
  const ov = (h - s * (v1 - v0)) / 2;
  return (x, y, z) => {
    const [u, v] = flat(x, y, z);
    return [ou + (u - u0) * s, h - (ov + (v - v0) * s)];
  };
}

const axisStyle = { stroke: 'var(--board-muted)', 'stroke-width': '1.8', fill: 'none' };
const label = (x: number, y: number, text: string, anchor = 'middle', size = 16): ShapeSpec => ({
  tag: 'text',
  attrs: {
    x: x.toFixed(1),
    y: y.toFixed(1),
    'text-anchor': anchor,
    'font-size': String(size),
    fill: ink,
  },
  text,
  fade: true,
  weight: 0.3,
});
function niceTicks(lo: number, hi: number) {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const step = [0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => span / s <= 10) || span / 5;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step)
    if (Math.abs(v) > 1e-9) out.push(Number(v.toFixed(6)));
  return out;
}

export function axesShapes(a: Axes, w: number, h: number): ShapeSpec[] {
  if (a.kind === '2d') {
    const at = frame2(a, w, h);
    const x0 = Math.min(Math.max(0, a.x[0]), a.x[1]);
    const y0 = Math.min(Math.max(0, a.y[0]), a.y[1]);
    const [ax, ay] = at(a.x[0], y0);
    const [bx] = at(a.x[1], y0);
    const [cx, cy] = at(x0, a.y[0]);
    const [, dy] = at(x0, a.y[1]);
    const shapes: ShapeSpec[] = [
      {
        tag: 'path',
        attrs: {
          ...axisStyle,
          d: `M${ax} ${ay} L${bx + 14} ${ay} ${arrowHead([bx + 16, ay], [bx, ay], 9)}`,
        },
      },
      {
        tag: 'path',
        attrs: {
          ...axisStyle,
          d: `M${cx} ${cy} L${cx} ${dy - 14} ${arrowHead([cx, dy - 16], [cx, dy], 9)}`,
        },
      },
      label(bx + 18, ay + 20, 'x'),
      label(cx - 14, dy - 12, 'y'),
    ];
    if (x0 === 0 && y0 === 0) shapes.push(label(cx - 12, ay + 18, 'O'));
    const ticks: string[] = [];
    for (const v of niceTicks(a.x[0], a.x[1])) {
      const [tx] = at(v, y0);
      ticks.push(`M${tx.toFixed(1)} ${ay - 4} L${tx.toFixed(1)} ${ay + 4}`);
      shapes.push(label(tx, ay + 19, String(v), 'middle', 12));
    }
    for (const v of niceTicks(a.y[0], a.y[1])) {
      const [, ty] = at(x0, v);
      ticks.push(`M${cx - 4} ${ty.toFixed(1)} L${cx + 4} ${ty.toFixed(1)}`);
      shapes.push(label(cx - 8, ty + 4, String(v), 'end', 12));
    }
    if (ticks.length)
      shapes.push({ tag: 'path', attrs: { ...axisStyle, d: ticks.join(' ') }, weight: 0.4 });
    return shapes;
  }
  const at = frame3(a, w, h);
  const axis = (end: [number, number, number], start: [number, number, number], name: string) => {
    const p0 = at(...start);
    const p1 = at(...end);
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    return [
      {
        tag: 'path' as const,
        attrs: {
          ...axisStyle,
          d: `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} L${p1[0].toFixed(1)} ${p1[1].toFixed(1)} ${arrowHead(p1, p0, 9)}`,
        },
      },
      label(p1[0] + (dx / len) * 14, p1[1] + (dy / len) * 14 + 5, name),
    ];
  };
  const [o0, o1] = at(0, 0, 0);
  return [
    ...axis([Math.max(a.x[1], 0) * 1.2 || 1, 0, 0], [Math.min(a.x[0], 0), 0, 0], 'x'),
    ...axis([0, Math.max(a.y[1], 0) * 1.2 || 1, 0], [0, Math.min(a.y[0], 0), 0], 'y'),
    ...axis([0, 0, Math.max(a.z[1], 0) * 1.2 || 1], [0, 0, Math.min(a.z[0], 0)], 'z'),
    label(o0 - 12, o1 + 16, 'O'),
  ];
}

// "t 0 6.28", "t: 0..2pi", "t ∈ [0, 2*pi]" → the variable and its range.
function range(
  spec: string | undefined,
  fallback: [string, number, number],
): [string, number, number] {
  const m = spec?.trim().match(/^([A-Za-z])\s*[:=∈]?\s*(.*)$/);
  if (!m) return fallback;
  const bits = m[2]
    .replace(/[[\]()（）]/g, ' ')
    .split(/\s*(?:\.\.|,|，|到|~|\bto\b)\s*|\s+/)
    .filter(Boolean);
  if (bits.length < 2) return fallback;
  const value = (s: string) => compile(s, [])({});
  return [m[1], value(bits[0]), value(bits[1])];
}
function sample(f: () => [number, number] | null, n: number, at: (i: number) => void) {
  const runs: [number, number][][] = [[]];
  for (let i = 0; i <= n; i++) {
    at(i);
    const p = f();
    if (!p) {
      if (runs[runs.length - 1].length) runs.push([]);
      continue;
    }
    runs[runs.length - 1].push(p);
  }
  return runs
    .filter((r) => r.length > 1)
    .map(polyD)
    .join(' ');
}

// A curve, a space curve or a surface, from the formulas after the bar: "x^2 - 1" (y as a
// function of x), "cos(t), sin(t) | t 0 6.28", "cos(t), sin(t), t/4 | t 0 12.6",
// "u*cos(v), u*sin(v), u | u 0 1 | v 0 6.28".
export function graphShapes(
  op: 'plot' | 'curve3d' | 'surface3d',
  body: string,
  a: Axes,
  w: number,
  h: number,
  color: string,
): ShapeSpec[] {
  const [formula, ...ranges] = body.split(/[|｜]/).map((s) => s.trim());
  const parts = formula
    .replace(/^\s*[a-z]\s*(\([^)]*\))?\s*=\s*/i, '')
    .split(/[,，;；]/)
    .map((s) => s.replace(/^\s*[xyz]\s*=\s*/i, '').trim())
    .filter(Boolean);
  const stroke = { stroke: color, fill: 'none', 'stroke-width': '3' };
  if (op === 'plot') {
    if (a.kind !== '2d') throw Error('plot 要画在二维坐标轴上');
    const at = frame2(a, w, h);
    const vars: Record<string, number> = {};
    // Off the top or bottom the curve stops rather than running along the edge.
    const ySpan = a.y[1] - a.y[0];
    const inView = (y: number) =>
      Number.isFinite(y) && y >= a.y[0] - ySpan * 0.05 && y <= a.y[1] + ySpan * 0.05;
    if (parts.length === 1) {
      const f = compile(parts[0], ['x']);
      const d = sample(
        () => {
          const y = f(vars);
          return inView(y) ? at(vars.x, y) : null;
        },
        400,
        (i) => (vars.x = a.x[0] + ((a.x[1] - a.x[0]) * i) / 400),
      );
      return [{ tag: 'path', attrs: { ...stroke, d }, weight: 2 }];
    }
    const [name, t0, t1] = range(ranges[0], ['t', 0, 2 * Math.PI]);
    const [fx, fy] = parts.map((p) => compile(p, [name]));
    const d = sample(
      () => {
        const x = fx(vars);
        const y = fy(vars);
        return Number.isFinite(x) && inView(y) ? at(x, y) : null;
      },
      400,
      (i) => (vars[name] = t0 + ((t1 - t0) * i) / 400),
    );
    return [{ tag: 'path', attrs: { ...stroke, d }, weight: 2 }];
  }
  if (a.kind !== '3d') throw Error(`${op} 要画在 axes3d 建立的空间坐标系里`);
  const at = frame3(a, w, h);
  if (parts.length !== 3) throw Error(`${op} 需要 x、y、z 三个表达式`);
  if (op === 'curve3d') {
    const [name, t0, t1] = range(ranges[0], ['t', 0, 2 * Math.PI]);
    const [fx, fy, fz] = parts.map((p) => compile(p, [name]));
    const vars: Record<string, number> = {};
    const d = sample(
      () => {
        const p = [fx(vars), fy(vars), fz(vars)] as const;
        return p.every(Number.isFinite) ? at(p[0], p[1], p[2]) : null;
      },
      500,
      (i) => (vars[name] = t0 + ((t1 - t0) * i) / 500),
    );
    return [{ tag: 'path', attrs: { ...stroke, d }, weight: 2.4 }];
  }
  const [un, u0, u1] = range(ranges[0], ['u', 0, 1]);
  const [vn, v0, v1] = range(ranges[1], ['v', 0, 2 * Math.PI]);
  const [fx, fy, fz] = parts.map((p) => compile(p, [un, vn]));
  const vars: Record<string, number> = {};
  const point = () => {
    const p = [fx(vars), fy(vars), fz(vars)] as const;
    return p.every(Number.isFinite) ? at(p[0], p[1], p[2]) : null;
  };
  const lines: string[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    vars[un] = u0 + ((u1 - u0) * i) / n;
    lines.push(sample(point, 60, (j) => (vars[vn] = v0 + ((v1 - v0) * j) / 60)));
    vars[vn] = v0 + ((v1 - v0) * i) / n;
    lines.push(sample(point, 60, (j) => (vars[un] = u0 + ((u1 - u0) * j) / 60)));
  }
  return [
    {
      tag: 'path',
      attrs: {
        stroke: color,
        fill: 'none',
        'stroke-width': '1.4',
        opacity: '0.7',
        d: lines.join(' '),
      },
      weight: 3,
    },
  ];
}

// A marked point on the axes: "1 2" or "1 0 2", then an optional label.
export function dotShapes(body: string, a: Axes, w: number, h: number, color: string): ShapeSpec[] {
  const [coords, text = ''] = body.split(/[|｜]/).map((s) => s.trim());
  const values = coords
    .split(/[\s,，()（）]+/)
    .filter(Boolean)
    .map((s) => compile(s, [])({}));
  const [x, y] =
    a.kind === '2d'
      ? frame2(a, w, h)(values[0], values[1])
      : frame3(a, w, h)(values[0], values[1], values[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw Error(`点的坐标不对：${coords}`);
  return [
    {
      tag: 'circle',
      attrs: {
        cx: x.toFixed(1),
        cy: y.toFixed(1),
        r: '4.5',
        fill: color,
        stroke: color,
        'stroke-width': '1',
      },
      weight: 0.4,
    },
    ...(text ? [label(x + 9, y - 8, text, 'start', 16)] : []),
  ];
}
