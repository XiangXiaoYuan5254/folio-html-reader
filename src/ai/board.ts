import { useSyncExternalStore } from 'react';
import { chat, errorText, isAbort } from './client';
import { fileName, related, spotContext } from './context';
import type { Where } from './context';
import { seesImages } from './images';
import { language, untrusted } from './prompts';
import { axesShapes, boardColor, dotShapes, graphShapes, svgShapes } from './board-figure';
import type { Axes, ShapeSpec } from './board-figure';
import type { AiConfig, AiProvider, DocText, WireMessage } from './types';
import type { Speaker, VoiceMode } from './voice';

// The whiteboard teacher. The model writes a lesson one command per line (what it says,
// what it writes, what it points at) and the board plays the lines back in order, the
// writing and pointing happening while the sentence before them is being said. The model
// never places anything: the board lays out what is written and works out where circles
// and arrows go, from the ids the model gave.

export type InkColor = 'red' | 'blue' | 'green' | 'orange' | 'yellow';
export type Command =
  | { op: 'say'; text: string }
  | { op: 'title' | 'text' | 'quote'; id: string; text: string }
  | { op: 'math'; id: string; tex: string }
  | { op: 'flow'; id: string; parts: string[] }
  | { op: 'circle' | 'underline' | 'box' | 'mark' | 'point'; target: string; color?: InkColor }
  | { op: 'arrow'; from: string; to: string; label: string; color?: InkColor }
  | { op: 'note'; target: string; text: string; color?: InkColor }
  // A part of the framed picture, as left, top, right, bottom in percent of its size.
  | { op: 'area'; id: string; pic: string; box: [number, number, number, number] }
  // A canvas to draw on, and what goes on it: SVG, axes, graphs and points.
  | { op: 'figure'; id: string; w: number; h: number }
  | { op: 'erase'; targets: string[] }
  // A piece of code; the lines come in a ``` fence after the command line.
  | { op: 'code'; id: string; lang: string; code: string }
  | { op: 'draw'; fig: string; markup: string }
  | { op: 'axes'; fig: string; nums: number[]; equal: boolean }
  | { op: 'axes3d'; fig: string; nums: number[] }
  | {
      op: 'plot' | 'curve3d' | 'surface3d' | 'dot';
      id: string;
      fig: string;
      body: string;
      color?: InkColor;
    };

const colorNames: Record<string, InkColor> = {
  red: 'red',
  红: 'red',
  blue: 'blue',
  蓝: 'blue',
  green: 'green',
  绿: 'green',
  orange: 'orange',
  橙: 'orange',
  yellow: 'yellow',
  黄: 'yellow',
};
const idPattern = /^[A-Za-z][\w-]*(\.\d+)?$/;
const validId = (s: string | undefined) => (s && idPattern.test(s) ? s : '');

// One line of the model's reply. Lines that aren't commands but read like speech are taken
// as speech, so a model that forgets the format still talks.
export function parseLine(raw: string): Command | null {
  const line = raw
    .trim()
    .replace(/^(?:[-*•]\s+|\d+[.)、]\s*)+/, '')
    .replace(/^`+|`+$/g, '')
    .trim();
  if (!line || line.startsWith('```')) return null;
  const match = line.match(/^([A-Za-z][A-Za-z\d]*)(?=\s|[|｜:：]|$)\s*([\s\S]*)$/);
  const prose = () =>
    /\p{L}/u.test(line) && !/[|｜]/.test(line) && !line.startsWith('#')
      ? ({ op: 'say', text: line.replace(/\*\*/g, '') } as const)
      : null;
  if (!match) return prose();
  const op = match[1].toLowerCase();
  const rest = match[2].trim();
  if (op === 'say') {
    const text = rest.replace(/^[|｜:：]\s*/, '').trim();
    return text ? { op, text } : null;
  }
  const bar = rest.search(/[|｜]/);
  let head = (bar === -1 ? rest : rest.slice(0, bar)).trim().split(/\s+/).filter(Boolean);
  let body = bar === -1 ? '' : rest.slice(bar + 1).trim();
  const color = (word?: string) => (word ? colorNames[word.toLowerCase()] : undefined);
  const block = op === 'title' || op === 'text' || op === 'quote' || op === 'math' || op === 'flow';
  // “text t1 内容” without the bar.
  if (block && bar === -1 && head.length > 1) {
    body = rest.slice(head[0].length).trim();
    head = [head[0]];
  }
  switch (op) {
    case 'code':
      return { op, id: validId(head[0]), lang: head[1] || '', code: body };
    case 'erase': {
      const targets = [...head, ...body.split(/[\s,，]+/)].filter((t) => validId(t));
      return targets.length ? { op, targets } : null;
    }
    case 'figure': {
      const [w = 600, h = 360] = (body.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      return { op, id: validId(head[0]), w: clamp(w, 120, 1600), h: clamp(h, 80, 1200) };
    }
    case 'draw': {
      // “draw g1 <rect …/>” without the bar.
      const markup = bar === -1 ? rest.slice((head[0] || '').length).trim() : body;
      return validId(head[0]) && markup.includes('<') ? { op, fig: head[0], markup } : null;
    }
    case 'axes':
    case 'axes3d': {
      const text = `${head.slice(1).join(' ')} ${body}`;
      const nums = (text.match(/-?\d*\.?\d+/g) || []).map(Number);
      if (!validId(head[0]) || nums.length < (op === 'axes' ? 4 : 6)) return null;
      return op === 'axes'
        ? { op, fig: head[0], nums, equal: /equal|等比/.test(text) }
        : { op, fig: head[0], nums };
    }
    case 'plot':
    case 'curve3d':
    case 'surface3d':
    case 'dot': {
      const tint = color(head[head.length - 1]);
      const ids = tint ? head.slice(0, -1) : head;
      const [id, fig] = ids.length > 1 ? ids : ['', ids[0]];
      return validId(fig) && body ? { op, id: validId(id), fig, body, color: tint } : null;
    }
    case 'title':
    case 'text':
    case 'quote':
      return body ? { op, id: validId(head[0]), text: body } : null;
    case 'math': {
      const tex = body.replace(/^\$+|\$+$/g, '').trim();
      return tex ? { op, id: validId(head[0]), tex } : null;
    }
    case 'flow': {
      const parts = body
        .split(/\s*(?:->|→|=>)\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length ? { op, id: validId(head[0]), parts: parts.slice(0, 6) } : null;
    }
    case 'circle':
    case 'underline':
    case 'box':
    case 'mark':
    case 'point':
      return validId(head[0]) ? { op, target: head[0], color: color(head[1]) } : null;
    case 'arrow':
      return validId(head[0]) && validId(head[1])
        ? { op, from: head[0], to: head[1], label: body, color: color(head[2]) }
        : null;
    case 'note':
      return validId(head[0]) && body
        ? { op, target: head[0], text: body, color: color(head[1]) }
        : null;
    case 'area': {
      let box = (body || head.slice(1).join(' '))
        .split(/[\s,，%]+/)
        .filter(Boolean)
        .map(Number);
      if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) return null;
      // Fractions of the picture rather than percent.
      if (box.every((v) => v <= 1)) box = box.map((v) => v * 100);
      const [l, t, r, b] = box.map((v) => clamp(v, 0, 100));
      return r - l >= 2 && b - t >= 2
        ? { op, id: validId(head[0]), pic: validId(head[1]), box: [l, t, r, b] }
        : null;
    }
  }
  return prose();
}

// [[id:part]] marks a part of a line or formula the teacher may point at later. Parts can
// sit inside parts (a whole denominator, and its exponent); brackets without an id, which
// models sometimes write for emphasis, are dropped.
type Mark = { id?: string; text: string } | string;
function marks(text: string): Mark[] {
  const out: Mark[] = [];
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf('[[', at);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let j = start; j < text.length;) {
      if (text.startsWith('[[', j)) {
        depth++;
        j += 2;
      } else if (text.startsWith(']]', j)) {
        j += 2;
        if (--depth === 0) {
          end = j;
          break;
        }
      } else j++;
    }
    if (end === -1) break;
    if (start > at) out.push(text.slice(at, start));
    const body = text.slice(start + 2, end - 2);
    const m = body.match(/^([A-Za-z][\w-]*)\s*[:：]\s*([\s\S]*)$/);
    out.push(m ? { id: m[1], text: m[2] } : { text: body });
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
// Rewrites every marked part, innermost first.
function mapMarks(text: string, wrap: (id: string, inner: string) => string): string {
  return marks(text)
    .map((m) => {
      if (typeof m === 'string') return m;
      const inner = mapMarks(m.text, wrap);
      return m.id ? wrap(m.id, inner) : inner;
    })
    .join('');
}
export const plainText = (text: string) => mapMarks(text, (_, inner) => inner);
// KaTeX writes \htmlData{ref=qk}{…} as an element with data-ref="qk".
export const texWithRefs = (tex: string) =>
  mapMarks(tex, (ref, inner) => `\\htmlData{ref=${ref}}{${inner}}`);
function partsOf(text: string) {
  const parts: { id: string; text: string }[] = [];
  mapMarks(text, (id, inner) => {
    parts.push({ id, text: inner });
    return inner;
  });
  return parts;
}

