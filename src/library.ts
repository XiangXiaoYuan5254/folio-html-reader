import { useSyncExternalStore } from 'react';
import { invoke, subscribe } from './api';

// 文献库: the project's papers, as electron/library.cjs keeps them.
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
// What OpenAlex or arXiv knows of a paper (electron/papers.cjs lookup).
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

const none: Library = { papers: [], lists: [] };
let current = none;
let byFile = new Map<string, LibraryPaper>();
const watchers = new Set<() => void>();
let asked = 0;
function set(next: Library) {
  current = next;
  byFile = new Map(next.papers.flatMap((p) => p.files.map((f) => [f, p] as const)));
  watchers.forEach((w) => w());
}
// Reads the open project's library again; a project without one (or none open) has none.
export async function reloadLibrary() {
  const mine = ++asked;
  let next = none;
  try {
    const value = await invoke<Library>('library');
    if (Array.isArray(value?.papers)) next = { papers: value.papers, lists: value.lists || [] };
  } catch {}
  if (mine === asked) set(next);
}
export function clearLibrary() {
  asked++;
  set(none);
}
subscribe((e) => {
  if (e.type === 'library-changed') void reloadLibrary();
});
const watch = (w: () => void) => {
  watchers.add(w);
  return () => watchers.delete(w);
};
export function useLibrary(): Library {
  return useSyncExternalStore(watch, () => current);
}
export const library = () => current;
// The paper a document belongs to.
export const paperOf = (path: string | undefined) => (path ? byFile.get(path) : undefined);
export function usePaperOf(path: string | undefined) {
  useLibrary();
  return paperOf(path);
}

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

export const libraryApi = {
  add: (paper: PaperPatch & { title: string }, overwrite = false) =>
    invoke<{ paper: LibraryPaper; created: boolean }>('library-add', { paper, overwrite }),
  addMany: (papers: (PaperPatch & { id?: string })[], overwrite = false) =>
    invoke<{ papers: LibraryPaper[]; created: number; updated: number }>('library-add', {
      papers,
      overwrite,
    }),
  update: (id: string, patch: PaperPatch) => invoke<LibraryPaper>('library-update', { id, patch }),
  remove: (ids: string[]) => invoke<number>('library-remove', { ids }),
  setList: (list: { name: string; note?: string; papers: string[] }) =>
    invoke<number>('library-list-set', list),
  lookup: (query: { title?: string; doi?: string; arxiv?: string }) =>
    invoke<{ papers: PaperCandidate[]; notes: string[] }>('library-lookup', query),
  detail: (id: string) => invoke<LibraryPaper & { documents: unknown[] }>('library-detail', { id }),
  exportBibtex: (ids?: string[]) => invoke<number | false>('library-export', { ids }),
  importBibtex: () => invoke<{ created: number; updated: number } | false>('library-import'),
};
