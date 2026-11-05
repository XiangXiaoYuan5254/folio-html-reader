// Run with Electron's Node (node:sqlite):
// ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron tests/license-pricing.e2e.mjs
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, createServer, openDb } from '../server/folio-license.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pricing-'));
const evidence = process.env.FOLIO_QA_DIR || path.join(temp, 'evidence');
await fs.mkdir(evidence, { recursive: true });
const workspace = path.join(temp, 'workspace');
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, '阅读.html'), '<h1>会员价格检查</h1>');
const end = Date.parse('2026-11-25T00:00:00+08:00');
let now = end - 60_000;
const db = openDb(':memory:');
const payments = [];
const service = createService({
  db,
  privateKey: crypto
    .generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' }),
  now: () => now,
  pay: {
    async create(order) {
      payments.push(order);
      return { orderId: order.orderNo, payUrl: `https://payment.invalid/${order.orderNo}` };
    },
    info: async () => ({ status: 1 }),
    verify: () => false,
  },
});
const code = service.offer({ device: 'a'.repeat(32) }).inviteCode.code;
const server = createServer({ service, adminToken: 'local-pricing-test' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  app = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_MEMBER: undefined,
      FOLIO_USER_DATA: path.join(temp, 'user-data'),
      FOLIO_WORKSPACE: workspace,
      FOLIO_LICENSE_DEVICE: 'pricing-test',
      FOLIO_LICENSE_SERVER: `http://127.0.0.1:${server.address().port}/api/folio`,
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Start the fake clock a moment early: pausing at the very time it started is "the past".
  await page.clock.install({ time: new Date(now - 1_000) });
  await page.clock.pauseAt(new Date(now));
  await page.getByRole('button', { name: '开通会员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '页间会员' });
  await dialog.getByText('限时邀请优惠', { exact: true }).waitFor();
  assert.match(await dialog.innerText(), /2026年11月24日 23:59/);
  assert.doesNotMatch(await dialog.innerText(), /298|早鸟价/);
  const annual = dialog.getByRole('radio').filter({ hasText: '365 天' });
  const lifetime = dialog.getByRole('radio').filter({ hasText: '一次买断' });
  const monthly = dialog.getByRole('radio').filter({ hasText: '30 天' });
  assert.equal(await annual.locator('.membership-price').innerText(), '¥49');
  assert.equal(await annual.locator('s').innerText(), '¥99');
  assert.equal(await lifetime.locator('.membership-price').innerText(), '¥98');
  assert.equal(await lifetime.locator('s').innerText(), '¥198');
  assert.equal(await monthly.locator('.membership-price').innerText(), '¥19.9');
  assert.match(await annual.innerText(), /填写好友邀请码后，原价立减 ¥50/);
  assert.match(await lifetime.innerText(), /填写好友邀请码后，原价立减 ¥100/);
  await dialog.getByRole('button', { name: '原价开通 · ¥99', exact: true }).waitFor();
  await dialog.screenshot({ path: path.join(evidence, 'invite-preview.png') });
  await dialog.getByRole('button', { name: '原价开通 · ¥99', exact: true }).click();
  await dialog.getByRole('img', { name: '付款二维码' }).waitFor();
  assert.equal(payments.at(-1).amount, 9900, 'previewing a price does not apply a discount');
  await dialog.getByRole('button', { name: '换个套餐' }).click();
  await dialog.getByRole('button', { name: '有好友的邀请码？点这里填写' }).click();
  await dialog.getByRole('textbox', { name: '好友的邀请码' }).fill('000000');
  await dialog.getByRole('button', { name: '使用', exact: true }).click();
  await dialog.getByText('没有这个邀请码，请检查有没有输错', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '原价开通 · ¥99', exact: true }).waitFor();
  await dialog.getByRole('textbox', { name: '好友的邀请码' }).fill(code);
  await dialog.getByRole('button', { name: '使用', exact: true }).click();
  await dialog.getByText('首年邀请码价', { exact: true }).waitFor();
  assert.equal(await annual.locator('.membership-price').innerText(), '¥49');
  assert.equal(await lifetime.locator('.membership-price').innerText(), '¥98');
  await lifetime.click();
  await dialog.getByRole('button', { name: '立即开通 · ¥98', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'invited.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 760));
  await page.screenshot({ path: path.join(evidence, 'invited-narrow.png') });
  await dialog.getByRole('button', { name: '立即开通 · ¥98', exact: true }).click();
  await dialog.getByRole('img', { name: '付款二维码' }).waitFor();
  assert.equal(payments.at(-1).amount, 9800);
  await dialog.getByRole('button', { name: '换个套餐' }).click();
  now = end;
  await page.clock.fastForward(60_000);
  await dialog.getByRole('button', { name: '立即开通 · ¥198', exact: true }).waitFor();
  assert.doesNotMatch(await dialog.innerText(), /限时邀请优惠|11月24日/);
  assert.match(await annual.innerText(), /邀请码已减 ¥50/);
  assert.equal(await lifetime.locator('.membership-price').innerText(), '¥198');
  assert.equal(await lifetime.locator('s').count(), 0);
  await page.screenshot({ path: path.join(evidence, 'expired.png') });
  await dialog.getByRole('button', { name: '立即开通 · ¥198', exact: true }).click();
  await dialog.getByRole('img', { name: '付款二维码' }).waitFor();
  assert.equal(payments.at(-1).amount, 19800);
  assert.deepEqual(errors, []);
  console.log(`Membership display, checkout and automatic expiry passed. Screenshots: ${evidence}`);
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