export type Piece = { text: string } | { math: string };
export type Segment = { ref?: string; pieces: Piece[] };
// Typed arrows written as arrows.
const arrows = (text: string) => text.replace(/<->/g, '↔').replace(/->/g, '→').replace(/=>/g, '⇒');
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(/\$([^$\n]+?)\$|\\\((.+?)\\\)/g)) {
    if (m.index! > last) out.push({ text: arrows(text.slice(last, m.index)) });
    out.push({ math: m[1] ?? m[2] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: arrows(text.slice(last)) });
  return out;
}
// A line of writing in pieces; parts inside parts of a line can't be pointed at on their own.
export function segments(text: string): Segment[] {
  return marks(text).map((m) =>
    typeof m === 'string'
      ? { pieces: pieces(m) }
      : { ...(m.id ? { ref: m.id } : {}), pieces: pieces(plainText(m.text)) },
  );
}

export type Block =
  | { kind: 'title' | 'text' | 'quote'; id: string; text: string; dur: number }
  | { kind: 'math'; id: string; tex: string; dur: number }
  | { kind: 'flow'; id: string; parts: string[]; dur: number }
  // The student's question, written above the answer to it.
  | { kind: 'asked'; id: string; text: string; dur: number }
  // The region of the page the student framed, at the top of the board.
  | { kind: 'picture'; id: string; src: string; dur: number }
  | { kind: 'code'; id: string; lang: string; code: string; dur: number }
  // A canvas the teacher draws on; `shapes` grows as the lesson goes on.
  | { kind: 'figure'; id: string; w: number; h: number; dur: number; shapes: Shape[] };
// One element of a drawing, with when it is drawn after it appears.
export type Shape = ShapeSpec & { key: string; delay: number; dur: number };
type FigureBlock = Extract<Block, { kind: 'figure' }>;
export type Ink =
  | {
      // A point is where the teacher is pointing now: there is only ever one.
      kind: 'circle' | 'underline' | 'box' | 'mark' | 'point';
      key: string;
      target: string;
      color: InkColor;
      dur: number;
    }
  | {
      kind: 'arrow';
      key: string;
      from: string;
      to: string;
      label: string;
      color: InkColor;
      dur: number;
    }
  | {
      kind: 'note';
      key: string;
      id: string;
      target: string;
      text: string;
      color: InkColor;
      dur: number;
    }
  // Not drawn: a part of the picture the teacher can then point at.
  | {
      kind: 'area';
      key: string;
      id: string;
      target: string;
      box: [number, number, number, number];
      color: InkColor;
      dur: number;
    };
// The student's pen strokes, as flat x,y lists in board coordinates.
export type Stroke = { id: string; points: number[]; sent: boolean };
export type TutorState = {
  blocks: Block[];
  inks: Ink[];
  strokes: Stroke[];
  // The sentence being said; `dur` is how long saying it takes. A live voice's words are
  // shown even while the next answer is being thought of.
  caption: { key: number; text: string; dur: number; live?: boolean } | null;
  transcript: { who: 'teacher' | 'student'; text: string }[];
  phase: 'thinking' | 'teaching' | 'idle' | 'error';
  // A board on a selection or picture waits for the student's question, or for them to let
  // the teacher go ahead, before the first lesson.
  waiting?: boolean;
  paused: boolean;
  speed: number;
  error?: string;
  // What was just written or pointed at, so the board can keep it in view.
  focus: { ref: string; n: number } | null;
  // What the teacher's pencil goes along: a block of writing (its id), the shapes one
  // drawing command added (their key, before the dot), or a mark (its key).
  pen: { kind: 'block' | 'shapes' | 'ink'; key: string; n: number } | null;
  // Things the teacher wiped off: they fade out and keep their place.
  erased: string[];
};

