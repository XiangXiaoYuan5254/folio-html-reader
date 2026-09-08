import type { Annotation, Point } from '../types';
import {
  annotationColors,
  colorPickerStyles,
  defaultColor,
  isCustomColor,
  normalizeColor,
} from '../colors';

type Patch = Partial<
  Pick<Annotation, 'note' | 'points' | 'size' | 'collapsed' | 'fontSize' | 'fontFamily' | 'color'>
>;
type Card = {
  element: HTMLDivElement;
  input: HTMLTextAreaElement;
  pin: HTMLButtonElement;
  title: HTMLElement;
  font?: HTMLSelectElement;
  family?: HTMLSelectElement;
  settings?: HTMLDivElement;
  settingsButton?: HTMLButtonElement;
  colorInput?: HTMLInputElement;
  customColor?: HTMLLabelElement;
  measure?: HTMLSpanElement;
};
type Callbacks = {
  update: (id: string, patch: Patch, group?: string) => void;
  remove: (id: string) => void;
  position: (a: Annotation) => Point | null;
  select: (id: string) => void;
};

const noteFonts = [
  {
    value: 'system',
    label: '系统默认',
    css: '-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
  },
  { value: 'songti', label: '宋体', css: '"Songti SC","STSong",serif' },
  { value: 'kaiti', label: '楷体', css: '"Kaiti SC","STKaiti",serif' },
  { value: 'heiti', label: '黑体', css: '"Heiti SC","PingFang SC",sans-serif' },
  { value: 'serif', label: 'Times New Roman', css: '"Times New Roman","Songti SC",serif' },
  { value: 'mono', label: '等宽字体', css: 'Menlo,"PingFang SC",monospace' },
];

const css = `
${colorPickerStyles}
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#504a28}
*{box-sizing:border-box} button,textarea{font:inherit} button{cursor:pointer}
.card{position:absolute;pointer-events:auto;border:1px solid color-mix(in srgb,var(--ink) 55%,#b39c4f);border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--ink) 22%,#fffef3);box-shadow:0 8px 25px #40361520;display:flex;flex-direction:column;min-width:220px;min-height:130px}
.card:focus-within{box-shadow:0 0 0 2px color-mix(in srgb,var(--ink) 42%,transparent),0 9px 28px #40361524}
.head{display:flex;align-items:center;gap:8px;height:40px;flex-shrink:0;padding:0 9px 0 14px;background:color-mix(in srgb,var(--ink) 35%,#fffdf1);cursor:grab;user-select:none;touch-action:none}
.head:active{cursor:grabbing}.title{font-size:14px;font-weight:550;flex:1}.head button{display:grid;place-items:center;width:25px;height:25px;border:0;background:transparent;border-radius:5px;color:#756c40;padding:4px}.head button:hover{background:#ffffff80;color:#37301c}
svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
textarea{width:100%;flex:1;min-height:0;resize:none;border:0;outline:0;background:transparent;color:#423e2d;padding:13px 15px 20px;font-size:var(--font-size,17px);font-family:var(--font-family);line-height:1.65;user-select:text;cursor:text;overflow:auto} textarea::placeholder{color:#998f60}
.note-settings{position:fixed;pointer-events:auto;overflow:auto;padding:10px;background:#fffdf8;border:1px solid #deded3;border-radius:8px;box-shadow:0 5px 15px #40361525;z-index:2;color:#394457;font:12px system-ui}
.font-controls{display:flex;gap:8px}.font-controls label{display:flex;align-items:center;gap:5px;min-width:0;white-space:nowrap}.font-controls label:first-child{flex:1}.note-settings select{min-width:0;width:100%;height:26px;border:1px solid #dce0e3;border-radius:4px;color:#394457;background:#fff;font:12px system-ui}.font-controls label:last-child select{width:49px}
.note-colors{display:flex;align-items:center;gap:7px;margin-top:10px}.note-colors button{width:20px;height:20px;border:2px solid white;border-radius:50%;outline:1px solid #dce3e8;padding:0;flex-shrink:0}.note-colors button[aria-pressed=true]{outline:2px solid #607b86}.note-colors .custom-color{width:20px;height:20px}.head button[aria-expanded=true]{background:#ffffffb0;color:#287b71}
.resize{position:absolute;right:2px;bottom:2px;display:grid;place-items:center;width:22px;height:22px;padding:3px;border:0;background:transparent;color:#a3975c;cursor:nwse-resize;touch-action:none}
.pin{position:absolute;pointer-events:auto;width:33px;height:33px;border:1px solid color-mix(in srgb,var(--ink) 60%,#aa984b);border-radius:8px;background:color-mix(in srgb,var(--ink) 35%,#fffce4);color:#65572d;box-shadow:0 3px 8px #40361522;display:grid;place-items:center;padding:7px}.pin:hover{filter:brightness(.97);transform:translateY(-1px)}
[hidden]{display:none!important} button:focus-visible{outline:2px solid #287b71;outline-offset:-2px}
.card.text-note{background:transparent;border:1px solid transparent;box-shadow:none;border-radius:3px;min-width:100px;min-height:32px;overflow:visible;display:block}
.text-note:focus-within,.text-note:hover{border-color:#8b9bdd;box-shadow:none}
.text-note .head{position:absolute;bottom:100%;left:-1px;height:32px;padding:0 5px 0 9px;gap:5px;background:#fff;border:1px solid #d5dce7;border-radius:7px;box-shadow:0 3px 12px #24324715;white-space:nowrap;min-width:245px}
.text-note .title{font-size:12px}.text-note select{font:12px system-ui;width:49px;height:24px;border:1px solid #e0e4eb;border-radius:4px;background:#fff;color:#394457}
.text-note .head,.text-note .resize{visibility:hidden}.text-note:hover .head,.text-note:focus-within .head,.text-note:hover .resize,.text-note:focus-within .resize{visibility:visible}
.text-note textarea,.text-note .text-measure{display:block;width:100%;padding:3px 5px;font-size:var(--font-size,20px);line-height:1.5;color:var(--ink);white-space:pre-wrap;overflow-wrap:break-word}
.text-note textarea{flex:none;min-height:32px;overflow:hidden;border-radius:0}
.text-note .text-measure{position:absolute;left:0;top:0;visibility:hidden;pointer-events:none}
.text-note textarea::placeholder{color:#94a3b8}.text-note .resize{color:#718096}
`;

