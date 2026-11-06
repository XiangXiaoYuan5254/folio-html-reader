const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlugins } = require('../electron/plugins.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');
const { readZip } = require('../electron/zip.cjs');
const recommendations = require('../electron/recommended-plugins.json');

test('official plugins stay offline until installed, and need no community switch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-download-'));
  const outputDir = path.join(dir, 'website');
  const calls = [];
  let corrupt = false;
  try {
    const { buildWebsitePlugins } = await import('../scripts/website-plugins.mjs');
    const entry = await buildWebsitePlugins({
      outputDir,
      recommendationsFile: path.join(dir, 'recommendations.json'),
    });
    assert.deepEqual(
      [entry],
      recommendations,
      'rebuild website:plugins before shipping recommendations',
    );
    const filename = path.basename(new URL(entry.url).pathname);
    const zip = await fs.readFile(path.join(outputDir, filename));
    const files = readZip(zip)
      .map((f) => f.name)
      .sort();
    const manifest = require('../plugins/ai-daily/folio-plugin.json');
    assert.deepEqual(
      files,
      ['folio-plugin.json', ...manifest.files].map((name) => `ai-daily/${name}`).sort(),
    );
    const plugins = createPlugins({
      userDir: path.join(dir, 'user'),
      appVersion: '0.30.0',
      documentsDir: path.join(dir, 'Documents'),
      atomicWrite,
      fetch: async (url) => {
        calls.push(url);
        return new Response(corrupt ? Buffer.from('corrupt archive') : zip);
      },
    });
    for (let i = 0; i < 3; i++) {
      const list = await plugins.list();
      assert.deepEqual(list.plugins, []);
      assert.equal(list.thirdParty, false);
      assert.equal(list.recommendations[0].id, 'ai-daily');
    }
    assert.deepEqual(calls, [], 'startup/listing must not fetch plugin files');
    await assert.rejects(plugins.inspect({ recommendation: 'unknown' }), /没有找到/);
    assert.deepEqual(calls, []);
    // Official plugins don't wait for the community switch: the SHA-256 vouches for them.
    const inspection = await plugins.inspect({ recommendation: 'ai-daily' });
    assert.deepEqual(calls, [entry.url]);
    assert.equal(inspection.manifest.id, 'ai-daily');
    assert.deepEqual(inspection.source, { type: 'official' });
    assert.deepEqual((await plugins.list()).plugins, [], 'download is not installation');
    assert.equal(await fs.stat(path.join(dir, 'user/plugins/ai-daily')).catch(() => null), null);
    let list = await plugins.install({ stage: inspection.stage });
    assert.equal(list.thirdParty, false);
    assert.equal(list.plugins.length, 1);
    assert.equal(list.plugins[0].bundled, false);
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
    assert.equal(calls.length, 1, 'removal/listing must not re-download');
    corrupt = true;
    await assert.rejects(plugins.inspect({ recommendation: 'ai-daily' }), /校验失败/);
    assert.deepEqual((await plugins.list()).plugins, []);
    // 0.30.0 installed it as a plain .zip: the same files make it official again; others don't.
    const zipFile = path.join(dir, filename);
    await fs.writeFile(zipFile, zip);
    await plugins.setThirdParty({ on: true });
    list = await plugins.install({ stage: (await plugins.inspect({ local: zipFile })).stage });
    assert.deepEqual(list.plugins[0].source, { type: 'official' }, 'the same files, by hand');
    const state = path.join(dir, 'user/plugins.json');
    const saved = JSON.parse(await fs.readFile(state, 'utf8'));
    saved.thirdParty = false;
    saved.plugins['ai-daily'].source = { type: 'zip', name: filename };
    await fs.writeFile(state, JSON.stringify(saved));
    const fresh = () =>
      createPlugins({
        userDir: path.join(dir, 'user'),
        appVersion: '0.30.0',
        documentsDir: path.join(dir, 'Documents'),
        atomicWrite,
        fetch: async () => Response.error(),
      });
    assert.deepEqual((await fresh().list()).plugins[0].source, { type: 'official' });
    assert.equal(
      JSON.parse(await fs.readFile(state, 'utf8')).plugins['ai-daily'].source.type,
      'official',
    );
    await fs.writeFile(state, JSON.stringify(saved));
    await fs.appendFile(path.join(dir, 'user/plugins/ai-daily/prompt.md'), '\n多一行');
    assert.equal(
      (await fresh().list()).plugins[0].source.type,
      'zip',
      'changed files are not official',
    );
    const rebuilt = await buildWebsitePlugins({
      outputDir,
      recommendationsFile: path.join(dir, 'recommendations.json'),
    });
    assert.equal(rebuilt.sha256, entry.sha256, 'repeat builds preserve the pinned archive hash');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
