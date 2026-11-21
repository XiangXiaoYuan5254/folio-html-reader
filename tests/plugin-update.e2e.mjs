// An official plugin updating itself, end to end in the real Electron app: an older AI 前沿日报
// is installed, the signed list (with a key of the test's own) has the version in this checkout,
// and 页间 installs it without being asked, keeping the plugin's settings and saying so.
// No real network or API key.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWebsitePlugins } from '../scripts/website-plugins.mjs';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-plugin-update-'));
const downloads = path.join(temp, 'downloads');
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-plugin-update-qa');
await fs.mkdir(downloads, { recursive: true });
await fs.mkdir(project, { recursive: true });
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(
  path.join(project, '笔记.html'),
  '<!doctype html><html><meta charset="utf-8"><body><h1>笔记</h1></body></html>',
);

const signing = crypto.generateKeyPairSync('ed25519');
await fs.writeFile(
  path.join(temp, 'key.pem'),
  signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
);
await fs.writeFile(
  path.join(temp, 'publish.json'),
  JSON.stringify({ plugins: [{ dir: path.join(root, 'plugins/ai-daily'), listed: true }] }),
);
const [entry] = (
  await buildWebsitePlugins({
    outputDir: downloads,
    sourcesFile: path.join(temp, 'publish.json'),
    keyFile: path.join(temp, 'key.pem'),
  })
).listed;
// As if read from the website before: the newer version is known at once.
await fs.mkdir(userData, { recursive: true });
await fs.copyFile(
  path.join(downloads, 'official.json'),
  path.join(userData, 'official-plugins.json'),
);

// The version before, installed from the official list, on, with a setting of the reader's own.
const installed = path.join(userData, 'plugins', 'ai-daily');
await fs.cp(path.join(root, 'plugins/ai-daily'), installed, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(installed, 'folio-plugin.json'), 'utf8'));
assert.notEqual(manifest.version, '1.0.0');
await fs.writeFile(
  path.join(installed, 'folio-plugin.json'),
  JSON.stringify({ ...manifest, version: '1.0.0' }, null, 2),
);
await fs.writeFile(
  path.join(userData, 'plugins.json'),
  JSON.stringify({
    version: 1,
    thirdParty: false,
    plugins: {
      'ai-daily': {
        enabled: true,
        enabledAt: Date.now(),
        installedAt: 1,
        source: { type: 'official' },
        settings: { count: '30' },
        // Not run by the schedule while the test looks on.
        schedule: { off: true },
      },
    },
  }),
);
const state = async () =>
  JSON.parse(await fs.readFile(path.join(userData, 'plugins.json'), 'utf8')).plugins['ai-daily'];
const onDisk = async () =>
  JSON.parse(await fs.readFile(path.join(installed, 'folio-plugin.json'), 'utf8')).version;

let app, page;
const errors = [];
try {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
      FOLIO_DOCUMENTS: path.join(temp, 'Documents'),
      FOLIO_NO_SPEECH_HELPER: '1',
      FOLIO_OFFICIAL_KEY: signing.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64'),
    },
  });
  await app.evaluate(
    ({ net }, { url, zip }) => {
      globalThis.downloads = 0;
      const real = net.fetch.bind(net);
      net.fetch = (input, init) => {
        if (String(input) !== url) return real(input, init);
        globalThis.downloads++;
        return Promise.resolve(new Response(Buffer.from(zip, 'base64')));
      };
    },
    {
      url: entry.url,
      zip: (
        await fs.readFile(path.join(downloads, path.basename(new URL(entry.url).pathname)))
      ).toString('base64'),
    },
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|Content Security Policy/.test(m.text()))
      errors.push(m.text());
  });
  await page.waitForSelector('.document-frame');

  // Updated a few seconds after the project opens, without anything clicked.
  await page.getByText(`「AI 前沿日报」已自动更新到 ${entry.version}`).waitFor();
  await page.screenshot({ path: path.join(evidence, 'plugin-auto-updated.png') });
  assert.equal(await onDisk(), entry.version);
  assert.equal(await app.evaluate(() => globalThis.downloads), 1);
  const saved = await state();
  assert.equal(saved.source.type, 'official');
  assert.equal(saved.settings.count, '30', 'its settings stay');
  assert.equal(saved.enabled, true);

  // 设置 › 插件 shows the new version, with nothing left to update.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('button', { name: '插件' }).click();
  const card = dialog.locator('.plugin-card').filter({ has: page.getByLabel('开启AI 前沿日报') });
  await card.locator('.plugin-version').getByText(entry.version, { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: /更新到/ }).count(), 0);

  // Not downloaded again on the next look.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 65_000)));
  assert.equal(await app.evaluate(() => globalThis.downloads), 1);

  assert.deepEqual(errors, []);
  console.log('plugin update e2e: ok');
} finally {
  const pid = app?.process().pid;
  await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
  try {
    if (pid) process.kill(pid);
  } catch {}
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
