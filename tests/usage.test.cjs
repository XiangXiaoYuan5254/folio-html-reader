const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUsage } = require('../electron/usage.cjs');

async function folder() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'folio-usage-'));
}
function usageIn(dir, calls, extra = {}) {
  return createUsage({
    file: path.join(dir, 'usage.json'),
    earlierFile: path.join(dir, 'settings.json'),
    memberFile: path.join(dir, 'license.json'),
    version: '0.31.0',
    platform: 'darwin',
    server: 'https://example.com/api/folio/',
    env: {},
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{}');
    },
    ...extra,
  });
}
// The license.json 0.29 and older kept: a signed lease naming the computer and its codes.
const license = (lease) =>
  JSON.stringify({ lease: { payload: JSON.stringify({ v: 1, ...lease }), sig: 'x' }, seen: 1 });
const device = 'c23c31aa'.repeat(4);

test('a new computer gets a random number that later launches keep', async () => {
  const dir = await folder();
  const calls = [];
  assert.equal(await usageIn(dir, calls).report(), true);
  const [{ url, body }] = calls;
  assert.equal(url, 'https://example.com/api/folio/usage');
  assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(body, { id: body.id, version: '0.31.0', platform: 'darwin', earlier: false });
  // An update is the same app data with a newer version.
  await usageIn(dir, calls, { version: '0.31.1' }).report();
  assert.equal(calls[1].body.id, body.id);
  assert.equal(calls[1].body.version, '0.31.1');
  assert.equal(calls[1].body.earlier, false);
});

test('settings left by an older 页间 mark the number as an old copy', async () => {
  const dir = await folder();
  await fs.writeFile(path.join(dir, 'settings.json'), '{}');
  const calls = [];
  await usageIn(dir, calls).report();
  assert.equal(calls[0].body.earlier, true);
  // Remembered, not checked again.
  await fs.rm(path.join(dir, 'settings.json'));
  await usageIn(dir, calls).report();
  assert.equal(calls[1].body.earlier, true);
});

test('a computer that had a membership code also sends its old computer number', async () => {
  const dir = await folder();
  const calls = [];
  await fs.writeFile(
    path.join(dir, 'license.json'),
    license({ device, member: true, codes: [{ code: 'ABCD-EFGH', plan: 'life' }] }),
  );
  await usageIn(dir, calls).report();
  assert.equal(calls[0].body.device, device);
  // Asked the activation server but never had a code (trial, or just looked): nothing extra.
  for (const lease of [
    { device, member: false, codes: [] },
    { device, member: true, kind: 'trial' },
    { device: 'not-a-number', codes: [{ code: 'X' }] },
  ]) {
    await fs.writeFile(path.join(dir, 'license.json'), license(lease));
    await usageIn(dir, calls).report();
    assert.equal(calls.at(-1).body.device, undefined, JSON.stringify(lease));
  }
  await fs.writeFile(path.join(dir, 'license.json'), '{"lease":');
  await usageIn(dir, calls).report();
  assert.equal(calls.at(-1).body.device, undefined);
});

test('"off" in usage.json or FOLIO_NO_USAGE turns it off', async () => {
  const dir = await folder();
  const calls = [];
  await usageIn(dir, calls).load();
  for (const value of ['1', 'true'])
    assert.equal(await usageIn(dir, calls, { env: { FOLIO_NO_USAGE: value } }).report(), false);
  assert.equal(calls.length, 0);
  assert.equal(await usageIn(dir, calls, { env: { FOLIO_NO_USAGE: '0' } }).report(), true);
  const file = path.join(dir, 'usage.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file)), off: true }));
  assert.equal(await usageIn(dir, calls).report(), false);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(await fs.readFile(file)).off, true, 'the file is left as it was');
});

test('a damaged file starts over with a new number', async () => {
  const dir = await folder();
  await fs.writeFile(path.join(dir, 'usage.json'), '{"id":"me"');
  const calls = [];
  await usageIn(dir, calls).report();
  assert.notEqual(calls[0].body.id, 'me');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'usage.json'), 'utf8'));
  assert.equal(saved.id, calls[0].body.id);
});
