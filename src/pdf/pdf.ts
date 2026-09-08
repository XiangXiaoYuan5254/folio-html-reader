import { getDocument, GlobalWorkerOptions, TextLayer, PasswordResponses } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import './pdf.css';

const channel = 'folio-reader-v1';
const send = (type: string, payload: Record<string, unknown> = {}) =>
  parent.postMessage({ channel, type, url: location.href, ...payload }, '*');
const assets = document.body.dataset.pdfAssets!;
const pagesHost = document.getElementById('pdf-pages')!;
const message = document.getElementById('pdf-message')!;
GlobalWorkerOptions.workerSrc = assets + 'pdf.worker.mjs';
type Page = {
  number: number;
  pdf: PDFPageProxy;
  viewport: ReturnType<PDFPageProxy['getViewport']>;
  element: HTMLElement;
  canvasHost: HTMLElement;
  text: HTMLElement;
  textReady: boolean;
  density: number;
  canvas?: HTMLCanvasElement;
};
let pdf: PDFDocumentProxy;
let pages: Page[] = [];
let scale = 1;
let currentPage = 1;
let maxWidth = 0;
let initialized = false;
let textReady: Promise<void> = Promise.resolve();
let outline: { id: string; text: string; level: number }[] = [];
const destinations = new Map<string, unknown>();
const visible = new Set<Page>();
const queued = new Set<Page>();
const cache = new Set<Page>();
let rendering = false;
let frame = 0;

