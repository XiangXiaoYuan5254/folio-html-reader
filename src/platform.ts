// Wording that differs between macOS and Windows. The web preview follows the browser's OS.
export const isMac = window.folio
  ? window.folio.platform === 'darwin'
  : /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const keyNames: Record<string, string> = isMac
  ? { mod: '⌘', shift: '⇧', alt: '⌥' }
  : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt' };
// shortcut('mod', 'shift', 'F') is "⌘ ⇧ F" on macOS and "Ctrl+Shift+F" on Windows.
export function shortcut(...keys: string[]) {
  return keys.map((key) => keyNames[key] ?? key).join(isMac ? ' ' : '+');
}
export const fileManager = isMac ? '访达' : '资源管理器';
export const trashName = isMac ? '废纸篓' : '回收站';
