// Official plugins, published on the website apart from the app: a versioned .zip each, and
// official.json, the signed list 页间 reads in 设置 › 插件 (electron/official-plugins.cjs).
// Publishing or updating a plugin needs no app release, and releasing the app touches no plugin.
//
// Which plugins: plugins/publish.json — { "plugins": [{ "dir": "ai-daily", "listed": true }] },
// each dir relative to plugins/. A plugin with "listed": false is built and uploaded, but not in
// the list, so no one sees it yet.
//
// The signing key never goes in the repository or on the server: FOLIO_PLUGIN_KEY, or
// ~/.config/folio/official-plugins.pem. `node scripts/website-plugins.mjs --new-key` makes one and
// prints the public key for OFFICIAL_KEYS.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPluginDir, MANIFEST } = require('../electron/plugin-manifest.cjs');
const { pluginDigest } = require('../electron/plugins.cjs');
const { signOfficial } = require('../electron/official-plugins.cjs');
const { writeZip } = require('../folio-plugins/cli/lib/zip.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://helloxxy.com/works/folio/plugins/';
export const defaultKeyFile = () =>
  process.env.FOLIO_PLUGIN_KEY || path.join(os.homedir(), '.config/folio/official-plugins.pem');
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

async function iconData(file) {
  const type = /\.svg$/i.test(file) ? 'image/svg+xml' : 'image/png';
  return `data:${type};base64,${(await fs.readFile(file)).toString('base64')}`;
}

// One plugin: its .zip (stable bytes, so the SHA-256 stays the same build after build) and its
// entry in the list.
async function buildPlugin(dir) {
  const { manifest, raw } = await readPluginDir(dir);
  const contents = [{ name: MANIFEST, data: raw }];
  for (const name of manifest.files)
    contents.push({ name, data: await fs.readFile(path.join(dir, name)) });
  const zip = writeZip(
    contents.map((f) => ({ ...f, name: `${manifest.id}/${f.name}` })),
    { date: new Date(2000, 0, 1) },
  );
  const filename = `${manifest.id}-${manifest.version}.zip`;
  const entry = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    requires: manifest.engines?.folio || '',
    url: SITE + filename,
    sha256: crypto.createHash('sha256').update(zip).digest('hex'),
    // Recognises a copy installed as a plain .zip (electron/plugins.cjs).
    digest: pluginDigest(contents),
    // Shown in 设置 › 插件 before anything is downloaded.
    icon: manifest.icon ? await iconData(path.join(dir, manifest.icon)) : '',
  };
  return { entry, zip, filename };
}

export async function buildWebsitePlugins({
  outputDir = path.join(root, 'website/plugins'),
  sourcesFile = path.join(root, 'plugins/publish.json'),
  keyFile = defaultKeyFile(),
  seq = Date.now(),
} = {}) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(await fs.readFile(keyFile));
  } catch {
    throw Error(
      `No plugin signing key at ${keyFile}. Use the maintainer's key (FOLIO_PLUGIN_KEY), or make one with --new-key and put its public key in electron/official-plugins.cjs.`,
    );
  }
  const sources = JSON.parse(await fs.readFile(sourcesFile, 'utf8')).plugins;
  const built = [];
  for (const { dir, listed } of sources) {
    const full = path.resolve(path.dirname(sourcesFile), dir);
    const plugin = await buildPlugin(full).catch((e) => {
      throw Error(`${dir}: ${e.message}`);
    });
    if (listed && !plugin.entry.requires)
      throw Error(`${dir}: a listed plugin says which 页间 it needs (engines.folio)`);
    built.push({ ...plugin, listed: !!listed });
  }
  const listed = built.filter((p) => p.listed).map((p) => p.entry);
  await fs.mkdir(outputDir, { recursive: true });
  for (const { filename, zip } of built) await fs.writeFile(path.join(outputDir, filename), zip);
  await fs.writeFile(
    path.join(outputDir, 'SHA256SUMS.txt'),
    built.map((p) => `${p.entry.sha256}  ${p.filename}\n`).join(''),
  );
  await fs.writeFile(
    path.join(outputDir, 'official.json'),
    signOfficial({ version: 1, seq, plugins: listed }, privateKey),
  );
  const template = await fs.readFile(path.join(root, 'scripts/website-plugins.html'), 'utf8');
  const articles = listed
    .map(
      (p) => `      <article class="plugin-entry">
        <img src="${escapeHtml(p.icon)}" alt="" />
        <div>
          <h2>${escapeHtml(p.name)}</h2>
          <p>${escapeHtml(p.description)}</p>
          <p class="plugin-meta">官方插件 · ${escapeHtml(p.version)} · 需要页间 ${escapeHtml(p.requires.replace(/^>=\s*/, ''))} 或更新版本</p>
        </div>
      </article>`,
    )
    .join('\n');
  await fs.writeFile(path.join(outputDir, 'index.html'), template.replace('{{plugins}}', articles));
  for (const p of built)
    console.log(`${p.listed ? 'listed  ' : 'unlisted'} ${p.filename} (${p.zip.length} bytes)`);
  console.log(`Signed official.json (seq ${seq}). Upload website/plugins/ — the zips before official.json.`);
  return { listed, built: built.map((p) => ({ ...p.entry, listed: p.listed })) };
}

async function newKey(file) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`Key written to ${file}. Public key for OFFICIAL_KEYS:`);
  console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--new-key')) await newKey(defaultKeyFile());
  else await buildWebsitePlugins();
}
