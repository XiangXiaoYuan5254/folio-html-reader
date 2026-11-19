// The `folio` object 页间 puts in a plugin's page and background script (electron/plugins.cjs),
// as far as this plugin uses it. The full description: folio-plugins/docs/page-api.md.
import type { Library, LibraryPaper, PaperCandidate, PaperPatch, PaperDetail } from './shared';

type Unsubscribe = () => void;
export type TreeBadge = {
  icon?: 'check' | 'half' | 'dot' | 'star' | 'flag' | 'bookmark';
  text?: string;
  color?: string;
  title?: string;
};
export type TreeMenuItem = { id: string; label: string; kinds?: string[] };

declare global {
  const folio: {
    readonly settings: Readonly<Record<string, string>>;
    readonly theme: { dark: boolean; accent: string; reducedMotion: boolean; id: string };
    on(
      event: 'theme',
      listener: (t: { dark: boolean; accent: string; id: string }) => void,
    ): Unsubscribe;
    on(event: 'library', listener: (data: { version: number }) => void): Unsubscribe;
    on(event: 'visible', listener: (data: { visible: boolean }) => void): Unsubscribe;
    on(
      event: 'document',
      listener: (doc: { path: string; kind: string; title: string }) => void,
    ): Unsubscribe;
    on(event: 'progress', listener: (p: { path: string; progress: number }) => void): Unsubscribe;
    on(
      event: 'menu',
      listener: (m: { id: string; path: string; kind: string }) => void,
    ): Unsubscribe;
    on(event: 'request', listener: (data: any) => void): Unsubscribe;
    on(
      event: 'created',
      listener: (c: { path: string; source: string; by: string }) => void,
    ): Unsubscribe;
    open(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    project(): Promise<{ name: string }>;
    notify(text: string, options?: { action?: string }): Promise<boolean>;
    openSettings(): Promise<void>;
    showPage(data?: unknown): Promise<void>;
    setBadge(text: string): Promise<void>;
    storage: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    library: {
      list(): Promise<Library>;
      get(id: string): Promise<PaperDetail>;
      update(id: string, patch: PaperPatch): Promise<LibraryPaper>;
      add(
        paper: PaperPatch & { title: string },
      ): Promise<{ paper: LibraryPaper; created: boolean }>;
      addMany(
        papers: (PaperPatch & { id?: string })[],
        options?: { overwrite?: boolean },
      ): Promise<{ papers: LibraryPaper[]; created: number; updated: number }>;
      remove(ids: string | string[]): Promise<number>;
      setList(list: { name: string; note?: string; papers: string[] }): Promise<number>;
      lookup(query: {
        title?: string;
        doi?: string;
        arxiv?: string;
      }): Promise<{ papers: PaperCandidate[]; notes: string[] }>;
      exportBibtex(ids?: string[]): Promise<number | false>;
      importBibtex(text?: string): Promise<{ created: number; updated: number } | false>;
    };
    documents: {
      list(): Promise<{ path: string; kind: string }[]>;
      read(
        path: string,
        options?: { maxChars?: number },
      ): Promise<{ path: string; title: string; text: string }>;
      annotations(path: string): Promise<{
        note: string;
        highlights: { text: string; note: string; by?: 'ai' }[];
        notes: string[];
      }>;
    };
    tree: {
      set(decor: {
        badges?: Record<string, TreeBadge>;
        menus?: Record<string, TreeMenuItem[]>;
        fileMenu?: TreeMenuItem[];
        folderMenu?: TreeMenuItem[];
      }): Promise<void>;
    };
    tools: {
      handle(
        name: string,
        handler:
          | ((input: any, how: { via: 'assistant' | 'mcp' }) => unknown)
          | {
              preview?: (input: any) => unknown;
              run: (input: any, how: { via: 'assistant' | 'mcp' }) => unknown;
            },
      ): void;
    };
  };
}
