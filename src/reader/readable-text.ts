// A plain-text rendering of the page for AI models: headings, lists, tables and paragraphs
// keep their shape, page chrome added by the reader is left out. Quotes the model copies
// from it are located again with quote-match, so offsets need not line up with the DOM.
const skipped = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'textarea',
  'select',
  'button',
  'input',
]);
const blocks = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'summary',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'ul',
  'caption',
]);

const inline = new Set(
  'a abbr b bdi bdo cite code data del dfn em i ins kbd mark q s samp small span strong sub sup time u var wbr font label'.split(
    ' ',
  ),
);

export function readableText(root: Element | DocumentFragment = document.body, rendered = true) {
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    const text = line.replace(/[ \t]+$/g, '').replace(/^\s+/, '');
    if (text && text !== '-' && text !== '|') lines.push(text);
    line = '';
  };
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      node.childNodes.forEach((child) => walk(child, pre));
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      line += pre ? data : data.replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (skipped.has(tag) || el.hasAttribute('data-folio-ui')) return;
    if (rendered && el.checkVisibility && !el.checkVisibility()) return;
    if (
      !rendered &&
      (el.hidden ||
        el.getAttribute('aria-hidden') === 'true' ||
        el.style?.display === 'none' ||
        el.style?.visibility === 'hidden')
    )
      return;
    const children = (keepPre = pre) => el.childNodes.forEach((child) => walk(child, keepPre));
    if (tag === 'br') return flush();
    if (tag === 'img') {
      const alt = el.getAttribute('alt')?.trim();
      if (alt) line += `［图片：${alt}］`;
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      flush();
      lines.push('');
      line = '#'.repeat(Number(tag[1])) + ' ';
      children();
      return flush();
    }
    if (tag === 'li') {
      flush();
      line = '- ';
      children();
      return flush();
    }
    if (tag === 'td' || tag === 'th') {
      children();
      line += ' | ';
      return;
    }
    if (tag === 'pre') {
      flush();
      children(true);
      lines.push(line.replace(/\s+$/, ''));
      line = '';
      return;
    }
    if (tag === 'blockquote') {
      flush();
      const start = lines.length;
      children();
      flush();
      for (let i = start; i < lines.length; i++) lines[i] = '> ' + lines[i];
      return;
    }
    const block =
      blocks.has(tag) ||
      (rendered &&
        !inline.has(tag) &&
        /^(block|flex|grid|list-item|table)/.test(getComputedStyle(el).display));
    if (block) flush();
    children();
    if (block) flush();
  };
  walk(root, false);
  flush();
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
