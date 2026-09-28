import type { FrameEvent, WorkspaceInfo } from './types';
import { fileManager } from './platform';
let token = '';
export const isDesktop = !!window.folio;
export async function invoke<T = any>(action: string, payload: unknown = {}): Promise<T> {
  if (window.folio) return window.folio.invoke(action, payload, token);
  const r = await fetch('/__api/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Folio-Token': token },
    body: JSON.stringify(payload),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error);
  return result;
}
export function useWorkspace(w: WorkspaceInfo) {
  token = w.token;
}
export function documentUrl(path: string, version: number) {
  return isDesktop
    ? `folio://document/${token}/${path.split('/').map(encodeURIComponent).join('/')}?v=${version}`
    : `/__document/${token}/${path.split('/').map(encodeURIComponent).join('/')}?v=${version}`;
}
export function subscribe(cb: (e: FrameEvent) => void) {
  return window.folio?.subscribe(cb) || (() => {});
}

export async function importFiles(files: File[], destination: string) {
  if (!window.folio) throw Error(`请在桌面版中从${fileManager}拖入文件`);
  return window.folio.importFiles(files, destination, token);
}
