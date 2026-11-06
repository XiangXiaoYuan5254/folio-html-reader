// Copies what the public folio-plugins repository shares with the app, so they never differ:
// the manifest rules (electron/plugin-manifest.cjs → the CLI's lib/manifest.cjs), the independently distributed
// AI 前沿日报 as an example, and the script types into the CLI package.
// tests/plugins.test.cjs fails when they've drifted; run `node scripts/sync-plugin-kit.mjs`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kit = path.join(root, 'folio-plugins');
const copies = [
  ['electron/plugin-manifest.cjs', 'folio-plugins/cli/lib/manifest.cjs'],
  ['folio-plugins/types/folio.d.ts', 'folio-plugins/cli/types/folio.d.ts'],
];
for (const name of await fs.readdir(path.join(root, 'plugins/ai-daily')))
  copies.push([`plugins/ai-daily/${name}`, `folio-plugins/examples/ai-daily/${name}`]);

export const pluginKitCopies = copies;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fs.access(kit);
  for (const [from, to] of copies) {
    await fs.mkdir(path.dirname(path.join(root, to)), { recursive: true });
    await fs.copyFile(path.join(root, from), path.join(root, to));
    console.log(`${from} → ${to}`);
  }
}
