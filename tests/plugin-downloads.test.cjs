const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlugins } = require('../electron/plugins.cjs');
const { OFFICIAL_URL } = require('../electron/official-plugins.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');
const { readZip } = require('../electron/zip.cjs');

const root = path.join(__dirname, '..');

// A signing key of the test's own, and plugins/publish.json's shape: AI 前沿日报 listed, another
// plugin built and uploaded but not listed.
async function website(dir) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(dir, 'key.pem');
  await fs.writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const sourcesFile = path.join(dir, 'publish.json');
  await fs.writeFile(
    sourcesFile,
    JSON.stringify({
      plugins: [
        { dir: path.join(root, 'plugins/ai-daily'), listed: true },
        { dir: path.join(root, 'folio-plugins/examples/hn-digest'), listed: false },
      ],
    }),
  );
  const { buildWebsitePlugins } = await import('../scripts/website-plugins.mjs');
  const outputDir = path.join(dir, 'website');
  const build = (opts = {}) => buildWebsitePlugins({ outputDir, sourcesFile, keyFile, ...opts });
  const read = (name) => fs.readFile(path.join(outputDir, name));
  return {
    build,
    read,
    key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

test('official plugins come from a signed list on the website, and need no community switch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-download-'));
  const calls = [];
  let served = null;
  let corrupt = false;
  try {
    const site = await website(dir);
    const first = await site.build({ seq: 100 });
    assert.deepEqual(
      first.listed.map((p) => p.id),
      ['ai-daily'],
      'an unlisted plugin is built but not offered',
    );
    assert.ok(await site.read('hn-digest-' + first.built[1].version + '.zip'));
    const entry = first.listed[0];
    assert.equal(
      entry.url,
      `https://helloxxy.com/works/folio/plugins/ai-daily-${entry.version}.zip`,
    );
    const zip = await site.read(path.basename(new URL(entry.url).pathname));
    const manifest = require('../plugins/ai-daily/folio-plugin.json');
    assert.deepEqual(
      readZip(zip)
        .map((f) => f.name)
        .sort(),
      ['folio-plugin.json', ...manifest.files].map((name) => `ai-daily/${name}`).sort(),
    );
    served = await site.read('official.json');
    const changed = [];
    const make = (opts = {}) =>
      createPlugins({
        userDir: path.join(dir, 'user'),
        appVersion: '0.31.0',
        documentsDir: path.join(dir, 'Documents'),
        atomicWrite,
        officialKeys: [site.key],
        onChange: () => changed.push(Date.now()),
        fetch: async (url) => {
          calls.push(url);
          if (url === OFFICIAL_URL)
            return served ? new Response(served) : new Response('', { status: 404 });
          return new Response(corrupt ? Buffer.from('corrupt archive') : zip);
        },
        ...opts,
      });
    const plugins = make();
    // The first look has nothing yet; the list comes in the background and the window is told.
    assert.deepEqual((await plugins.list()).recommendations, []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(changed.length, 1);
    for (let i = 0; i < 3; i++) {
      const list = await plugins.list();
      assert.deepEqual(list.plugins, []);
      assert.equal(list.thirdParty, false);
      assert.deepEqual(
        list.recommendations.map((p) => [p.id, p.version, p.sha256]),
        [['ai-daily', entry.version, entry.sha256]],
      );
      assert.match(list.recommendations[0].icon, /^data:image\/svg\+xml;base64,/);
    }
    assert.deepEqual(calls, [OFFICIAL_URL], 'the list is read once; no plugin is downloaded');
    await assert.rejects(plugins.inspect({ recommendation: 'hn-digest' }), /没有找到/);
    // Official plugins don't wait for the community switch: the signed SHA-256 vouches for them.
    const inspection = await plugins.inspect({ recommendation: 'ai-daily' });
    assert.deepEqual(calls, [OFFICIAL_URL, entry.url]);
    assert.deepEqual(inspection.source, { type: 'official' });
    assert.deepEqual((await plugins.list()).plugins, [], 'download is not installation');
    let list = await plugins.install({ stage: inspection.stage });
    assert.equal(list.plugins.length, 1);
    assert.deepEqual(list.plugins[0].source, { type: 'official' });
    assert.equal(list.plugins[0].enabled, false, 'installation never auto-enables a plugin');
    await plugins.set({ id: 'ai-daily', enabled: true });
    assert.match((await plugins.load({ id: 'ai-daily' })).prompt, /AI/);
    await plugins.setThirdParty({ on: true });
    await plugins.setThirdParty({ on: false });
    assert.equal(
      (await plugins.list()).plugins[0].enabled,
      true,
      'the community switch is not its',
    );
    await plugins.remove({ id: 'ai-daily' });
    list = await plugins.list();
    assert.deepEqual(list.plugins, []);
    assert.equal(list.recommendations[0].id, 'ai-daily');
    corrupt = true;
    await assert.rejects(plugins.inspect({ recommendation: 'ai-daily' }), /校验失败/);
    assert.deepEqual((await plugins.list()).plugins, []);
    corrupt = false;

    // The list as last verified stays: offline, or offered anything older, unsigned or signed
    // with another key, 页间 keeps it.
    await site.build({ seq: 99 });
    const older = await site.read('official.json');
    await fs.mkdir(path.join(dir, 'other'));
    const other = await website(path.join(dir, 'other'));
    await other.build({ seq: 500 });
    const forged = await other.read('official.json');
    const outer = JSON.parse(String(served));
    const tampered = JSON.stringify({
      ...outer,
      signed: outer.signed.replace(entry.sha256, '0'.repeat(64)),
    });
    for (const body of [null, older, forged, tampered, 'not json']) {
      served = body;
      changed.length = 0;
      const again = make();
      assert.deepEqual(
        (await again.list()).recommendations.map((p) => p.sha256),
        [entry.sha256],
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(
        (await again.list()).recommendations.map((p) => p.sha256),
        [entry.sha256],
      );
      assert.equal(changed.length, 0);
    }
    // A newer list replaces it; one that needs a newer 页间 isn't offered.
    await site.build({ seq: 200 });
    served = await site.read('official.json');
    const newer = make();
    await newer.list();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(changed.length, 1);
    assert.deepEqual(
      (await make({ appVersion: '0.29.0' }).list()).recommendations,
      [],
      `AI 前沿日报 needs ${entry.requires}`,
    );

    // 0.30.0 installed it as a plain .zip: the same files make it official again; others don't.
    const zipFile = path.join(dir, path.basename(new URL(entry.url).pathname));
    await fs.writeFile(zipFile, zip);
    await plugins.setThirdParty({ on: true });
    list = await plugins.install({ stage: (await plugins.inspect({ local: zipFile })).stage });
    assert.deepEqual(list.plugins[0].source, { type: 'official' }, 'the same files, by hand');
    const state = path.join(dir, 'user/plugins.json');
    const saved = JSON.parse(await fs.readFile(state, 'utf8'));
    saved.thirdParty = false;
    saved.plugins['ai-daily'].source = { type: 'zip', name: path.basename(zipFile) };
    await fs.writeFile(state, JSON.stringify(saved));
    const offline = () => make({ fetch: async () => Response.error() });
    assert.deepEqual((await offline().list()).plugins[0].source, { type: 'official' });
    assert.equal(
      JSON.parse(await fs.readFile(state, 'utf8')).plugins['ai-daily'].source.type,
      'official',
    );
    await fs.writeFile(state, JSON.stringify(saved));
    await fs.appendFile(path.join(dir, 'user/plugins/ai-daily/prompt.md'), '\n多一行');
    assert.equal(
      (await offline().list()).plugins[0].source.type,
      'zip',
      'changed files are not official',
    );
    const rebuilt = await site.build();
    assert.equal(rebuilt.listed[0].sha256, entry.sha256, 'repeat builds keep the archive hash');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
