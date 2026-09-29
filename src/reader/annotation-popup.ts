import type { Annotation } from '../types';
import {
  annotationColors,
  colorPickerStyles,
  defaultColor,
  isCustomColor,
  normalizeColor,
} from '../colors';

type Rect = { left: number; top: number; right: number; bottom: number };
type Callbacks = {
  rect: (a: Annotation) => Rect | null;
  markerRect: (a: Annotation) => Rect | null;
  update: (id: string, patch: Partial<Annotation>, group?: string) => void;
  remove: (id: string) => void;
  select: (id: string) => void;
  // One text size for every highlight note, chosen in the note editor.
  fontSize: (size: number) => void;
};
export const NOTE_FONT_MIN = 12;
export const NOTE_FONT_MAX = 26;
const css = `
${colorPickerStyles}
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#334155}
*{box-sizing:border-box}[hidden]{display:none!important}button,textarea{font:inherit}
.popup{position:absolute;pointer-events:auto;width:304px;background:#fff;border:1px solid #dce3e8;border-radius:12px;box-shadow:0 8px 28px #26374c26;overflow:hidden;font-size:14px}
.head{display:flex;align-items:center;justify-content:space-between;padding:10px 13px;border-bottom:1px solid #edf0f3;font-weight:600}.head button{font-size:20px;width:24px;height:24px}
button{border:0;background:transparent;color:inherit;cursor:pointer;border-radius:5px}button:hover{background:#edf4f2}button:focus-visible{outline:2px solid #287b71}
.actions{display:flex;align-items:center;gap:6px;padding:10px}.note-action{padding:7px 10px;color:#287b71;background:#edf7f4;flex:1}.delete{padding:7px;color:#b64d55}
.colors{display:flex;gap:10px;padding:3px 15px 13px}.color{width:19px;height:19px;border-radius:50%;border:2px solid #fff;outline:1px solid #dce3e8}.color[aria-pressed=true]{outline:2px solid #607b86}
textarea{display:block;width:100%;min-height:135px;max-height:min(50vh,420px);resize:vertical;border:0;outline:0;padding:13px 15px;color:#334155;background:#fffdf0;font-size:var(--note-size,15px);line-height:1.65}.footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 13px;color:#82908f;font-size:12px}.sizes{display:flex;align-items:center;gap:2px;margin-left:auto}.size{padding:3px 7px;color:#5d6b75;font-size:12px}.size-value{min-width:20px;text-align:center;font-variant-numeric:tabular-nums}.done{padding:6px 14px;background:#287b71;color:white}.done:hover{background:#20675f}
.preview{position:absolute;pointer-events:auto;cursor:pointer;display:flex;flex-direction:column;width:max-content;max-width:360px;max-height:min(420px,60vh);background:#fff7b2;color:#514a28;border:1px solid #dfd49b;border-radius:10px;box-shadow:0 5px 18px #4a421d22;font-size:15px;line-height:1.65;overflow:hidden}
.preview-text{overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;padding:11px 14px 6px;font-size:var(--note-size,15px)}.preview-hint{flex-shrink:0;padding:4px 14px 8px;font-size:12px;color:#8a7d3f}.preview:hover{border-color:#cdbd6a}
.note-indicator{position:absolute;pointer-events:auto;display:grid;place-items:center;width:22px;height:16px;padding:0;background:#fff7b2;color:#554b22;border:1px solid #dfce83;border-radius:4px;box-shadow:0 1px 4px #4a421d18;font:700 14px/1 system-ui;user-select:none}
.note-indicator:hover{background:#fff19a}.note-indicator[data-previewing=true]{background:transparent;border-color:transparent;box-shadow:none;color:transparent}
`;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}
function button(label: string, className = '', text = label) {
  const e = element('button', className, text);
  e.type = 'button';
  e.setAttribute('aria-label', label);
  return e;
}

export class AnnotationPopup {
  private host = element('div');
  private shadow: ShadowRoot;
  private panel = element('div', 'popup');
  private preview = element('div', 'preview');
  private previewText = element('div', 'preview-text');
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private overPreview = false;
  private input = element('textarea');
  private actions = element('div', 'actions');
  private colors = element('div', 'colors');
  private customColor = element('label', 'custom-color');
  private colorInput = element('input');
  private colorTarget: { id: string; group: string; value: string } | null = null;
  private footer = element('div', 'footer');
  private sizeLabel = element('span', 'size-value');
  private fontSize = 15;
  private title = element('span');
  private noteButton = button('添加笔记', 'note-action');
  private current: Annotation | null = null;
  private previewAnnotation: Annotation | null = null;
  private hovered = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private group = '';
  private indicators = new Map<string, { annotation: Annotation; button: HTMLButtonElement }>();

