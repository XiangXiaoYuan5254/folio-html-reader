import { useSyncExternalStore } from 'react';
import { crossFade } from './motion';

export type ThemeId =
  | 'default'
  | 'paper'
  | 'sky'
  | 'blossom'
  | 'brutal'
  | 'editorial'
  | 'night'
  | 'ink'
  | 'terminal'
  | 'aurora';
export type ThemeInfo = {
  id: ThemeId;
  name: string;
  tagline: string;
  dark: boolean;
  // Changes shapes, borders and type as well as colors (theme-styles.css).
  bold?: boolean;
  // Solid colors for the native window: its background and the Windows caption buttons.
  window: string;
  titlebar: string;
  symbol: string;
};

export const themes: ThemeInfo[] = [
  {
    id: 'default',
    name: '青岚',
    tagline: '默认 · 清爽青绿',
    dark: false,
    window: '#f7f8fa',
    titlebar: '#ffffff',
    symbol: '#5f6b77',
  },
  {
    id: 'paper',
    name: '宣纸',
    tagline: '暖白纸色 · 朱砂点染',
    dark: false,
    window: '#f2ece1',
    titlebar: '#f7f2e8',
    symbol: '#6a5f53',
  },
  {
    id: 'sky',
    name: '晴空',
    tagline: '通透天蓝 · 渐变按钮',
    dark: false,
    window: '#edf1f8',
    titlebar: '#f8faff',
    symbol: '#56637c',
  },
  {
    id: 'blossom',
    name: '桃夭',
    tagline: '柔和樱粉 · 温润不刺眼',
    dark: false,
    window: '#f8eef0',
    titlebar: '#fdf6f7',
    symbol: '#75606a',
  },
  {
    id: 'brutal',
    name: '新粗野',
    tagline: '粗黑描边 · 硬投影撞色',
    dark: false,
    bold: true,
    window: '#fff8e7',
    titlebar: '#ffd23f',
    symbol: '#111111',
  },
  {
    id: 'editorial',
    name: '报刊',
    tagline: '报纸版式 · 黑白朱红',
    dark: false,
    bold: true,
    window: '#efebe2',
    titlebar: '#f7f4ec',
    symbol: '#141414',
  },
  {
    id: 'night',
    name: '夜读',
    tagline: '深蓝灰 · 青绿微光',
    dark: true,
    window: '#14181e',
    titlebar: '#15191f',
    symbol: '#a6afbd',
  },
  {
    id: 'ink',
    name: '墨金',
    tagline: '墨色沉静 · 鎏金点缀',
    dark: true,
    window: '#12110f',
    titlebar: '#141210',
    symbol: '#b3a894',
  },
  {
    id: 'terminal',
    name: '终端',
    tagline: '荧光绿 · 等宽扫描线',
    dark: true,
    bold: true,
    window: '#050805',
    titlebar: '#040704',
    symbol: '#33ff66',
  },
  {
    id: 'aurora',
    name: '极光',
    tagline: '极光渐变 · 毛玻璃浮层',
    dark: true,
    bold: true,
    window: '#0b0b1a',
    titlebar: '#100c26',
    symbol: '#d6d3f5',
  },
];

export type ThemePrefs = {
  theme: ThemeId;
  // Use `light` or `dark` according to the system appearance instead of `theme`.
  followSystem: boolean;
  light: ThemeId;
  dark: ThemeId;
};

const storageKey = 'folio.theme';
const byId = new Map(themes.map((t) => [t.id, t]));
const isTheme = (value: unknown, dark?: boolean): value is ThemeId =>
  typeof value === 'string' &&
  byId.has(value as ThemeId) &&
  (dark === undefined || byId.get(value as ThemeId)!.dark === dark);

function load(): ThemePrefs {
  let saved: Partial<ThemePrefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
  } catch {}
  return {
    theme: isTheme(saved.theme) ? saved.theme : 'default',
    followSystem: saved.followSystem === true,
    light: isTheme(saved.light, false) ? saved.light : 'default',
    dark: isTheme(saved.dark, true) ? saved.dark : 'night',
  };
}

// Without a membership only the default theme shows (src/license.ts); the chosen ones are kept
// for when it comes back. The last answer is remembered, so a member's theme shows from the
// first frame instead of after the membership has been checked.
export const freeTheme: ThemeId = 'default';
const unlockedKey = 'folio.themes-unlocked';
let unlocked = false;
try {
  unlocked = localStorage.getItem(unlockedKey) === '1';
} catch {}

const media = window.matchMedia('(prefers-color-scheme: dark)');
let prefs = load();
let state = { prefs, active: resolve(prefs), unlocked };
const listeners = new Set<() => void>();

function resolve(p: ThemePrefs): ThemeId {
  if (!unlocked) return freeTheme;
  if (!p.followSystem) return p.theme;
  return media.matches ? p.dark : p.light;
}

function update(next: ThemePrefs) {
  prefs = next;
  try {
    localStorage.setItem(storageKey, JSON.stringify(prefs));
  } catch {}
  refresh();
}

function refresh() {
  const active = resolve(prefs);
  const changed = active !== state.active;
  state = { prefs, active, unlocked };
  const show = () => {
    applyTheme();
    for (const listener of listeners) listener();
  };
  // A new theme fades in over the old one instead of flipping every color at once.
  if (changed) crossFade(show);
  else show();
}

/** Puts the saved theme on the page; called before the first render to avoid a flash. */
export function applyTheme() {
  const info = byId.get(state.active)!;
  const root = document.documentElement;
  root.dataset.theme = info.id;
  root.dataset.style = info.bold ? 'bold' : 'classic';
  root.dataset.scheme = info.dark ? 'dark' : 'light';
  // On a Mac the classic themes let the window's frosted material show through the title
  // bar and the file tree; the bold themes keep their own solid surfaces.
  root.toggleAttribute('data-glass', window.folio?.platform === 'darwin' && !info.bold);
  window.folio
    ?.invoke('appearance', { window: info.window, titlebar: info.titlebar, symbol: info.symbol })
    .catch(() => {});
}

/** Picks a theme; while following the system it fills the light or dark slot. */
export function setTheme(id: ThemeId) {
  const dark = byId.get(id)!.dark;
  update({
    ...prefs,
    theme: prefs.followSystem ? prefs.theme : id,
    ...(dark ? { dark: id } : { light: id }),
  });
}

export function setFollowSystem(followSystem: boolean) {
  // Turning it off keeps the theme that is showing now.
  update({ ...prefs, followSystem, theme: followSystem ? prefs.theme : state.active });
}

export function setThemesUnlocked(next: boolean) {
  if (next === unlocked) return;
  unlocked = next;
  try {
    localStorage.setItem(unlockedKey, next ? '1' : '0');
  } catch {}
  refresh();
}

media.addEventListener('change', () => {
  if (prefs.followSystem) refresh();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme() {
  return useSyncExternalStore(subscribe, () => state);
}

export function themeInfo(id: ThemeId) {
  return byId.get(id)!;
}
