import type { Anchor, Annotation, Point, Tool } from '../types';
import { erasePaths, inkPaths, inkPathData, smoothPoints } from './ink';
import { PageNotes } from './notes';
import { AnnotationPopup } from './annotation-popup';
import { stickyNoteSize } from './note-size';
import { penCursor } from './pen-cursor';
(() => {
  const channel = 'folio-reader-v1';
  const send = (type: string, payload: Record<string, unknown> = {}) =>
    parent.postMessage({ channel, type, ...payload }, '*');
  let annotations: Annotation[] = [];
  let tool: Tool = 'select';
  let color = '#edbd39';
  let strokeWidth = 2.5;
  let eraserSize = 24;
  let stickySize = stickyNoteSize(null);
  let selection: Anchor | null = null;
  let selectionClick = false;
  let points: Point[] = [];
  let drawingAnchor: Annotation['anchor'];
  let isDrawing = false;
  let isErasing = false;
  let activePointer = -1;
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
    };
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
    const end = pos + quote.exact.length;
    const a = nodes.find((n) => n.start <= pos && n.end > pos),
      b = nodes.find((n) => n.start < end && n.end >= end);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, pos - a.start);
    r.setEnd(b.node, end - b.start);
    return r;
  }
  function point(e: PointerEvent): Point {
    return {
      x: Math.round((e.clientX + scrollX) * 10) / 10,
      y: Math.round((e.clientY + scrollY) * 10) / 10,
    };
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
    hitRegions = [];
    for (const a of annotations) {
      if (a.quote) {
        const r = locate(a.quote, index);
        if (!r) {
          missing.push(a.id);
          continue;
        }
        for (const rect of r.getClientRects()) {
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
          rects: Array.from(r.getClientRects())
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
    const q = captureSelection() || selection;
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
    const drawing = ['pen', 'laser', 'arrow', 'rectangle', 'eraser', 'sticky', 'text'].includes(
      tool,
    );
    svg.style.pointerEvents = drawing ? 'auto' : 'none';
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
    const target = document
      .elementsFromPoint(p.x - scrollX, p.y - scrollY)
      .find((el) => !el.closest('[data-folio-ui]'))
      ?.closest('p,h1,h2,h3,h4,figure,img,section,article,div');
    if (!target || target === document.body || target.closest('[data-folio-ui]')) return undefined;
    const r = target.getBoundingClientRect();
    return { selector: selector(target), top: r.top + scrollY, left: r.left + scrollX };
  }
  function notePosition(a: Annotation): Point | null {
    if (a.points?.length) {
      const o = offset(a);
      // Keep margin notes reachable when a sidebar or browser-style zoom
      // narrows the page. The saved location returns when it widens again.
      return {
        x: Math.max(
          0,
          Math.min(
            document.documentElement.scrollWidth - (a.size?.width || 300) - 8,
            a.points[0].x + o.x,
          ),
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
            Math.min(
              document.documentElement.scrollWidth - (a.size?.width || 300) - 12,
              r.left + scrollX,
            ),
          ),
          y: r.bottom + scrollY + 10,
        };
    }
    return null;
  }
  function create(a: Annotation, focus = false) {
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
    const rects = Array.from(locate(a.quote)?.getClientRects() || []);
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
    if (!['pen', 'eraser', 'laser'].includes(tool)) {
      cursor.style.display = 'none';
      return;
    }
    cursor.style.display = '';
    cursor.setAttribute('cx', String(e.clientX));
    cursor.setAttribute('cy', String(e.clientY));
    cursor.setAttribute(
      'r',
      String(
        tool === 'eraser' ? eraserSize / 2 : tool === 'laser' ? 5 : Math.max(2, strokeWidth / 2),
      ),
    );
    cursor.setAttribute(
      'fill',
      tool === 'eraser' ? '#ffffff66' : tool === 'laser' ? '#fff' : color,
    );
    cursor.setAttribute(
      'stroke',
      tool === 'eraser' ? '#566a72' : tool === 'laser' ? '#ff4b57' : '#ffffff',
    );
    cursor.setAttribute('stroke-width', tool === 'eraser' ? '1.3' : tool === 'laser' ? '3' : '1');
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
  function outline() {
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
    document.body.append(svg);
    notes = new PageNotes({
      position: notePosition,
      select: (id) => send('select-annotation', { id }),
      remove: (id) => {
        annotations = annotations.filter((a) => a.id !== id);
        send('delete', { id });
        schedule();
      },
      update: (id, patch, group) => {
        if (patch.size && annotations.find((a) => a.id === id)?.type === 'sticky')
          stickySize = stickyNoteSize(patch.size);
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
      select: (id) => send('select-annotation', { id }),
      remove: (id) => {
        annotations = annotations.filter((a) => a.id !== id);
        send('delete', { id });
        schedule();
      },
    });
    // Pointer events inside the sandboxed reader do not bubble to the app shell.
    // Notify it without consuming the gesture, so the first stroke still draws.
    document.addEventListener('pointerdown', () => send('pointerdown'), {
      capture: true,
      passive: true,
    });
    document.addEventListener('mousedown', () => {
      selectionClick = false;
    });
    document.addEventListener('mouseup', () => {
      if (isDrawing || isErasing || !['select', 'highlight', 'underline'].includes(tool)) return;
      selectionClick = !!window.getSelection()?.toString();
      setTimeout(() => {
        const q = captureSelection();
        if (!q) return;
        selection = q;
        send('selection', { quote: q });
        if (['highlight', 'underline'].includes(tool)) annotate(tool);
      }, 0);
    });
    svg.addEventListener('pointerdown', (e) => {
      if (
        !['pen', 'laser', 'arrow', 'rectangle', 'eraser', 'sticky', 'text'].includes(tool) ||
        e.button !== 0
      )
        return;
      e.preventDefault();
      svg.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges();
      const p = point(e);
      if (tool === 'sticky' || tool === 'text') {
        const isText = tool === 'text';
        const size = isText
          ? { width: 300, height: 36 }
          : {
              ...stickySize,
              width: Math.min(
                stickySize.width,
                Math.max(220, document.documentElement.clientWidth - 16),
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
            color,
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
      svg.setPointerCapture(e.pointerId);
      pointerCursor(e);
      if (tool === 'eraser') {
        isErasing = true;
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
      if (isErasing && eraseLast) erase(eraseLast, point(e));
      if (isDrawing) {
        if (['pen', 'laser'].includes(strokeTool)) points.push(point(e));
        else points = [points[0], point(e)];
      }
      finishGesture();
    });
    svg.addEventListener('pointercancel', () => finishGesture(true));
    svg.addEventListener('pointerleave', () => {
      if (activePointer < 0) cursor.style.display = 'none';
    });
    window.addEventListener(
      'scroll',
      () => {
        layer.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
        previewLayer.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
        laserLayer.setAttribute('transform', `translate(${-scrollX},${-scrollY})`);
        notes.reposition();
        popup.reposition();
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
    });
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
    window.addEventListener('keydown', (e) => {
      const input = e
        .composedPath()
        .some((t) => t instanceof Element && t.matches('input,textarea,[contenteditable="true"]'));
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
        finishGesture(true);
        laserLayer.replaceChildren();
        popup.close();
        temporaryEraser = false;
        setTool('select');
        send('escape');
        window.getSelection()?.removeAllRanges();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        ['s', 'f', 'z'].includes(e.key.toLowerCase()) &&
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
    send('ready', { title: document.title });
  }
  window.addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.channel !== channel) return;
    const m = e.data;
    if (!ready) return;
    if (m.type === 'sync') {
      const currentInk = new Map(annotations.map((a) => [a.id, a]));
      annotations = (m.annotations || []).flatMap((a: Annotation) =>
        isErasing && erased.has(a.id) ? (currentInk.has(a.id) ? [currentInk.get(a.id)] : []) : [a],
      );
      color = m.color || color;
      strokeWidth = Math.max(1, Math.min(12, Number(m.strokeWidth) || 2.5));
      eraserSize = Math.max(8, Math.min(64, Number(m.eraserSize) || 24));
      stickySize = stickyNoteSize(m.stickySize);
      if (!temporaryEraser) setTool(m.tool || 'select');
      schedule();
    }
    if (m.type === 'restore') {
      restoreScroll = Number(m.scroll) || 0;
      requestAnimationFrame(restorePosition);
    }
    if (m.type === 'annotate') annotate(m.tool);
    if (m.type === 'jump') {
      const a = annotations.find((a) => a.id === m.id);
      if (a?.quote) {
        locate(a.quote)?.startContainer.parentElement?.scrollIntoView({
          block: 'center',
          behavior: 'auto',
        });
      } else if (a?.points?.length)
        scrollTo({ top: a.points[0].y + offset(a).y - innerHeight / 3, behavior: 'auto' });
      if (a?.quote) {
        popup.show(a, true, false);
      } else if (a && ['sticky', 'text'].includes(a.type)) {
        notes.sync(annotations);
        notes.open(a.id, false);
      }
    }
    if (m.type === 'heading')
      document
        .querySelector(`[data-folio-heading="${CSS.escape(m.id)}"]`)
        ?.scrollIntoView({ behavior: 'auto', block: 'start' });
    if (m.type === 'find') {
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