function state() {
  if (initialized)
    send('pdf-state', {
      page: currentPage,
      total: pages.length,
      width: maxWidth,
      hasText: pages[currentPage - 1]?.textReady
        ? !!pages[currentPage - 1].text.textContent?.trim()
        : null,
    });
}
function updatePage() {
  frame = 0;
  const y = scrollY + Math.min(innerHeight * 0.3, 240);
  currentPage =
    (pages.find((p) => p.element.offsetTop + p.element.offsetHeight > y) || pages.at(-1))?.number ||
    1;
  state();
}
function goPage(number: number) {
  const page = pages[Math.max(0, Math.min(pages.length - 1, Math.floor(number) - 1))];
  if (!page) return;
  scrollTo({ top: Math.max(0, page.element.offsetTop - 18), behavior: 'instant' });
  currentPage = page.number;
  visible.add(page);
  queue(page);
  state();
}
async function goDestination(destination: unknown) {
  const dest =
    typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
  if (!Array.isArray(dest)) return;
  const page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
  goPage(page);
}
function density(page: Page) {
  return Math.max(
    0.5,
    Math.min(
      devicePixelRatio * scale,
      6,
      Math.sqrt(12_000_000 / (page.viewport.width * page.viewport.height)),
    ),
  );
}
function queue(page: Page) {
  if (Math.abs(page.density - density(page)) < 0.03 && page.canvas) return;
  queued.add(page);
  void paint();
}
async function paint() {
  if (rendering) return;
  rendering = true;
  try {
    while (queued.size) {
      const page = [...queued].sort(
        (a, b) => Math.abs(a.number - currentPage) - Math.abs(b.number - currentPage),
      )[0];
      queued.delete(page);
      if (!visible.has(page)) continue;
      const ratio = density(page);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(page.viewport.width * ratio);
      canvas.height = Math.ceil(page.viewport.height * ratio);
      canvas.style.width = `${page.viewport.width}px`;
      canvas.style.height = `${page.viewport.height}px`;
      canvas.setAttribute('aria-hidden', 'true');
      try {
        await page.pdf.render({
          canvas,
          viewport: page.viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        }).promise;
        const previous = page.canvas;
        page.canvasHost.replaceChildren(canvas);
        page.canvas = canvas;
        page.density = ratio;
        page.element.dataset.rendered = 'true';
        if (previous) previous.width = previous.height = 0;
        cache.delete(page);
        cache.add(page);
        // Keep only nearby raster pages in memory; fixed page boxes and text
        // stay mounted so search, selection and saved page coordinates survive.
        for (const old of cache) {
          if (cache.size <= Math.max(6, visible.size)) break;
          if (visible.has(old)) continue;
          old.canvasHost.replaceChildren();
          if (old.canvas) old.canvas.width = old.canvas.height = 0;
          old.canvas = undefined;
          old.density = 0;
          delete old.element.dataset.rendered;
          cache.delete(old);
        }
        if (visible.has(page) && Math.abs(ratio - density(page)) >= 0.03) queued.add(page);
      } catch (error) {
        canvas.width = canvas.height = 0;
        page.canvasHost.textContent = `第 ${page.number} 页无法显示，请重新打开文件`;
        console.error('PDF page render failed', error);
      }
    }
  } finally {
    rendering = false;
  }
}
async function links(page: Page) {
  const annotations = await page.pdf.getAnnotations({ intent: 'display' });
  const host = document.createElement('div');
  host.className = 'pdf-original-annotations';
  host.dataset.folioUi = 'pdf-original';
  for (const annotation of annotations) {
    const content = annotation.contentsObj?.str || annotation.contents || '';
    if (!annotation.url && !annotation.dest && !content) continue;
    if (!Array.isArray(annotation.rect)) continue;
    const rect = [
      ...page.viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
      ...page.viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]),
    ];
    const node = document.createElement(annotation.url || annotation.dest ? 'a' : 'button');
    node.className = 'pdf-original-annotation';
    node.style.cssText = `left:${Math.min(rect[0], rect[2])}px;top:${Math.min(rect[1], rect[3])}px;width:${Math.max(12, Math.abs(rect[2] - rect[0]))}px;height:${Math.max(12, Math.abs(rect[3] - rect[1]))}px`;
    node.title = content || (annotation.dest ? '跳转到引用位置' : annotation.url);
    node.setAttribute('aria-label', node.title);
    if (annotation.url && /^(https?:|mailto:)/i.test(annotation.url))
      (node as HTMLAnchorElement).href = annotation.url;
    if (!annotation.url && !annotation.dest) {
      node.textContent = '•••';
      node.classList.add('pdf-original-comment');
    }
    node.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (annotation.dest) void goDestination(annotation.dest).catch(() => {});
      else if (annotation.url && /^https?:/i.test(annotation.url))
        send('link', { url: annotation.url });
      else if (content) {
        let popover = host.querySelector('.pdf-original-note');
        if (popover) {
          popover.remove();
          return;
        }
        popover = document.createElement('div');
        popover.className = 'pdf-original-note';
        popover.textContent = content;
        (popover as HTMLElement).style.cssText =
          `left:${Math.max(8, Math.min(page.viewport.width - 260, rect[0]))}px;top:${Math.max(8, Math.min(rect[1] + 24, page.viewport.height - 140))}px`;
        popover.addEventListener('click', () => popover?.remove());
        host.append(popover);
      }
    });
    host.append(node);
  }
  page.element.append(host);
}
async function loadText() {
  // Extract all text independently of raster rendering, so off-screen pages
  // remain searchable without allocating a canvas for every page.
  for (let offset = 0; offset < pages.length; offset += 3) {
    await Promise.all(
      pages.slice(offset, offset + 3).map(async (page) => {
        try {
          const content = await page.pdf.getTextContent();
          await new TextLayer({
            textContentSource: content,
            container: page.text,
            viewport: page.viewport,
          }).render();
          page.textReady = true;
          await links(page);
        } catch (e) {
          console.warn(`PDF text layer ${page.number}`, e);
        }
      }),
    );
    state();
  }
}
async function loadOutline() {
  const bookmarks = await pdf.getOutline();
  if (!bookmarks?.length) return;
  const items: typeof outline = [];
  const walk = (nodes: typeof bookmarks, level: number) => {
    for (const node of nodes) {
      const id = `pdf-bookmark-${items.length}`;
      items.push({ id, text: node.title, level: Math.min(3, level) });
      destinations.set(id, node.dest);
      walk(node.items || [], level + 1);
    }
  };
  walk(bookmarks, 1);
  outline = items;
  send('outline', { items: outline });
}
function passwordPrompt(update: (value: string) => void, reason: number) {
  message.replaceChildren();
  message.className = 'pdf-password';
  const title = document.createElement('h2');
  title.textContent = '此 PDF 需要密码';
  const hint = document.createElement('p');
  hint.textContent =
    reason === PasswordResponses.INCORRECT_PASSWORD
      ? '密码不正确，请重新输入。'
      : '输入文档密码后即可阅读和批注。';
  const form = document.createElement('div');
  form.className = 'pdf-password-fields';
  form.setAttribute('role', 'form');
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'PDF 密码');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '打开 PDF';
  form.append(input, button);
  const unlock = () => {
    if (input.value) {
      const value = input.value;
      input.value = '';
      hint.textContent = '正在验证…';
      update(value);
    }
  };
  button.addEventListener('click', unlock);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      unlock();
    }
  });
  message.append(title, hint, form);
  input.focus();
}
async function start() {
  const task = getDocument({
    url: document.body.dataset.pdfUrl!,
    cMapUrl: assets + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: assets + 'standard_fonts/',
    wasmUrl: assets + 'wasm/',
    iccUrl: assets + 'iccs/',
  });
  task.onPassword = passwordPrompt;
  pdf = await task.promise;
  const pageObjects: PDFPageProxy[] = [];
  for (let offset = 0; offset < pdf.numPages; offset += 8) {
    pageObjects.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(8, pdf.numPages - offset) }, (_, i) =>
          pdf.getPage(offset + i + 1),
        ),
      )),
    );
  }
  const fragment = document.createDocumentFragment();
  pages = pageObjects.map((page, i) => {
    const viewport = page.getViewport({ scale: 4 / 3 });
    maxWidth = Math.max(maxWidth, viewport.width);
    const element = document.createElement('section');
    element.id = `pdf-page-${i + 1}`;
    element.dataset.pdfPage = String(i + 1);
    element.className = 'pdf-page';
    element.setAttribute('aria-label', `第 ${i + 1} 页`);
    element.style.cssText = `width:${viewport.width}px;height:${viewport.height}px;--total-scale-factor:${viewport.scale};--scale-round-x:1px;--scale-round-y:1px`;
    const canvasHost = document.createElement('div');
    canvasHost.className = 'pdf-canvas';
    canvasHost.dataset.folioUi = 'pdf-canvas';
    const text = document.createElement('div');
    text.className = 'textLayer';
    const label = document.createElement('div');
    label.className = 'pdf-page-label';
    label.dataset.folioUi = 'pdf-page-label';
    label.textContent = `${i + 1} / ${pdf.numPages}`;
    element.append(canvasHost, text, label);
    fragment.append(element);
    return {
      number: i + 1,
      pdf: page,
      viewport,
      element,
      canvasHost,
      text,
      textReady: false,
      density: 0,
    };
  });
  pagesHost.replaceChildren(fragment);
  pagesHost.style.minWidth = `${maxWidth + 48}px`;
  message.remove();
  initialized = true;
  outline = pages.map((p) => ({ id: `pdf-page-${p.number}`, text: `第 ${p.number} 页`, level: 1 }));
  document.addEventListener('folio:pdf-outline', () => send('outline', { items: outline }));
  window.addEventListener(
    'scroll',
    () => {
      if (!frame) frame = requestAnimationFrame(updatePage);
    },
    { passive: true },
  );
  window.addEventListener('resize', updatePage);
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    const m = event.data;
    if (m.type === 'request-ready') state();
    if (m.type === 'pdf-page') goPage(Number(m.page) || 1);
    if (m.type === 'zoom-state' && Number.isFinite(m.scale)) {
      scale = m.scale || 1;
      for (const p of visible) queue(p);
    }
    if (m.type === 'heading') {
      if (m.id.startsWith('pdf-page-')) goPage(Number(m.id.slice(9)));
      else if (destinations.has(m.id)) void goDestination(destinations.get(m.id)).catch(() => {});
    }
  });
  document.addEventListener('folio:pdf-find', async (event) => {
    const detail = (event as CustomEvent).detail;
    await textReady;
    const ok = (
      window as unknown as Window & {
        find: (s: string, a: boolean, b: boolean, c: boolean) => boolean;
      }
    ).find(detail.query, false, !!detail.backwards, true);
    send('found', { ok });
  });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = pages[Number((entry.target as HTMLElement).dataset.pdfPage) - 1];
        if (entry.isIntersecting) {
          visible.add(page);
          queue(page);
        } else visible.delete(page);
      }
    },
    { rootMargin: '450px 0px' },
  );
  pages.forEach((p) => observer.observe(p.element));
  state();
  await import('../reader/runtime');
  textReady = loadText();
  void loadOutline().catch(() => {});
}
void start().catch((error) => {
  message.className = 'pdf-error';
  message.textContent =
    error?.name === 'PasswordException'
      ? '未能解锁 PDF，请重新打开后输入密码。'
      : '无法打开此 PDF，请确认文件完整且为有效的 PDF 文档。';
  console.warn('PDF open failed:', error?.message);
});
