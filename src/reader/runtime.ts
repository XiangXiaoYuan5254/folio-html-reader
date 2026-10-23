import type { Anchor, Annotation, EraserMode, Point, Tool } from '../types';
import { erasePaths, inkPaths, inkPathData, inkBounds, smoothPoints } from './ink';
import { PageNotes } from './notes';
import { AnnotationPopup } from './annotation-popup';
import { STICKY_MIN_WIDTH, STICKY_PIN_SIZE, stickyNoteSize, textNoteWidth } from './note-size';
import { penCursor } from './pen-cursor';
import { defaultColor, defaultStickyColor, normalizeColor } from '../colors';
import { SelectionIndicator } from './selection-indicator';
import type { SelectionRect } from './selection-indicator';
import { ReaderZoom } from './zoom';
import { LinkedScroll } from './linked-scroll';
import { capturePdfRects, pdfQuoteRects, pdfPageAnchor } from './pdf-anchors';
import { ElementInspector } from './inspector';
import { readableText } from './readable-text';
import { findQuote } from '../ai/quote-match';
(() => {
  const channel = 'folio-reader-v1';
  const send = (type: string, payload: Record<string, unknown> = {}) =>
    parent.postMessage({ channel, type, ...payload }, '*');
  const inspector = new ElementInspector(send);
  let annotations: Annotation[] = [];
  let tool: Tool = 'select';
  let toolPinned = false;
  let editingPageNote = false;
  let color = defaultColor;
  let stickyColor = defaultStickyColor;
  let strokeWidth = 2.5;
  let eraserSize = 24;
  let eraserMode: EraserMode = 'partial';
  let gestureEraserMode: EraserMode = 'partial';
  let stickySize = stickyNoteSize(null);
  let textWidth = textNoteWidth(null);
  let selection: Anchor | null = null;
  let selectionClick = false;
  let selectionBoxPending = false;
  // The annotation ids last reported in reading order.
  let readingOrder = '';
  let points: Point[] = [];
  let drawingAnchor: Annotation['anchor'];
  let isDrawing = false;
  let isErasing = false;
  let activePointer = -1;
  let activePointerType = '';
  let strokeTool: Tool = 'pen';
  let strokeColor = color;
  let strokeSize = strokeWidth;
  let eraseLast: Point | null = null;
  let eraseOriginal: Annotation[] = [];
  const erased = new Set<string>();
  let temporaryEraser = false;
  let svg: SVGSVGElement;
  let layer: SVGGElement;
  let previewLayer: SVGGElement;
  let laserLayer: SVGGElement;
  let cursor: SVGCircleElement;
  let notes: PageNotes;
  let popup: AnnotationPopup;
  let indicator: SelectionIndicator;
  let readerZoom: ReaderZoom;
  let linkedScroll: LinkedScroll;
  // Only an explicit sidebar jump enables the visual locator. The active
  // annotation also changes during drawing/editing and must not enable it.
  let located: string | null = null;
  let attentionPending = false;
  let hitRegions: {
    id: string;
    rects: { left: number; top: number; right: number; bottom: number }[];
  }[] = [];
  let previewPending = false;
  let hover: SVGPathElement | SVGRectElement | null = null;
  let pending = false;
  let ready = false;
  let lastScroll = 0;
  let restoreScroll: number | null = null;
  const ns = 'http://www.w3.org/2000/svg';
  const svgEl = (name: string, attrs: Record<string, string | number> = {}) => {
    const e = document.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  function textIndex() {
    const nodes: { node: Text; start: number; end: number }[] = [];
    let text = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest(
          'script,style,noscript,[data-folio-ui],svg,textarea,select',
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const start = text.length;
      text += node.data;
      nodes.push({ node, start, end: text.length });
    }
    return { text, nodes };
  }
  function captureSelection() {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    if (!document.body.contains(r.commonAncestorContainer)) return null;
    const { text, nodes } = textIndex();
    const a = nodes.find((n) => n.node === r.startContainer),
      b = nodes.find((n) => n.node === r.endContainer);
    let start = a ? a.start + r.startOffset : text.indexOf(r.toString());
    let end = b ? b.start + r.endOffset : start + r.toString().length;
    if (start < 0 || end <= start || end - start > 100_000) return null;
    return {
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - 48), start),
      suffix: text.slice(end, end + 48),
      start,
      end,
      ...(document.documentElement.dataset.folioPdf ? { pdfRects: capturePdfRects(r) } : {}),
    };
  }
  // The selected text's box in this window, so the app can place its toolbar beside it.
  function selectionBox() {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    let box: { left: number; top: number; right: number; bottom: number } | null = null;
    for (const r of Array.from(s.getRangeAt(0).getClientRects())) {
      if (!r.width || !r.height) continue;
      box = box
        ? {
            left: Math.min(box.left, r.left),
            top: Math.min(box.top, r.top),
            right: Math.max(box.right, r.right),
            bottom: Math.max(box.bottom, r.bottom),
          }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return box;
  }
  // The selection moves with the page; its toolbar follows once per frame.
  function followSelection() {
    if (!selection || selectionBoxPending) return;
    selectionBoxPending = true;
    requestAnimationFrame(() => {
      selectionBoxPending = false;
      if (selection) send('selection-box', { rect: selectionBox() });
    });
  }
  function locate(quote: Anchor, index = textIndex()) {
    const { text, nodes } = index;
    let pos = -1;
    if (
      text.slice(quote.start, quote.end) === quote.exact &&
      text.slice(Math.max(0, quote.start - quote.prefix.length), quote.start) === quote.prefix &&
      text.slice(quote.end, quote.end + quote.suffix.length) === quote.suffix
    )
      pos = quote.start;
    else {
      let best = -Infinity;
      let ambiguous = false;
      let at = text.indexOf(quote.exact);
      while (at !== -1) {
        let score = 0;
        const pre = text.slice(Math.max(0, at - 48), at),
          suf = text.slice(at + quote.exact.length, at + quote.exact.length + 48);
        for (let i = 1; i <= Math.min(pre.length, quote.prefix.length); i++) {
          if (pre.at(-i) !== quote.prefix.at(-i)) break;
          score++;
        }
        for (let i = 0; i < Math.min(suf.length, quote.suffix.length); i++) {
          if (suf[i] !== quote.suffix[i]) break;
          score++;
        }
        if (score > best) {
          best = score;
          pos = at;
          ambiguous = false;
        } else if (score === best) ambiguous = true;
        at = text.indexOf(quote.exact, at + Math.max(1, quote.exact.length));
      }
      if (ambiguous) pos = -1;
    }
    if (pos < 0) return null;
    return rangeAt(pos, pos + quote.exact.length, nodes);
  }
  function rangeAt(start: number, end: number, nodes: ReturnType<typeof textIndex>['nodes']) {
    const a = nodes.find((n) => n.start <= start && n.end > start),
      b = nodes.find((n) => n.start < end && n.end >= end);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, start - a.start);
    r.setEnd(b.node, end - b.start);
    return r;
  }
  const isPdf = () => !!document.documentElement.dataset.folioPdf;
  // PDF text layers load in the background; HTML may still be filled in by its own scripts.
  function whenTextReady() {
    if (isPdf())
      return new Promise<void>((resolve) =>
        document.dispatchEvent(new CustomEvent('folio:pdf-when-text', { detail: { resolve } })),
      );
    if (document.readyState === 'complete') return new Promise((r) => setTimeout(r, 150));
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4000);
      window.addEventListener('load', () => {
        clearTimeout(timer);
        setTimeout(resolve, 150);
      });
    });
  }
  async function aiText() {
    await whenTextReady();
    if (isPdf())
      return new Promise((resolve) =>
        document.dispatchEvent(new CustomEvent('folio:pdf-text', { detail: { resolve } })),
      );
    return { title: document.title, text: readableText(document.body) };
  }
  // A PDF's figures and tables, cut out for 全文翻译.
  function aiFigures() {
    if (!isPdf()) return Promise.resolve([]);
    return new Promise((resolve) =>
      document.dispatchEvent(new CustomEvent('folio:pdf-figures', { detail: { resolve } })),
    );
  }
  // What a box framed on the page (for the whiteboard) covers: the text inside it, the text
  // in view around it, and in a PDF the page it is on. The box is in viewport coordinates.
  function regionText(box: { left: number; top: number; right: number; bottom: number }) {
    const meets = (r: DOMRect, b: typeof box) =>
      r.width + r.height > 0 &&
      r.right > b.left &&
      r.left < b.right &&
      r.bottom > b.top &&
      r.top < b.bottom;
    const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const inside: string[] = [];
    const visible: string[] = [];
    let seen = 0;
    const range = document.createRange();
    for (const { node } of textIndex().nodes) {
      const data = node.data.replace(/\s+/g, ' ').trim();
      if (!data) continue;
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      if (!rects.some((r) => meets(r, view))) continue;
      if (seen < 8_000) visible.push(data);
      seen += data.length;
      if (rects.some((r) => meets(r, box))) inside.push(data);
    }
    const x = (box.left + box.right) / 2;
    const y = (box.top + box.bottom) / 2;
    const page = isPdf()
      ? Number(
          (document.elementFromPoint(x, y)?.closest('[data-pdf-page]') as HTMLElement | null)
            ?.dataset.pdfPage,
        ) || undefined
      : undefined;
    return {
      inside: inside.join(' ').slice(0, 4_000),
      visible: visible.join(' ').slice(0, 8_000),
      page,
    };
  }
  // Anchors for quotes a model chose, in the same form a manual highlight saves.
  async function aiAnchors(quotes: string[]) {
    await whenTextReady();
    const index = textIndex();
    return quotes.map((quote): Anchor | null => {
      const found = typeof quote === 'string' ? findQuote(index.text, quote) : null;
      if (!found) return null;
      const { start, end } = found;
      const anchor: Anchor = {
        exact: index.text.slice(start, end),
        prefix: index.text.slice(Math.max(0, start - 48), start),
        suffix: index.text.slice(end, end + 48),
        start,
        end,
      };
      // PDF highlights keep page geometry; if it can't be measured right now, the text
      // anchor alone still finds the passage, as it does in HTML.
      if (isPdf()) {
        const range = rangeAt(start, end, index.nodes);
        const rects = range ? capturePdfRects(range) : undefined;
        if (rects?.length) anchor.pdfRects = rects;
      }
      return anchor;
    });
  }
  // 同步滚动 between a translation (全文翻译) and the PDF it was made from: each side turns its
  // scroll position into one measure, the original's page number plus how far into the page
  // (a translation's blocks carry theirs as data-at), and follows the other side's.
  let paired = false;
  let followUntil = 0;
  let pairFrame = 0;
  let marks: { key: string; points: { y: number; at: number }[] } | null = null;
  // The line the eyes are on, a little below the top.
  const readingLine = () => innerHeight * 0.3;
  // A PDF page's blank margin at the top and the bottom.
  const pageMargin = 0.07;
  const pairOf = () =>
    document.querySelector<HTMLMetaElement>('meta[name="folio-translation"]')?.content || '';
  function translationPoints() {
    const key = `${document.documentElement.scrollHeight}:${innerWidth}`;
    if (marks?.key === key) return marks.points;
    const points = Array.from(document.querySelectorAll<HTMLElement>('[data-at]'))
      .map((el) => ({ y: el.getBoundingClientRect().top + scrollY, at: Number(el.dataset.at) }))
      .filter((p) => Number.isFinite(p.y) && Number.isFinite(p.at));
    // The top of the translation goes with the top of the first page.
    if (points.length) points.unshift({ y: 0, at: Math.floor(points[0].at) });
    marks = { key, points };
    return points;
  }
  // Between two known points, both measures move in step.
  function along(
    points: { y: number; at: number }[],
    from: 'y' | 'at',
    to: 'y' | 'at',
    value: number,
  ) {
    let i = -1;
    while (i + 1 < points.length && points[i + 1][from] <= value) i++;
    if (i < 0) return points[0]?.[to] ?? NaN;
    const a = points[i];
    const b = points[i + 1];
    if (!b || b[from] === a[from]) return a[to];
    return a[to] + ((b[to] - a[to]) * (value - a[from])) / (b[from] - a[from]);
  }
  function pdfPages() {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-pdf-page]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { n: Number(el.dataset.pdfPage), top: r.top + scrollY, height: r.height };
    });
  }
  // The measure at a point down the document, and the point for a measure.
  function measureAt(y: number) {
    if (!isPdf()) return along(translationPoints(), 'y', 'at', y);
    const pages = pdfPages();
    let page = pages[0];
    for (const p of pages) if (p.top <= y) page = p;
    if (!page) return NaN;
    const f = ((y - page.top) / Math.max(1, page.height) - pageMargin) / (1 - 2 * pageMargin);
    return page.n + Math.max(0, Math.min(0.999, f));
  }
  function pointFor(at: number) {
    if (!isPdf()) return along(translationPoints(), 'at', 'y', at);
    const pages = pdfPages();
    const page = pages.find((p) => p.n === Math.floor(at)) || (at < 1 ? pages[0] : pages.at(-1));
    if (!page) return NaN;
    const f = Math.max(0, Math.min(1, at - page.n));
    return page.top + page.height * (pageMargin + (1 - 2 * pageMargin) * f);
  }
  function pairScrolled() {
    if (!paired || pairFrame || Date.now() < followUntil) return;
    pairFrame = requestAnimationFrame(() => {
      pairFrame = 0;
      const at = measureAt(scrollY + readingLine());
      if (Number.isFinite(at)) send('pair-scroll', { at });
    });
  }
  // Following the other side doesn't report back, or the two would chase each other.
  function pairFollow(at: number) {
    const y = paired && Number.isFinite(at) ? pointFor(at) : NaN;
    if (!Number.isFinite(y)) return;
    followUntil = Date.now() + 250;
    cancelAnimationFrame(pairFrame);
    pairFrame = 0;
    scrollTo({ top: Math.max(0, y - readingLine()), behavior: 'instant' });
  }
  // Jumps the reader asks for (a heading, an annotation, a cited passage) glide there.
  const glide = (): ScrollBehavior =>
    matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  // Briefly marks a cited passage without saving anything.
  let citeLayer: SVGGElement | null = null;
  let citeTimer: ReturnType<typeof setTimeout> | undefined;
  async function flashQuote(quote: string, page = 0) {
    await whenTextReady();
    const index = textIndex();
    // In a PDF, the passage on that page rather than the same words somewhere else.
    const near =
      page && isPdf()
        ? index.nodes.find((n) => n.node.parentElement?.closest(`[data-pdf-page="${page}"]`))?.start
        : undefined;
    const found = findQuote(index.text, quote, near);
    const range = found && rangeAt(found.start, found.end, index.nodes);
    const rects = Array.from(range?.getClientRects() || []).filter((r) => r.width && r.height);
    if (!rects.length) return false;
    const first = rects[0];
    if (first.top < 40 || first.bottom > innerHeight - 40)
      scrollTo({ top: Math.max(0, first.top + scrollY - innerHeight / 3), behavior: glide() });
    citeLayer?.remove();
    clearTimeout(citeTimer);
    const layerNode = svgEl('g', {
      'data-folio-cite': '',
      'pointer-events': 'none',
    }) as SVGGElement;
    for (const r of Array.from(range!.getClientRects()).filter((r) => r.width && r.height))
      layerNode.append(
        svgEl('rect', {
          x: r.left + scrollX - 2,
          y: r.top + scrollY - 1,
          width: r.width + 4,
          height: r.height + 2,
          rx: 3,
          fill: '#6654d9',
          'fill-opacity': '.16',
          stroke: '#6654d9',
          'stroke-width': 1.2,
          'stroke-dasharray': '4 3',
        }),
      );
    layerNode.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
    svg.append(layerNode);
    citeLayer = layerNode;
    const fade = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? null
      : layerNode.animate([{ opacity: 1 }, { opacity: 0 }], {
          delay: 2600,
          duration: 600,
          fill: 'forwards',
        });
    citeTimer = setTimeout(() => {
      fade?.cancel();
      layerNode.remove();
      if (citeLayer === layerNode) citeLayer = null;
    }, 3300);
    return true;
  }
  function point(e: PointerEvent): Point {
    return {
      x: Math.round((e.clientX + scrollX) * 10) / 10,
      y: Math.round((e.clientY + scrollY) * 10) / 10,
    };
  }
  function quoteRects(quote: Anchor): DOMRect[] {
    return pdfQuoteRects(quote) || Array.from(locate(quote)?.getClientRects() || []);
  }
  function selector(el: Element): string {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      let n = 1;
      let prev = current.previousElementSibling;
      while (prev) {
        if (prev.tagName === current.tagName) n++;
        prev = prev.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${n})`);
      current = current.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  }
  function offset(a: Annotation) {
    if (!a.anchor) return { x: 0, y: 0 };
    try {
      const el = document.querySelector(a.anchor.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX - a.anchor.left, y: r.top + scrollY - a.anchor.top };
      }
    } catch {}
    return { x: 0, y: 0 };
  }
  function shape(a: Annotation) {
    const p = a.points || [];
    if (!['pen', 'arrow', 'rectangle'].includes(a.type) || !inkPaths(a).length) return null;
    const o = offset(a);
    const first = p[0],
      last = p[p.length - 1];
    let e;
    if (a.type === 'rectangle' && !a.paths)
      e = svgEl('rect', {
        x: Math.min(first.x, last.x) + o.x,
        y: Math.min(first.y, last.y) + o.y,
        width: Math.abs(last.x - first.x),
        height: Math.abs(last.y - first.y),
        rx: 2,
      });
    else {
      e = svgEl('path', { d: inkPathData(inkPaths(a), o) });
    }
    e.setAttribute('stroke', a.color);
    e.setAttribute('fill', 'none');
    e.setAttribute('stroke-width', String(a.strokeWidth || 2.5));
    e.setAttribute('stroke-linecap', 'round');
    e.setAttribute('stroke-linejoin', 'round');
    e.setAttribute('data-annotation-id', a.id);
    return e;
  }
  function render() {
    pending = false;
    if (!layer) return;
    layer.replaceChildren();
    layer.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
    const index = textIndex();
    const missing: string[] = [];
    const marked = new Map<string, number>();
    hitRegions = [];
    for (const a of annotations) {
      if (a.quote) {
        const rects =
          pdfQuoteRects(a.quote) || Array.from(locate(a.quote, index)?.getClientRects() || []);
        if (!rects.length) {
          missing.push(a.id);
          continue;
        }
        const first = rects.find((r) => r.width && r.height);
        if (first) marked.set(a.id, first.top + scrollY);
        for (const rect of rects) {
          if (!rect.width || !rect.height) continue;
          const e = svgEl('rect', {
            x: rect.left + scrollX,
            y: (a.type === 'underline' ? rect.bottom - 2 : rect.top) + scrollY,
            width: rect.width,
            height: a.type === 'underline' ? 2 : rect.height,
            fill: a.color,
            opacity: a.type === 'underline' ? '.9' : '.28',
            rx: 1,
            'data-annotation-id': a.id,
          });
          layer.append(e);
        }
        hitRegions.push({
          id: a.id,
          rects: rects
            .filter((r) => r.width && r.height)
            .map((r) => ({
              left: r.left + scrollX,
              top: r.top + scrollY,
              right: r.right + scrollX,
              bottom: r.bottom + scrollY,
            })),
        });
      } else {
        const e = shape(a);
        if (e) layer.append(e);
      }
    }
    if (missing.join(',') !== svg.dataset.orphans) {
      svg.dataset.orphans = missing.join(',');
      send('orphans', { ids: missing });
    }
    notes?.sync(annotations);
    popup?.sync(annotations);
    reportReadingOrder(marked);
    const current = annotations.find((a) => a.id === located);
    indicator?.sync(current?.id || null, current ? selectionRects(current) : []);
    if (attentionPending && current) indicator.flash();
    attentionPending = false;
  }
  // The side panel lists annotations in reading order. Text marks follow their text
  // (which keeps two-column PDFs column by column); notes and drawings go before the
  // first mark below them. Marks whose text is gone come last.
  function reportReadingOrder(marked: Map<string, number>) {
    const marks: { id: string; top: number; start: number }[] = [];
    const placed: { id: string; top: number; left: number }[] = [];
    const unplaced: string[] = [];
    for (const a of annotations) {
      if (a.quote) {
        const top = marked.get(a.id);
        if (top === undefined) unplaced.push(a.id);
        else marks.push({ id: a.id, top, start: a.quote.start || 0 });
        continue;
      }
      const r = selectionRects(a)[0];
      if (r) placed.push({ id: a.id, top: r.top, left: r.left });
      else unplaced.push(a.id);
    }
    marks.sort((a, b) => a.start - b.start);
    placed.sort((a, b) => a.top - b.top || a.left - b.left);
    const ids: string[] = [];
    let next = 0;
    for (const m of marks) {
      while (next < placed.length && placed[next].top <= m.top) ids.push(placed[next++].id);
      ids.push(m.id);
    }
    ids.push(...placed.slice(next).map((p) => p.id), ...unplaced);
    if (ids.join(',') === readingOrder) return;
    readingOrder = ids.join(',');
    send('order', { ids });
  }
  function selectionRects(a: Annotation): SelectionRect[] {
    if (a.quote)
      return quoteRects(a.quote)
        .filter((r) => r.width && r.height)
        .map((r) => ({
          left: r.left + scrollX,
          top: r.top + scrollY,
          width: r.width,
          height: r.height,
        }));
    if (['text', 'sticky'].includes(a.type)) {
      const r = notes.rect(a.id);
      return r
        ? [{ left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height }]
        : [];
    }
    const bounds = inkBounds(inkPaths(a));
    if (!bounds) return [];
    const o = offset(a),
      pad = (a.strokeWidth || 2.5) / 2;
    return [
      {
        left: bounds.left + o.x - pad,
        top: bounds.top + o.y - pad,
        width: bounds.width + pad * 2,
        height: bounds.height + pad * 2,
      },
    ];
  }
  function clearLocation() {
    located = null;
    attentionPending = false;
    schedule();
  }
  function selectAnnotation(id: string | null) {
    clearLocation();
    send('select-annotation', { id });
  }
  function revealAnnotation(a: Annotation) {
    // Already-visible neighbors stay still, making rapid comparisons easy.
    const rects = selectionRects(a);
    const r =
      rects.find((r) => r.top >= scrollY + 24 && r.top + r.height <= scrollY + innerHeight - 24) ||
      rects[0];
    if (!r) return;
    const top = r.top - scrollY,
      left = r.left - scrollX;
    if (
      top < 24 ||
      top + r.height > innerHeight - 24 ||
      left < 16 ||
      left + r.width > innerWidth - 16
    )
      scrollTo({
        top: Math.max(0, r.top - Math.max(32, (innerHeight - r.height) / 2)),
        left: Math.max(0, r.left - Math.max(16, (innerWidth - r.width) / 2)),
        behavior: glide(),
      });
  }
  function schedule() {
    if (!pending) {
      pending = true;
      requestAnimationFrame(render);
    }
  }
  function restorePosition() {
    // Electron can deliver the document's ready message before the iframe
    // has a viewport. Wait for its first real layout before restoring scroll.
    if (restoreScroll === null || !innerWidth || !innerHeight) return;
    const top = restoreScroll;
    restoreScroll = null;
    scrollTo(0, top);
  }
  function annotate(type: string) {
    if (type !== 'highlight' && type !== 'underline') return;
    const q = captureSelection();
    if (!q) return;
    const a: Annotation = {
      id: crypto.randomUUID(),
      type,
      color,
      quote: q,
      note: '',
      createdAt: Date.now(),
    };
    window.getSelection()?.removeAllRanges();
    selection = null;
    send('selection', { quote: null });
    create(a);
  }
  function setTool(next: Tool) {
    const changed = tool !== next;
    tool = next;
    if (changed) editingPageNote = false;
    const drawing = ['pen', 'laser', 'arrow', 'rectangle', 'eraser', 'sticky', 'text'].includes(
      tool,
    );
    svg.style.pointerEvents = drawing ? 'auto' : 'none';
    // On a touchscreen, a finger or pen drag would otherwise scroll the page
    // and cancel the stroke; drawing tools keep the drag for themselves.
    svg.style.touchAction = drawing ? 'none' : '';
    svg.style.cursor =
      tool === 'pen'
        ? penCursor(color)
        : ['eraser', 'laser'].includes(tool)
          ? 'none'
          : tool === 'text'
            ? 'text'
            : drawing
              ? 'crosshair'
              : 'auto';
    if (changed) cursor.style.display = 'none';
    if (changed) popup?.close();
    schedule();
  }
  function anchorAt(p: Point): Annotation['anchor'] {
    if (document.documentElement.dataset.folioPdf) return pdfPageAnchor(p);
    const target = document
      .elementsFromPoint(p.x - scrollX, p.y - scrollY)
      .find((el) => !el.closest('[data-folio-ui]'))
      ?.closest('p,h1,h2,h3,h4,figure,img,section,article,div');
    if (!target || target === document.body || target.closest('[data-folio-ui]')) return undefined;
    const r = target.getBoundingClientRect();
    return { selector: selector(target), top: r.top + scrollY, left: r.left + scrollX };
  }
  function notePosition(a: Annotation): Point | null {
    // A collapsed pin near the right edge opens its card shifted left to fit.
    const width = a.collapsed ? STICKY_PIN_SIZE : a.size?.width || 300;
    if (a.points?.length) {
      const o = offset(a);
      // Keep margin notes reachable when a sidebar or browser-style zoom
      // narrows the page. The saved location returns when it widens again.
      return {
        x: Math.max(
          0,
          Math.min(document.documentElement.scrollWidth - width - 8, a.points[0].x + o.x),
        ),
        y: a.points[0].y + o.y,
      };
    }
    if (a.quote) {
      const r = locate(a.quote)?.getBoundingClientRect();
      if (r)
        return {
          x: Math.max(
            8,
            Math.min(document.documentElement.scrollWidth - width - 12, r.left + scrollX),
          ),
          y: r.bottom + scrollY + 10,
        };
    }
    return null;
  }
  function create(a: Annotation, focus = false) {
    clearLocation();
    annotations = [...annotations, a];
    send('create', { annotation: a });
    schedule();
    if (focus) {
      if (a.quote) popup.show(a, true);
      else {
        notes.sync(annotations);
        notes.open(a.id);
      }
    }
  }
  function updateAnnotation(id: string, patch: Partial<Annotation>, group?: string) {
    annotations = annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
    send('update-annotation', { id, patch, group });
    schedule();
  }
  function quoteRect(a: Annotation) {
    if (!a.quote) return null;
    const rects = quoteRects(a.quote);
    return rects.find((r) => r.bottom > 0 && r.top < innerHeight) || rects[0] || null;
  }
  function hitAnnotation(e: MouseEvent) {
    const x = e.clientX + scrollX,
      y = e.clientY + scrollY;
    const hit = [...hitRegions]
      .reverse()
      .find((h) => h.rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
    return annotations.find((a) => a.id === hit?.id) || null;
  }
  function pointerCursor(e: PointerEvent) {
    // The pen already has a native crosshair with a center dot. A second
    // DOM dot repaints behind the native cursor and appears to chase it.
    // Only tools that hide the native cursor need this rendered indicator.
    if (!['eraser', 'laser'].includes(tool)) {
      cursor.style.display = 'none';
      return;
    }
    cursor.style.display = '';
    cursor.setAttribute('cx', String(e.clientX));
    cursor.setAttribute('cy', String(e.clientY));
    cursor.setAttribute('r', String(tool === 'eraser' ? eraserSize / 2 : 5));
    cursor.setAttribute('fill', tool === 'eraser' ? '#ffffff66' : '#fff');
    cursor.setAttribute('stroke', tool === 'eraser' ? '#566a72' : '#ff4b57');
    cursor.setAttribute('stroke-width', tool === 'eraser' ? '1.3' : '3');
    cursor.setAttribute(
      'stroke-dasharray',
      tool === 'eraser' && eraserMode === 'stroke' ? '3 2' : 'none',
    );
    cursor.style.filter = tool === 'laser' ? 'drop-shadow(0 0 5px #ff3b49)' : '';
  }
  function erase(from: Point, to: Point) {
    let changed = false;
    annotations = annotations.flatMap((a) => {
      if (!['pen', 'arrow', 'rectangle'].includes(a.type)) return [a];
      const paths = inkPaths(a),
        o = offset(a);
      const next = erasePaths(
        paths,
        { x: from.x - o.x, y: from.y - o.y },
        { x: to.x - o.x, y: to.y - o.y },
        eraserSize / 2 + (a.strokeWidth || 2.5) / 2,
        gestureEraserMode,
      );
      if (next === paths) return [a];
      changed = true;
      erased.add(a.id);
      return next.length ? [{ ...a, paths: next }] : [];
    });
    if (changed) schedule();
  }
  function previewStroke() {
    hover?.remove();
    hover = shape({
      id: 'preview',
      type: (strokeTool === 'laser' ? 'pen' : strokeTool) as Annotation['type'],
      points: ['pen', 'laser'].includes(strokeTool) ? smoothPoints(points) : points,
      color: strokeTool === 'laser' ? '#ff4557' : strokeColor,
      strokeWidth: strokeTool === 'laser' ? 4 : strokeSize,
      note: '',
      createdAt: 0,
    }) as typeof hover;
    if (hover) {
      if (strokeTool === 'laser') hover.style.filter = 'drop-shadow(0 0 4px #ff596c)';
      previewLayer.append(hover);
    }
  }
  function schedulePreview() {
    if (previewPending) return;
    previewPending = true;
    requestAnimationFrame(() => {
      previewPending = false;
      if (isDrawing) previewStroke();
    });
  }
  function finishGesture(cancel = false) {
    const wasDrawing = isDrawing,
      wasErasing = isErasing;
    isDrawing = false;
    isErasing = false;
    if (wasDrawing && strokeTool === 'laser' && !cancel && points.length) {
      previewStroke();
      if (hover) {
        hover.removeAttribute('data-annotation-id');
        hover.setAttribute('data-folio-laser', 'true');
        laserLayer.append(hover);
        const fading = hover;
        fading.animate([{ opacity: 1 }, { opacity: 0 }], {
          delay: 2200,
          duration: 700,
          fill: 'forwards',
        });
        setTimeout(() => fading.remove(), 3000);
        hover = null;
      }
    }
    hover?.remove();
    hover = null;
    try {
      if (activePointer >= 0) svg.releasePointerCapture(activePointer);
    } catch {}
    activePointer = -1;
    if (wasErasing) {
      if (cancel) annotations = eraseOriginal;
      else if (erased.size)
        send('erase-ink', {
          changes: annotations
            .filter((a) => erased.has(a.id))
            .map((a) => ({ id: a.id, paths: a.paths })),
          removed: [...erased].filter((id) => !annotations.some((a) => a.id === id)),
        });
      erased.clear();
      eraseOriginal = [];
      eraseLast = null;
      schedule();
    }
    if (
      wasDrawing &&
      strokeTool !== 'laser' &&
      !cancel &&
      points.length &&
      (strokeTool === 'pen' || points.length > 1)
    )
      create({
        id: crypto.randomUUID(),
        type: strokeTool as Annotation['type'],
        color: strokeColor,
        strokeWidth: strokeSize,
        points: strokeTool === 'pen' ? smoothPoints(points) : points,
        anchor: drawingAnchor,
        note: '',
        createdAt: Date.now(),
      });
    points = [];
  }
  // Whether a stroke ignores this event: a second finger or a palm. A pen or
  // mouse has a single pointer, so a new one means the stroke's pointer was
  // released outside the reader; a pen lifted over the app shell comes back
  // with a new pointerId. That, or the stroke's own pointer pressing again or
  // moving with no button down, ends the stroke instead.
  function ignoredPointer(e: PointerEvent) {
    if (activePointer < 0) return false;
    if (e.pointerId !== activePointer) {
      if (e.pointerType === 'touch' || activePointerType === 'touch') return true;
      finishGesture();
    } else if (e.type === 'pointerdown' || (e.type === 'pointermove' && !e.buttons))
      finishGesture();
    return false;
  }
  function outline() {
    if (document.documentElement.dataset.folioPdf) {
      document.dispatchEvent(new Event('folio:pdf-outline'));
      return;
    }
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(
      (e) => !e.closest('[data-folio-ui]'),
    );
    send('outline', {
      items: headings.map((e, i) => {
        e.setAttribute('data-folio-heading', String(i));
        return {
          id: String(i),
          text: e.textContent?.trim().slice(0, 150) || '',
          level: Number(e.tagName[1]),
        };
      }),
    });
  }
  function init() {
    if (ready) return;
    ready = true;
    const style = document.createElement('style');
    style.dataset.folioUi = 'true';
    style.textContent =
      'html{scroll-behavior:auto!important} [data-folio-ui="overlay"]{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:2147483646!important;pointer-events:none;overflow:hidden!important;margin:0!important;padding:0!important;max-width:none!important;transform:none!important} ::selection{background:rgba(47,139,126,.24)}';
    document.head.append(style);
    svg = svgEl('svg', {
      'data-folio-ui': 'overlay',
      'aria-hidden': 'true',
      tabindex: '-1',
    }) as SVGSVGElement;
    svg.style.setProperty('outline', 'none', 'important');
    layer = svgEl('g') as SVGGElement;
    previewLayer = svgEl('g') as SVGGElement;
    laserLayer = svgEl('g') as SVGGElement;
    cursor = svgEl('circle', {
      'data-folio-cursor': 'true',
      'pointer-events': 'none',
    }) as SVGCircleElement;
    cursor.style.display = 'none';
    svg.append(layer, laserLayer, previewLayer, cursor);
    indicator = new SelectionIndicator(svg);
    document.body.append(svg);
    notes = new PageNotes({
      position: notePosition,
      select: (id) => {
        if (
          (tool === 'sticky' || tool === 'text') &&
          annotations.some((a) => a.id === id && a.type === tool)
        )
          editingPageNote = true;
        selectAnnotation(id);
      },
      remove: (id) => {
        annotations = annotations.filter((a) => a.id !== id);
        send('delete', { id });
        schedule();
      },
      update: (id, patch, group) => {
        const type = annotations.find((a) => a.id === id)?.type;
        const nextColor = normalizeColor(patch.color);
        if (type === 'sticky' && nextColor) stickyColor = nextColor;
        if (patch.size && type === 'sticky') stickySize = stickyNoteSize(patch.size);
        if (patch.size && type === 'text') textWidth = textNoteWidth(patch.size.width);
        const next = {
          ...patch,
          ...(patch.points?.[0] ? { anchor: anchorAt(patch.points[0]) } : {}),
        };
        annotations = annotations.map((a) => (a.id === id ? { ...a, ...next } : a));
        send('update-annotation', { id, patch: next, group });
        schedule();
      },
    });
    popup = new AnnotationPopup({
      rect: quoteRect,
      markerRect: (a) => {
        const r = hitRegions.find((h) => h.id === a.id)?.rects[0];
        return r
          ? {
              left: r.left - scrollX,
              top: r.top - scrollY,
              right: r.right - scrollX,
              bottom: r.bottom - scrollY,
            }
          : null;
      },
      update: updateAnnotation,
      select: selectAnnotation,
      remove: (id) => {
        annotations = annotations.filter((a) => a.id !== id);
        send('delete', { id });
        schedule();
      },
      fontSize: (size) => {
        popup.setFontSize(size);
        send('note-font-size', { size });
      },
    });
    // Pointer events inside the sandboxed reader do not bubble to the app shell.
    // Notify it before handling the gesture so it can activate this reading pane.
    document.addEventListener(
      'pointerdown',
      (e) => {
        send('pointerdown');
        clearLocation();
        if (
          !e
            .composedPath()
            .some(
              (node) =>
                node instanceof Element &&
                node.matches('[data-folio-ui="notes"],[data-folio-ui="annotation-popup"]'),
            )
        ) {
          selectAnnotation(null);
          if (editingPageNote && !toolPinned && e.button === 0) {
            // Finish the note without placing another one or starting a stroke.
            // Keep consuming clicks until the app syncs the restored tool.
            e.preventDefault();
            e.stopPropagation();
            svg.focus({ preventScroll: true });
            send('finish-page-note', { tool });
          }
        }
      },
      {
        capture: true,
      },
    );
    document.addEventListener('mousedown', () => {
      selectionClick = false;
    });
    document.addEventListener('selectionchange', () => {
      if (selection && window.getSelection()?.isCollapsed) {
        selection = null;
        send('selection', { quote: null });
      }
    });
    document.addEventListener('mouseup', () => {
      if (isDrawing || isErasing || !['select', 'highlight', 'underline'].includes(tool)) return;
      selectionClick = !!window.getSelection()?.toString();
      setTimeout(() => {
        const q = captureSelection();
        selection = q;
        send('selection', { quote: q, rect: q ? selectionBox() : null });
        if (q && ['highlight', 'underline'].includes(tool)) annotate(tool);
      }, 0);
    });
    svg.addEventListener('pointerdown', (e) => {
      if (
        !['pen', 'laser', 'arrow', 'rectangle', 'eraser', 'sticky', 'text'].includes(tool) ||
        e.button !== 0
      )
        return;
      e.preventDefault();
      // A second finger landing mid-stroke must not restart the gesture.
      if (ignoredPointer(e)) return;
      svg.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges();
      const p = point(e);
      if (tool === 'sticky' || tool === 'text') {
        const isText = tool === 'text';
        const size = isText
          ? { width: textWidth, height: 36 }
          : {
              ...stickySize,
              width: Math.min(
                stickySize.width,
                Math.max(STICKY_MIN_WIDTH, document.documentElement.clientWidth - 16),
              ),
            };
        const position = {
          x: Math.max(
            (isText ? 0 : scrollX) + 8,
            Math.min(
              (isText
                ? document.documentElement.scrollWidth
                : scrollX + document.documentElement.clientWidth) -
                size.width -
                12,
              p.x,
            ),
          ),
          y: Math.max(isText ? 40 : 8, p.y),
        };
        create(
          {
            id: crypto.randomUUID(),
            type: isText ? 'text' : 'sticky',
            color: isText ? color : stickyColor,
            points: [position],
            anchor: anchorAt(position),
            size,
            ...(isText ? { fontSize: 20 } : {}),
            collapsed: false,
            note: '',
            createdAt: Date.now(),
          },
          true,
        );
        return;
      }
      activePointer = e.pointerId;
      activePointerType = e.pointerType;
      svg.setPointerCapture(e.pointerId);
      pointerCursor(e);
      if (tool === 'eraser') {
        isErasing = true;
        gestureEraserMode = eraserMode;
        eraseOriginal = annotations;
        erased.clear();
        eraseLast = p;
        erase(p, p);
      } else {
        isDrawing = true;
        strokeTool = tool;
        strokeColor = color;
        strokeSize = strokeWidth;
        points = [p];
        drawingAnchor = anchorAt(p);
        previewStroke();
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (ignoredPointer(e)) return;
      pointerCursor(e);
      if (!isDrawing && !isErasing) return;
      const samples = e.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [e]) {
        const p = point(sample);
        if (isErasing && eraseLast) {
          erase(eraseLast, p);
          eraseLast = p;
        } else if (['pen', 'laser'].includes(strokeTool)) {
          const last = points.at(-1)!;
          if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.2) points.push(p);
        } else points = [points[0], p];
      }
      if (isDrawing) schedulePreview();
    });
    svg.addEventListener('pointerup', (e) => {
      if (activePointer >= 0 && e.pointerId !== activePointer) return;
      if (isErasing && eraseLast) erase(eraseLast, point(e));
      if (isDrawing) {
        if (['pen', 'laser'].includes(strokeTool)) points.push(point(e));
        else points = [points[0], point(e)];
      }
      finishGesture();
    });
    svg.addEventListener('pointercancel', (e) => {
      if (activePointer >= 0 && e.pointerId !== activePointer) return;
      finishGesture(true);
    });
    svg.addEventListener('pointerleave', () => {
      if (activePointer < 0) cursor.style.display = 'none';
    });
    readerZoom = new ReaderZoom((delta) => {
      finishGesture();
      popup.close();
      send('zoom-wheel', { delta });
    }, schedule);
    linkedScroll = new LinkedScroll((delta) => send('linked-wheel', { delta }));
    window.addEventListener(
      'scroll',
      () => {
        layer.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
        previewLayer.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
        laserLayer.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
        citeLayer?.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
        notes.reposition();
        popup.reposition();
        pairScrolled();
        const now = Date.now();
        if (now - lastScroll > 150) {
          lastScroll = now;
          send('scroll', {
            scroll: scrollY,
            progress: Math.round(
              (scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)) * 100,
            ),
          });
        }
      },
      { passive: true },
    );
    window.addEventListener('scrollend', () =>
      send('scroll', {
        scroll: scrollY,
        progress: Math.round(
          (scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)) * 100,
        ),
      }),
    );
    window.addEventListener('resize', () => {
      restorePosition();
      schedule();
      followSelection();
    });
    // Captures scrolling inside the page's own scroll areas as well as the window.
    document.addEventListener('scroll', followSelection, { capture: true, passive: true });
    new ResizeObserver(schedule).observe(document.body);
    new MutationObserver((records) => {
      if (
        records.some(
          (r) =>
            !(r.target instanceof Element ? r.target : r.target.parentElement)?.closest(
              '[data-folio-ui]',
            ),
        )
      ) {
        schedule();
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    document.fonts?.ready.then(schedule);
    document.addEventListener('pointermove', (e) => {
      if (
        ['select', 'highlight', 'underline'].includes(tool) &&
        !e.buttons &&
        window.getSelection()?.isCollapsed
      )
        popup.hover(hitAnnotation(e));
      else popup.hover(null);
    });
    document.documentElement.addEventListener('pointerleave', () => popup.hover(null));
    document.addEventListener('click', (e) => {
      // The click that finishes a text selection must not reopen its new highlight.
      if (selectionClick && e.detail !== 0) return;
      if (
        ['select', 'highlight', 'underline'].includes(tool) &&
        window.getSelection()?.isCollapsed
      ) {
        const a = hitAnnotation(e);
        if (a) {
          popup.show(a);
          return;
        }
      }
      const a = (e.target as Element).closest('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      if (href.startsWith('#')) {
        try {
          document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
        } catch {}
        return;
      }
      send('link', { url: a.href });
    });
    // Double-click a picture to see it larger over the whole window. Pictures the page
    // already makes clickable (a link, a button, its own zoom) are left to the page.
    window.addEventListener('dblclick', (e) => {
      const img = e.target;
      if (
        e.defaultPrevented ||
        tool !== 'select' ||
        document.documentElement.dataset.folioPdf ||
        !(img instanceof HTMLImageElement) ||
        !img.naturalWidth ||
        img.closest('a[href],button,[onclick]') ||
        ['pointer', 'zoom-in'].includes(getComputedStyle(img).cursor)
      )
        return;
      const r = img.getBoundingClientRect();
      if (Math.min(r.width, r.height) < 40) return;
      window.getSelection()?.removeAllRanges();
      send('image', { src: img.currentSrc || img.src });
    });
    window.addEventListener('keydown', (e) => {
      const path = e.composedPath();
      const input = path.some(
        (t) => t instanceof Element && t.matches('input,textarea,select,[contenteditable]'),
      );
      const pageNote = path.some(
        (t) => t instanceof Element && t.matches('[data-folio-ui="notes"]'),
      );
      if (
        e.key === 'Tab' &&
        (!input || pageNote) &&
        !e.isComposing &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        if (!e.repeat) {
          finishGesture();
          temporaryEraser = false;
          // Leave the note editor immediately so a second Tab also switches
          // tools, instead of walking through its resize/delete controls.
          if (pageNote) svg.focus({ preventScroll: true });
          send('switch-tool');
        }
      }
      if (
        !input &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'e' &&
        tool === 'pen' &&
        !e.repeat
      ) {
        e.preventDefault();
        finishGesture();
        temporaryEraser = true;
        setTool('eraser');
      }
      if (e.key === 'Escape') {
        selectAnnotation(null);
        finishGesture(true);
        laserLayer.replaceChildren();
        popup.close();
        temporaryEraser = false;
        setTool('select');
        send('escape');
        window.getSelection()?.removeAllRanges();
      }
      // Windows also redoes with Ctrl+Y.
      const redo = e.ctrlKey && e.key.toLowerCase() === 'y' && !/Mac/.test(navigator.platform);
      if (
        (e.metaKey || e.ctrlKey) &&
        (['s', 'f', 'z'].includes(e.key.toLowerCase()) || redo) &&
        !(input && e.key.toLowerCase() !== 's')
      ) {
        e.preventDefault();
        send('shortcut', { key: e.key.toLowerCase(), shift: e.shiftKey });
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 'e' && temporaryEraser) {
        finishGesture();
        temporaryEraser = false;
        setTool('pen');
      }
    });
    window.addEventListener('blur', () => {
      finishGesture();
      if (temporaryEraser) {
        temporaryEraser = false;
        setTool('pen');
      }
      cursor.style.display = 'none';
    });
    outline();
    send('ready', { title: document.title, url: location.href, pairOf: pairOf() });
  }
  window.addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.channel !== channel) return;
    const m = e.data;
    if (!ready) return;
    if (m.type === 'request-ready') {
      outline();
      send('ready', { title: document.title, url: location.href, pairOf: pairOf() });
    }
    if (m.type === 'zoom-state') readerZoom.apply(m.scale, m.enabled);
    if (m.type === 'scroll-link-state') linkedScroll.setEnabled(!!m.enabled);
    if (m.type === 'pair-state') paired = !!m.enabled;
    if (m.type === 'pair-follow') pairFollow(Number(m.at));
    // A jump the app asks for (a page, a passage) is not for the other side to follow.
    if (m.type === 'pdf-page' || m.type === 'ai-flash') followUntil = Date.now() + 1500;
    if (m.type === 'appearance' && document.documentElement.dataset.folioPdf) {
      const color = (value: unknown) =>
        typeof value === 'string' && /^#[\da-f]{3,8}$/i.test(value) ? value : '';
      document.documentElement.style.setProperty('--folio-desk', color(m.desk));
      document.documentElement.style.setProperty('--folio-desk-text', color(m.deskText));
    }
    if (m.type === 'linked-scroll') linkedScroll.move(m.delta, m.scale);
    if (m.type === 'sync') {
      const currentInk = new Map(annotations.map((a) => [a.id, a]));
      annotations = (m.annotations || []).flatMap((a: Annotation) =>
        isErasing && erased.has(a.id) ? (currentInk.has(a.id) ? [currentInk.get(a.id)] : []) : [a],
      );
      if (located && (m.selected !== located || !annotations.some((a) => a.id === located)))
        clearLocation();
      color = m.color || color;
      stickyColor = normalizeColor(m.stickyColor) || stickyColor;
      strokeWidth = Math.max(1, Math.min(12, Number(m.strokeWidth) || 2.5));
      eraserSize = Math.max(8, Math.min(64, Number(m.eraserSize) || 24));
      eraserMode = m.eraserMode === 'stroke' ? 'stroke' : 'partial';
      stickySize = stickyNoteSize(m.stickySize);
      textWidth = textNoteWidth(m.textWidth);
      toolPinned = !!m.toolPinned;
      if (Number.isFinite(m.noteFontSize)) popup.setFontSize(m.noteFontSize);
      if (!temporaryEraser) setTool(m.tool || 'select');
      inspector.setEnabled(!!m.inspect);
      schedule();
    }
    if (m.type === 'restore') {
      restoreScroll = Number(m.scroll) || 0;
      requestAnimationFrame(restorePosition);
    }
    if (m.type === 'temporary-eraser') {
      if (m.active && tool === 'pen' && !temporaryEraser) {
        finishGesture();
        temporaryEraser = true;
        setTool('eraser');
      } else if (!m.active && temporaryEraser) {
        finishGesture();
        temporaryEraser = false;
        setTool('pen');
      }
    }
    // The pen was lifted over the app shell, which this frame never hears about.
    if (m.type === 'pointerup' && activePointer >= 0 && activePointerType === 'pen')
      finishGesture();
    if (m.type === 'annotate') annotate(m.tool);
    // Requests from the app's AI features answer with a reply to the same id.
    const reply = (work: Promise<unknown>) =>
      work.then(
        (result) => send('reply', { replyTo: m.replyTo, result }),
        (e) => send('reply', { replyTo: m.replyTo, error: String(e?.message || e) }),
      );
    if (m.type === 'ai-text') reply(aiText());
    if (m.type === 'ai-figures') reply(aiFigures());
    if (m.type === 'ai-anchors') reply(aiAnchors(Array.isArray(m.quotes) ? m.quotes : []));
    if (m.type === 'ai-flash')
      reply(flashQuote(String(m.quote || ''), Math.max(0, Math.floor(Number(m.page) || 0))));
    if (m.type === 'ai-region') reply(Promise.resolve().then(() => regionText(m.box)));
    if (m.type === 'clear-selection') {
      window.getSelection()?.removeAllRanges();
      selection = null;
      send('selection', { quote: null });
    }
    if (m.type === 'jump') {
      const a = annotations.find((a) => a.id === m.id);
      popup.close();
      if (a && ['sticky', 'text'].includes(a.type)) {
        notes.sync(annotations);
        notes.open(a.id, false);
      }
      located = a?.id || null;
      if (a) revealAnnotation(a);
      attentionPending = !!a;
      schedule();
    }
    if (m.type === 'heading')
      document
        .querySelector(`[data-folio-heading="${CSS.escape(m.id)}"]`)
        ?.scrollIntoView({ behavior: glide(), block: 'start' });
    if (m.type === 'find') {
      if (document.documentElement.dataset.folioPdf) {
        document.dispatchEvent(new CustomEvent('folio:pdf-find', { detail: m }));
        return;
      }
      const ok = (
        window as unknown as Window & {
          find: (
            text: string,
            caseSensitive: boolean,
            backwards: boolean,
            wrap: boolean,
          ) => boolean;
        }
      ).find(m.query, false, !!m.backwards, true);
      send('found', { ok });
    }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
