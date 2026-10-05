import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import '../whiteboard.css';
import {
  Eraser,
  GraduationCap,
  History,
  ImagePlus,
  LoaderCircle,
  NotebookPen,
  Pause,
  Play,
  Presentation,
  RotateCcw,
  ScrollText,
  SendHorizontal,
  X,
} from 'lucide-react';
import { invoke } from '../api';
import { providerFor, useAiConfig, useChoice } from '../ai/client';
import { effortLabel, levelsFor, loadedModelOptions, lowerLevel } from '../ai/levels';
import { isImageFile, maxImages, prepareImage } from '../ai/images';
import { plainText, segments, texWithRefs, useTutor } from '../ai/board';
import type { Block, Camera, Ink, Look, Shape, Stroke, Tutor } from '../ai/board';
import {
  arrowPath,
  boxPath,
  circlePath,
  markPath,
  notePath,
  pairs,
  smooth,
  underlinePath,
} from '../ai/board-ink';
import type { Box } from '../ai/board-ink';
import {
  canTalk,
  listener,
  onVoiceProblem,
  stopSpeech,
  useSpeechSupport,
  useVoiceSettings,
  voice as teacherVoice,
} from '../ai/voice';
import { IconButton } from './IconButton';
import { BoardPen } from './BoardPen';
import { Listening, VoiceButton } from './BoardVoice';
import { ModelMenu } from './ModelMenu';

// The board is a fixed-width page scaled to the window, so what the student draws stays
// on the words it was drawn on when the window changes size.
const boardWidth = 960;
const noteLeft = 736;
const noteWidth = 204;
const speeds = [1, 1.5, 2];

type Vars = CSSProperties & Record<`--${string}`, string | number>;
type P = [number, number];
const ms = (v: number) => `${Math.round(v)}ms`;

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
// A formula the model got wrong is shown without its marked parts, or failing that as the
// model wrote it, rather than as KaTeX's red error.
function katexHtml(tex: string, display: boolean) {
  for (const source of [texWithRefs(tex), plainText(tex)])
    try {
      return katex.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        output: 'html',
        strict: 'ignore',
        trust: (context) => context.command === '\\htmlData',
      });
    } catch {}
  return `<span class="wb-tex-raw">${escape(plainText(tex))}</span>`;
}

// Text that appears a character at a time over `dur`, as if being written.
function Written({ text, start = 0, dur }: { text: string; start?: number; dur: number }) {
  const segs = useMemo(() => segments(text), [text]);
  const total = segs.reduce(
    (n, s) => n + s.pieces.reduce((m, p) => m + ('math' in p ? 3 : [...p.text].length), 0),
    0,
  );
  const step = dur / Math.max(1, total);
  let at = start;
  const next = (weight: number) => {
    const style = { '--d': ms(at) } as Vars;
    at += weight * step;
    return style;
  };
  return (
    <>
      {segs.map((seg, i) => {
        const inner = seg.pieces.map((p, j) =>
          'math' in p ? (
            <span
              key={j}
              className="wb-atom wb-inline-math"
              data-tex={p.math}
              style={next(3)}
              dangerouslySetInnerHTML={{ __html: katexHtml(p.math, false) }}
            />
          ) : (
            [...p.text].map((ch, k) => (
              <span key={`${j}.${k}`} className="wb-atom" style={next(1)}>
                {ch}
              </span>
            ))
          ),
        );
        return seg.ref ? (
          <span key={i} className="wb-ref" data-ref={seg.ref}>
            {inner}
          </span>
        ) : (
          <Fragment key={i}>{inner}</Fragment>
        );
      })}
    </>
  );
}

// The teacher is working out what to say; after a few seconds, for how long, so a long
// think doesn't look like the board is stuck, and after a long one, `slow`: why, and what
// would make it quicker.
function Thinking({ text, slow }: { text: string; slow: string }) {
  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - since) / 1000);
  return (
    <>
      <p className="wb-status">
        <LoaderCircle className="spin" size={14} />
        {text}
        {seconds >= 5 ? <span className="wb-status-time">{seconds} 秒</span> : null}
      </p>
      {seconds >= 25 ? <p className="wb-status-hint">{slow}</p> : null}
    </>
  );
}

