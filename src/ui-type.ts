import { useSyncExternalStore } from 'react';

// The interface's own font and size (设置 › 外观与阅读). Documents keep their own design: the
// size is the window's zoom, which ReaderFrame undoes inside the document. Unset, the
// theme's font and 100% show, as they always have.
export type UiType = { font: string; zoom: number };
export const uiZooms = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const storageKey = 'folio.ui-type';
// Behind a picked font, for the characters it doesn't have (Chinese, for most Latin fonts).
const fallback =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";

const clean = (font: unknown) =>
  typeof font === 'string'
    ? font
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 200)
    : '';
function load(): UiType {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return { font: clean(saved?.font), zoom: uiZooms.includes(saved?.zoom) ? saved.zoom : 1 };
  } catch {
    return { font: '', zoom: 1 };
  }
}
let state = load();
const listeners = new Set<() => void>();

// A font family as CSS names it.
export const fontStack = (family: string) => `"${family.replace(/["\\]/g, '\\$&')}"`;

/** Puts the saved font and size on the interface; called before the first render. */
export function applyUiType() {
  const root = document.documentElement.style;
  if (state.font) {
    const stack = `${fontStack(state.font)}, ${fallback}`;
    root.setProperty('--font-sans', stack);
    root.setProperty('--font-display', stack);
  } else {
    root.removeProperty('--font-sans');
    root.removeProperty('--font-display');
  }
  window.folio?.invoke('ui-zoom', { zoom: state.zoom }).catch(() => {});
}

export function setUiType(next: Partial<UiType>) {
  const font = 'font' in next ? clean(next.font) : state.font;
  const zoom = uiZooms.includes(next.zoom!) ? next.zoom! : state.zoom;
  state = { font, zoom };
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {}
  applyUiType();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useUiType() {
  return useSyncExternalStore(subscribe, () => state);
}

// Chinese names for common Chinese fonts, which the system lists by their English names.
const chineseNames: Record<string, string> = {
  'PingFang SC': '苹方-简',
  'PingFang TC': '苹方-繁',
  'Hiragino Sans GB': '冬青黑体简体中文',
  'Heiti SC': '黑体-简',
  'Songti SC': '宋体-简',
  'Kaiti SC': '楷体-简',
  'Yuanti SC': '圆体-简',
  'Lantinghei SC': '兰亭黑-简',
  'Libian SC': '隶变-简',
  'Weibei SC': '魏碑-简',
  'Xingkai SC': '行楷-简',
  'Wawati SC': '娃娃体-简',
  'Hannotate SC': '手札体-简',
  'HanziPen SC': '翩翩体-简',
  STHeiti: '华文黑体',
  STSong: '华文宋体',
  STKaiti: '华文楷体',
  STFangsong: '华文仿宋',
  'Microsoft YaHei': '微软雅黑',
  'Microsoft YaHei UI': '微软雅黑 UI',
  'Microsoft JhengHei': '微軟正黑體',
  SimSun: '宋体',
  NSimSun: '新宋体',
  SimHei: '黑体',
  KaiTi: '楷体',
  FangSong: '仿宋',
  DengXian: '等线',
  'Source Han Sans SC': '思源黑体',
  'Source Han Serif SC': '思源宋体',
  'Noto Sans SC': '思源黑体（Noto）',
  'Noto Serif SC': '思源宋体（Noto）',
  'LXGW WenKai': '霞鹜文楷',
};
export type FontOption = { family: string; name: string };
let families: Promise<FontOption[]> | null = null;
/** The font families installed on this computer, Chinese ones first; asked for once. */
export function localFonts() {
  families ||= (async () => {
    const query = (window as { queryLocalFonts?: () => Promise<{ family: string }[]> })
      .queryLocalFonts;
    if (!query) return [];
    const found = [...new Set((await query()).map((f) => clean(f.family)).filter(Boolean))];
    return found
      .map((family) => ({ family, name: chineseNames[family] || '' }))
      .sort((a, b) => Number(!a.name) - Number(!b.name) || a.family.localeCompare(b.family, 'en'));
  })();
  families.catch(() => (families = null));
  return families;
}
