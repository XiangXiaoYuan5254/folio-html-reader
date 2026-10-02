import type { Anchor, Annotation, DocumentData } from '../types';
import type { DocText, Paper } from './types';

// What the AI features may do in the app. App.tsx implements it on top of the open
// documents, the readers and the workspace; everything goes through the same paths as
// manual edits (undo history, backups, project boundaries).
export type AiHost = {
  projectName(): string;
  root(): string | undefined;
  files(): { path: string; kind: 'html' | 'pdf' }[];
  activePath(): string | undefined;
  docText(path: string): Promise<DocText>;
  anchors(path: string, quotes: string[]): Promise<(Anchor | null)[]>;
  flash(path: string, quote: string): Promise<boolean>;
  // The saved data and, for HTML, the current source (including unsaved edits).
  documentData(
    path: string,
  ): Promise<{ id: string; kind: 'html' | 'pdf'; data: DocumentData; source: string }>;
  addAnnotations(path: string, annotations: Annotation[]): Promise<void>;
  setNote(path: string, note: string): Promise<void>;
  // Opens `path` with the side panel on its document note, scrolled to the end.
  showNote(path: string): Promise<void>;
  setSource(path: string, source: string): Promise<{ saved: boolean }>;
  createHtml(path: string, content: string): Promise<void>;
  // Papers from OpenAlex and arXiv; `notes` says which of them could not be reached.
  searchPapers(options: {
    query: string;
    limit?: number;
    fromYear?: number;
    pdfOnly?: boolean;
  }): Promise<{ papers: Paper[]; notes: string[] }>;
  // Downloads a PDF into the project, creating folders on the way; resolves with its size.
  savePdf(url: string, path: string): Promise<number>;
  open(path: string): Promise<void>;
  // Shows `path` in two-column reading next to `beside` (e.g. a notes page next to its paper).
  openBeside(path: string, beside: string): Promise<void>;
  confirm(options: { title: string; message: string; confirmLabel: string }): Promise<boolean>;
  notify(text: string, error?: boolean): void;
  openSettings(): void;
};
