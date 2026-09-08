// Relay wheel input, never scroll events: restoration, zoom and the receiving
// pane's programmatic scroll must not feed back into the other document.
export class LinkedScroll {
  private enabled = false;
  private delta = 0;
  private frame = 0;

  constructor(private request: (delta: number) => void) {
    window.addEventListener('wheel', this.wheel, { passive: false });
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.delta = 0;
    }
  }

  private wheel = (e: WheelEvent) => {
    if (
      !this.enabled ||
      e.defaultPrevented ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      !Number.isFinite(e.deltaY) ||
      !e.deltaY ||
      Math.abs(e.deltaX) > Math.abs(e.deltaY)
    )
      return;
    for (const node of e.composedPath()) {
      if (
        !(node instanceof HTMLElement) ||
        node === document.body ||
        node === document.documentElement
      )
        continue;
      // Editing a note or scrolling an embedded table must remain local. The
      // drawing overlay itself is deliberately allowed to relay page scrolling.
      if (
        node.matches(
          'input,textarea,select,[contenteditable],[data-folio-ui="notes"],[data-folio-ui="annotation-popup"]',
        )
      )
        return;
      if (
        node.scrollHeight > node.clientHeight + 1 &&
        /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)
      )
        return;
    }
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    this.delta += e.deltaY * unit;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const delta = this.delta;
      this.delta = 0;
      if (this.enabled && delta) this.request(delta);
    });
  };

  move(delta: number, scale: number) {
    if (!Number.isFinite(delta) || !Number.isFinite(scale) || scale <= 0) return;
    scrollBy({ top: delta / scale, behavior: 'instant' });
  }
}
