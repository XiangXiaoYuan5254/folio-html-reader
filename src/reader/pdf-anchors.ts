import type { Anchor, Annotation, PdfRect, Point } from '../types';

// PDF page geometry is fixed. Store rectangles within their page rather than
// relying on a text index that changes as background text layers arrive.
export function capturePdfRects(range: Range): PdfRect[] | undefined {
  if (!document.documentElement.dataset.folioPdf) return undefined;
  const pages = [...document.querySelectorAll<HTMLElement>('[data-pdf-page]')].map((page) => ({
    page: Number(page.dataset.pdfPage),
    rect: page.getBoundingClientRect(),
  }));
  const result: PdfRect[] = [];
  // Range.getClientRects also includes fully selected page/container boxes.
  // Measure text nodes alone, otherwise a cross-page selection paints whole pages.
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(
    document.getElementById('pdf-pages')!,
    NodeFilter.SHOW_TEXT,
  );
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('.textLayer') || !range.intersectsNode(node)) continue;
    const textRange = document.createRange();
    textRange.selectNodeContents(node);
    if (range.startContainer === node) textRange.setStart(node, range.startOffset);
    if (range.endContainer === node) textRange.setEnd(node, range.endOffset);
    rects.push(...textRange.getClientRects());
  }
  for (const rect of rects) {
    if (rect.width < 0.2 || rect.height < 0.2) continue;
    const page = pages.find(
      ({ rect: p }) =>
        rect.top + rect.height / 2 >= p.top && rect.top + rect.height / 2 <= p.bottom,
    );
    if (!page) continue;
    const item = {
      page: page.page,
      left: rect.left - page.rect.left,
      top: rect.top - page.rect.top,
      width: rect.width,
      height: rect.height,
    };
    if (
      !result.some(
        (r) =>
          r.page === item.page &&
          Math.abs(r.left - item.left) < 0.1 &&
          Math.abs(r.top - item.top) < 0.1 &&
          Math.abs(r.width - item.width) < 0.1,
      )
    )
      result.push(item);
  }
  return result;
}

export function pdfQuoteRects(quote: Anchor): DOMRect[] | null {
  if (!quote.pdfRects) return null;
  return quote.pdfRects.flatMap((r) => {
    const page = document.getElementById(`pdf-page-${r.page}`)?.getBoundingClientRect();
    return page ? [new DOMRect(page.left + r.left, page.top + r.top, r.width, r.height)] : [];
  });
}

export function pdfPageAnchor(point: Point): Annotation['anchor'] {
  const pages = [...document.querySelectorAll<HTMLElement>('[data-pdf-page]')];
  const y = point.y - scrollY;
  const page = pages.find((p) => p.getBoundingClientRect().bottom >= y) || pages.at(-1);
  if (!page) return undefined;
  const rect = page.getBoundingClientRect();
  return { selector: `#${page.id}`, top: rect.top + scrollY, left: rect.left + scrollX };
}
