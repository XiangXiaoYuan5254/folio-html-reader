// Official plugins written in TypeScript (plugins/<id>/src): bundled into the plain .js and .css
// files their folio-plugin.json lists, which are what gets published. A page runs as a classic
// script in a sandboxed frame (no modules there), so each entry becomes one self-contained IIFE.
//
//   node scripts/build-plugins.mjs           build them all
//   node scripts/build-plugins.mjs --watch   rebuild on every change (with 「从文件夹加载…」)
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugins = [
  {
    dir: 'plugins/library',
    entries: { page: 'src/page.tsx', background: 'src/background.ts' },
  },
];

const options = plugins.map(({ dir, entries }) => ({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([out, src]) => [out, path.join(dir, src)]),
  ),
  outdir: dir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
}));

if (process.argv.includes('--watch')) {
  for (const o of options) await (await context(o)).watch();
  console.log('watching plugins…');
} else {
  for (const o of options) await build(o);
}
