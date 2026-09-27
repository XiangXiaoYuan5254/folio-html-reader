// Pick mode for source editing, like the browser's element inspector: the element
// under the pointer is outlined and reported by the offset of the start tag that
// produced it (see markSourceOffsets); a click picks it without touching the page.
type Send = (type: string, payload?: Record<string, unknown>) => void;

const css = `
.box{position:fixed;display:none;pointer-events:none;background:rgba(47,139,126,.14);outline:1.5px solid #2f8b7e;outline-offset:-1px}
.label{position:fixed;display:none;pointer-events:none;max-width:min(420px,calc(100vw - 16px));padding:3px 7px;border-radius:4px;background:#243240;color:#fff;font:11px/1.5 Menlo,Consolas,"PingFang SC","Microsoft YaHei",monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px #0003}
.label b{color:#8fd9c9;font-weight:600}.label span{color:#b8c2cc;margin-left:6px}
`;

export class ElementInspector {
  private enabled = false;
  private host: HTMLElement | null = null;
  private box!: HTMLDivElement;
  private label!: HTMLDivElement;
  private current: HTMLElement | null = null;

  constructor(private send: Send) {}

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    const events = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'];
    if (on) {
      this.mount();
      window.addEventListener('pointermove', this.move, true);
      for (const type of events) window.addEventListener(type, this.block, true);
      window.addEventListener('scroll', this.redraw, true);
      window.addEventListener('resize', this.redraw);
    } else {
      window.removeEventListener('pointermove', this.move, true);
      for (const type of events) window.removeEventListener(type, this.block, true);
      window.removeEventListener('scroll', this.redraw, true);
      window.removeEventListener('resize', this.redraw);
      this.current = null;
      this.host?.remove();
      this.host = null;
    }
  }

  private mount() {
    const host = document.createElement('folio-inspector');
    host.dataset.folioUi = 'inspector';
    host.style.cssText =
      'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.label = document.createElement('div');
    this.label.className = 'label';
    root.append(style, this.box, this.label);
    document.documentElement.append(host);
    this.host = host;
  }

  private target(x: number, y: number) {
    const hit = document.elementsFromPoint(x, y).find((el) => !el.closest('[data-folio-ui]'));
    return hit?.closest<HTMLElement>('[data-folio-src]') || null;
  }

  private move = (e: PointerEvent) => {
    const el = this.target(e.clientX, e.clientY);
    if (el === this.current) return;
    this.current = el;
    this.redraw();
    if (el) this.send('inspect-hover', this.describe(el));
  };

  private block = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const { clientX, clientY } = e as MouseEvent;
    const el = this.target(clientX, clientY) || this.current;
    if (el) this.send('inspect-pick', this.describe(el));
  };

  private describe(el: HTMLElement) {
    return { offset: Number(el.dataset.folioSrc), tag: el.localName };
  }

  private redraw = () => {
    const el = this.current;
    if (!el || !el.isConnected) {
      this.box.style.display = this.label.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(this.box.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const classes = [...el.classList].map((c) => '.' + c).join('');
    const name = document.createElement('b');
    name.textContent = el.localName + (el.id ? '#' + el.id : '') + classes;
    const size = document.createElement('span');
    size.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    this.label.replaceChildren(name, size);
    this.label.style.display = 'block';
    const above = r.top >= 26;
    this.label.style.left = `${Math.max(4, Math.min(r.left, innerWidth - this.label.offsetWidth - 4))}px`;
    this.label.style.top = `${above ? r.top - 24 : Math.min(r.bottom + 4, innerHeight - 24)}px`;
  };
}