function button(label: string, path: string, className = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.className = className;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  b.append(svg);
  return b;
}

export class PageNotes {
  private shadow: ShadowRoot;
  private items = new Map<string, Annotation>();
  private cards = new Map<string, Card>();
  private editingGroup = '';
  private drag: {
    id: string;
    mode: 'move' | 'resize';
    start: Point;
    origin: Point;
    width: number;
    height: number;
    next: Point;
    size: { width: number; height: number };
    pointer: number;
    target: HTMLElement;
  } | null = null;

  constructor(private callbacks: Callbacks) {
    const host = document.createElement('div');
    host.dataset.folioUi = 'notes';
    host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;transform:none!important;margin:0!important;padding:0!important;';
    this.shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    this.shadow.append(style);
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'])
      host.addEventListener(type, (e) => e.stopPropagation());
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', () => this.finish());
    window.addEventListener('pointercancel', () => this.finish(true));
    document.addEventListener(
      'pointerdown',
      (e) => {
        for (const card of this.cards.values())
          if (
            !e.composedPath().includes(card.settings!) &&
            !e.composedPath().includes(card.settingsButton!)
          )
            this.showSettings(card, false);
      },
      true,
    );
    document.body.append(host);
  }

  sync(annotations: Annotation[]) {
    this.items = new Map(
      annotations.filter((a) => a.type === 'sticky' || a.type === 'text').map((a) => [a.id, a]),
    );
    for (const [id, card] of this.cards)
      if (!this.items.has(id)) {
        card.element.remove();
        card.pin.remove();
        this.cards.delete(id);
      }
    for (const [id, a] of this.items) {
      const card = this.cards.get(id) || this.create(a);
      if (this.shadow.activeElement !== card.input && card.input.value !== a.note)
        card.input.value = a.note;
      if (card.measure) {
        const text = card.input.value.trimEnd() || card.input.placeholder;
        if (card.measure.textContent !== text) card.measure.textContent = text;
      }
      const ink = a.color || defaultColor;
      card.element.style.setProperty('--ink', ink);
      const fontSize = a.fontSize || (a.type === 'text' ? 20 : 17);
      const family = noteFonts.find((font) => font.value === a.fontFamily) || noteFonts[0];
      card.element.style.setProperty('--font-size', `${fontSize}px`);
      card.element.style.setProperty('--font-family', family.css);
      if (card.font) card.font.value = String(fontSize);
      if (card.family) card.family.value = family.value;
      if (card.colorInput) card.colorInput.value = normalizeColor(ink) || defaultColor;
      if (card.customColor) {
        card.customColor.dataset.selected = String(isCustomColor(ink));
        card.customColor.style.setProperty('--custom-ink', ink);
      }
      for (const b of card.settings?.querySelectorAll<HTMLButtonElement>('[data-color]') || [])
        b.setAttribute('aria-pressed', String(b.dataset.color === ink));
      card.pin.style.setProperty('--ink', ink);
      card.pin.title = a.note ? `展开便签：${a.note.slice(0, 80)}` : '展开便签';
      const collapsed = a.collapsed ?? false;
      const position = this.callbacks.position(a);
      card.element.hidden = collapsed || !position;
      card.pin.hidden = !collapsed || !position;
      const size = a.size || { width: 300, height: a.type === 'text' ? 36 : 200 };
      if (this.drag?.id !== id) {
        card.element.style.width = `${size.width}px`;
        card.element.style.height = `${size.height}px`;
        this.positionCard(card, position);
        if (a.type === 'text') this.fitText(card, size.height);
      }
    }
  }

