// 文献库: the project's papers, as 页间 keeps them (electron/library.cjs, folio.library), and
// the small helpers the page and the background script share.
export type PaperStatus = 'unread' | 'reading' | 'done';
export type LibraryPaper = {
  id: string;
  title: string;
  // Another name: a translated title, or the short name people call it.
  alias: string;
  authors: string[];
  year: number;
  venue: string;
  doi: string;
  arxiv: string;
  pmid: string;
  url: string;
  abstract: string;
  summary: string;
  note: string;
  tags: string[];
  // Levels divided by “/”.
  category: string;
  citations: number;
  status: PaperStatus;
  // The day it was marked read (YYYY-MM-DD), '' when not read or not known.
  readAt: string;
  addedAt: number;
  // Its documents in the project; `gone` are the ones no longer there.
  files: string[];
  gone: string[];
};
export type ReadingList = { name: string; note: string; papers: string[] };
export type Library = { papers: LibraryPaper[]; lists: ReadingList[] };
export type PaperPatch = Partial<
  Omit<LibraryPaper, 'id' | 'gone' | 'addedAt' | 'authors' | 'tags'>
> & { authors?: string[] | string; tags?: string[] | string };
export type PaperDetail = LibraryPaper & {
  documents: {
    path: string;
    kind: string;
    note?: string;
    highlights?: { text: string; note: string; by?: 'ai' }[];
    notes?: string[];
  }[];
};
// What OpenAlex or arXiv knows of a paper.
export type PaperCandidate = {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  citations?: number;
  doi?: string;
  arxiv?: string;
  pmid?: string;
  url?: string;
  abstract?: string;
  source: string;
  match: number;
};

export const statusName: Record<PaperStatus, string> = {
  unread: '未读',
  reading: '在读',
  done: '已读',
};

// “Vaswani 等”: who wrote it, short enough for a list.
export function authorsShort(p: { authors: string[] }) {
  const first = p.authors[0];
  if (!first) return '';
  const name = first.includes(',')
    ? first.split(',')[0].trim()
    : /[一-鿿]/.test(first)
      ? first
      : first.split(/\s+/).at(-1)!;
  return p.authors.length > 1 ? `${name} 等` : name;
}
// Where a paper sits: the category given, or the folder its first file is in.
export function categoryOf(p: LibraryPaper) {
  if (p.category) return p.category;
  const file = p.files.find((f) => !p.gone.includes(f));
  return file && file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
}
// The file to open for a paper: the one being read (a note page or the PDF), first there.
export const mainFile = (p: LibraryPaper) => p.files.find((f) => !p.gone.includes(f));
// A title guessed from a file name: “1706.03762v7.pdf” stays; “attention_is_all-you-need.pdf”
// → “attention is all you need”.
export function titleFromPath(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(name) ? name : name.replace(/[_]+/g, ' ').trim() || name;
}
export const arxivIdIn = (text: string) =>
  text.match(/(?:^|[^\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d.]*\d)/)?.[1] || '';
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// The documents a paper can have: not pictures.
export const isPaperFile = (kind: string) => ['pdf', 'html', 'markdown'].includes(kind);