function MathBlock({ block }: { block: Extract<Block, { kind: 'math' }> }) {
  const html = useMemo(() => katexHtml(block.tex, true), [block.tex]);
  const el = useRef<HTMLDivElement>(null);
  // A formula wider than the board's column is made smaller to fit, not cut off.
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const fit = () => {
      node.style.zoom = '';
      const room = (node.parentElement?.clientWidth || 640) - 22;
      const need = node.querySelector<HTMLElement>('.katex-display > .katex')?.scrollWidth || 0;
      if (need > room) node.style.zoom = String(Math.max(0.5, room / need));
    };
    fit();
    void document.fonts.ready.then(fit);
  }, [html]);
  return (
    <div
      ref={el}
      className="wb-block wb-math"
      data-ref={block.id}
      aria-label={block.tex}
      style={{ '--dur': ms(block.dur) } as Vars}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
// One element of a drawing: strokes are drawn along their length and then filled; words
// and dashed lines fade in.
function ShapeView({ shape }: { shape: Shape }) {
  const props: Record<string, unknown> = {};
  const style = { '--delay': ms(shape.delay), '--dur': ms(shape.dur) } as Vars;
  for (const [name, value] of Object.entries(shape.attrs)) {
    if (name === 'fill-opacity') style['--fo'] = value;
    else if (name === 'opacity' && (shape.fade || shape.tag === 'text')) style['--op'] = value;
    else props[name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = value;
  }
  if (shape.tag === 'text')
    return (
      <text
        {...props}
        className="wb-fig-text"
        data-ref={shape.ref}
        data-pen={shape.key}
        style={style}
      >
        {shape.text}
      </text>
    );
  const Tag = shape.tag;
  return (
    <Tag
      {...props}
      pathLength={shape.fade ? undefined : 1}
      className={shape.fade ? 'wb-fig-fade' : 'wb-fig-draw'}
      data-ref={shape.ref}
      data-pen={shape.key}
      style={style}
    />
  );
}
const figureWidth = 640;
function FigureView({ block }: { block: Extract<Block, { kind: 'figure' }> }) {
  const scale = Math.min(1, figureWidth / block.w, 480 / block.h);
  return (
    <svg
      className="wb-block wb-figure"
      data-ref={block.id}
      viewBox={`0 0 ${block.w} ${block.h}`}
      width={block.w * scale}
      height={block.h * scale}
      overflow="visible"
    >
      <g filter="url(#wb-rough)">
        {block.shapes.map((shape) => (
          <ShapeView key={shape.key} shape={shape} />
        ))}
      </g>
    </svg>
  );
}

// Code keeps its indentation and line numbers; keywords, strings, numbers and comments
// get the board's colors.
const keywords = new Set(
  'and as assert async await break case catch class const continue def default del do elif else enum except export extends false False finally for from fn func function go if impl import in interface is lambda let match mut new nil None not null or pass private protected public raise return self static struct super switch this throw true True try type typeof var void while with yield'.split(
    ' ',
  ),
);
function codeTokens(line: string, hash: boolean) {
  const pattern = hash
    ? /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_.]*\b)|([A-Za-z_]\w*)|(\s+|.)/g
    : /(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?)|(\b\d[\d_.]*\b)|([A-Za-z_]\w*)|(\s+|.)/g;
  return [...line.matchAll(pattern)].map((m) => ({
    text: m[0],
    kind: m[1]
      ? 'comment'
      : m[2]
        ? 'string'
        : m[3]
          ? 'number'
          : m[4] && keywords.has(m[4])
            ? 'keyword'
            : '',
  }));
}
function CodeBlock({ block }: { block: Extract<Block, { kind: 'code' }> }) {
  const lines = block.code.split('\n');
  const hash =
    /^(py|python\d?|rb|ruby|sh|bash|shell|zsh|r|perl|ya?ml|toml)$/i.test(block.lang) ||
    (!block.lang && lines.some((l) => /^\s*(def |elif |import |from \w+ import)/.test(l)));
  const step = block.dur / Math.max(1, block.code.replace(/\s/g, '').length);
  let at = 0;
  return (
    <div className="wb-block wb-code" data-ref={block.id} aria-label={`代码 ${block.lang}`}>
      {lines.map((line, i) => {
        const indent = line.match(/^\s*/)![0];
        const rest = line.slice(indent.length);
        const start = at;
        const atoms = codeTokens(rest, hash).flatMap((t, j) =>
          [...t.text].map((ch, k) => {
            const style = { '--d': ms(at) } as Vars;
            if (ch.trim()) at += step;
            return (
              <span
                key={`${j}.${k}`}
                className={`wb-atom${t.kind ? ` wb-tok-${t.kind}` : ''}`}
                style={style}
              >
                {ch}
              </span>
            );
          }),
        );
        return (
          <div className="wb-code-line" key={i}>
            <span className="wb-code-no wb-atom" style={{ '--d': ms(start) } as Vars}>
              {i + 1}
            </span>
            {indent}
            {rest ? (
              <span data-ref={`${block.id}.${i + 1}`} data-owner={`${block.id}.${i + 1}`}>
                {atoms}
              </span>
            ) : (
              '\u200b'
            )}
          </div>
        );
      })}
    </div>
  );
}

const BlockView = memo(function BlockView({ block }: { block: Block }) {
  const style = { '--dur': ms(block.dur) } as Vars;
  const own = { 'data-ref': block.id, 'data-owner': block.id, style };
  switch (block.kind) {
    case 'title':
      return (
        <h3 className="wb-block wb-title" {...own}>
          <Written text={block.text} dur={block.dur} />
        </h3>
      );
    case 'text':
      return (
        <p className="wb-block wb-text" {...own}>
          <Written text={block.text} dur={block.dur} />
        </p>
      );
    case 'quote':
      return (
        <blockquote className="wb-block wb-quote" {...own}>
          <Written text={block.text} dur={block.dur} />
        </blockquote>
      );
    case 'math':
      return <MathBlock block={block} />;
    case 'flow': {
      const per = block.dur / block.parts.length;
      return (
        <div className="wb-block wb-flow" data-ref={block.id} style={style}>
          {block.parts.map((part, i) => (
            <Fragment key={i}>
              {i ? (
                <svg
                  className="wb-flow-arrow"
                  viewBox="0 0 44 20"
                  aria-hidden="true"
                  style={{ '--delay': ms(i * per - 150), '--dur': ms(240) } as Vars}
                >
                  <path
                    className="wb-stroke"
                    pathLength={1}
                    d="M3 11 Q22 7 39 10 M31 4 L40 10 L31 16"
                  />
                </svg>
              ) : null}
              <div
                className="wb-flow-box"
                data-ref={`${block.id}.${i + 1}`}
                data-owner={`${block.id}.${i + 1}`}
                style={{ '--d': ms(i * per) } as Vars}
              >
                <Written text={part} start={i * per + 150} dur={Math.max(150, per - 250)} />
              </div>
            </Fragment>
          ))}
        </div>
      );
    }
    case 'asked':
      return (
        <div className="wb-asked">
          <span>你问：{block.text}</span>
        </div>
      );
    case 'figure':
      return <FigureView block={block} />;
    case 'code':
      return <CodeBlock block={block} />;
    case 'picture':
      return (
        <figure className="wb-block wb-picture">
          <img data-ref={block.id} src={block.src} alt="框选的区域" draggable={false} />
        </figure>
      );
  }
});

