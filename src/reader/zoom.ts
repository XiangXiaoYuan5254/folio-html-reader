type ZoomAnchor = {
  rect: () => { left: number; top: number; width: number; height: number };
  x: number;
  y: number;
  screenX: number;
  screenY: number;
};

// The iframe reflows when its CSS scale changes. Keep a character (or an
// element in non-text content) under the pointer instead of preserving only
// scrollY, which would jump to a different paragraph after reflow.
export class ReaderZoom {
  private scale = 1;
  private enabled = true;
  private delta = 0;
  private frame = 0;
  private waiting = false;
  private anchor: ZoomAnchor | null = null;
  private pointer = { x: 0, y: 0 };

  constructor(
    private request: (delta: number) => void,
    private repaint: () => void,
  ) {
    window.addEventListener('wheel', this.wheel, { passive: false, capture: true });
  }

  private wheel = (e: WheelEvent) => {
    if (!this.enabled || !e.metaKey || !Number.isFinite(e.deltaY) || !e.deltaY) return;
    e.preventDefault();
    e.stopPropagation();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    this.delta += e.deltaY * unit;
    this.pointer = { x: e.clientX * this.scale, y: e.clientY * this.scale };
    this.schedule();
  };

  private schedule() {
    if (this.frame || this.waiting || !this.delta || !this.enabled) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const delta = this.delta;
      this.delta = 0;
      this.anchor = this.capture();
      this.waiting = true;
      this.request(delta);
    });
  }

  private capture(): ZoomAnchor {
    const x = this.pointer.x / this.scale,
      y = this.pointer.y / this.scale;
    const range = document.caretRangeFromPoint(x, y);
    let rect: ZoomAnchor['rect'] | undefined;
    if (
      range?.startContainer.nodeType === Node.TEXT_NODE &&
      !range.startContainer.parentElement?.closest('[data-folio-ui],input,textarea,select')
    ) {
      const node = range.startContainer as Text;
      const start = Math.min(range.startOffset, Math.max(0, node.length - 1));
      range.setStart(node, start);
      range.setEnd(node, Math.min(start + 1, node.length));
      const r = range.getBoundingClientRect();
      if (r.height && x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4)
        rect = () => range.getBoundingClientRect();
    }
    if (!rect) {
      const el = document
        .elementsFromPoint(x, y)
        .find(
          (el) =>
            el !== document.body &&
            el !== document.documentElement &&
            !el.closest('[data-folio-ui]'),
        );
      if (el) rect = () => el.getBoundingClientRect();
    }
    // Blank document margins have no layout element to follow.
    if (!rect) {
      const left = scrollX + x,
        top = scrollY + y;
      rect = () => ({ left: left - scrollX, top: top - scrollY, width: 0, height: 0 });
    }
    const r = rect();
    return {
      rect,
      x: r.width ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0,
      y: r.height ? Math.max(0, Math.min(1, (y - r.top) / r.height)) : 0,
      screenX: this.pointer.x,
      screenY: this.pointer.y,
    };
  }

  apply(scale: number, enabled = true) {
    this.scale = scale || 1;
    this.enabled = enabled;
    if (!enabled) {
      this.delta = 0;
      this.anchor = null;
    }
    if (!this.waiting) return;
    // The parent sends this after committing the new iframe size/transform.
    requestAnimationFrame(() => {
      const anchor = this.anchor;
      this.anchor = null;
      if (anchor) {
        const r = anchor.rect();
        scrollBy({
          left: r.left + r.width * anchor.x - anchor.screenX / this.scale,
          top: r.top + r.height * anchor.y - anchor.screenY / this.scale,
          behavior: 'instant',
        });
      }
      this.waiting = false;
      this.repaint();
      this.schedule();
    });
  }
}
