// Standalone plugin downloads. No installer or update metadata is touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPluginDir, MANIFEST } = require('../electron/plugin-manifest.cjs');
const { writeZip } = require('../folio-plugins/cli/lib/zip.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );

export async function buildWebsitePlugins({
  outputDir = path.join(root, 'website/plugins'),
  recommendationsFile = path.join(root, 'electron/recommended-plugins.json'),
} = {}) {
  const { version: appVersion } = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  );
  const { manifest, raw, dir } = await readPluginDir(path.join(root, 'plugins/ai-daily'), {
    appVersion,
  });
  const files = [{ name: `${manifest.id}/${MANIFEST}`, data: raw }];
  for (const name of manifest.files)
    files.push({ name: `${manifest.id}/${name}`, data: await fs.readFile(path.join(dir, name)) });
  // Stable archive bytes, so the app can pin and verify its SHA-256 before installation.
  const zip = writeZip(files, { date: new Date(2000, 0, 1) });
  const filename = `${manifest.id}-${manifest.version}.zip`;
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  const recommendation = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    requires: manifest.engines.folio,
    url: `https://helloxxy.com/works/folio/plugins/${filename}`,
    sha256,
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, filename), zip);
  await fs.writeFile(path.join(outputDir, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`);
  const template = await fs.readFile(path.join(root, 'scripts/website-plugins.html'), 'utf8');
  const values = { ...recommendation, filename, size: `${Math.ceil(zip.length / 1024)} KB` };
  await fs.writeFile(
    path.join(outputDir, 'index.html'),
    template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (!(key in values)) throw Error(`Unknown plugin page field: ${key}`);
      return escapeHtml(values[key]);
    }),
  );
  await fs.writeFile(recommendationsFile, JSON.stringify([recommendation], null, 2) + '\n');
  console.log(
    `Plugin ready: ${filename} (${zip.length} bytes). Upload website/plugins/ before releasing the app.`,
  );
  return recommendation;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWebsitePlugins();
