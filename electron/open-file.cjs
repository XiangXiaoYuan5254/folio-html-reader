const fs = require('node:fs/promises');
const path = require('node:path');
const { isDocument } = require('./formats.cjs');

// Relative path of `file` inside `root`, or null when it is outside it or in a
// hidden folder (projects keep their own data in `.html-reader`).
function inside(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.some((p) => p.startsWith('.')) ? null : parts.join('/');
}

// Picks the project for a file opened from Finder or Explorer: the current project when it
// holds the file, else the innermost recent project that does, else the file's folder.
async function projectFor(file, current, recent = []) {
  const real = await fs.realpath(file);
  if (!isDocument(real))
    throw Error(`页间只能打开 HTML、PDF、Markdown 或图片文件：${path.basename(file)}`);
  const roots = [];
  for (const root of recent)
    if (typeof root === 'string') {
      const r = await fs.realpath(root).catch(() => null);
      if (r) roots.push(r);
    }
  roots.sort((a, b) => b.length - a.length);
  for (const root of current ? [current, ...roots] : roots) {
    const relative = inside(root, real);
    if (relative) return { root, relative };
  }
  return { root: path.dirname(real), relative: path.basename(real) };
}

// Documents passed on the command line. Windows and Linux open files this way (Explorer's
// "Open with", double-click, dropping onto the icon) instead of macOS's open-file event.
// Chromium adds its own switches to a second instance's argv, so only document paths count.
function filesFromArgv(argv, cwd) {
  return argv
    .slice(1)
    .filter((arg) => typeof arg === 'string' && !arg.startsWith('-') && isDocument(arg))
    .map((arg) => path.resolve(cwd, arg));
}

module.exports = { projectFor, filesFromArgv };
