// 使用统计 (electron/usage.cjs) in the real app: a friend who had a membership code updates to
// this version and opens it. It reports soon after launch, with the old computer number; with
// FOLIO_NO_USAGE it sends nothing. The server is a local stand-in.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-usage-'));
const project = path.join(temp, '项目');
const userData = path.join(temp, 'user-data');
await fs.mkdir(project);
await fs.mkdir(userData);
await fs.writeFile(path.join(project, '示例.html'), '<h1>示例</h1>');
// What 0.29 left behind: its settings, and a lease naming the computer and its code.
const device = '0123456789abcdef'.repeat(2);
await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ root: project }));
await fs.writeFile(
  path.join(userData, 'license.json'),
  JSON.stringify({
    lease: {
      payload: JSON.stringify({ v: 1, device, member: true, codes: [{ code: 'A', plan: 'life' }] }),
      sig: 'x',
    },
  }),
);
const reports = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/api/folio/usage' && req.method === 'POST') reports.push(JSON.parse(body));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
let app;
async function start(env = {}) {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
      FOLIO_USAGE_SERVER: `http://127.0.0.1:${server.address().port}/api/folio`,
      ...env,
    },
  });
  await app.firstWindow();
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await start();
  for (let i = 0; !reports.length && i < 100; i++) await wait(200);
  assert.equal(reports.length, 1, 'reported soon after launch');
  const [first] = reports;
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first, {
    id: first.id,
    version,
    platform: process.platform,
    earlier: true,
    device,
  });
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'usage.json'), 'utf8'));
  assert.deepEqual(saved, { id: first.id, off: false, earlier: true });
  await app.close();

  // Turned off from outside the window: nothing past the first report's moment.
  await start({ FOLIO_NO_USAGE: '1' });
  await wait(10_000);
  assert.equal(reports.length, 1, 'FOLIO_NO_USAGE sends nothing');
  console.log('PASS: reports on launch with the old computer number; FOLIO_NO_USAGE turns it off');
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
