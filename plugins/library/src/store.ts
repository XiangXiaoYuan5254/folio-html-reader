import { useSyncExternalStore } from 'react';
import type { Library, PaperPatch } from './shared';

// The page's copy of the library: read when the page opens and each time 页间 says it changed.
const none: Library = { papers: [], lists: [] };
let current = none;
let asked = 0;
const watchers = new Set<() => void>();
function set(next: Library) {
  current = next;
  watchers.forEach((w) => w());
}
export async function reloadLibrary() {
  const mine = ++asked;
  try {
    const value = await folio.library.list();
    if (mine === asked && Array.isArray(value?.papers))
      set({ papers: value.papers, lists: value.lists || [] });
  } catch (e) {
    folio.warn('读文献库出错：', e);
  }
}
folio.on('library', () => void reloadLibrary());
export function useLibrary(): Library {
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => current,
  );
}

export const libraryApi = {
  add: (paper: PaperPatch & { title: string }) => folio.library.add(paper),
  addMany: (papers: (PaperPatch & { id?: string })[], overwrite = false) =>
    folio.library.addMany(papers, { overwrite }),
  update: (id: string, patch: PaperPatch) => folio.library.update(id, patch),
  remove: (ids: string[]) => folio.library.remove(ids),
  lookup: (query: { title?: string; doi?: string; arxiv?: string }) => folio.library.lookup(query),
  exportBibtex: (ids?: string[]) => folio.library.exportBibtex(ids),
  importBibtex: () => folio.library.importBibtex(),
};

// A short message at the bottom of the page.
type Toast = { text: string; error: boolean; id: number };
let toast: Toast | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toastWatchers = new Set<() => void>();
export function notify(text: string, error = false) {
  toast = { text, error, id: (toast?.id || 0) + 1 };
  toastWatchers.forEach((w) => w());
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast = null;
      toastWatchers.forEach((w) => w());
    },
    error ? 6000 : 3500,
  );
}
export function useToast() {
  return useSyncExternalStore(
    (w) => {
      toastWatchers.add(w);
      return () => toastWatchers.delete(w);
    },
    () => toast,
  );
}
export const clean = (e: unknown) => String((e as Error)?.message || e);
export const openFile = (path: string) =>
  void folio.open(path).catch((e) => notify(clean(e), true));
