import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createService, openDb } from '../server/folio-license.mjs';

const end = Date.parse('2026-11-25T00:00:00+08:00');
const privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
const device = (letter) => letter.repeat(32);
const donor = device('a');
const buyer = device('b');
const other = device('c');
const plan = (offer, name) => offer.plans.find((p) => p.plan === name);

function setup(t, start = Date.parse('2026-10-24T12:00:00+08:00')) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  let at = start;
  const requests = [];
  const service = createService({
    db,
    privateKey,
    now: () => at,
    pay: {
      async create(order) {
        requests.push(order);
        return { orderId: order.orderNo, payUrl: `https://payment.invalid/${order.orderNo}` };
      },
      verify: () => true,
      info: async () => ({ status: 1 }),
    },
  });
  const invite = service.offer({ device: donor }).inviteCode.code;
  return {
    db,
    service,
    invite,
    requests,
    time: (next) => (at = next),
    pay(order) {
      assert.equal(
        service.notify({ merchantOrderNo: order.no, amount: order.amount, status: 2 }),
        'success',
      );
    },
  };
}

test('regular prices and first-purchase discounts agree with the payment requests', async (t) => {
  const { service, invite, requests } = setup(t);
  const regular = service.offer({ device: buyer });
  assert.deepEqual(
    regular.plans.map((p) => p.amount),
    [1990, 9900, 19800],
  );
  assert.equal(plan(regular, 'life').later, undefined);
  const offer = service.offer({ device: buyer, invite });
  assert.deepEqual(
    offer.plans.map((p) => p.amount),
    [1990, 4900, 9800],
  );
  assert.deepEqual(offer.inviteCode.discount, { year: 5000, life: 10000 });
  assert.equal(offer.inviteCode.discountUntil.life, end);
  for (const name of ['month', 'year', 'life']) {
    const { order } = await service.order({ device: buyer, plan: name, invite });
    assert.equal(order.amount, plan(offer, name).amount);
    assert.equal(requests.at(-1).amount, order.amount);
  }
});

test('invitation text states the renewal price and the deadline in Beijing time', (t) => {
  const { service } = setup(t);
  const { share } = service.offer({ device: buyer }).inviteCode;
  assert.match(share, /年度会员立减 ¥50.*续费 ¥99\/年/);
  assert.match(share, /永久会员立减 ¥100/);
  assert.match(share, /北京时间 2026年11月24日 23:59/);
});

test('only the lifetime discount ends at the exact deadline', async (t) => {
  const { service, invite, time, db, requests } = setup(t, end - 1);
  assert.equal(plan(service.offer({ device: buyer, invite }), 'life').amount, 9800);
  time(end);
  const offer = service.offer({ device: buyer, invite });
  assert.equal(plan(offer, 'life').amount, 19800);
  assert.equal(plan(offer, 'life').discount, undefined);
  assert.equal(plan(offer, 'year').amount, 4900);
  assert.deepEqual(offer.inviteCode.discount, { year: 5000 });
  assert.deepEqual(offer.inviteCode.discountUntil, {});
  assert.doesNotMatch(offer.inviteCode.share, /永久|100|11月24日/);
  const { order } = await service.order({ device: buyer, plan: 'life', invite });
  assert.equal(order.amount, 19800);
  assert.equal(requests.at(-1).amount, 19800);
  const row = db.prepare('SELECT discount, inviter FROM orders WHERE no = ?').get(order.no);
  assert.equal(row.discount, null);
  assert.equal(row.inviter, null);
  const annual = await service.order({ device: other, plan: 'year', invite });
  assert.equal(
    annual.order.amount,
    4900,
    'an undiscounted lifetime order must not reserve the code',
  );
});

test('an order opened before the deadline retains its price and permanent entitlement', async (t) => {
  const { service, invite, time, pay, db } = setup(t, end - 1);
  const { order } = await service.order({ device: buyer, plan: 'life', invite });
  assert.equal(order.amount, 9800);
  time(end + 60_000);
  pay(order);
  const status = await service.orderStatus({ device: buyer, order: order.no });
  assert.equal(status.paid, true);
  const bought = db
    .prepare(
      'SELECT c.plan, c.days, c.revoked_at FROM codes c JOIN orders o ON o.code = c.code WHERE o.no = ?',
    )
    .get(order.no);
  assert.equal(bought.plan, 'life');
  assert.equal(bought.days, 0);
  assert.equal(bought.revoked_at, null);
  assert.equal(service.offer({ device: donor }).inviteCode.used, true);
});

test('annual renewals cost 99 and upgrades credit only the 49 actually paid', async (t) => {
  const { service, invite, pay } = setup(t);
  const { order } = await service.order({ device: buyer, plan: 'year', invite });
  pay(order);
  const offer = service.offer({ device: buyer });
  assert.equal(offer.inviteCode.first, false);
  assert.equal(plan(offer, 'year').amount, 9900);
  assert.equal(plan(offer, 'life').credit, 4900);
  assert.equal(plan(offer, 'life').amount, 14900);
  const renewal = await service.order({ device: buyer, plan: 'year' });
  assert.equal(renewal.order.amount, 9900);
  const newCode = service.offer({ device: other }).inviteCode.code;
  await assert.rejects(service.order({ device: buyer, plan: 'life', invite: newCode }), {
    error: 'invite-not-first',
  });
});

test('own, unknown and already-used invitation codes cannot get the promotion', async (t) => {
  const { service, invite, pay } = setup(t);
  await assert.rejects(service.order({ device: donor, plan: 'life', invite }), {
    error: 'invite-own',
  });
  await assert.rejects(service.order({ device: buyer, plan: 'life', invite: '000000' }), {
    error: 'invite-not-found',
  });
  const { order } = await service.order({ device: buyer, plan: 'life', invite });
  pay(order);
  await assert.rejects(service.order({ device: other, plan: 'year', invite }), {
    error: 'invite-used',
  });
});

test('monthly purchases remain 19.9 and do not use up an invitation code', async (t) => {
  const { service, invite, pay } = setup(t);
  const { order } = await service.order({ device: buyer, plan: 'month', invite });
  assert.equal(order.amount, 1990);
  pay(order);
  assert.equal(service.offer({ device: donor }).inviteCode.used, false);
  assert.equal((await service.order({ device: other, plan: 'life', invite })).order.amount, 9800);
});