const InkView = memo(function InkView({
  ink,
  rects,
  notes,
  writing,
}: {
  ink: Ink;
  rects: Map<string, Box>;
  notes: Map<string, Box>;
  // Where the letters and formula glyphs are, which arrows keep clear of.
  writing: Box[];
}) {
  const style = { '--dur': ms(ink.dur), color: `var(--board-${ink.color})` } as Vars;
  if (ink.kind === 'arrow') {
    const a = rects.get(ink.from);
    const b = rects.get(ink.to);
    if (!a || !b) return null;
    const p = arrowPath(a, b, ink.key, ink.label, writing);
    return (
      <g style={style} data-on={`${ink.from} ${ink.to}`}>
        <path className="wb-stroke" data-pen={ink.key} pathLength={1} d={p.shaft} />
        <path className="wb-stroke wb-arrow-head" data-pen={ink.key} pathLength={1} d={p.head} />
        {p.label ? (
          <text className="wb-arrow-label" x={p.label.x} y={p.label.y} textAnchor={p.label.anchor}>
            {ink.label}
          </text>
        ) : null}
      </g>
    );
  }
  if (ink.kind === 'note') {
    const target = rects.get(ink.target);
    const box = notes.get(ink.key);
    if (!target || !box) return null;
    return (
      <path
        className="wb-stroke wb-leader"
        data-on={`${ink.target} ${ink.id}`}
        data-pen={ink.key}
        pathLength={1}
        d={notePath(target, box)}
        style={{ ...style, '--dur': ms(300) } as Vars}
      />
    );
  }
  if (ink.kind === 'mark' || ink.kind === 'point' || ink.kind === 'area') return null;
  const b = rects.get(ink.target);
  if (!b) return null;
  const d =
    ink.kind === 'circle'
      ? circlePath(b, ink.key)
      : ink.kind === 'underline'
        ? underlinePath(b, ink.key)
        : boxPath(b, ink.key);
  return (
    <path
      className="wb-stroke"
      data-on={ink.target}
      data-pen={ink.key}
      pathLength={1}
      d={d}
      style={style}
    />
  );
});

const sameBox = (o: Box | undefined, r: Box) =>
  !!o &&
  Math.abs(o.x - r.x) <= 0.5 &&
  Math.abs(o.y - r.y) <= 0.5 &&
  Math.abs(o.w - r.w) <= 0.5 &&
  Math.abs(o.h - r.h) <= 0.5;
function sameRects(a: Map<string, Box>, b: Map<string, Box>) {
  if (a.size !== b.size) return false;
  for (const [k, r] of b) if (!sameBox(a.get(k), r)) return false;
  return true;
}
const sameList = (a: Box[], b: Box[]) =>
  a.length === b.length && b.every((r, i) => sameBox(a[i], r));
function bounds(points: P[]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function length(points: P[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}
function inside([x, y]: P, polygon: P[]) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const within = ([x, y]: P, b: Box) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

// Words for what one of the student's strokes points at: the characters it circles or
// underlines, the formulas or parts of them it covers, or the nearest thing on the board.
function describeStroke(points: number[], root: HTMLElement, tutor: Tutor) {
  const pts = pairs(points);
  const b = bounds(pts);
  const diag = Math.hypot(b.w, b.h);
  const gap = Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]);
  const shape =
    diag < 8
      ? 'dot'
      : diag > 20 && gap < Math.max(30, diag * 0.35) && length(pts) > diag * 1.6
        ? 'loop'
        : b.h < b.w * 0.3
          ? 'line'
          : 'stroke';
  const base = root.getBoundingClientRect();
  const s = base.width / boardWidth || 1;
  const local = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - base.left) / s,
      y: (r.top - base.top) / s,
      w: r.width / s,
      h: r.height / s,
    };
  };
  const lineY = b.y + b.h / 2;
  const pad: Box = { x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16 };
  const below = (r: Box) => lineY >= r.y + r.h * 0.3 && lineY <= r.y + r.h + 16;
  const probes = (r: Box): P[] =>
    [
      [0.5, 0.5],
      [0.2, 0.3],
      [0.8, 0.3],
      [0.2, 0.7],
      [0.8, 0.7],
    ].map(([fx, fy]) => [r.x + r.w * fx, r.y + r.h * fy]);
  const covers = (p: P) => (shape === 'loop' ? inside(p, pts) : within(p, pad));
  const score = (r: Box) => {
    if (shape === 'dot') return within(pts[0], r) ? 1 : 0;
    if (shape === 'line')
      return below(r)
        ? Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x)) / (r.w || 1)
        : 0;
    return probes(r).filter(covers).length / 5;
  };

  const parts: string[] = [];
  // Characters, by the line of writing they belong to.
  if (shape !== 'dot') {
    const picked = new Map<string, string>();
    root.querySelectorAll<HTMLElement>('.wb-atom').forEach((el) => {
      const owner = el.closest<HTMLElement>('[data-owner]')?.dataset.owner;
      if (!owner || !tutor.knows(owner)) return;
      const r = local(el);
      const center: P = [r.x + r.w / 2, r.y + r.h / 2];
      const hit =
        shape === 'line'
          ? center[0] >= b.x - 2 && center[0] <= b.x + b.w + 2 && below(r)
          : covers(center);
      if (hit)
        picked.set(
          owner,
          (picked.get(owner) || '') + (el.dataset.tex ? `$${el.dataset.tex}$` : el.textContent),
        );
    });
    for (const [owner, text] of picked) {
      const whole = tutor.textOf(owner).replace(/\s+/g, '');
      const got = text.replace(/\s+/g, '');
      parts.push(
        got.length >= whole.length * 0.8
          ? tutor.describe(owner)
          : `${tutor.describe(owner)}中的「${clip(text.trim(), 40)}」`,
      );
    }
  }
  // Formulas and their marked parts, which have no characters of their own.
  const elements = new Map<string, HTMLElement>();
  root
    .querySelectorAll<HTMLElement>('[data-ref]')
    .forEach((el) => elements.set(el.dataset.ref!, el));
  const hits: { ref: string; score: number }[] = [];
  for (const [ref, el] of elements) {
    if (!tutor.knows(ref)) continue;
    if (shape !== 'dot' && el.querySelector('.wb-atom')) continue;
    const r = local(el);
    const v = score(r);
    // A picture is marked wherever on it the stroke is, however small: mostly on it is a
    // part of it (named by where), unless it takes in most of the picture.
    if (el.tagName === 'IMG' && shape !== 'dot' && v < 0.8) {
      // A straight line has no height of its own.
      const s = { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
      const across = Math.min(s.x + s.w, r.x + r.w) - Math.max(s.x, r.x);
      const down = Math.min(s.y + s.h, r.y + r.h) - Math.max(s.y, r.y);
      if (across > 0 && down > 0 && across * down >= s.w * s.h * 0.5)
        hits.push({ ref, score: 0.5 });
      continue;
    }
    if (v > 0) hits.push({ ref, score: v });
  }
  const contains = (a: string, b: string) =>
    a !== b && !!elements.get(a)?.contains(elements.get(b)!);
  // Where on a picture the stroke is, in the percent the teacher uses for areas.
  const name = (ref: string, whole: boolean) => {
    const el = elements.get(ref)!;
    if (el.tagName !== 'IMG') return whole ? tutor.describe(ref) : `${tutor.describe(ref)}的一部分`;
    const r = local(el);
    const pct = (v: number, from: number, size: number) =>
      Math.round(Math.max(0, Math.min(100, ((v - from) / size) * 100)));
    const spot = `左 ${pct(b.x, r.x, r.w)}% 上 ${pct(b.y, r.y, r.h)}% 右 ${pct(b.x + b.w, r.x, r.w)}% 下 ${pct(b.y + b.h, r.y, r.h)}%`;
    return whole ? `整张${tutor.describe(ref)}` : `${tutor.describe(ref)} 中（${spot}）的地方`;
  };
  if (shape === 'dot') {
    // The innermost thing under the point.
    const inner = hits.filter((h) => !hits.some((o) => contains(h.ref, o.ref)));
    for (const h of inner.slice(0, 2))
      parts.push(
        elements.get(h.ref)!.tagName === 'IMG' ? name(h.ref, false) : tutor.describe(h.ref),
      );
  } else {
    const full = hits.filter((h) => h.score >= 0.8).map((h) => h.ref);
    const some = hits.filter((h) => h.score < 0.8).map((h) => h.ref);
    for (const ref of full) if (!full.some((o) => contains(o, ref))) parts.push(name(ref, true));
    for (const ref of some)
      if (
        !full.some((o) => contains(o, ref) || contains(ref, o)) &&
        !some.some((o) => contains(ref, o))
      )
        parts.push(name(ref, false));
  }
  const list = parts.slice(0, 4).join('、');
  if (!list) {
    let nearest = '';
    let best = Infinity;
    const c: P = [b.x + b.w / 2, b.y + b.h / 2];
    for (const [ref, el] of elements) {
      if (!tutor.knows(ref)) continue;
      const r = local(el);
      const dx = Math.max(r.x - c[0], 0, c[0] - r.x - r.w);
      const dy = Math.max(r.y - c[1], 0, c[1] - r.y - r.h);
      const d = Math.hypot(dx, dy);
      if (d < best) [best, nearest] = [d, ref];
    }
    return nearest
      ? `在白板空白处画了一笔，离它最近的是${tutor.describe(nearest)}`
      : '在白板空白处画了一笔';
  }
  return shape === 'loop'
    ? `圈出了${list}`
    : shape === 'line'
      ? `在${list}下面划了线`
      : shape === 'dot'
        ? `点了点${list}`
        : `在${list}上画了一笔`;
}

