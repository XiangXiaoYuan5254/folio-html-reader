import textTypes from '../electron/text-types.json';

// The files 页间 opens as documents; electron/formats.cjs decides the same on its side.
// Markdown, pictures, code and Word are read and annotated like HTML; HTML and Markdown have
// 源码 to edit.
export type DocKind = 'html' | 'pdf' | 'markdown' | 'image' | 'word' | 'code';

const kinds: DocKind[] = ['html', 'pdf', 'markdown', 'image', 'word', 'code'];

// What a code or text file holds, from its extension or, for a Makefile or LICENSE, its name:
// a highlight.js language, or text, plain, csv, tsv.
export function textType(path: string): string | null {
  const name = (path.split(/[/\\]/).at(-1) || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const table: Record<string, string> = dot > 0 ? textTypes.extensions : textTypes.names;
  const key = dot > 0 ? name.slice(dot + 1) : name;
  return Object.hasOwn(table, key) ? table[key] : null;
}

export function docKind(path: string): DocKind | null {
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)) return 'image';
  if (/\.docx$/i.test(path)) return 'word';
  if (textType(path) !== null) return 'code';
  return null;
}

export const isDocKind = (kind: string): kind is DocKind => kinds.includes(kind as DocKind);

export const kindName: Record<DocKind, string> = {
  html: 'HTML',
  pdf: 'PDF',
  markdown: 'Markdown',
  image: '图片',
  word: 'Word',
  code: '文本',
};

// The documents with source to edit in 源码 mode, beside a live preview.
export const hasSource = (kind: DocKind) => kind === 'html' || kind === 'markdown';
