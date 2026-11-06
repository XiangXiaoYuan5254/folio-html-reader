// Plugins as electron/plugins.cjs describes them.
export type PluginSetting = {
  key: string;
  type: 'text' | 'textarea' | 'folder';
  label: string;
  hint: string;
  default: string;
};
export type PluginTrigger = { type: 'daily'; time: string } | { type: 'button'; label: string };
export type PluginManifest = {
  folio: 1;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  homepage: string;
  engines?: { folio: string };
  icon: string;
  files: string[];
  run: {
    prompt: string;
    template: string;
    script: string;
    tools: string[];
    web: boolean;
    // project: works in the open project. folder: in a folder of its own, whichever project
    // is open, seeing and writing nothing else.
    where: 'project' | 'folder';
  };
  triggers: PluginTrigger[];
  permissions: { network: string[]; write: string[] };
  settings: PluginSetting[];
};
export type PluginSource =
  | { type: 'bundled' }
  | { type: 'local' }
  // An official plugin: downloaded from the website and checked against its SHA-256.
  | { type: 'official' }
  // Loaded from a folder being written: read where it is, so saved changes count at once.
  | { type: 'folder'; path: string; shown: string }
  // Installed from a .zip: a copy, updated by installing a newer .zip.
  | { type: 'zip'; name: string }
  | {
      type: 'github' | 'gitee';
      owner: string;
      repo: string;
      ref: string;
      path: string;
      url: string;
      commit: string;
    };
export type PluginResult = { ok: boolean; message: string; output: string; at: number };
export type PluginInfo = {
  id: string;
  manifest?: PluginManifest;
  // A plugin that couldn't be read, and why.
  error?: string;
  // A plugin loaded from a folder: what its author may have got wrong (it still runs).
  warnings?: string[];
  bundled: boolean;
  source?: PluginSource;
  enabled: boolean;
  settings: Record<string, string>;
  // The project its schedule runs in.
  root: string;
  enabledAt: number;
  lastRun: number;
  lastResult: PluginResult | null;
  installedAt: number;
  // A folder plugin's folder: as set, as shown (~/Documents/AI日报), and as Folio's project
  // path for it (links resolved), to tell when it's the project open.
  folder?: { path: string; shown: string; real: string };
  // A plugin with a daily trigger: the time it runs (the reader's own, or its default), or
  // off; changedAt is when that was last changed.
  schedule?: { time: string; off: boolean; changedAt: number };
};
// An official plugin, as listed before anything is downloaded.
export type PluginRecommendation = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  requires: string;
  // Its icon, as a data: URL ('' for none).
  icon?: string;
};
export type PluginList = {
  thirdParty: boolean;
  appVersion: string;
  plugins: PluginInfo[];
  recommendations: PluginRecommendation[];
};
export type PluginAdded = {
  network: string[];
  write: string[];
  tools: string[];
  script: boolean;
  web: boolean;
};
// A plugin read from a link and waiting to be installed.
export type PluginInspection = {
  stage: string;
  manifest: PluginManifest;
  source: Exclude<PluginSource, { type: 'bundled' } | { type: 'local' }>;
  files: { name: string; size: number }[];
  installed: { version: string; commit: string } | null;
  sameCommit: boolean;
  added: PluginAdded | null;
  warnings: string[];
};
// A line in a plugin's run log (electron/plugins.cjs keeps the latest few hundred).
export type PluginLogKind = 'run' | 'tool' | 'script' | 'warn' | 'error';
export type PluginLogEntry = { at: number; kind: PluginLogKind; text: string };
// A plugin in the directory of third-party plugins (the public folio-plugins repository).
export type DirectoryPlugin = {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  tags: string[];
};
export type PluginDirectory = { at: number; from: string; plugins: DirectoryPlugin[] };
export type PluginLoaded = {
  manifest: PluginManifest;
  prompt: string;
  template: string;
  hasScript: boolean;
};
