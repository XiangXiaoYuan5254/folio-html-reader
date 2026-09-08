export type SelectionRect = { left: number; top: number; width: number; height: number };
const ns = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string | number>) {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** A visual-only layer: never changes saved ink or participates in hit testing. */
export class SelectionIndicator {
  private position = svg('g', { 'pointer-events': 'none', 'data-folio-selection': '' });
  private outline = svg('g', {});
  private animation: Animation | null = null;

  constructor(parent: SVGElement) {
    this.position.append(this.outline);
    parent.append(this.position);
  }

  sync(id: string | null, rects: SelectionRect[]) {
    this.position.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
    this.position.setAttribute('data-folio-selection', id || '');
    this.outline.replaceChildren();
    if (!id || !rects.length) {
      this.animation?.cancel();
      return;
    }
    for (const rect of rects) {
      const attrs = {
        x: rect.left - 5,
        y: rect.top - 5,
        width: Math.max(2, rect.width) + 10,
        height: Math.max(2, rect.height) + 10,
        rx: 4,
        fill: 'none',
        'vector-effect': 'non-scaling-stroke',
      };
      this.outline.append(
        svg('rect', { ...attrs, stroke: '#fff', 'stroke-width': 4, opacity: '.95' }),
        svg('rect', {
          ...attrs,
          stroke: '#6654d9',
          'stroke-width': 1.5,
          'stroke-dasharray': '5 4',
          'data-selection-outline': id,
        }),
      );
    }
  }

  flash() {
    this.animation?.cancel();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.animation = this.outline.animate(
      [0, -3, 3, -2, 2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 450, easing: 'ease-in-out' },
    );
  }
}
