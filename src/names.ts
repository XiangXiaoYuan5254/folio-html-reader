import type { FileNode } from './types';

// The k-th name to try in place of one already taken, as electron/workspace.cjs numbers it:
// 未命名.html → 未命名2.html, 未命名3.html…; a name ending in a number goes on from it
// (未命名2.html → 未命名3.html, 文档09.html → 文档10.html); a name that is only a number
// gets a dash (2024.html → 2024-2.html).
export function numberedName(name: string, k: number, folder: boolean) {
  const dot = folder ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const counted = /^(.*\D)(\d+)$/.exec(stem);
  const next = counted
    ? counted[1] + String(Number(counted[2]) + k).padStart(counted[2].length, '0')
    : `${stem}${/^\d+$/.test(stem) ? '-' : ''}${k + 1}`;
  return `${next}${ext}`;
}

// The names in a folder of the project ('' is its top), in lower case: the disk may not
// tell case apart.
function namesIn(tree: FileNode[], folder: string) {
  let nodes = tree;
  for (const part of folder ? folder.split('/') : [])
    nodes = nodes.find((n) => n.kind === 'folder' && n.name === part)?.children || [];
  return new Set(nodes.map((n) => n.name.toLowerCase()));
}

/** `name`, or the first numbered one not yet in `folder`. */
export function freeName(tree: FileNode[], folder: string, name: string, isFolder: boolean) {
  const taken = namesIn(tree, folder);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : numberedName(name, n - 1, isFolder);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}