const defaultColor: Record<string, InkColor> = {
  circle: 'red',
  underline: 'blue',
  box: 'green',
  mark: 'yellow',
  point: 'yellow',
  arrow: 'orange',
  note: 'red',
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// How long writing or drawing each thing takes at normal speed, in ms.
function drawTime(cmd: Command) {
  switch (cmd.op) {
    case 'title':
      return clamp(plainText(cmd.text).length * 85, 500, 2200);
    case 'text':
      return clamp(plainText(cmd.text).length * 55, 450, 2600);
    case 'quote':
      return clamp(plainText(cmd.text).length * 30, 450, 2200);
    case 'math':
      return clamp(700 + cmd.tex.length * 14, 900, 2600);
    case 'flow':
      return 450 * cmd.parts.length + 250;
    case 'circle':
      return 750;
    case 'underline':
      return 450;
    case 'box':
      return 850;
    case 'mark':
      return 550;
    case 'point':
      return 300;
    case 'arrow':
      return 800;
    case 'note':
      return clamp(400 + cmd.text.length * 45, 700, 2200);
    case 'figure':
      return 250;
    case 'erase':
      return 450;
    case 'code':
      return clamp(cmd.code.length * 16, 500, 4500);
    case 'draw': {
      const parts = cmd.markup.match(
        /<(path|line|polyline|polygon|rect|circle|ellipse|text|arrow)\b/gi,
      );
      return clamp((parts?.length || 1) * 420, 400, 4000);
    }
    case 'axes':
    case 'axes3d':
      return 900;
    case 'plot':
      return 1400;
    case 'curve3d':
      return 1800;
    case 'surface3d':
      return 2400;
    case 'dot':
      return 450;
    default:
      return 0;
  }
}
// Speaking pace: about 5.5 Chinese characters a second.
const charsPerSecond = 5.5;
// A point or graph as the board keeps it ("dot 1 1 | A", "plot x^2"), in words.
function plotWords(text: string) {
  const dot = text.match(/^dot\s+([^|]*?)\s*(?:\|\s*(.+))?$/);
  if (dot) return dot[2] ? `点 ${dot[2].trim()}` : `点 (${dot[1].trim().split(/\s+/).join(', ')})`;
  const graph = text.match(/^(?:plot|curve3d|surface3d)\s+(.+)$/);
  return graph ? `图像 ${graph[1].trim()}` : text;
}
// What a command puts on the board, in a few words, for a voice that teaches in its own
// words; `what` names what an id points at, '' when it isn't known.
function commandNote(cmd: Command, what: (ref: string) => string) {
  const at = (ref: string) => (what(ref) ? `「${clip(what(ref), 40)}」` : '刚写的内容');
  switch (cmd.op) {
    case 'title':
    case 'text':
    case 'quote':
      return `写出「${clip(cmd.text, 60)}」`;
    case 'math':
      return `写出公式 ${clip(cmd.tex, 80)}`;
    case 'flow':
      return `画出流程：${cmd.parts.map((p) => clip(p, 20)).join(' → ')}`;
    case 'circle':
      return `圈出${at(cmd.target)}`;
    case 'underline':
      return `在${at(cmd.target)}下面划线`;
    case 'box':
      return `框出${at(cmd.target)}`;
    case 'mark':
      return `标亮${at(cmd.target)}`;
    case 'point':
      return `指着${at(cmd.target)}`;
    case 'arrow':
      return `从${at(cmd.from)}画箭头指向${at(cmd.to)}${cmd.label ? `，写着「${clip(cmd.label, 30)}」` : ''}`;
    case 'note':
      return `在旁边注上「${clip(cmd.text, 40)}」`;
    case 'area':
      return '框出图里的一部分';
    case 'draw':
      return '在图里画图';
    case 'axes':
    case 'axes3d':
      return '画坐标系';
    case 'plot':
    case 'curve3d':
    case 'surface3d':
      return `画出 ${clip(cmd.body, 60)}`;
    case 'dot':
      return `标出${plotWords(`dot ${cmd.body}`)}`;
    case 'erase':
      return '擦掉一部分板书';
    case 'code':
      return `写出一段${cmd.lang ? ` ${cmd.lang} ` : ''}代码`;
    default:
      return '';
  }
}
// The end of what a voice is saying, as much as fits in the caption.
function captionTail(text: string) {
  if (text.length <= 90) return text;
  const tail = text.slice(-90);
  const stop = tail.search(/[。！？!?]/);
  return stop >= 0 && stop < tail.length - 1 ? tail.slice(stop + 1).trim() : tail;
}
const clip = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export type LessonKind = 'text' | 'picture' | 'blank';
export function tutorSystem(config: AiConfig, kind: LessonKind = 'text', voice: VoiceMode = 'off') {
  const asked = {
    text: '学生读文档时选中了一段内容请你讲解。',
    picture: '学生读文档时框选了一块区域（公式、图表或一段排版）请你讲解，框选的画面就是附图。',
    blank: '学生会直接问你问题，可能附上题目的图片。',
  }[kind];
  return [
    `你是「页间」里的白板老师，名字叫页老师，学生也这样称呼你。${asked}你要像站在白板前的老师：一边说，一边在白板上写写画画，把它讲明白。`,
    '',
    '## 输出格式',
    '只输出下面的指令，每行一条。不要输出其他文字，不要用代码块。',
    '',
    voice === 'off' ? '说话（学生看到的字幕）：' : '说话（会用语音读出来，同时显示为字幕）：',
    'say 要说的话',
    '',
    '写字（白板从上往下自动排版，你不用、也不能指定位置）：',
    'title 编号 | 小标题',
    'text 编号 | 一行板书，可以含行内公式 $x^2$',
    'math 编号 | 单独一行的 LaTeX 公式',
    'quote 编号 | 从文档逐字摘录的原文',
    'flow 编号 | 第一步 -> 第二步 -> 第三步      （只用于一条直线的几个步骤）',
    'code 编号 语言              写一段代码：这一行之后紧跟用 ``` 包起来的代码，缩进照原样保留。代码一定用 code 写，不要用 text 一行行写。',
    '                            之后用 编号.行号 指某一行，例如 underline c1.3、circle c1.5、note c1.5 | 负数计数。',
    '',
    '画图（结构图、示意图、数组、链表、树、图、几何图形、简笔画……需要图时就画，不要用 flow 或文字硬凑）：',
    'figure 编号 | 宽 高          新建一块画布放在白板上，宽最多 640、高最多 480，画布内坐标原点在左上角',
    'draw 画布编号 | SVG 元素      往画布里画，可用 path line polyline polygon rect circle ellipse text；',
    '                            箭头写 <arrow x1="" y1="" x2="" y2=""/>，拐弯的箭头写 <arrow points="x1 y1 x2 y2 x3 y3"/>',
    '- 边说边画：每句 say 后面只 draw 这句话说到的一两个元素（一行 draw 可以写几个元素），一张图分几句话画完。',
    '- 颜色写 stroke="red|blue|green|orange"（文字写 fill），不写就是粉笔色；形状默认空心。<text> 里只写纯文字，不能写 LaTeX。',
    '- 画之前先想好布局，元素之间留出空隙，文字不要压在线上。',
    '- 以后要指着讲的元素加 id，例如 <rect id="n1" …/>，之后可以 circle n1、arrow n1 n2。',
    '',
    '数学图像（写表达式就行，不用自己算点）：',
    'axes 画布编号 | x 最小 最大 y 最小 最大 [equal]      二维坐标轴；equal 让 x、y 等比例（画圆、几何时用）',
    'plot [编号] 画布编号 | 表达式                        y 关于 x 的函数，例如 plot c1 g1 | x^2 - 1',
    'plot [编号] 画布编号 | x(t), y(t) | t 起 止          平面参数曲线',
    'axes3d 画布编号 | x 最小 最大 y 最小 最大 z 最小 最大    空间直角坐标系（课本画法：x 轴朝左下，y 轴朝右，z 轴朝上）',
    'curve3d [编号] 画布编号 | x(t), y(t), z(t) | t 起 止   空间曲线',
    'surface3d [编号] 画布编号 | x(u,v), y(u,v), z(u,v) | u 起 止 | v 起 止    曲面，画成网格',
    'dot [编号] 画布编号 | 坐标 | 标签                     在坐标系里标一个点：二维写 x y，三维写 x y z',
    '表达式可用 + - * / ^、sin cos tan exp ln sqrt abs、pi，例如 e^(-t)*cos(3t)。这几条指令可以在画布编号后加颜色；同一块画布里也可以再 draw 文字和箭头做标注。',
    '',
    '在写好、画好的内容上标注：',
    'circle 目标            圈出来',
    'underline 目标         在下面划线',
    'box 目标               框起来',
    'mark 目标              用荧光笔涂',
    'point 目标             指着正在讲的地方（像激光笔，同一时间只有一处，下一次 point 时上一处自动消失）。逐行讲代码、一步步推导时用它，不要每行都 underline。',
    'arrow 目标A 目标B | 箭头上的字（可省略）',
    'note 目标 | 旁注        写在右侧空白处，连线到目标',
    'erase 目标 [目标…]      擦掉写过或画过的东西。演示指针移动、箭头反向、数值变化时，先擦掉旧的再画新的，别让新旧叠在一起。',
    '',
    '目标写编号。text、math、quote 里以后要单独指着讲的部分，写的时候用 [[片段编号:内容]] 标出来（编号和冒号不能省）：',
    'text t2 | 输出 = [[w:权重]] × [[v:内容]]',
    'math m1 | \\mathrm{softmax}\\left(\\frac{[[qk:QK^\\top]]}{[[dk:\\sqrt{d_k}]]}\\right)V',
    '之后就能 circle qk、underline w。flow 的各个框依次是 编号.1、编号.2……',
    '标注指令末尾可以加颜色：red、blue、green、orange。',
    '',
    kind === 'picture'
      ? '白板最上方已经放好了学生框选的图，编号 img。学生之后发来的图片也会放到白板上，编号 img2、img3……（会告诉你）。'
      : '学生发来的图片会放到白板上，编号 img、img2……（会告诉你）。',
    '要指着图片里的某一部分讲，先用 area 标出它在图中的位置，再圈它：',
    'area 编号 [图片编号] | 左 上 右 下    （图中的百分比位置，0～100；不写图片编号就是最近的一张）',
    '只在确定位置时用 area；不确定就 circle 整张图，并在 say 里说清是哪部分。图里的公式要讲时，用 math 重新写出来再标注。',
    '',
    '## 怎么讲',
    '- 先 say，再写或画这句话提到的东西，就像边说边写。每句 say 口语化，不超过 40 字。',
    '- 板书要精炼：关键词、公式、例子。不要把 say 的话抄到白板上。能画图就画图：示意图、结构图、函数图像、空间图形比文字直观得多。',
    kind === 'blank'
      ? '- 讲题时先把题目的已知和要求写清楚，再一步步推，关键步骤配图；最后一句话总结思路。'
      : '- 先用一两句说清这段在讲什么（可以先 quote 原文最关键的一句），再拆开讲关键概念，必要时举个具体例子或代入数字，最后一句话总结。\n' +
        '- 学生一开始就带着问题来（第一条消息里有「我的问题」）时，围绕这个问题讲：需要的背景一两句交代，不要把这段内容从头到尾讲一遍，句数按问题需要来。',
    '- 第一次讲 6～15 句 say。多用 circle、underline 指着你正在说的地方；arrow 用来连接上下相邻或同一行的两样东西，箭头上的字要短（不超过 6 个字）。',
    '- 最后一句 say 问学生哪里还不清楚。',
    '- 编号用字母加数字（t1、m2、g1、qk），整块白板不重复。只能标注已经写出来的编号。公式用 KaTeX 支持的 LaTeX。',
    '- 学生打断你时，会告诉你他在白板上圈了或划了哪里、你讲到了哪里。直接回应：先指着他标的地方（circle 或 underline），换一种说法讲，必要时在下面写新的板书或画图；不要从头重讲，讲完问他懂了没有。',
    ...(voice === 'off'
      ? []
      : [
          '- say 的话会被朗读出来，只写念得出来的口语：不要写公式、LaTeX、代码和特殊符号，数学式说读法（「x 的平方」「根号 d k」「QK 转置」），公式本身写在白板上；英文术语照常说（softmax 就说 softmax）。',
        ]),
    ...(voice === 'talk'
      ? [
          '- 学生在和你语音对话，像面对面说话：每次回答短一些，一句 say 只说一个意思。他说的话标了「语音」的，是语音识别转成的文字，可能有同音字或断句错误（比如「公式」认成「公司」、「分母」认成「父母」），按上下文理解，不用指出。',
          '- 他只说「懂了」「好的」「嗯」之类时，用一两句话回应，问他要不要继续往下讲或者换个地方问，不要重讲。',
        ]
      : []),
    language(config.prefs),
    untrusted,
    '',
    '## 示例（只示范格式）',
    'say 这句话的核心，其实是一个加权平均。',
    'text t1 | 输出 = [[w:权重]] × [[v:内容]] 再求和',
    'underline t1',
    'say 权重越大，这个词对结果的影响就越大。',
    'circle w red',
    'note w | 所有权重加起来等于 1',
    'say 我们画一个数组，看指针怎么走。',
    'figure g1 | 420 130',
    'draw g1 | <rect id="c0" x="20" y="20" width="60" height="60"/><text x="50" y="58" text-anchor="middle">3</text><rect x="80" y="20" width="60" height="60"/><text x="110" y="58" text-anchor="middle">7</text>',
    'say 指针 i 从最左边开始。',
    'draw g1 | <arrow id="i0" x1="50" y1="120" x2="50" y2="88" stroke="red"/><text id="i0t" x="58" y="120" fill="red">i</text>',
    'circle c0',
    'say i 往右走一格。',
    'erase i0 i0t',
    'draw g1 | <arrow id="i1" x1="110" y1="120" x2="110" y2="88" stroke="red"/><text id="i1t" x="118" y="120" fill="red">i</text>',
  ].join('\n');
}
type Spot = { opening: string; around: string };
function documentPart(context: Spot | null, where: string) {
  if (!context) return [];
  return [
    context.opening ? `文档开头（全文在讲什么）：\n<opening>\n${context.opening}\n</opening>` : '',
    context.around
      ? `${context.opening ? `${where}前后的原文` : '文档全文'}：\n<context>\n${context.around}\n</context>`
      : '',
  ];
}
function pictureIntro(title: string, context: Spot | null, where: Where) {
  const place = where.page ? `第 ${where.page} 页框选的区域` : '框选的区域';
  return [
    `我在读《${title}》。`,
    ...documentPart(context, place),
    where.inside
      ? `框选区域里的文字（从页面文字层取出，公式符号可能错乱，以附图为准）：\n<inside>\n${where.inside}\n</inside>`
      : '',
    `我${where.page ? `在第 ${where.page} 页` : ''}框选了文档里的一块区域，就是附图。图里的符号、术语在原文里有定义的，按原文的定义讲。`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
function firstPrompt(title: string, context: Spot | null, selection: string) {
  return [
    `我在读《${title}》。`,
    ...documentPart(context, '选中部分'),
    `我选中的内容：\n<selection>\n${selection}\n</selection>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
// Asked for when the student lets the teacher go ahead without a question of their own.
const teachAll = {
  text: '请在白板上给我讲解我选中的这部分。',
  picture: '请结合上下文在白板上给我讲解图里的内容。',
};

// A board as a section of a document's note: a picture of it (or, without one, what was
// written on it), then the talk. The link at the top opens the board again.
export function boardNote(
  entry: BoardEntry,
  state: Pick<TutorState, 'blocks' | 'inks' | 'transcript' | 'erased'>,
  picture = '',
) {
  const gone = new Set(state.erased);
  const blocks = state.blocks.filter((b) => !gone.has(b.id));
  // Side notes go under the line they point at.
  const notes = new Map<string, string[]>();
  const owner = (target: string) =>
    blocks.find(
      (b) =>
        b.id === target ||
        target.startsWith(b.id + '.') ||
        ('text' in b && b.text.includes(`[[${target}:`)) ||
        (b.kind === 'math' && b.tex.includes(`[[${target}:`)) ||
        (b.kind === 'figure' && b.shapes.some((x) => x.ref === target)),
    )?.id || '';
  for (const i of state.inks)
    if (i.kind === 'note' && !gone.has(i.id)) {
      const at = owner(i.target);
      notes.set(at, [...(notes.get(at) || []), plainText(i.text)]);
    }
  const written: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'title') written.push(`#### ${plainText(b.text)}`);
    else if (b.kind === 'text') written.push(`- ${plainText(b.text)}`);
    else if (b.kind === 'quote') written.push(`> ${plainText(b.text)}`);
    else if (b.kind === 'math') written.push(`$$${plainText(b.tex)}$$`);
    else if (b.kind === 'flow') written.push(`- ${b.parts.map(plainText).join(' → ')}`);
    else if (b.kind === 'code') written.push('```' + b.lang, b.code, '```');
    else if (b.kind === 'asked') written.push(`**问：${b.text}**`);
    else if (b.kind === 'figure') written.push('- （一张图，在白板里看）');
    else continue;
    for (const n of notes.get(b.id) || []) written.push(`  - 旁注：${n}`);
  }
  for (const n of notes.get('') || []) written.push(`- 旁注：${n}`);
  // The teacher's sentences run together into one paragraph per answer.
  const talk: string[] = [];
  for (const line of state.transcript) {
    if (line.who === 'student') talk.push(`**我：${line.text}**`);
    else if (talk.length && !talk[talk.length - 1].startsWith('**'))
      talk[talk.length - 1] += line.text;
    else talk.push(line.text);
  }
  const date = new Date(entry.updatedAt).toLocaleDateString('zh-CN');
  const from = entry.source
    ? `来自 ${fileName(entry.source)}${entry.page ? ` 第 ${entry.page} 页` : ''} · `
    : '';
  return [
    `## 白板：${entry.title}（${date}）`,
    '',
    `${from}[在白板中打开](folio-board:${entry.id})`,
    ...(picture
      ? ['', `![白板：${entry.title.replace(/[[\]]/g, '')}](note-image:${picture})`]
      : written.length
        ? ['', '### 板书', '', ...written]
        : []),
    ...(talk.length ? ['', '### 讲解', '', talk.join('\n\n')] : []),
  ].join('\n');
}
// The note with a board's section in it: replacing the one saved from the same board
// before (`replaced`), or else added at the end.
export function withBoardNote(note: string, id: string, section: string) {
  const lines = note.split('\n');
  const link = `(folio-board:${id})`;
  const at = lines.findIndex(
    (l, i) => /^## /.test(l) && lines.slice(i + 1, i + 4).some((x) => x.includes(link)),
  );
  if (at === -1)
    return { note: note.trim() ? `${note.trimEnd()}\n\n${section}` : section, replaced: '' };
  let next = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (next === -1) next = lines.length;
  const rest = next === lines.length ? [] : ['', ...lines.slice(next)];
  return {
    note: [...lines.slice(0, at), ...section.split('\n'), ...rest].join('\n'),
    replaced: lines.slice(at, next).join('\n'),
  };
}

type Ref = { label: string; text: string; parent?: string };
// A lesson as it is kept in the project, to open again and go on asking.
export type BoardEntry = {
  id: string;
  title: string;
  // The document it was about; empty for a blank board.
  source: string;
  // The PDF page a framed region was on.
  page?: number;
  kind: LessonKind;
  createdAt: number;
  updatedAt: number;
  questions: number;
};
export type SavedBoard = {
  version: 1;
  id: string;
  selection: string;
  picture?: string;
  intro: string;
  turns: WireMessage[];
  state: Pick<TutorState, 'blocks' | 'inks' | 'strokes' | 'transcript' | 'erased' | 'speed'>;
  refs: [string, Ref][];
  alias: [string, string][];
  axes: [string, Axes][];
  pictures: string[];
  counter: number;
};
// A sentence being made ready to be said out loud.
type Sound = { id: string; ms: Promise<number> };
type Options = {
  selection: string;
  // The document the lesson is about, kept with the saved board.
  source?: string;
  // Keeps the board in the project; called after each answer, drawing and on closing.
  save?: (entry: BoardEntry, board: SavedBoard) => Promise<void>;
  // A board saved earlier, to carry on with.
  restore?: { entry: BoardEntry; board: SavedBoard };
  // A framed region of the page to explain instead of selected text, as a data: URL.
  picture?: string;
  // Where the region was framed, and the text the page has there.
  where?: Where;
  docText: () => Promise<DocText>;
  // Settings and consent, as the other AI features check them.
  ready: () => Promise<{ provider: AiProvider; config: AiConfig }>;
};

export class Tutor {
  private state: TutorState = {
    blocks: [],
    inks: [],
    strokes: [],
    caption: null,
    transcript: [],
    phase: 'thinking',
    paused: false,
    speed: 1,
    focus: null,
    pen: null,
    erased: [],
  };
  private listeners = new Set<() => void>();
  private turns: WireMessage[] = [];
  // Each request (the lesson, then each question) is a run; interrupting starts a new one.
  private run = 0;
  private controller: AbortController | null = null;
  private queue: { cmd: Command; raw: string; sound?: Sound }[] = [];
  private buffer = '';
  private streaming = false;
  private failure = '';
  // The lines of the current reply that reached the board, which is what the model is told
  // it said when the student interrupts.
  private played: string[] = [];
  private turnOpen = false;
  private saying = '';
  // Playback runs on a clock that stops while paused.
  private speechEnd = 0;
  private drawEnd = 0;
  private pausedAt = 0;
  private pausedFor = 0;
  private waiters = new Set<() => void>();
  private refs = new Map<string, Ref>();
  // Each canvas's coordinate system, once axes are drawn on it.
  private axes = new Map<string, Axes>();
  // Pictures on the board, oldest first: the framed region, then ones the student sent.
  private pictures: string[] = [];
  private kind: LessonKind;
  private alias = new Map<string, string>();
  private counter = 0;
  private asked = '';
  // What the first request starts with: the document and what was selected or framed. It
  // goes with the first question, or with every question until a lesson got through.
  private intro = '';
  // Getting the board ready (reading the document for the intro).
  private opening: Promise<void> | null = null;
  private retryLast: (() => void) | null = null;
  private disposed = false;
  // The teacher's voice, when the lesson is said out loud, and the sentence being said.
  private voice: VoiceMode = 'off';
  private speaker: Speaker | null = null;
  private voiceDone: Promise<void> | null = null;
  // Stops putting what a live voice says in the caption and transcript.
  private unspeak: (() => void) | null = null;
  // Paused with the voice too, not just the board while the student talks to it.
  private voicePaused = false;
  // The sentence the commands being read belong to, and what they put on the board, for a
  // voice that teaches in its own words.
  private lastSay = '';
  private lastNote = '';
  private written = new Map<string, string>();
  readonly id: string;
  private createdAt = Date.now();
  constructor(private options: Options) {
    this.kind = options.picture ? 'picture' : options.selection ? 'text' : 'blank';
    this.id = crypto.randomUUID();
    const saved = options.restore;
    if (!saved) return;
    const { entry, board } = saved;
    this.id = entry.id;
    this.kind = entry.kind;
    this.createdAt = entry.createdAt;
    this.intro = board.intro;
    this.turns = board.turns;
    this.refs = new Map(board.refs);
    this.alias = new Map(board.alias);
    this.axes = new Map(board.axes);
    this.pictures = board.pictures;
    this.counter = board.counter;
    // Everything already on the board is there at once, not written out again.
    const still = board.state;
    const said = [...still.transcript].reverse().find((l) => l.who === 'teacher');
    this.state = {
      ...this.state,
      ...still,
      blocks: still.blocks.map((b) =>
        b.kind === 'figure'
          ? { ...b, dur: 0, shapes: b.shapes.map((x) => ({ ...x, delay: 0, dur: 0 })) }
          : { ...b, dur: 0 },
      ),
      inks: still.inks.map((i) => ({ ...i, dur: 0 })),
      strokes: still.strokes.map((x) => ({ ...x, sent: true })),
      caption: said ? { key: ++this.counter, text: said.text, dur: 0 } : null,
      phase: 'idle',
      // Kept before its first lesson (for the marks on it): it still waits.
      waiting: this.kind !== 'blank' && !board.turns.length,
    };
  }
  // What the list of saved boards calls this one.
  private title() {
    const first = this.state.transcript.find((l) => l.who === 'student')?.text;
    // A framed region is named by what the teacher headed the board with.
    const heading = this.state.blocks.find((b) => b.kind === 'title');
    const text =
      this.kind === 'text'
        ? this.options.selection
        : this.kind === 'picture'
          ? (heading && 'text' in heading && plainText(heading.text)) || first || '框选的区域'
          : first || '空白白板';
    return clip(text, 60);
  }
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleSave(ms = 800) {
    if (!this.options.save) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), ms);
  }
  saveNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const s = this.state;
    // A board nobody asked anything on isn't worth keeping.
    if (!this.options.save || (!s.transcript.length && !s.strokes.length)) return Promise.resolve();
    const entry = this.entry();
    const board: SavedBoard = {
      version: 1,
      id: this.id,
      selection: this.options.selection,
      ...(this.options.picture ? { picture: this.options.picture } : {}),
      intro: this.intro,
      // A reply still coming in is saved as far as it got.
      turns: this.turnOpen
        ? [
            ...this.turns,
            { role: 'assistant', content: this.played.join('\n') || '（还没开始讲）' },
          ]
        : this.turns,
      state: {
        blocks: s.blocks,
        inks: s.inks,
        strokes: s.strokes,
        transcript: s.transcript,
        erased: s.erased,
        speed: s.speed,
      },
      refs: [...this.refs],
      alias: [...this.alias],
      axes: [...this.axes],
      pictures: this.pictures,
      counter: this.counter,
    };
    return this.options.save(entry, board);
  }
  // How the list of saved boards shows this one.
  entry(): BoardEntry {
    const s = this.state;
    const page = this.options.restore?.entry.page ?? this.options.where?.page;
    return {
      id: this.id,
      title: this.title(),
      source: this.source,
      ...(page ? { page } : {}),
      kind: this.kind,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      questions: s.transcript.filter((l) => l.who === 'student').length,
    };
  }
  // The document's text, read once for the lesson and the questions after it.
  private text: Promise<DocText | null> | null = null;
  private docText() {
    return (this.text ||= this.options.docText().catch(() => null));
  }
  // Parts of the document a question may be about beyond what the lesson started from, such
  // as a definition in another section.
  private async passages(question: string) {
    if (!this.source) return '';
    const doc = await this.docText();
    const found = doc ? related(doc, question, 1_600, this.intro) : [];
    if (!found.length) return '';
    return `文档里可能和这个问题有关的其他段落（按关键词找的，不一定相关）：\n<passages>\n${found
      .map((c) => `【${c.label}】\n${c.text}`)
      .join('\n\n')}\n</passages>`;
  }
  get source() {
    return this.options.restore?.entry.source ?? this.options.source ?? '';
  }
  private addPicture(src: string, label: string): Block {
    const id = this.pictures.length ? `img${this.pictures.length + 1}` : 'img';
    this.pictures.push(id);
    this.refs.set(id, { label, text: '' });
    return { kind: 'picture', id, src, dur: 400 };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.state;
  private set(patch: Partial<TutorState> | ((s: TutorState) => TutorState)) {
    this.state = typeof patch === 'function' ? patch(this.state) : { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // Gets the board ready: the picture goes up and the document is read, then it waits for
  // the student (a blank board for their first question).
  start() {
    return (this.opening ||= this.open());
  }
  private async open() {
    const { picture, selection } = this.options;
    if (this.options.restore) return;
    if (this.kind === 'blank') return this.set({ phase: 'idle' });
    if (picture) this.set({ blocks: [this.addPicture(picture, '框选的图')] });
    const doc = await this.docText();
    const title = doc?.title || (doc ? fileName(doc.path) : '') || '文档';
    const where = this.options.where || {};
    this.intro = picture
      ? pictureIntro(title, doc && spotContext(doc, where), where)
      : firstPrompt(title, doc && spotContext(doc, { inside: selection }), selection);
    // Unless they asked already.
    if (!this.disposed && !this.state.transcript.length) this.set({ phase: 'idle', waiting: true });
  }
  // The student lets the teacher go ahead without a question: the whole selection or
  // picture is explained.
  teach() {
    if (!this.state.waiting) return;
    const { picture, selection } = this.options;
    this.set({ waiting: false });
    this.speaker?.asked?.(picture ? '框选的这张图' : `「${clip(selection, 200)}」`, 'start');
    void this.request(
      () => `${this.intro}\n\n${picture ? teachAll.picture : teachAll.text}`,
      undefined,
      picture ? [picture] : undefined,
    );
  }
  // The student interrupts or asks after the lesson. `marks` says what their strokes point
  // at; `capture` takes a picture of the board with the strokes on it.
  ask(
    question: string,
    marks: string[],
    strokeIds: string[],
    capture?: () => Promise<string | null>,
    pictures: string[] = [],
    // Said out loud rather than typed, and written down by speech recognition.
    spoken = false,
  ) {
    const q = question.trim();
    const cut =
      this.turnOpen && this.saying && (this.queue.length || this.streaming || this.speaking())
        ? `你正在讲“${this.saying}”${this.speaking() ? '（这句还没说完）' : ''}的时候`
        : '';
    // A voice that teaches in its own words: what it actually said, which the model is told.
    const spokenLately = this.speaker?.live
      ? this.state.transcript
          .filter((l) => l.who === 'teacher')
          .slice(-2)
          .map((l) => l.text)
          .join(' ')
      : '';
    // The first question on a selection or picture: the lesson starts with it.
    const first = !!this.state.waiting;
    if (first) this.set({ waiting: false });
    this.speaker?.asked?.(
      [
        q || '这里没听懂',
        marks.length ? `（在白板上标出了：${marks.join('；')}）` : '',
        pictures.length ? `（还发了 ${pictures.length} 张图片）` : '',
      ].join(''),
      first ? 'start' : spoken ? 'spoken' : 'typed',
    );
    this.interrupt();
    this.asked = q || '这里没听懂';
    this.set((s) => ({
      ...s,
      transcript: [
        ...s.transcript,
        { who: 'student', text: q || '（在白板上标了一下）这里没听懂' },
      ],
    }));
    // Pictures the student sent go on the board under their question, where the teacher
    // can point at them.
    const sent = pictures.map((src) => this.addPicture(src, '学生发的图'));
    if (sent.length) {
      const asked: Block = {
        kind: 'asked',
        id: `asked${++this.counter}`,
        text: this.asked,
        dur: 300,
      };
      this.asked = '';
      this.set((s) => ({
        ...s,
        blocks: [...s.blocks, asked, ...sent],
        focus: { ref: sent[0].id, n: ++this.counter },
      }));
    }
    const board = this.boardText();
    // The framed picture goes along again if the lesson itself never got through.
    const again = [
      ...(!this.turns.length && this.options.picture ? [this.options.picture] : []),
      ...pictures,
    ];
    void this.request(
      async (image) => {
        this.set((s) => ({
          ...s,
          strokes: s.strokes.map((x) => (strokeIds.includes(x.id) ? { ...x, sent: true } : x)),
        }));
        const passages = q ? await this.passages(q) : '';
        // Asked before the board was ready: the intro is still being made.
        await this.opening;
        return [
          this.turns.length ? '' : this.intro,
          passages,
          board ? `白板上现在有：\n${board}` : '',
          cut ? `${cut}，我打断了你。` : '',
          spokenLately ? `（你用语音实际讲到的是：「${clip(spokenLately, 300)}」）` : '',
          sent.length
            ? `我发了 ${sent.length} 张图片（${sent.length > 1 ? '按顺序' : ''}附在这条消息里），已经放在白板上，编号 ${sent.map((b) => b.id).join('、')}。`
            : '',
          marks.length
            ? `我用紫色的笔在白板上做了标记：\n${marks.map((m) => `- ${m}`).join('\n')}` +
              (image ? '\n这次附的截图是白板现在的画面，紫色笔迹是我画的。' : '')
            : '',
          spoken && q
            ? `我说（语音）：${q}`
            : `我的问题：${q || '我标的地方没听懂，请换个方式再讲一遍。'}`,
        ]
          .filter(Boolean)
          .join('\n\n');
      },
      capture,
      again.length ? again : undefined,
    );
  }
  retry() {
    this.retryLast?.();
  }
  // `voice` false pauses only the board: the student has started talking to a voice that
  // stops and listens by itself.
  pause(voice = true) {
    if (this.state.paused) return;
    this.pausedAt = performance.now();
    if (voice) this.speaker?.pause();
    this.voicePaused = voice;
    this.set({ paused: true });
  }
  resume() {
    if (!this.state.paused) return;
    this.pausedFor += performance.now() - this.pausedAt;
    this.pausedAt = 0;
    if (this.voicePaused) this.speaker?.resume();
    this.voicePaused = false;
    this.set({ paused: false });
    this.wake();
  }
  setSpeed(speed: number) {
    this.speaker?.speed(speed);
    this.set({ speed });
  }
  // Says the lesson out loud, or stops doing so. What is already queued is said from the
  // next sentence on.
  setVoice(mode: VoiceMode, speaker: Speaker | null) {
    const next = mode === 'off' ? null : speaker;
    if (this.speaker && this.speaker !== next) {
      this.speaker.hush();
      this.voiceDone = null;
      for (const item of this.queue) item.sound = undefined;
    }
    this.voice = next ? mode : 'off';
    this.speaker = next;
    this.unspeak?.();
    this.unspeak = null;
    if (next) {
      next.speed(this.state.speed);
      if (this.state.paused && this.voicePaused) next.pause();
      next.warm?.();
      // Which voice speaks may be known only later: one that says things of its own is
      // followed whenever it does.
      this.follow(next);
    }
    this.wake();
  }
  // A live voice is the caption: what it says as it says it, each thing it says a line of
  // the transcript, whether part of the lesson or not.
  private follow(speaker: Speaker) {
    let key = 0;
    let line = -1;
    this.unspeak =
      speaker.onSpeech?.((text, final) => {
        if (!text) return;
        this.set((s) => {
          const fresh = !key;
          if (fresh) {
            key = ++this.counter;
            line = s.transcript.length;
          }
          const said = { who: 'teacher' as const, text };
          return {
            ...s,
            caption: { key, text: captionTail(text), dur: 0, live: true },
            transcript: fresh
              ? [...s.transcript, said]
              : s.transcript.map((l, i) => (i === line ? said : l)),
          };
        });
        if (final) {
          key = 0;
          this.scheduleSave(1500);
        }
      }) || null;
  }
  addStroke(points: number[]) {
    const stroke = { id: `s${++this.counter}`, points, sent: false };
    this.set((s) => ({ ...s, strokes: [...s.strokes, stroke] }));
    this.scheduleSave(1500);
  }
  undoStroke() {
    const last = [...this.state.strokes].reverse().find((s) => !s.sent);
    if (last) this.set((s) => ({ ...s, strokes: s.strokes.filter((x) => x !== last) }));
    this.scheduleSave(1500);
  }
  clearStrokes() {
    this.set((s) => ({ ...s, strokes: s.strokes.filter((x) => x.sent) }));
    this.scheduleSave(1500);
  }
  // Stops the lesson; the board is saved as it stands unless that was just done.
  dispose(save = true) {
    if (save) void this.saveNow().catch(() => {});
    this.disposed = true;
    this.unspeak?.();
    this.speaker?.hush();
    this.controller?.abort();
    this.run++;
    this.wake();
    this.listeners.clear();
  }

  // What something on the board is, for telling the model what the student marked.
  knows(ref: string) {
    return this.refs.has(ref);
  }
  describe(ref: string) {
    const r = this.refs.get(ref);
    if (!r) return ref;
    const own = r.text ? `${r.label} ${ref}「${clip(r.text, 50)}」` : `${r.label} ${ref}`;
    const parent = r.parent && this.refs.get(r.parent);
    return parent && r.label === '片段' ? `${own}（在${parent.label} ${r.parent} 里）` : own;
  }
  textOf(ref: string) {
    return this.refs.get(ref)?.text || '';
  }
  private boardText() {
    const lines: string[] = [];
    for (const [id, r] of this.refs) {
      if (r.parent && r.label !== '旁注') continue;
      const parts = [...this.refs]
        .filter(([, p]) => p.parent === id && p.label !== '旁注')
        .map(([pid, p]) => `${pid}「${clip(p.text, 30)}」`);
      const note = r.label === '旁注' ? `（连着 ${r.parent}）` : '';
      lines.push(
        `- ${id}：${r.label}${note}${r.text ? `「${clip(r.text, 80)}」` : ''}${parts.length ? `，其中 ${parts.join('、')}` : ''}`,
      );
    }
    return lines.join('\n');
  }

  private vnow() {
    return (this.pausedAt || performance.now()) - this.pausedFor;
  }
  private speaking() {
    return this.vnow() < this.speechEnd;
  }
  private wake() {
    for (const w of [...this.waiters]) w();
  }
  // Waits `ms` of real time, or less when something changes.
  private nap(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
  private async until(run: number, time: number) {
    while (run === this.run && (this.state.paused || this.vnow() < time))
      await this.nap(this.state.paused ? 1000 : Math.max(16, Math.min(120, time - this.vnow())));
  }
  private interrupt() {
    this.controller?.abort();
    this.controller = null;
    if (this.turnOpen) this.closeTurn(this.queue.length > 0 || this.streaming || this.speaking());
    this.run++;
    this.queue = [];
    this.buffer = '';
    this.fence = null;
    this.codeHead = null;
    this.streaming = false;
    this.speechEnd = this.drawEnd = 0;
    this.speaker?.hush();
    this.voiceDone = null;
    this.wake();
  }
  private closeTurn(interrupted: boolean) {
    this.turnOpen = false;
    const said = this.played.join('\n');
    this.played = [];
    this.turns.push({
      role: 'assistant',
      content:
        (said || '（还没开始讲）') +
        (interrupted ? '\n（讲到这里，学生打断了我，后面准备的没有讲。）' : ''),
    });
    this.scheduleSave(300);
  }

  // `attach` pictures stay with the question in the conversation; the `capture` of the
  // board goes with this request only.
  private async request(
    build: (image: boolean) => string | Promise<string>,
    capture?: () => Promise<string | null>,
    attach?: string[],
  ) {
    const run = ++this.run;
    const controller = new AbortController();
    this.controller = controller;
    this.retryLast = null;
    this.failure = '';
    this.resume();
    this.set((s) => ({
      ...s,
      phase: 'thinking',
      error: undefined,
      caption: s.caption?.live ? null : s.caption,
    }));
    try {
      const { provider, config } = await this.options.ready();
      if (run !== this.run) return;
      const vision = seesImages(provider) !== false;
      if (attach?.length && !vision)
        throw Error(
          `${provider.name} 的 ${provider.model} 看不到图片。请在 AI 设置里换一个能看图的模型${this.kind === 'picture' ? '，或者选中文字再用白板' : '，或者把题目打成文字'}。`,
        );
      let shot: string | null = null;
      if (capture && vision) shot = await capture().catch(() => null);
      if (run !== this.run) return;
      const content = await build(!!shot);
      if (run !== this.run) return;
      const user: WireMessage = attach
        ? { role: 'user', content, images: attach }
        : { role: 'user', content };
      const images = [...(attach || []), ...(shot ? [shot] : [])];
      const messages = [...this.turns, images.length ? { ...user, images } : user];
      this.turns.push(user);
      this.turnOpen = true;
      this.played = [];
      this.lastSay = '';
      this.buffer = '';
      this.streaming = true;
      void this.play(run);
      const result = await chat(
        { system: tutorSystem(config, this.kind, this.voice), messages, use: 'board' },
        { signal: controller.signal, onText: (d) => this.feed(run, d) },
      );
      if (run !== this.run) return;
      this.feed(run, '\n');
      // A fence the model never closed.
      this.closeFence();
      if (!result.text.trim()) throw Error('没有收到回答');
      this.speaker?.ended?.();
    } catch (e) {
      if (run !== this.run || isAbort(e)) return;
      this.failure = errorText(e);
      this.retryLast = () => void this.request(build, capture, attach);
      // Nothing reached the board: forget the question, so trying again sends it once.
      if (this.turnOpen && !this.played.length && !this.queue.length) {
        this.turnOpen = false;
        this.turns.pop();
      }
      if (!this.turnOpen) this.set({ phase: 'error', error: this.failure });
    } finally {
      if (run === this.run) {
        this.streaming = false;
        this.wake();
      }
    }
  }
  private feed(run: number, delta: string) {
    if (run !== this.run) return;
    this.buffer += delta;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      this.line(raw);
    }
    this.wake();
  }
  // Code arrives as a `code` line and then a ``` fence whose lines keep their indentation.
  // A fence with a language is code even without the `code` line; a bare one, which some
  // models wrap their whole reply in, is ignored.
  private codeHead: { id: string; lang: string; raw: string } | null = null;
  private fence: { id: string; lang: string; lines: string[]; raw: string[] } | null = null;
  private line(raw: string) {
    if (this.fence) {
      if (/^\s*```\s*$/.test(raw)) this.closeFence();
      else {
        this.fence.lines.push(raw.replace(/\t/g, '    ').replace(/\s+$/, ''));
        this.fence.raw.push(raw);
      }
      return;
    }
    const open = raw.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (open) {
      const lang = open[1];
      if (
        this.codeHead ||
        (lang && !/^(text|txt|plain|board|whiteboard|markdown|md)$/i.test(lang))
      ) {
        const head = this.codeHead;
        this.fence = {
          id: head?.id || '',
          lang: head?.lang || lang,
          lines: [],
          raw: [...(head ? [head.raw] : []), raw],
        };
        this.codeHead = null;
      }
      return;
    }
    const cmd = parseLine(raw);
    if (!cmd) return;
    if (cmd.op === 'code' && !cmd.code) {
      this.codeHead = { id: cmd.id, lang: cmd.lang, raw: raw.trim() };
      return;
    }
    this.codeHead = null;
    const sound = cmd.op === 'say' && this.speaker ? this.sound(cmd.text) : undefined;
    this.queue.push({ cmd, raw: raw.trim(), ...(sound ? { sound } : {}) });
    this.told(cmd, sound?.id);
  }
  // Tells a voice that teaches in its own words what goes on the board with each sentence.
  private told(cmd: Command, sound?: string) {
    if (sound) {
      this.lastSay = sound;
      this.lastNote = '';
      return;
    }
    if ('id' in cmd && cmd.id) {
      const text =
        'text' in cmd
          ? cmd.text
          : 'tex' in cmd
            ? cmd.tex
            : 'parts' in cmd
              ? cmd.parts.join('→')
              : 'body' in cmd
                ? plotWords(`${cmd.op} ${cmd.body}`)
                : '';
      if (text) this.written.set(cmd.id, text);
    }
    if (!this.lastSay || !this.speaker?.note) return;
    const note = commandNote(cmd, (ref) => {
      const base = this.resolve(ref).split('.')[0];
      return plotWords(
        this.written.get(ref.split('.')[0]) || this.textOf(this.resolve(ref)) || this.textOf(base),
      );
    });
    if (!note || note === this.lastNote) return;
    this.lastNote = note;
    this.speaker.note(this.lastSay, note);
  }
  private sound(text: string): Sound {
    const id = `v${++this.counter}`;
    return { id, ms: this.speaker!.prepare(id, text) };
  }
  // Waits for a sentence to be ready to say: its length in ms, or 0 if it won't be said.
  private async ready(run: number, sound: Sound) {
    let ms: number | null = null;
    void sound.ms.then(
      (v) => ((ms = v), this.wake()),
      () => ((ms = 0), this.wake()),
    );
    const start = performance.now();
    while (run === this.run && ms === null && performance.now() - start < 8000) await this.nap(250);
    return ms ?? 0;
  }
  // Waits for a live voice to start on a sentence; one that stays silent is given up on.
  private async begun(run: number, started: Promise<void>) {
    let on = false;
    void started.then(() => {
      on = true;
      this.wake();
    });
    const limit = this.vnow() + 15_000;
    while (run === this.run && !on && (this.state.paused || this.vnow() < limit))
      await this.nap(this.state.paused ? 1000 : 120);
  }
  // Waits for the sentence being said to end: it can run past its time when the speed
  // changes halfway, and a voice that never says it's done is given up on.
  private async said(run: number) {
    const done = this.voiceDone;
    if (!done) return;
    let over = false;
    void done.then(() => {
      over = true;
      this.wake();
    });
    // A live voice takes as long as it takes.
    const limit = this.speechEnd + (this.speaker?.live ? 60_000 : 3000);
    while (run === this.run && !over && (this.state.paused || this.vnow() < limit))
      await this.nap(this.state.paused ? 1000 : 120);
    if (this.voiceDone === done) this.voiceDone = null;
  }
  private closeFence() {
    const f = this.fence;
    this.fence = null;
    if (!f) return;
    while (f.lines.length && !f.lines[f.lines.length - 1].trim()) f.lines.pop();
    if (!f.lines.length) return;
    const cmd: Command = { op: 'code', id: f.id, lang: f.lang, code: f.lines.join('\n') };
    this.queue.push({ cmd, raw: [...f.raw, '```'].join('\n') });
    this.told(cmd);
  }
  private async play(run: number) {
    while (run === this.run) {
      await this.until(run, 0);
      const next = this.queue.shift();
      if (!next) {
        if (!this.streaming) break;
        await this.nap(1000);
        continue;
      }
      const speed = this.state.speed;
      if (next.cmd.op === 'say') {
        await this.until(run, Math.max(this.speechEnd, this.drawEnd));
        await this.said(run);
        // A live voice pauses between sentences by itself.
        if (this.played.length && !this.speaker?.live)
          await this.until(run, this.vnow() + 280 / speed);
        if (run !== this.run) return;
        const text = next.cmd.text;
        let dur = Math.max(900, (text.length * 1000) / (charsPerSecond * speed));
        const speaker = this.speaker;
        let live = '';
        if (speaker) {
          const sound = next.sound || this.sound(text);
          const ms = await this.ready(run, sound);
          if (run !== this.run) return;
          // Said at the speed it is now, which may have changed while it was being made.
          if (ms > 0 && this.speaker === speaker) {
            dur = ms / this.state.speed;
            this.voiceDone = speaker.say(sound.id);
            if (speaker.live) live = sound.id;
          }
        }
        this.saying = text;
        if (live) {
          // The voice says it its own way and is the caption (follow). What goes on the
          // board with it is drawn once the voice is on it, and the next sentence can start
          // as soon as this one has been said.
          this.set({ phase: 'teaching' });
          const begun = speaker?.started?.(live);
          if (begun) await this.begun(run, begun);
          if (run !== this.run) return;
          this.speechEnd = this.vnow() + dur;
          const end = this.speechEnd;
          void this.voiceDone?.then(() => {
            if (run !== this.run || this.speechEnd !== end) return;
            this.speechEnd = Math.min(end, this.vnow());
            this.wake();
          });
        } else {
          this.speechEnd = this.vnow() + dur;
          this.set((s) => ({
            ...s,
            phase: 'teaching',
            caption: { key: ++this.counter, text, dur },
            transcript: [...s.transcript, { who: 'teacher', text }],
          }));
        }
      } else {
        await this.until(run, this.drawEnd);
        if (run !== this.run) return;
        const dur = Math.round(drawTime(next.cmd) / speed);
        if (!this.draw(next.cmd, dur)) continue;
        this.drawEnd = this.vnow() + dur + 150 / speed;
      }
      this.played.push(next.raw);
    }
    if (run !== this.run) return;
    await this.until(run, Math.max(this.speechEnd, this.drawEnd));
    await this.said(run);
    if (run !== this.run) return;
    if (this.turnOpen) this.closeTurn(!!this.failure);
    // A reply that only pointed at things leaves no question to write above the next one.
    this.asked = '';
    this.set({
      phase: this.failure ? 'error' : 'idle',
      error: this.failure || undefined,
    });
  }

  private nextId(prefix: string) {
    let id: string;
    do id = `${prefix}${++this.counter}`;
    while (this.refs.has(id));
    return id;
  }
  private resolve(ref: string) {
    const [base, part] = ref.split(/\.(?=\d+$)/);
    const real = this.alias.get(base) || base;
    return part ? `${real}.${part}` : real;
  }
  // Puts one command on the board. False when it points at something that isn't there.
  private figure(wanted: string, w: number, h: number, dur: number): FigureBlock {
    let id = wanted || this.nextId('g');
    if (this.refs.has(id)) {
      const fresh = this.nextId(`${id}_`);
      this.alias.set(id, fresh);
      id = fresh;
    }
    this.refs.set(id, { label: '画布', text: `${Math.round(w)}×${Math.round(h)}` });
    return { kind: 'figure', id, w, h, dur, shapes: [] };
  }
  // The shapes one drawing command adds to a canvas.
  private shapesFor(cmd: Command, fig: FigureBlock): ShapeSpec[] {
    const range = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
    const axes = this.axes.get(fig.id);
    switch (cmd.op) {
      case 'draw':
        return svgShapes(cmd.markup);
      case 'axes':
      case 'axes3d': {
        const n = cmd.nums;
        const next: Axes =
          cmd.op === 'axes'
            ? { kind: '2d', x: range(n[0], n[1]), y: range(n[2], n[3]), equal: cmd.equal }
            : { kind: '3d', x: range(n[0], n[1]), y: range(n[2], n[3]), z: range(n[4], n[5]) };
        this.axes.set(fig.id, next);
        const where =
          next.kind === '2d'
            ? `二维坐标系 x∈[${next.x}] y∈[${next.y}]`
            : `空间坐标系 x∈[${next.x}] y∈[${next.y}] z∈[${next.z}]`;
        this.refs.set(fig.id, { label: '画布', text: where });
        return axesShapes(next, fig.w, fig.h);
      }
      case 'plot':
      case 'curve3d':
      case 'surface3d':
      case 'dot': {
        const tint =
          boardColor(cmd.color) ||
          (cmd.op === 'curve3d' || cmd.op === 'dot' ? 'var(--board-red)' : 'var(--board-blue)');
        const flat = cmd.op === 'plot' || (cmd.op === 'dot' && axes?.kind !== '3d');
        // Graphs on a canvas without axes get default ones first.
        let frame = axes;
        const extra: ShapeSpec[] = [];
        if (!frame || (cmd.op !== 'dot' && (frame.kind === '2d') !== flat)) {
          frame = flat
            ? { kind: '2d', x: [-5, 5], y: [-5, 5], equal: true }
            : { kind: '3d', x: [-2, 2], y: [-2, 2], z: [0, 3] };
          this.axes.set(fig.id, frame);
          extra.push(...axesShapes(frame, fig.w, fig.h));
        }
        const made =
          cmd.op === 'dot'
            ? dotShapes(cmd.body, frame, fig.w, fig.h, tint)
            : graphShapes(cmd.op, cmd.body, frame, fig.w, fig.h, tint);
        if (cmd.id && made[0]) made[0] = { ...made[0], ref: cmd.id };
        return [...extra, ...made];
      }
      default:
        return [];
    }
  }
  // Spreads a command's drawing time over its shapes, bigger shapes taking longer.
  private timed(specs: ShapeSpec[], dur: number, key: string): Shape[] {
    const total = specs.reduce((n, s) => n + (s.weight ?? 1), 0) || 1;
    let at = 0;
    return specs.map((spec, i) => {
      const share = (dur * (spec.weight ?? 1)) / total;
      const shape = {
        ...spec,
        key: `${key}.${i}`,
        delay: Math.round(at),
        dur: Math.round(Math.max(120, share * 0.92)),
      };
      at += share;
      return shape;
    });
  }

  private draw(cmd: Command, dur: number): boolean {
    let block: Block | null = null;
    let grown: FigureBlock | null = null;
    let ink: Ink | null = null;
    let focus = '';
    const key = `k${++this.counter}`;
    switch (cmd.op) {
      case 'title':
      case 'text':
      case 'quote':
      case 'math':
      case 'flow': {
        let id = cmd.id || this.nextId(cmd.op[0]);
        if (this.refs.has(id)) {
          const fresh = this.nextId(`${id}_`);
          this.alias.set(id, fresh);
          id = fresh;
        }
        const labels = {
          title: '小标题',
          text: '板书',
          quote: '原文摘录',
          math: '公式',
          flow: '流程图',
        };
        const label = labels[cmd.op];
        if (cmd.op === 'flow') {
          block = { kind: 'flow', id, parts: cmd.parts, dur };
          this.refs.set(id, { label, text: cmd.parts.map(plainText).join(' → ') });
          cmd.parts.forEach((p, i) =>
            this.refs.set(`${id}.${i + 1}`, { label: '流程框', text: plainText(p), parent: id }),
          );
        } else {
          const source = cmd.op === 'math' ? cmd.tex : cmd.text;
          block =
            cmd.op === 'math'
              ? { kind: 'math', id, tex: cmd.tex, dur }
              : { kind: cmd.op, id, text: cmd.text, dur };
          this.refs.set(id, { label, text: plainText(source) });
          for (const part of partsOf(source))
            this.refs.set(part.id, { label: '片段', text: part.text, parent: id });
        }
        focus = id;
        break;
      }
      case 'circle':
      case 'underline':
      case 'box':
      case 'mark':
      case 'point': {
        const target = this.resolve(cmd.target);
        if (!this.refs.has(target)) return false;
        ink = { kind: cmd.op, key, target, color: cmd.color || defaultColor[cmd.op], dur };
        focus = target;
        break;
      }
      case 'arrow': {
        const from = this.resolve(cmd.from);
        const to = this.resolve(cmd.to);
        if (!this.refs.has(from) || !this.refs.has(to) || from === to) return false;
        ink = { kind: 'arrow', key, from, to, label: cmd.label, color: cmd.color || 'orange', dur };
        focus = to;
        break;
      }
      case 'note': {
        const target = this.resolve(cmd.target);
        if (!this.refs.has(target)) return false;
        const id = this.nextId('n');
        this.refs.set(id, { label: '旁注', text: plainText(cmd.text), parent: target });
        ink = { kind: 'note', key, id, target, text: cmd.text, color: cmd.color || 'red', dur };
        focus = target;
        break;
      }
      case 'area': {
        const pic = cmd.pic ? this.resolve(cmd.pic) : this.pictures[this.pictures.length - 1];
        if (!pic || !this.pictures.includes(pic)) return false;
        const [l, t, r, b] = cmd.box.map(Math.round);
        let id = cmd.id || this.nextId('a');
        if (this.refs.has(id)) id = this.nextId(`${id}_`);
        this.refs.set(id, {
          label: '图中区域',
          text: `左 ${l}% 上 ${t}% 右 ${r}% 下 ${b}%`,
          parent: pic,
        });
        ink = { kind: 'area', key, id, target: pic, box: cmd.box, color: 'red', dur: 0 };
        focus = pic;
        break;
      }
      case 'code': {
        let id = cmd.id || this.nextId('c');
        if (this.refs.has(id)) {
          const fresh = this.nextId(`${id}_`);
          this.alias.set(id, fresh);
          id = fresh;
        }
        const lines = cmd.code.split('\n');
        this.refs.set(id, { label: '代码', text: lines.find((l) => l.trim())?.trim() || '' });
        lines.forEach((l, i) => {
          if (l.trim())
            this.refs.set(`${id}.${i + 1}`, { label: '代码行', text: l.trim(), parent: id });
        });
        block = { kind: 'code', id, lang: cmd.lang, code: cmd.code, dur };
        focus = id;
        break;
      }
      case 'figure': {
        block = this.figure(cmd.id, cmd.w, cmd.h, dur);
        focus = block.id;
        break;
      }
      case 'erase': {
        const gone = cmd.targets.map((t) => this.resolve(t)).filter((t) => this.refs.has(t));
        if (!gone.length) return false;
        // Parts of what is erased go with it.
        const all = new Set(gone);
        for (let grew = true; grew;) {
          grew = false;
          for (const [id, r] of this.refs)
            if (r.parent && all.has(r.parent) && !all.has(id)) {
              all.add(id);
              grew = true;
            }
        }
        for (const id of all) this.refs.delete(id);
        this.set((s) => ({ ...s, phase: 'teaching', erased: [...s.erased, ...all] }));
        return true;
      }
      case 'draw':
      case 'axes':
      case 'axes3d':
      case 'plot':
      case 'curve3d':
      case 'surface3d':
      case 'dot': {
        const id = this.resolve(cmd.fig);
        const existing = this.state.blocks.find(
          (b): b is FigureBlock => b.kind === 'figure' && b.id === id,
        );
        // Drawing on a canvas that wasn't made first makes one.
        const fig = existing || this.figure(id, 600, 360, 250);
        let specs: ShapeSpec[];
        try {
          specs = this.shapesFor(cmd, fig);
        } catch {
          return false;
        }
        if (!specs.length) return false;
        for (const spec of specs) {
          if (!spec.ref) continue;
          let ref = spec.ref;
          if (this.refs.has(ref)) {
            const fresh = this.nextId(`${ref}_`);
            this.alias.set(ref, fresh);
            ref = spec.ref = fresh;
          }
          const names: Record<string, string> = {
            rect: '矩形',
            circle: '圆',
            ellipse: '椭圆',
            line: '线',
            path: '线条',
            polyline: '折线',
            polygon: '多边形',
          };
          const graph = cmd.op !== 'draw' && cmd.op !== 'axes' && cmd.op !== 'axes3d';
          this.refs.set(ref, {
            label: graph ? '图像' : '图形',
            text: graph
              ? `${cmd.op} ${(cmd as { body: string }).body}`
              : spec.tag === 'text'
                ? `文字 ${spec.text}`
                : names[spec.tag] || spec.tag,
            parent: fig.id,
          });
        }
        const shapes = this.timed(specs, dur, key);
        if (existing) grown = { ...existing, shapes: [...existing.shapes, ...shapes] };
        else block = { ...fig, shapes };
        focus = shapes.find((s) => s.ref)?.ref || fig.id;
        break;
      }
      default:
        return false;
    }
    const asked: Block | null =
      block && this.asked
        ? { kind: 'asked', id: `asked${++this.counter}`, text: this.asked, dur: 300 }
        : null;
    if (block) this.asked = '';
    this.set((s) => ({
      ...s,
      phase: 'teaching',
      blocks: block
        ? [...s.blocks, ...(asked ? [asked] : []), block]
        : grown
          ? s.blocks.map((b) => (b.id === grown.id ? grown : b))
          : s.blocks,
      inks: ink
        ? [...(ink.kind === 'point' ? s.inks.filter((i) => i.kind !== 'point') : s.inks), ink]
        : s.inks,
      focus: { ref: focus, n: ++this.counter },
      pen:
        block && block.kind !== 'figure'
          ? { kind: 'block', key: block.id, n: this.counter }
          : grown || block
            ? { kind: 'shapes', key, n: this.counter }
            : ink && ink.kind !== 'area'
              ? { kind: 'ink', key: ink.key, n: this.counter }
              : s.pen,
    }));
    return true;
  }
}

export function useTutor(tutor: Tutor) {
  return useSyncExternalStore(tutor.subscribe, tutor.get);
}