  constructor(private callbacks: Callbacks) {
    this.host.dataset.folioUi = 'annotation-popup';
    this.host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;transform:none!important;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = element('style');
    style.textContent = css;
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', '批注笔记编辑');
    this.preview.setAttribute('role', 'button');
    this.preview.setAttribute('aria-label', '批注笔记预览，点击编辑');
    this.preview.tabIndex = -1;
    // The preview stays while the pointer is on it, so long notes can be scrolled and read;
    // clicking it opens the note for editing.
    this.preview.append(this.previewText, element('div', 'preview-hint', '点击编辑笔记'));
    this.preview.onpointerenter = () => {
      this.overPreview = true;
      this.cancelHide();
    };
    this.preview.onpointerleave = () => {
      this.overPreview = false;
      this.scheduleHide();
    };
    this.preview.onclick = () => {
      const a = this.previewAnnotation;
      if (a) this.show(a, true);
    };
    const head = element('div', 'head');
    const close = button('关闭笔记', '', '×');
    close.onclick = () => this.close();
    head.append(this.title, close);
    this.noteButton.onclick = () => this.current && this.show(this.current, true);
    const remove = button('删除这条批注', 'delete', '删除');
    remove.onclick = () => {
      if (this.current) this.callbacks.remove(this.current.id);
      this.close();
    };
    this.actions.append(this.noteButton, remove);
    for (const { value: color, name: label } of annotationColors) {
      const b = button(`批注颜色：${label}`, 'color', '');
      b.style.background = color;
      b.dataset.color = color;
      b.onclick = () => {
        if (this.current) this.callbacks.update(this.current.id, { color });
      };
      this.colors.append(b);
    }
    this.colorInput.type = 'color';
    this.colorInput.setAttribute('aria-label', '批注自定义颜色');
    this.customColor.title = '自定义批注颜色 · 点击打开选色盘';
    this.colorInput.onclick = () => {
      if (this.current)
        this.colorTarget = {
          id: this.current.id,
          group: `quote-color:${crypto.randomUUID()}`,
          value: this.current.color,
        };
    };
    const changeColor = () => {
      // The native macOS panel can blur (and dismiss) this popup. Keep the
      // original annotation as the target until that color choice finishes.
      if (!this.colorTarget && this.current)
        this.colorTarget = {
          id: this.current.id,
          group: `quote-color:${crypto.randomUUID()}`,
          value: this.current.color,
        };
      const target = this.colorTarget;
      const color = normalizeColor(this.colorInput.value);
      if (target && color && target.value !== color) {
        target.value = color;
        this.callbacks.update(target.id, { color }, target.group);
      }
    };
    this.colorInput.oninput = changeColor;
    this.colorInput.onchange = () => {
      changeColor();
      this.colorTarget = null;
    };
    this.customColor.append(this.colorInput);
    this.colors.append(this.customColor);
    this.input.setAttribute('aria-label', '批注笔记内容');
    this.input.placeholder = '写下与这段原文有关的想法…';
    this.input.spellcheck = false;
    this.input.oninput = () => {
      if (this.current)
        this.callbacks.update(this.current.id, { note: this.input.value }, this.group);
    };
    const done = button('完成笔记', 'done', '完成');
    done.onclick = () => this.close();
    const smaller = button('缩小笔记字号', 'size', 'A−');
    const larger = button('放大笔记字号', 'size', 'A+');
    smaller.onclick = () => this.callbacks.fontSize(Math.max(NOTE_FONT_MIN, this.fontSize - 1));
    larger.onclick = () => this.callbacks.fontSize(Math.min(NOTE_FONT_MAX, this.fontSize + 1));
    this.sizeLabel.title = '笔记字号';
    const sizes = element('span', 'sizes');
    sizes.append(smaller, this.sizeLabel, larger);
    this.footer.append(element('span', 'saved', '自动保存'), sizes, done);
    this.panel.append(head, this.actions, this.colors, this.input, this.footer);
    this.panel.hidden = this.preview.hidden = true;
    this.shadow.append(style, this.panel, this.preview);
    this.setFontSize(this.fontSize);
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'])
      this.host.addEventListener(type, (e) => e.stopPropagation());
    this.host.addEventListener('pointermove', (e) => e.stopPropagation());
    // Scrolling a long note shouldn't scroll or zoom the page underneath.
    this.host.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!e.composedPath().includes(this.host)) this.close();
      },
      true,
    );
    window.addEventListener('blur', () => this.close());
    document.body.append(this.host);
  }

  setFontSize(size: number) {
    this.fontSize = Math.max(NOTE_FONT_MIN, Math.min(NOTE_FONT_MAX, Math.round(size) || 15));
    this.host.style.setProperty('--note-size', `${this.fontSize}px`);
    this.sizeLabel.textContent = String(this.fontSize);
    this.reposition();
  }

  sync(annotations: Annotation[]) {
    if (this.colorTarget && !annotations.some((a) => a.id === this.colorTarget?.id))
      this.colorTarget = null;
    if (this.current) {
      const a = annotations.find((a) => a.id === this.current?.id);
      if (!a) {
        this.close();
      } else {
        this.current = a;
        this.updatePanel();
      }
    }
    if (this.previewAnnotation) {
      const a = annotations.find((a) => a.id === this.previewAnnotation?.id);
      this.previewAnnotation = a || null;
      this.previewText.textContent = a?.note || '';
      this.preview.hidden = !a?.note.trim();
    }
    const annotated = annotations.filter((a) => a.quote && a.note.trim());
    const ids = new Set(annotated.map((a) => a.id));
    for (const [id, marker] of this.indicators) {
      if (!ids.has(id)) {
        marker.button.remove();
        this.indicators.delete(id);
      }
    }
    for (const a of annotated) {
      let marker = this.indicators.get(a.id);
      if (!marker) {
        const b = button('查看批注笔记', 'note-indicator', '···');
        b.dataset.noteIndicator = a.id;
        b.onpointerenter = () => this.hover(this.indicators.get(a.id)?.annotation || null);
        b.onclick = () => {
          const current = this.indicators.get(a.id)?.annotation;
          if (current) this.show(current);
        };
        this.shadow.insertBefore(b, this.panel);
        marker = { annotation: a, button: b };
        this.indicators.set(a.id, marker);
      }
      marker.annotation = a;
    }
    this.reposition();
  }

  private updatePanel() {
    const a = this.current;
    if (!a) return;
    if (this.shadow.activeElement !== this.input) this.input.value = a.note;
    this.noteButton.textContent = a.note.trim() ? '编辑笔记' : '添加笔记';
    this.noteButton.setAttribute('aria-label', this.noteButton.textContent);
    for (const b of this.colors.querySelectorAll('button'))
      b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.color === a.color));
    this.colorInput.value = normalizeColor(a.color) || defaultColor;
    this.customColor.dataset.selected = String(isCustomColor(a.color));
    this.customColor.style.setProperty('--custom-ink', a.color);
  }

  show(a: Annotation, edit = false, focus = true) {
    this.clearPreview();
    this.current = a;
    this.group = `quote-note:${a.id}:${crypto.randomUUID()}`;
    this.title.textContent = a.type === 'underline' ? '下划线' : '高亮';
    this.input.value = a.note;
    this.input.hidden = this.footer.hidden = !edit;
    this.actions.hidden = this.colors.hidden = edit;
    this.panel.hidden = false;
    this.updatePanel();
    this.reposition();
    this.callbacks.select(a.id);
    if (edit && focus) this.input.focus({ preventScroll: true });
  }

  hover(a: Annotation | null) {
    if (!this.panel.hidden) return;
    // Leaving the text toward the preview (or anywhere) gives it a moment before it goes.
    if (!a?.note.trim() && this.previewAnnotation && !this.preview.hidden) {
      this.scheduleHide();
      return;
    }
    if (this.hovered === (a?.id || '')) {
      this.cancelHide();
      return;
    }
    this.clearPreview();
    if (!a?.note.trim()) return;
    this.hovered = a.id;
    this.timer = setTimeout(() => {
      const latest = this.indicators.get(a.id)?.annotation;
      if (!latest?.note.trim()) {
        this.clearPreview();
        return;
      }
      this.previewAnnotation = latest;
      this.previewText.textContent = latest.note;
      this.previewText.scrollTop = 0;
      this.preview.hidden = false;
      this.reposition();
    }, 280);
  }

  private place(el: HTMLElement, a: Annotation) {
    const r = this.callbacks.rect(a);
    if (!r) {
      el.hidden = true;
      return;
    }
    el.style.maxWidth = `${Math.min(el === this.preview ? 360 : 304, Math.max(0, innerWidth - 16))}px`;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, r.left))}px`;
    el.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, r.bottom + height + 10 < innerHeight ? r.bottom + 8 : r.top - height - 8))}px`;
  }

  reposition() {
    if (this.current && !this.panel.hidden) this.place(this.panel, this.current);
    if (this.previewAnnotation && !this.preview.hidden)
      this.place(this.preview, this.previewAnnotation);
    for (const { annotation: a, button: b } of this.indicators.values()) {
      const r = this.callbacks.markerRect(a);
      b.hidden =
        !r || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth;
      if (!r || b.hidden) continue;
      b.style.left = `${Math.max(2, Math.min(innerWidth - 24, r.left - 6))}px`;
      b.style.top = `${Math.max(2, r.top - 18)}px`;
    }
    this.indicatorVisibility();
  }

  private indicatorVisibility() {
    for (const [id, { button }] of this.indicators)
      button.dataset.previewing = String(
        (this.previewAnnotation?.id === id && !this.preview.hidden) ||
          (this.current?.id === id && !this.panel.hidden),
      );
  }

  private scheduleHide() {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      if (!this.overPreview) this.clearPreview();
    }, 350);
  }
  private cancelHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
  private clearPreview() {
    this.cancelHide();
    this.overPreview = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hovered = '';
    this.previewAnnotation = null;
    this.preview.hidden = true;
    this.indicatorVisibility();
  }

  close() {
    this.clearPreview();
    this.panel.hidden = true;
    this.current = null;
    this.input.blur();
    this.indicatorVisibility();
  }
}
