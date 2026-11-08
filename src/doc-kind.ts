// The files 页间 opens as documents; electron/formats.cjs decides the same on its side.
// Markdown and pictures are read and annotated like HTML; HTML and Markdown have 源码 to edit.
export type DocKind = 'html' | 'pdf' | 'markdown' | 'image';

export function docKind(path: string): DocKind | null {
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)) return 'image';
  return null;
}

export const isDocKind = (kind: string): kind is DocKind =>
  kind === 'html' || kind === 'pdf' || kind === 'markdown' || kind === 'image';

export const kindName: Record<DocKind, string> = {
  html: 'HTML',
  pdf: 'PDF',
  markdown: 'Markdown',
  image: '图片',
};

// The documents with source to edit in 源码 mode, beside a live preview.
export const hasSource = (kind: DocKind) => kind === 'html' || kind === 'markdown';
