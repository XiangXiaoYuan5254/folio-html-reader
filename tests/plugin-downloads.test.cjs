const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPlugins } = require('../electron/plugins.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');
const { readZip } = require('../electron/zip.cjs');
const recommendations = require('../electron/recommended-plugins.json');

test('recommendations stay offline; only an explicit download stages the standalone ZIP', async () => {
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
    await assert.rejects(plugins.inspect({ recommendation: 'ai-daily' }), /外部插件/);
    assert.deepEqual(calls, [], 'consent is required before downloading');
    await plugins.setThirdParty({ on: true });
    await assert.rejects(plugins.inspect({ recommendation: 'unknown' }), /没有找到/);
    assert.deepEqual(calls, []);
    const inspection = await plugins.inspect({ recommendation: 'ai-daily' });
    assert.deepEqual(calls, [entry.url]);
    assert.equal(inspection.manifest.id, 'ai-daily');
    assert.deepEqual((await plugins.list()).plugins, [], 'download is not installation');
    assert.equal(await fs.stat(path.join(dir, 'user/plugins/ai-daily')).catch(() => null), null);
    let list = await plugins.install({ stage: inspection.stage });
    assert.equal(list.plugins.length, 1);
    assert.equal(list.plugins[0].bundled, false);
    assert.equal(list.plugins[0].enabled, false, 'installation never auto-enables a plugin');
    await plugins.set({ id: 'ai-daily', enabled: true });
    assert.match((await plugins.load({ id: 'ai-daily' })).prompt, /AI/);
    await plugins.setThirdParty({ on: false });
    assert.equal((await plugins.list()).plugins[0].enabled, false);
    await plugins.remove({ id: 'ai-daily' });
    list = await plugins.list();
    assert.deepEqual(list.plugins, []);
    assert.equal(list.recommendations[0].id, 'ai-daily');
    assert.equal(calls.length, 1, 'removal/listing must not re-download');
    await plugins.setThirdParty({ on: true });
    corrupt = true;
    await assert.rejects(plugins.inspect({ recommendation: 'ai-daily' }), /校验失败/);
    assert.deepEqual((await plugins.list()).plugins, []);
    const rebuilt = await buildWebsitePlugins({
      outputDir,
      recommendationsFile: path.join(dir, 'recommendations.json'),
    });
    assert.equal(rebuilt.sha256, entry.sha256, 'repeat builds preserve the pinned archive hash');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
