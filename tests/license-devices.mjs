// The admin views of who uses 页间: the computers the activation server knows, and every copy
// that has it open, seen from its update checks in the website's access log.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, downloadStats, openDb } from '../server/folio-license.mjs';

const DAY = 86_400_000;
const privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
const pc = (letter) => letter.repeat(32);

test('the device list tells members, trials and the rest apart', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const start = Date.parse('2026-11-01T10:00:00+08:00');
  let at = start;
  const service = createService({
    db,
    privateKey,
    now: () => at,
    pay: {
      create: async (order) => ({ orderId: order.orderNo, payUrl: 'https://payment.invalid/' }),
      verify: () => true,
      info: async () => ({ status: 1 }),
    },
  });
  const mac = { platform: 'darwin', version: '0.28.0' };
  service.trial({ device: pc('a'), ...mac });
  at += 60_000;
  service.trial({ device: pc('b'), platform: 'win32', version: '0.27.0' });
  at += 60_000;
  const [gift] = service.admin.codes({ plan: 'life', count: 1, batch: '组长' }).codes;
  service.activate({ device: pc('c'), code: gift, ...mac });
  at += 60_000;
  const [refunded] = service.admin.codes({ plan: 'year', count: 1, batch: '退款' }).codes;
  service.activate({ device: pc('d'), code: refunded, ...mac });
  service.admin.revoke({ code: refunded, reason: '退款' });
  at += 60_000;
  await service.order({ device: pc('e'), plan: 'year', platform: 'win32', version: '0.28.0' });
  // A computer that never tried or bought anything isn't kept.
  service.refresh({ device: pc('f'), ...mac });

  // Four days on: the first two trials are over, and the first computer opens the membership
  // window again; a new computer starts its trial.
  at = start + 4 * DAY;
  service.refresh({ device: pc('a'), ...mac });
  at += 60_000;
  service.trial({ device: pc('9'), ...mac });

  const all = service.admin.devices({});
  assert.deepEqual(all.counts, { member: 1, trial: 1, 'trial-ended': 2, other: 2 });
  assert.equal(all.total, 6);
  assert.deepEqual(
    all.computers.map((c) => c.device),
    ['99999999', 'aaaaaaaa', 'eeeeeeee', 'dddddddd', 'cccccccc', 'bbbbbbbb'],
  );
  const by = Object.fromEntries(all.computers.map((c) => [c.device[0], c]));
  assert.equal(by[9].status, 'trial');
  assert.equal(by.a.status, 'trial-ended');
  assert.equal(by.a.trial, start);
  assert.equal(by.a.trialUntil, start + 3 * DAY);
  assert.equal(by.a.first, start);
  assert.equal(by.a.seen, start + 4 * DAY, 'came back after the trial');
  assert.equal(by.b.seen, start + 60_000);
  assert.equal(by.b.platform, 'win32');
  assert.equal(by.b.version, '0.27.0');
  assert.deepEqual([by.c.status, by.c.plan, by.c.batch], ['member', 'life', '组长']);
  assert.deepEqual([by.d.status, by.d.batch, by.d.unpaid], ['other', null, 0]);
  assert.deepEqual([by.e.status, by.e.trial, by.e.unpaid], ['other', null, 1]);
  assert.ok(
    all.computers.every((c) => c.device.length === 8),
    'only part of each id',
  );

  const ended = service.admin.devices({ status: 'trial-ended' });
  assert.equal(ended.total, 2);
  assert.deepEqual(
    ended.computers.map((c) => c.device),
    ['aaaaaaaa', 'bbbbbbbb'],
  );
  assert.equal(service.admin.devices({ limit: 2 }).computers.length, 2);
});

test('update checks show which addresses have 页间 open, members or not', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-opens-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const line = (ip, time, url, status, agent) =>
    `${ip} - - [${time} +0800] "GET ${url} HTTP/1.1" ${status} 420 "-" "${agent}"`;
  const mac = '/works/folio/downloads/latest-mac.yml';
  const win = '/works/folio/downloads/latest.yml';
  const updater = 'electron-builder';
  const file = path.join(dir, 'access.log');
  await fs.writeFile(
    file,
    [
      // Too long ago for a 7-day window.
      line('7.7.7.7', '20/Oct/2026:09:00:00', win, 200, updater),
      line('1.2.3.4', '03/Nov/2026:10:00:00', `${mac}?noCache=1j2k`, 200, updater),
      line('1.2.3.4', '03/Nov/2026:14:00:00', `${mac}?noCache=1j2l`, 200, updater),
      line('1.2.3.4', '04/Nov/2026:09:00:00', `${mac}?noCache=1j2m`, 200, updater),
      line('5.6.7.8', '04/Nov/2026:08:00:00', win, 200, updater),
      // Not a copy of the app: someone opening the file in a browser, or a failed request.
      line('9.9.9.9', '04/Nov/2026:08:30:00', win, 200, 'Mozilla/5.0 (Macintosh)'),
      line('8.8.8.8', '04/Nov/2026:08:40:00', mac, 404, updater),
      // The owner's network (it called the admin API) doesn't count.
      line('10.0.0.5', '04/Nov/2026:09:10:00', '/api/folio/admin/stats', 200, 'node'),
      line('10.0.0.9', '04/Nov/2026:09:20:00', mac, 200, updater),
    ].join('\n') + '\n',
  );
  const now = Date.parse('2026-11-04T12:00:00+08:00');
  const week = await downloadStats({ file, days: 7, now });
  assert.equal(week.opened, 2);
  assert.deepEqual(week.opens, [
    {
      ip: '1.2.3.4',
      platform: 'darwin',
      first: Date.parse('2026-11-03T10:00:00+08:00'),
      last: Date.parse('2026-11-04T09:00:00+08:00'),
      days: 2,
    },
    {
      ip: '5.6.7.8',
      platform: 'win32',
      first: Date.parse('2026-11-04T08:00:00+08:00'),
      last: Date.parse('2026-11-04T08:00:00+08:00'),
      days: 1,
    },
  ]);
  const day = (d) => week.daily.find((x) => x.day === d).opens;
  assert.deepEqual(day('2026-11-03'), { darwin: 1, win32: 0 });
  assert.deepEqual(day('2026-11-04'), { darwin: 1, win32: 1 });
  // Update checks aren't downloads or updates.
  assert.deepEqual(week.events, []);
  assert.ok(week.daily.every((d) => d.updates.darwin + d.updates.win32 === 0));

  const everything = await downloadStats({ file, days: 0, now });
  assert.equal(everything.opened, 3);
  assert.equal(everything.since, '2026-10-20');
  assert.equal(everything.opens.at(-1).ip, '7.7.7.7');
});
