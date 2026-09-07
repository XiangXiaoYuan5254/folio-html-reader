export type Tool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'text'
  | 'sticky'
  | 'pen'
  | 'laser'
  | 'arrow'
  | 'rectangle'
  | 'eraser';
export type Anchor = { exact: string; prefix: string; suffix: string; start: number; end: number };
export type Point = { x: number; y: number };
export type Annotation = {
  id: string;
  type: Exclude<Tool, 'select' | 'eraser' | 'laser'>;
  color: string;
  createdAt: number;
  quote?: Anchor;
  points?: Point[];
  /** Remaining ink fragments after a partial erase; older documents use points. */
  paths?: Point[][];
  strokeWidth?: number;
  fontSize?: number;
  size?: { width: number; height: number };
  collapsed?: boolean;
  note: string;
  anchor?: { selector: string; top: number; left: number };
  orphan?: boolean;
};
export type DocumentData = {
  version: 1;
  annotations: Annotation[];
  note: string;
  scroll: number;
  zoom: number;
};
export type FileNode = {
  name: string;
  path: string;
  kind: 'folder' | 'html' | 'asset';
  children?: FileNode[];
};
export type WorkspaceInfo = {
  name: string;
  root: string;
  token: string;
  tree: FileNode[];
  session?: { paths: string[]; active: string } | null;
};
export type OpenDocument = {
  path: string;
  id: string;
  source: string;
  version: string;
  data: DocumentData;
  draft: string;
  preview: number;
  history: Annotation[][];
  future: Annotation[][];
};
export type OutlineItem = { id: string; text: string; level: number };
export type FrameEvent = { type: string; [key: string]: any };
export interface FolioBridge {
  platform: string;
  invoke: (action: string, payload?: unknown, token?: string) => Promise<any>;
  subscribe: (cb: (e: { type: string }) => void) => () => void;
}
declare global {
  interface Window {
    folio?: FolioBridge;
  }
}