export default function Whiteboard({
  tutor,
  selection,
  onClose,
  onNotify,
  onHistory,
  onOpenSettings,
  noteTarget,
  onNote,
  noteAsk,
}: {
  tutor: Tutor;
  selection: string;
  onClose: () => void;
  onNotify: (text: string, error?: boolean) => void;
  // Shows the saved boards, to switch to another one.
  onHistory: () => void;
  // Opens the AI settings, on the page for speech services' keys when asked.
  onOpenSettings: (page?: 'voices') => void;
  // The document whose note the board can be kept in, if any.
  noteTarget?: string;
  // Keeps the board in the note, with a picture of it when one could be taken.
  onNote: (picture: string | null) => Promise<void>;
  // Asks for that from outside (the sidebar's menu), once per `n`.
  noteAsk?: { id: string; n: number } | null;
}) {
  const state = useTutor(tutor);
  const root = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [scale, setScale] = useState(1);
  const [viewHeight, setViewHeight] = useState(600);
  const [rects, setRects] = useState<Map<string, Box>>(() => new Map());
  const [glyphs, setGlyphs] = useState<Box[]>([]);
  const drawing = useRef<number[] | null>(null);
  const [live, setLive] = useState<number[] | null>(null);
  const [question, setQuestion] = useState('');
  // Pictures waiting to go with the next question, e.g. a problem to solve.
  const [pics, setPics] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  async function addPics(files: File[]) {
    const images = files.filter(isImageFile);
    if (!images.length) return;
    const room = maxImages - pics.length;
    if (room <= 0) return onNotify(`每次最多附 ${maxImages} 张图片`, true);
    try {
      const ready = await Promise.all(images.slice(0, room).map((f) => prepareImage(f)));
      setPics((list) => [...list, ...ready].slice(0, maxImages));
      if (images.length > room) onNotify(`每次最多附 ${maxImages} 张图片`, true);
    } catch {
      onNotify('这张图片读取不了，换成 PNG 或 JPG 再试', true);
    }
    input.current?.focus();
  }
  const [log, setLog] = useState(false);
  const pending = state.strokes.filter((s) => !s.sent);
  const busy = state.phase === 'teaching' || state.phase === 'thinking';
  const nothing = !question.trim() && !pending.length && !pics.length;
  // Waiting for the student's first question: it is typed straight away.
  useEffect(() => {
    if (state.waiting) input.current?.focus({ preventScroll: true });
  }, [state.waiting]);

  // Whether the teacher talks out loud, and whether the student talks back. A voice
  // conversation needs something that listens; without it the teacher just talks.
  const voice = useVoiceSettings();
  const support = useSpeechSupport();
  const mode =
    voice.mode === 'talk' && support && !canTalk(support, voice.voice) ? 'speak' : voice.mode;
  const config = useAiConfig();
  const locale = config?.prefs.language === 'en' ? 'en-US' : 'zh-CN';
  // What a long think is put down to: the reasoning level, with a lower one to switch to in
  // the model menu above, or else the model.
  const teacher = providerFor(config, 'board');
  const { levels, effort } = levelsFor(
    teacher,
    config,
    loadedModelOptions(teacher?.id),
    useChoice(config, 'board') ? 'board' : 'chat',
  );
  const lower = lowerLevel(levels, effort);
  const slow = lower
    ? `推理档位是「${effortLabel(effort)}」，页老师要多想一会儿。着急的话，可以在右上角换成「${effortLabel(lower)}」，下次提问会快一些。`
    : '这个模型要多想一会儿。着急的话，可以在右上角换个快一些的模型。';
  useEffect(() => tutor.setVoice(mode, mode === 'off' ? null : teacherVoice), [mode, tutor]);
  // The helper goes when the board does, and the voice forgets it: another board opened in
  // its place starts afresh.
  useEffect(() => () => void stopSpeech(), [tutor]);
  useEffect(() => onVoiceProblem((message) => onNotify(message, true)), [onNotify]);
  // The teacher stopped because the student started talking.
  const [cutIn, setCutIn] = useState(false);

  useEffect(() => root.current?.focus(), []);
  useLayoutEffect(() => {
    const view = viewport.current!;
    const fit = () => {
      setScale(Math.max(0.5, Math.min(1.35, (view.clientWidth - 8) / boardWidth)));
      setViewHeight(view.clientHeight);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(view);
    return () => observer.disconnect();
  }, []);

  // Where everything the teacher can point at is, in board coordinates.
  const measure = useCallback(() => {
    const el = canvas.current;
    if (!el) return;
    const base = el.getBoundingClientRect();
    const s = base.width / boardWidth || 1;
    const box = (node: Element): Box => {
      const r = node.getBoundingClientRect();
      return {
        x: (r.left - base.left) / s,
        y: (r.top - base.top) / s,
        w: r.width / s,
        h: r.height / s,
      };
    };
    const next = new Map<string, Box>();
    el.querySelectorAll<HTMLElement>('[data-ref]').forEach((node) =>
      next.set(node.dataset.ref!, box(node)),
    );
    setRects((prev) => (sameRects(prev, next) ? prev : next));
    // Letters, joined into runs along each line, and the glyphs, bars and radicals of formulas.
    const found: Box[] = [];
    const parts =
      '.wb-atom, .katex-html span, .katex-html svg, .wb-flow-box, .wb-flow-arrow, .wb-asked';
    el.querySelectorAll(parts).forEach((node) => {
      const glyph = node.matches('.katex-html span');
      if (node.matches('.wb-inline-math')) return;
      if (
        glyph &&
        !node.matches('.frac-line') &&
        (node.children.length || !node.textContent?.trim())
      )
        return;
      const r = box(node);
      if (!r.w || !r.h) return;
      const last = found[found.length - 1];
      if (
        last &&
        node.classList.contains('wb-atom') &&
        Math.abs(last.y - r.y) < 2 &&
        r.x >= last.x &&
        r.x - (last.x + last.w) < 4
      ) {
        last.w = r.x + r.w - last.x;
        last.h = Math.max(last.h, r.h);
      } else found.push({ ...r });
    });
    setGlyphs((prev) => (sameList(prev, found) ? prev : found));
  }, []);
  // Margin notes go beside what they are about, below the note before.
  const notes = useMemo(() => {
    const out = new Map<string, Box>();
    let bottom = 0;
    for (const ink of state.inks) {
      if (ink.kind !== 'note') continue;
      const target = rects.get(ink.target);
      if (!target) continue;
      const y = Math.max(target.y - 4, bottom + 12);
      const h = rects.get(ink.id)?.h ?? 40;
      out.set(ink.key, { x: noteLeft, y, w: noteWidth, h });
      bottom = y + h;
    }
    return out;
  }, [state.inks, rects]);
  // Arrows also keep clear of the teacher's underlines.
  const writing = useMemo(() => {
    const lines = state.inks.flatMap((ink) => {
      const b = ink.kind === 'underline' && rects.get(ink.target);
      return b ? [{ x: b.x - 6, y: b.y + b.h, w: b.w + 12, h: 10 }] : [];
    });
    // Pictures and drawings are kept clear of too.
    const solid = state.blocks
      .filter((b) => b.kind === 'picture' || b.kind === 'figure')
      .map((b) => rects.get(b.id))
      .filter((b): b is Box => !!b);
    return [...glyphs, ...lines, ...solid];
  }, [glyphs, state.inks, state.blocks, rects]);
  useLayoutEffect(measure, [state.blocks, state.inks, scale, notes, measure]);
  useEffect(() => {
    const el = canvas.current!;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // KaTeX's fonts load when a formula first needs them and change its size.
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [measure]);

  // The board's camera. It moves only when what the teacher writes or points at next is out
  // of sight, glides there at a pace the eye can follow, and the lesson waits for it, so the
  // pen starts where it can be seen.
  useEffect(() => {
    const view = viewport.current!;
    let frame = 0;
    const stop = () => cancelAnimationFrame(frame);
    // Where the view is to scroll to for `look`, or null when it is in sight already.
    const aim = (look: Look): number | null => {
      const el = canvas.current;
      if (!el || drawing.current) return null;
      const v = view.getBoundingClientRect();
      const top = view.scrollTop;
      const h = view.clientHeight;
      const at = (r: DOMRect) => ({ top: r.top - v.top + top, bottom: r.bottom - v.top + top });
      let to: number;
      if ('room' in look) {
        const s = el.getBoundingClientRect().width / boardWidth || 1;
        // Below the last thing written, or at the top of an empty board.
        let bottom = at(el.getBoundingClientRect()).top + 36 * s;
        el.querySelectorAll('.wb-main > *, .wb-note').forEach((n) => {
          bottom = Math.max(bottom, at(n.getBoundingClientRect()).bottom);
        });
        const need = Math.min(look.room * s + 24, h * 0.85);
        if (bottom + need <= top + h - 48) return null;
        // Having to move, it moves far enough for the next few lines as well, with the last
        // ones written still in sight above.
        to = Math.max(bottom + need + 48 - h, bottom - h * 0.3);
      } else {
        let u: { top: number; bottom: number } | null = null;
        for (const ref of look.refs) {
          const all = el.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`);
          const node = all[all.length - 1];
          if (!node) continue;
          const r = at(node.getBoundingClientRect());
          u = u ? { top: Math.min(u.top, r.top), bottom: Math.max(u.bottom, r.bottom) } : r;
        }
        if (!u || (u.top >= top + 40 && u.bottom <= top + h - 48)) return null;
        to = u.bottom - u.top > h - 100 ? u.top - 40 : (u.top + u.bottom) / 2 - h * 0.4;
      }
      to = Math.max(0, Math.min(view.scrollHeight - h, to));
      return Math.abs(to - top) < 8 ? null : to;
    };
    const camera: Camera = {
      needs(look) {
        const to = aim(look);
        return to === null ? 'none' : 'refs' in look && to < view.scrollTop ? 'back' : 'on';
      },
      go(look, speed) {
        const to = aim(look);
        if (to === null) return 0;
        stop();
        const from = view.scrollTop;
        const ms =
          Math.min(1100, Math.max(480, 380 + Math.abs(to - from) * 0.45)) / Math.sqrt(speed);
        const start = performance.now();
        const step = (now: number) => {
          const k = Math.min(1, (now - start) / ms);
          const eased = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
          view.scrollTop = from + (to - from) * eased;
          if (k < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return ms;
      },
    };
    // The student scrolling, with a wheel or a finger, takes over from a glide under way.
    view.addEventListener('wheel', stop, { passive: true });
    view.addEventListener('touchstart', stop, { passive: true });
    const off = tutor.setCamera(camera);
    return () => {
      stop();
      off();
      view.removeEventListener('wheel', stop);
      view.removeEventListener('touchstart', stop);
    };
  }, [tutor]);
  // Without the camera (a picture sent with a question), the board scrolls to what's new.
  useEffect(() => {
    const view = viewport.current;
    const ref = state.focus?.ref;
    if (!view || !ref || drawing.current) return;
    const all = canvas.current!.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`);
    const el = all[all.length - 1];
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = view.getBoundingClientRect();
    if (r.top < v.top + 40 || r.bottom > v.bottom - 60)
      view.scrollTo({
        top: Math.max(0, view.scrollTop + r.top - v.top - v.height * 0.35),
        behavior: 'smooth',
      });
  }, [state.focus]);

  function toBoard(e: { clientX: number; clientY: number }): P {
    const r = canvas.current!.getBoundingClientRect();
    const s = r.width / boardWidth || 1;
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
  }
  function endStroke(keep: boolean) {
    const points = drawing.current;
    drawing.current = null;
    setLive(null);
    if (!keep || !points) return;
    // A tap points at one spot.
    tutor.addStroke(points.length >= 4 ? points : [...points, points[0] + 0.5, points[1] + 0.5]);
    input.current?.focus({ preventScroll: true });
  }
  // A picture of the board with the student's marks, for models that can see.
  async function shoot(strokes: Stroke[]) {
    const view = viewport.current;
    if (!view) return null;
    const ys = strokes.flatMap((s) => pairs(s.points).map(([, y]) => y * scale));
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    if (top < view.scrollTop + 20 || bottom > view.scrollTop + view.clientHeight - 20)
      view.scrollTop = Math.max(0, (top + bottom) / 2 - view.clientHeight / 2);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = view.getBoundingClientRect();
    const png = await invoke<string>('capture-region', {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    });
    return prepareImage(png);
  }
  // A picture of the whole board, taken a screenful at a time as it scrolls and joined up.
  async function boardPicture() {
    const view = viewport.current;
    const el = canvas.current;
    if (!view || !el) return null;
    setLog(false);
    const saved = view.scrollTop;
    const base = el.getBoundingClientRect();
    const box = view.getBoundingClientRect();
    // Down to the last thing written, drawn or marked, not the empty board below it.
    let bottom = 0;
    el.querySelectorAll('.wb-main > *, .wb-note').forEach((n) => {
      bottom = Math.max(bottom, n.getBoundingClientRect().bottom - base.top);
    });
    for (const st of state.strokes)
      for (const [, y] of pairs(st.points)) bottom = Math.max(bottom, y * scale);
    const offset = base.top - box.top + saved;
    const total = Math.min(view.scrollHeight, Math.ceil(offset + bottom + 36 * scale));
    // Whole pixels inside the viewport, so no edge of the footer or frame gets in.
    const left = Math.ceil(box.left);
    const top = Math.ceil(box.top);
    const width = Math.floor(box.left + view.clientWidth) - left;
    const height = Math.floor(box.top + view.clientHeight) - top;
    const inset = top - box.top;
    const shots: { at: number; png: string }[] = [];
    try {
      for (let y = 0; y < total; y += height) {
        view.scrollTop = y;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        shots.push({
          at: view.scrollTop + inset,
          png: await invoke<string>('capture-region', { x: left, y: top, width, height }),
        });
      }
    } finally {
      view.scrollTop = saved;
    }
    const images = await Promise.all(
      shots.map(
        (s) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = s.png;
          }),
      ),
    );
    const ratio = images[0].naturalWidth / width;
    // At most 1400 pixels wide, and within what a canvas can hold.
    const k = Math.min(ratio, 1400 / width, 16000 / total);
    const out = document.createElement('canvas');
    out.width = Math.round(width * k);
    out.height = Math.round(total * k);
    const ctx = out.getContext('2d')!;
    // The part-pixel left above the first slice is board, not black.
    ctx.fillStyle = getComputedStyle(view.parentElement!).backgroundColor;
    ctx.fillRect(0, 0, out.width, out.height);
    shots.forEach((s, i) =>
      ctx.drawImage(images[i], 0, s.at * k, width * k, (images[i].naturalHeight / ratio) * k),
    );
    return out.toDataURL('image/jpeg', 0.88);
  }
  const [keeping, setKeeping] = useState(false);
  async function keepInNote() {
    if (keeping) return;
    setKeeping(true);
    try {
      const picture = await boardPicture().catch(() => null);
      if (!picture) onNotify('白板截图没有成功，只存了文字', true);
      await onNote(picture);
    } finally {
      setKeeping(false);
    }
  }
  const asked = useRef(0);
  useEffect(() => {
    if (!noteAsk || noteAsk.id !== tutor.id || asked.current === noteAsk.n) return;
    asked.current = noteAsk.n;
    // A board just opened lays out, and KaTeX loads its fonts, before the picture.
    void document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400))).then(keepInNote);
  }, [noteAsk, tutor]);
  // Sends what was typed, or what was said out loud, with the marks and pictures waiting.
  function send(said?: string) {
    const q = (said ?? question).trim();
    // Nothing asked before the first lesson: the teacher goes ahead.
    if (!q && !pending.length && !pics.length) return void (state.waiting && tutor.teach());
    const marks = pending.map((s) => describeStroke(s.points, canvas.current!, tutor));
    if (said === undefined) setQuestion('');
    setPics([]);
    setLog(false);
    tutor.ask(
      q,
      marks,
      pending.map((s) => s.id),
      pending.length ? () => shoot(pending) : undefined,
      pics,
      said !== undefined,
    );
  }

  const noteBottom = Math.max(0, ...[...notes.values()].map((n) => n.y + n.h));
  const status =
    state.phase === 'thinking'
      ? state.blocks.length
        ? '页老师在想怎么回答…'
        : '页老师在备课…'
      : '';
  return (
    <div className="modal-backdrop whiteboard-backdrop">
      <section
        ref={root}
        className="whiteboard"
        role="dialog"
        aria-modal="true"
        aria-label="白板讲解"
        tabIndex={-1}
        data-paused={state.paused || undefined}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).filter(isImageFile);
          if (!files.length) return;
          e.preventDefault();
          void addPics(files);
        }}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.items).some((i) => i.kind === 'file')) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files);
          if (!files.length) return;
          e.preventDefault();
          if (!files.some(isImageFile)) return onNotify('只能拖入图片', true);
          void addPics(files);
        }}
        onKeyDown={(e) => {
          const typing = (e.target as Element).closest('input');
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
            e.preventDefault();
            tutor.undoStroke();
          } else if (e.key === ' ' && !typing && !(e.target as Element).closest('button')) {
            e.preventDefault();
            if (state.paused) tutor.resume();
            else if (state.phase === 'teaching') tutor.pause();
          } else if (e.key === 'Escape') {
            if (drawing.current) endStroke(false);
            else if (log) setLog(false);
          }
          // The reader's own shortcuts (undo, tools) don't reach through the board.
          e.stopPropagation();
        }}
      >
        <header className="whiteboard-head">
          <h2>
            <Presentation size={17} />
            白板讲解
          </h2>
          <span className="whiteboard-quote" title={selection}>
            {selection}
          </span>
          <ModelMenu use="board" className="model-pick" onOpenSettings={onOpenSettings} />
          {noteTarget ? (
            <button
              type="button"
              className="whiteboard-note"
              title={
                busy
                  ? '页老师讲完再存'
                  : `把板书和讲解整理进「${noteTarget.split('/').at(-1)}」的笔记；再存一次会更新那一段`
              }
              disabled={!state.transcript.length || keeping || busy}
              onClick={() => void keepInNote()}
            >
              {keeping ? <LoaderCircle className="spin" size={14} /> : <NotebookPen size={14} />}
              {keeping ? '正在存…' : '存入笔记'}
            </button>
          ) : null}
          <IconButton
            label="白板记录"
            help="讲过的白板自动保存，可以打开接着问"
            onClick={onHistory}
          >
            <History size={16} />
          </IconButton>
          <IconButton label="关闭白板" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="whiteboard-stage">
          <svg className="wb-defs" aria-hidden="true">
            <filter id="wb-rough">
              <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="7" />
              <feDisplacementMap in="SourceGraphic" scale="2.4" />
            </filter>
          </svg>
          {state.erased.length ? (
            <style>
              {`${state.erased
                .map(
                  (r) =>
                    `.wb-canvas [data-ref="${CSS.escape(r)}"], .wb-canvas [data-on~="${CSS.escape(r)}"]`,
                )
                .join(
                  ',',
                )} { animation: none !important; stroke-dashoffset: 0 !important; opacity: 0 !important; transition: opacity 450ms ease-out; pointer-events: none; }`}
            </style>
          ) : null}
          <div className="whiteboard-viewport" ref={viewport}>
            <div
              ref={canvas}
              className="wb-canvas"
              style={{
                zoom: scale,
                minHeight: Math.max(viewHeight / scale, noteBottom + 160),
                // Room below the writing to scroll it up into, for what comes next.
                paddingBottom: Math.max(180, (viewHeight / scale) * 0.75),
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                // Starting to draw is interrupting: the teacher stops and waits.
                if (state.phase === 'teaching') tutor.pause();
                setLog(false);
                drawing.current = toBoard(e);
                setLive(drawing.current);
              }}
              onPointerMove={(e) => {
                const points = drawing.current;
                if (!points) return;
                const [x, y] = toBoard(e);
                if (Math.hypot(x - points[points.length - 2], y - points[points.length - 1]) < 2)
                  return;
                points.push(x, y);
                setLive([...points]);
              }}
              onPointerUp={() => endStroke(true)}
              onPointerCancel={() => endStroke(false)}
            >
              <svg className="wb-layer wb-under" aria-hidden="true">
                {state.inks.map((ink) => {
                  if (ink.kind !== 'mark' && ink.kind !== 'point') return null;
                  const b = rects.get(ink.target);
                  if (!b) return null;
                  const m = markPath(b, ink.key);
                  return (
                    <path
                      key={ink.key}
                      data-on={ink.target}
                      data-pen={ink.key}
                      className={`wb-stroke wb-marker${ink.kind === 'point' ? ' wb-pointer' : ''}`}
                      pathLength={1}
                      d={m.d}
                      style={
                        {
                          '--dur': ms(ink.dur),
                          color: `var(--board-${ink.color})`,
                          strokeWidth: m.width,
                        } as Vars
                      }
                    />
                  );
                })}
              </svg>
              <div className="wb-main">
                {state.blocks.map((block) => (
                  <BlockView key={block.id} block={block} />
                ))}
              </div>
              {state.inks.map((ink) => {
                const box = ink.kind === 'note' && notes.get(ink.key);
                return box && ink.kind === 'note' ? (
                  <div
                    key={ink.key}
                    className="wb-note"
                    data-ref={ink.id}
                    data-owner={ink.id}
                    data-pen={ink.key}
                    style={{ top: box.y, color: `var(--board-${ink.color})` }}
                  >
                    <Written text={ink.text} start={250} dur={Math.max(200, ink.dur - 250)} />
                  </div>
                ) : null;
              })}
              {state.inks.map((ink) => {
                const img = ink.kind === 'area' && rects.get(ink.target);
                if (!img || ink.kind !== 'area') return null;
                const [l, t, r, b] = ink.box;
                return (
                  <div
                    key={ink.key}
                    className="wb-area"
                    data-ref={ink.id}
                    style={{
                      left: img.x + (img.w * l) / 100,
                      top: img.y + (img.h * t) / 100,
                      width: (img.w * (r - l)) / 100,
                      height: (img.h * (b - t)) / 100,
                    }}
                  />
                );
              })}
              <svg className="wb-layer wb-over" aria-hidden="true">
                {state.inks.map((ink) => (
                  <InkView key={ink.key} ink={ink} rects={rects} notes={notes} writing={writing} />
                ))}
                {state.strokes.map((s) => (
                  <path
                    key={s.id}
                    className="wb-user"
                    data-sent={s.sent || undefined}
                    d={smooth(pairs(s.points))}
                  />
                ))}
                {live ? <path className="wb-user" d={smooth(pairs(live))} /> : null}
              </svg>
              <BoardPen
                pen={state.pen}
                paused={state.paused}
                teaching={state.phase === 'teaching'}
                canvas={canvas}
              />
            </div>
          </div>
          {status && !state.blocks.length ? (
            <div className="wb-empty">
              <LoaderCircle className="spin" size={22} />
              {status}
            </div>
          ) : state.waiting && !state.blocks.length ? (
            <div className="wb-empty">等你提问，或者点「直接讲」</div>
          ) : state.phase === 'idle' && !state.blocks.length ? (
            <div className="wb-empty">在下面问一道题，也可以粘贴、拖入或添加题目的图片</div>
          ) : null}
          {state.paused ? (
            <div className="wb-paused">
              {cutIn
                ? '页老师停下来在听你说'
                : mode === 'talk'
                  ? '已暂停 · 圈出没懂的地方，直接说哪里不懂'
                  : '已暂停 · 圈出没懂的地方，告诉页老师哪里不懂'}
            </div>
          ) : null}
        </div>
        <footer className="whiteboard-foot">
          {log ? (
            <div className="wb-log" role="log" aria-label="字幕记录">
              {state.transcript.length ? (
                state.transcript.map((line, i) => (
                  <p key={i} data-who={line.who}>
                    <b>{line.who === 'teacher' ? '页老师' : '我'}</b>
                    {line.text}
                  </p>
                ))
              ) : (
                <p>还没有字幕</p>
              )}
            </div>
          ) : null}
          <div className="wb-caption">
            <span className="wb-avatar" aria-hidden="true">
              <GraduationCap size={17} />
            </span>
            <div className="wb-caption-body" aria-live="polite">
              {state.phase === 'error' ? (
                <p className="wb-error">{state.error}</p>
              ) : (
                <>
                  {status ? <Thinking text={status} slow={slow} /> : null}
                  {state.waiting ? (
                    <p className="wb-caption-text">
                      {mode === 'talk' ? '想问什么直接说' : '想问什么就在下面输入'}
                      ；不问的话点「直接讲」，我把这部分完整讲一遍。
                    </p>
                  ) : null}
                  {/* A live voice goes on talking while the teacher thinks. */}
                  {state.caption && (!status || state.caption.live) ? (
                    <p className="wb-caption-text" key={state.caption.key}>
                      <Written text={state.caption.text} dur={state.caption.dur} />
                    </p>
                  ) : null}
                  {state.beat ? (
                    <span
                      className="wb-beat"
                      key={state.beat.key}
                      aria-hidden="true"
                      style={{ '--dur': ms(state.beat.dur) } as Vars}
                    />
                  ) : null}
                </>
              )}
            </div>
            <div className="wb-controls">
              {state.phase === 'error' ? (
                <button className="wb-retry" onClick={() => tutor.retry()}>
                  <RotateCcw size={13} />
                  重试
                </button>
              ) : null}
              <IconButton
                label={state.paused ? '继续讲' : '暂停'}
                disabled={!state.paused && state.phase !== 'teaching'}
                onClick={() => (state.paused ? tutor.resume() : tutor.pause())}
              >
                {state.paused ? <Play size={16} /> : <Pause size={16} />}
              </IconButton>
              <button
                className="wb-speed"
                aria-label={`讲解速度 ${state.speed}×`}
                title="讲解速度"
                onClick={() =>
                  tutor.setSpeed(speeds[(speeds.indexOf(state.speed) + 1) % speeds.length])
                }
              >
                {state.speed}×
              </button>
              <IconButton label="字幕记录" active={log} onClick={() => setLog(!log)}>
                <ScrollText size={16} />
              </IconButton>
              <VoiceButton
                mode={mode}
                voice={voice.voice}
                ears={voice.ears}
                support={support}
                busy={state.phase === 'teaching' && !state.paused}
                onOpenSettings={() => onOpenSettings('voices')}
              />
            </div>
          </div>
          {mode === 'talk' && support ? (
            <Listening
              // A ChatGPT voice listens itself; the helper or the page's microphone listens for
              // the others. Each board listens afresh, after the one before stopped the voice.
              key={`${tutor.id}-${listener()}`}
              tutor={tutor}
              locale={locale}
              onSay={(text) => send(text)}
              onCutIn={setCutIn}
              onError={(text) => onNotify(text, true)}
            />
          ) : null}
          <form
            className="wb-ask"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {pics.map((src, i) => (
              <span className="wb-pic" key={i}>
                <img src={src} alt={`要发送的第 ${i + 1} 张图片`} />
                <button
                  type="button"
                  aria-label={`移除第 ${i + 1} 张图片`}
                  onClick={() => setPics((list) => list.filter((_, j) => j !== i))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {pending.length ? (
              <span className="wb-marks">
                已标 {pending.length} 处
                <button
                  type="button"
                  aria-label="清除我的标记"
                  onClick={() => tutor.clearStrokes()}
                >
                  <Eraser size={13} />
                </button>
              </span>
            ) : null}
            <input
              ref={input}
              aria-label="向页老师提问"
              placeholder={
                mode === 'talk'
                  ? '开口说就行，也可以在这里打字'
                  : state.waiting
                    ? '先问你想知道的，比如：这一步为什么成立？'
                    : busy
                      ? '随时打断：在白板上圈出没懂的地方，再说哪里不懂'
                      : state.blocks.length
                        ? '还有哪里不懂？可以先在白板上圈出来'
                        : '问一道题，比如：用图讲讲二叉树的层序遍历'
              }
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <IconButton
              type="button"
              label="添加图片"
              help="也可以直接粘贴或拖入图片，比如一道题的截图"
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus size={16} />
            </IconButton>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              multiple
              hidden
              onChange={(e) => {
                void addPics(Array.from(e.target.files || []));
                e.target.value = '';
              }}
            />
            {state.waiting && nothing ? (
              <button className="wb-send">
                <Play size={14} />
                直接讲
              </button>
            ) : (
              <button className="wb-send" disabled={nothing}>
                <SendHorizontal size={14} />
                {busy ? '打断提问' : '提问'}
              </button>
            )}
          </form>
        </footer>
      </section>
    </div>
  );
}