  private fitText(card: Card, minHeight: number) {
    card.element.style.height = 'auto';
    card.input.style.height = '0px';
    card.input.style.height = `${Math.max(minHeight, card.input.scrollHeight)}px`;
  }

  private positionCard(card: Card, p: Point | null) {
    if (!p) return;
    for (const el of [card.element, card.pin]) {
      el.style.left = `${p.x - scrollX}px`;
      el.style.top = `${p.y - scrollY}px`;
    }
    this.positionSettings(card);
  }

  reposition() {
    for (const [id, a] of this.items) {
      const card = this.cards.get(id);
      if (card && this.drag?.id !== id) this.positionCard(card, this.callbacks.position(a));
    }
  }

  open(id: string, focus = true) {
    const a = this.items.get(id);
    if (!a) return;
    if (a.collapsed ?? false) this.patch(id, { collapsed: false });
    this.callbacks.select(id);
    if (focus) this.cards.get(id)?.input.focus({ preventScroll: true });
  }

  rect(id: string) {
    const card = this.cards.get(id);
    if (!card) return null;
    if (!card.element.hidden && card.measure) {
      // A textarea exposes its editor box, not its rendered text bounds. Mirror
      // the same font and wrapping so selection follows the visible words.
      const range = document.createRange();
      range.selectNodeContents(card.measure);
      const rect = range.getBoundingClientRect();
      if (rect.width && rect.height) return rect;
    }
    const element = card.element.hidden ? card.pin : card.element;
    return element.getBoundingClientRect();
  }

  private patch(id: string, patch: Patch, group?: string) {
    const a = this.items.get(id);
    if (!a) return;
    this.items.set(id, { ...a, ...patch });
    this.sync([...this.items.values()]);
    this.callbacks.update(id, patch, group);
  }

  private showSettings(card: Card, show: boolean) {
    if (!card.settings) return;
    card.settings.hidden = !show;
    card.settingsButton?.setAttribute('aria-expanded', String(show));
    if (show) this.positionSettings(card);
  }

  private positionSettings(card: Card) {
    const panel = card.settings;
    if (!panel || panel.hidden) return;
    if (card.element.hidden) {
      this.showSettings(card, false);
      return;
    }
    const note = card.element.getBoundingClientRect();
    const gap = 8;
    if (note.bottom <= 0 || note.top >= innerHeight || note.right <= 0 || note.left >= innerWidth) {
      this.showSettings(card, false);
      return;
    }
    const width = Math.min(Math.max(note.width, 260), 360, innerWidth - gap * 2);
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${innerHeight - gap * 2}px`;
    const height = panel.getBoundingClientRect().height;
    let left = Math.max(gap, Math.min(note.left, innerWidth - width - gap));
    let top = note.top - height - gap;
    // Prefer the space above the whole note. At the top edge, use a free side
    // or the space below the note instead of covering its text editor.
    if (top < gap) {
      if (innerWidth - note.right >= width + gap * 2) {
        left = note.right + gap;
        top = Math.max(gap, Math.min(note.top, innerHeight - height - gap));
      } else if (note.left >= width + gap * 2) {
        left = note.left - width - gap;
        top = Math.max(gap, Math.min(note.top, innerHeight - height - gap));
      } else {
        top = Math.max(gap, Math.min(note.bottom + gap, innerHeight - height - gap));
        panel.style.maxHeight = `${Math.max(40, innerHeight - top - gap)}px`;
      }
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  private stickySettings(a: Annotation, card: Card, head: HTMLElement, before: HTMLElement) {
    const toggle = button('便签样式', 'M4 7h16M4 17h16M8 4v6M16 14v6');
    toggle.setAttribute('aria-expanded', 'false');
    const panel = document.createElement('div');
    panel.className = 'note-settings';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', '便签样式设置');
    panel.hidden = true;
    card.settings = panel;
    card.settingsButton = toggle;
    toggle.onclick = () => {
      const show = panel.hidden;
      for (const other of this.cards.values()) this.showSettings(other, false);
      this.showSettings(card, show);
      this.callbacks.select(a.id);
    };
    const fields = document.createElement('div');
    fields.className = 'font-controls';
    const field = (name: string, options: { value: string; label: string }[]) => {
      const label = document.createElement('label');
      label.append(name);
      const select = document.createElement('select');
      select.setAttribute('aria-label', `便签${name}`);
      for (const option of options) select.add(new Option(option.label, option.value));
      label.append(select);
      fields.append(label);
      return select;
    };
    card.family = field('字体', noteFonts);
    card.family.onchange = () => this.patch(a.id, { fontFamily: card.family!.value });
    card.font = field(
      '字号',
      [12, 14, 16, 17, 18, 20, 24, 28, 32, 40, 48, 64].map((size) => ({
        value: String(size),
        label: String(size),
      })),
    );
    card.font.onchange = () => this.patch(a.id, { fontSize: Number(card.font!.value) });
    const colors = document.createElement('div');
    colors.className = 'note-colors';
    colors.append('底色');
    for (const { value, name } of annotationColors) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.title = name;
      choice.setAttribute('aria-label', `便签颜色：${name}`);
      choice.dataset.color = value;
      choice.style.background = value;
      choice.onclick = () => this.patch(a.id, { color: value });
      colors.append(choice);
    }
    const custom = document.createElement('label');
    custom.className = 'custom-color';
    custom.title = '自定义便签颜色';
    const input = document.createElement('input');
    input.type = 'color';
    input.setAttribute('aria-label', '便签自定义颜色');
    let colorGroup = '';
    input.onclick = () => {
      colorGroup = `sticky-color:${crypto.randomUUID()}`;
    };
    const updateColor = () => {
      const color = normalizeColor(input.value);
      if (color && color !== this.items.get(a.id)?.color) {
        colorGroup ||= `sticky-color:${crypto.randomUUID()}`;
        this.patch(a.id, { color }, colorGroup);
      }
    };
    input.oninput = updateColor;
    input.onchange = () => {
      updateColor();
      colorGroup = '';
    };
    custom.append(input);
    colors.append(custom);
    card.colorInput = input;
    card.customColor = custom;
    panel.append(fields, colors);
    panel.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.showSettings(card, false);
        toggle.focus({ preventScroll: true });
      }
    };
    head.insertBefore(toggle, before);
    card.element.append(panel);
  }

  private create(a: Annotation): Card {
    const el = document.createElement('div');
    const isText = a.type === 'text';
    el.className = `card${isText ? ' text-note' : ''}`;
    el.dataset.noteId = a.id;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', isText ? '页面文本注释' : '页面便签');
    const head = document.createElement('div');
    head.className = 'head';
    head.title = isText ? '拖动移动文本注释' : '拖动移动便签';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = isText ? '文本注释' : '便签';
    const collapse = button(
      isText ? '完成编辑' : '收起便签',
      isText ? 'M5 12l4 4L19 6' : 'M5 12h14',
    );
    const remove = button(
      isText ? '删除文本注释' : '删除便签',
      'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    );
    head.append(title, collapse, remove);
    const input = document.createElement('textarea');
    input.placeholder = isText ? '输入文字…' : '写下你的想法…';
    input.setAttribute('aria-label', isText ? '文本注释内容' : '页面便签内容');
    input.rows = isText ? 1 : 3;
    input.spellcheck = false;
    const resize = button(
      isText ? '调整文本宽度' : '调整便签大小',
      'M9 20l11-11M15 20l5-5',
      'resize',
    );
    const pin = button('展开便签', 'M4 3h16v12l-5 6H4zM14 21v-7h6', 'pin');
    pin.dataset.notePin = a.id;
    el.append(head, input, resize);
    const card: Card = { element: el, input, pin, title };
    if (!isText) this.stickySettings(a, card, head, collapse);
    if (isText) {
      const measure = document.createElement('div');
      measure.className = 'text-measure';
      measure.setAttribute('aria-hidden', 'true');
      card.measure = document.createElement('span');
      measure.append(card.measure);
      el.append(measure);
      const font = document.createElement('select');
      font.setAttribute('aria-label', '文本字号');
      for (const size of [14, 16, 18, 20, 24, 28, 32, 40, 48]) {
        const option = document.createElement('option');
        option.value = String(size);
        option.textContent = String(size);
        font.append(option);
      }
      font.onchange = () => this.patch(a.id, { fontSize: Number(font.value) });
      head.insertBefore(font, collapse);
      card.font = font;
      el.addEventListener('focusout', () => {
        setTimeout(() => {
          if (
            !el.contains(this.shadow.activeElement) &&
            this.items.has(a.id) &&
            !this.items.get(a.id)?.note.trim()
          )
            this.callbacks.remove(a.id);
        }, 0);
      });
    }
    this.cards.set(a.id, card);
    this.shadow.append(el, pin);
    collapse.onclick = () => {
      if (isText) (this.shadow.activeElement as HTMLElement | null)?.blur();
      else this.patch(a.id, { collapsed: true });
    };
    remove.onclick = () => this.callbacks.remove(a.id);
    pin.onclick = () => this.open(a.id);
    input.onfocus = () => {
      this.editingGroup = `note:${a.id}:${crypto.randomUUID()}`;
      this.callbacks.select(a.id);
    };
    input.oninput = () => this.patch(a.id, { note: input.value }, this.editingGroup);
    input.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        input.blur();
        if (!isText) this.patch(a.id, { collapsed: true });
      }
    };
    const start = (e: PointerEvent, mode: 'move' | 'resize') => {
      if (e.button !== 0 || (mode === 'move' && (e.target as Element).closest('button,select')))
        return;
      const current = this.items.get(a.id),
        origin = current && this.callbacks.position(current);
      if (!current || !origin) return;
      e.preventDefault();
      e.stopPropagation();
      const size = current.size || { width: 300, height: 200 };
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      this.drag = {
        id: a.id,
        mode,
        start: { x: e.clientX, y: e.clientY },
        origin,
        ...size,
        next: origin,
        size,
        pointer: e.pointerId,
        target,
      };
      this.callbacks.select(a.id);
    };
    head.onpointerdown = (e) => start(e, 'move');
    resize.onpointerdown = (e) => start(e, 'resize');
    return card;
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const card = this.cards.get(d.id);
    if (!card) return;
    const dx = e.clientX - d.start.x,
      dy = e.clientY - d.start.y;
    if (d.mode === 'move') {
      d.next = {
        x: Math.max(
          0,
          Math.min(document.documentElement.scrollWidth - d.width - 8, d.origin.x + dx),
        ),
        y: Math.max(0, Math.min(document.documentElement.scrollHeight - 40, d.origin.y + dy)),
      };
      this.positionCard(card, d.next);
    } else {
      d.size = {
        width: Math.max(
          220,
          Math.min(600, document.documentElement.scrollWidth - d.origin.x - 8, d.width + dx),
        ),
        height: Math.max(130, Math.min(800, d.height + dy)),
      };
      if (this.items.get(d.id)?.type === 'text') d.size.height = 36;
      card.element.style.width = `${d.size.width}px`;
      card.element.style.height = `${d.size.height}px`;
      if (this.items.get(d.id)?.type === 'text') this.fitText(card, 36);
    }
  }

  private finish(cancel = false) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      d.target.releasePointerCapture(d.pointer);
    } catch {}
    if (cancel) {
      this.sync([...this.items.values()]);
      return;
    }
    if (d.mode === 'move' && (d.next.x !== d.origin.x || d.next.y !== d.origin.y))
      this.patch(d.id, { points: [d.next] });
    else if (d.mode === 'resize' && (d.size.width !== d.width || d.size.height !== d.height))
      this.patch(d.id, { size: d.size });
  }
}
