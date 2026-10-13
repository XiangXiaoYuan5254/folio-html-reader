// 页间's activation server. Memberships are bought in the app with WeChat Pay or Alipay through
// 简付 (jian-pay.com); each purchase becomes a code already activated on the buyer's computer.
// Codes made here to give away are typed in instead. A code belongs to one computer at a time,
// the buyer can move it to a new computer once a week, and a refunded code is revoked so the
// membership it gave ends.
// Every computer also has an invite code: a friend's first purchase with it costs less, and the
// friend paying earns its owner days of membership, or lifetime after enough of them.
// Every answer is a lease signed with the server's Ed25519 key; the app trusts nothing else.
// Needs Node 22.13+ (node:sqlite) and nothing from npm. Deployment: server/README.md.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;
// Days each plan adds; a lifetime code (0) never runs out.
export const plans = { month: 30, year: 365, life: 0 };
// What the app sells, in fen. Before `early.until` the early price takes the place of `amount`.
export const prices = {
  month: { amount: 1990, name: '页间会员 30 天' },
  year: { amount: 9900, name: '页间会员 365 天' },
  life: {
    amount: 29800,
    name: '页间永久会员',
    early: { amount: 19800, until: Date.parse('2026-11-13T00:00:00+08:00') },
  },
};
export const rules = {
  trialDays: 3,
  // How long the app keeps a membership without reaching the server, and so how long a
  // revoked code can still work on a computer kept offline.
  leaseDays: 7,
  moveEveryDays: 7,
};
// Inviting friends. A computer that has never paid takes `discount` (fen) off its first purchase
// with a friend's code. When it pays, the code's owner gets `days[plan]` days, and lifetime once
// `lifeAfter` friends bought a year or lifetime; then the code stops working. After `until`
// (null: no end) no code takes anything off; what was given stays.
export const invites = {
  discount: 500,
  days: { month: 7, year: 30, life: 30 },
  lifeAfter: 5,
  until: null,
};
// No 0/O, 1/I/L: codes are read off a screen and typed in.
const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const normalizeCode = (code) =>
  String(code || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
export const formatCode = (code) => code.match(/.{1,4}/g).join('-');
const newCode = (length = 16) =>
  Array.from(crypto.randomBytes(length), (b) => alphabet[b % alphabet.length]).join('');
const priceOf = (plan, at) => {
  const p = prices[plan];
  return p.early && at < p.early.until ? p.early.amount : p.amount;
};

class Refusal extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    Object.assign(this, { status, error, extra });
  }
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      days INTEGER NOT NULL,
      batch TEXT,
      created_at INTEGER NOT NULL,
      device TEXT,
      activated_at INTEGER,
      moved_at INTEGER,
      revoked_at INTEGER,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS codes_device ON codes(device);
    CREATE TABLE IF NOT EXISTS trials (device TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (
      device TEXT PRIMARY KEY,
      platform TEXT,
      version TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      code TEXT,
      device TEXT,
      detail TEXT
    );
    -- Purchases in the app; code is the code a paid order became.
    CREATE TABLE IF NOT EXISTS orders (
      no TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      plan TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      pay_id TEXT,
      pay_url TEXT,
      checked_at INTEGER,
      paid_at INTEGER,
      method TEXT,
      code TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_device ON orders(device);
    -- Each computer's invite code, made the first time it asks; life_code is the lifetime code
    -- its friends earned it.
    CREATE TABLE IF NOT EXISTS invites (
      device TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      life_code TEXT
    );
  `);
  // Added later: what an upgrade to lifetime took off for the days left of bought memberships.
  // Then what a friend's invite code took off, whose code it was (`inviter`, a device) and the
  // code that friend's payment gave its owner (`reward`).
  const columns = db
    .prepare('PRAGMA table_info(orders)')
    .all()
    .map((c) => c.name);
  for (const [name, type] of [
    ['credit', 'INTEGER'],
    ['discount', 'INTEGER'],
    ['inviter', 'TEXT'],
    ['reward', 'TEXT'],
  ])
    if (!columns.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS orders_inviter ON orders(inviter)');
  return db;
}

// `pay` is a createJianPay() client; without one the app can't buy, only activate codes.
export function createService({ db, privateKey, pay = null, now = Date.now }) {
  const key = crypto.createPrivateKey(privateKey);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const log = (type, code, device, detail) =>
    run(
      'INSERT INTO events (at, type, code, device, detail) VALUES (?, ?, ?, ?, ?)',
      now(),
      type,
      code ?? null,
      device ?? null,
      detail ?? null,
    );
  const checkDevice = (device) => {
    if (typeof device !== 'string' || !/^[0-9a-f]{32}$/.test(device))
      throw new Refusal(400, 'bad-request', '请求无效，请更新页间后再试');
    return device;
  };
  const meet = ({ device, platform, version }) => {
    const at = now();
    run(
      `INSERT INTO devices (device, platform, version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device) DO UPDATE SET platform = coalesce(excluded.platform, platform),
         version = coalesce(excluded.version, version), last_seen = excluded.last_seen`,
      device,
      platform ? String(platform).slice(0, 16) : null,
      version ? String(version).slice(0, 16) : null,
      at,
      at,
    );
  };
  // A computer's membership: its codes back to back in the order they were activated, so a
  // code bought before the last one runs out adds its days after it. A lifetime code makes it
  // last for good. Revoked codes count for nothing. The trial runs on its own beside them.
  function membership(device) {
    const codes = all(
      'SELECT code, plan, days, activated_at, revoked_at FROM codes WHERE device = ? ORDER BY activated_at',
      device,
    );
    let paidUntil = 0;
    let forever = false;
    for (const c of codes) {
      if (c.revoked_at) continue;
      if (c.plan === 'life') forever = true;
      else paidUntil = Math.max(c.activated_at, paidUntil) + c.days * DAY;
    }
    const trial = one('SELECT started_at FROM trials WHERE device = ?', device);
    const trialUntil = trial ? trial.started_at + rules.trialDays * DAY : 0;
    return { codes, paidUntil, forever, trialUntil, trialUsed: !!trial };
  }
  // What a computer's membership is on right now: 'life', the plan of the code whose days are
  // running (codes back to back, as in membership()), or null.
  function runningPlan(device, at) {
    const m = membership(device);
    if (m.forever) return 'life';
    let paidUntil = 0;
    for (const c of m.codes) {
      if (c.revoked_at) continue;
      const start = Math.max(c.activated_at, paidUntil);
      paidUntil = start + c.days * DAY;
      if (start <= at && at < paidUntil) return c.plan;
    }
    return null;
  }
  // The codes are given in full: the window shows them for moving to another computer.
  function lease(device) {
    const at = now();
    const m = membership(device);
    const expires = m.forever ? null : Math.max(m.paidUntil, m.trialUntil) || null;
    const member = m.forever || expires > at;
    const payload = JSON.stringify({
      v: 1,
      device,
      issued: at,
      member,
      kind: m.forever || m.paidUntil > at ? 'paid' : m.trialUntil > at ? 'trial' : null,
      ...(m.forever ? { forever: true } : {}),
      expires,
      until:
        member && expires
          ? Math.min(expires, at + rules.leaseDays * DAY)
          : at + rules.leaseDays * DAY,
      trialUsed: m.trialUsed,
      // `invite`: days a friend's purchase earned, as many as `days`.
      codes: m.codes.map((c) => ({
        code: formatCode(c.code),
        plan: c.plan,
        ...(c.plan === 'invite' ? { days: c.days } : {}),
        ...(c.revoked_at ? { revoked: true } : {}),
      })),
    });
    return { payload, sig: crypto.sign(null, Buffer.from(payload), key).toString('base64') };
  }

  function activate(body) {
    const device = checkDevice(body.device);
    const code = normalizeCode(body.code);
    const row = code && one('SELECT * FROM codes WHERE code = ?', code);
    if (!row) throw new Refusal(404, 'not-found', '没有这个激活码，请检查有没有输错');
    if (row.revoked_at) throw new Refusal(410, 'revoked', '这个激活码已作废');
    meet(body);
    if (!row.device) {
      run('UPDATE codes SET device = ?, activated_at = ? WHERE code = ?', device, now(), code);
      log('activate', code, device);
    } else if (row.device !== device) {
      // It's on another computer: moving brings that computer's whole membership over.
      const lastMove = one('SELECT max(moved_at) AS at FROM codes WHERE device = ?', row.device).at;
      const canMoveAt = lastMove ? lastMove + rules.moveEveryDays * DAY : 0;
      const from = one('SELECT platform FROM devices WHERE device = ?', row.device)?.platform;
      if (!body.move)
        throw new Refusal(409, 'in-use', '这个激活码正在另一台电脑上使用', {
          platform: from || null,
          canMoveAt: canMoveAt > now() ? canMoveAt : null,
        });
      if (canMoveAt > now())
        throw new Refusal(429, 'move-too-soon', '这个激活码 7 天内转移过，暂时不能再转', {
          canMoveAt,
        });
      run('UPDATE codes SET device = ?, moved_at = ? WHERE device = ?', device, now(), row.device);
      log('move', code, device, row.device);
    }
    return { lease: lease(device) };
  }
  function trial(body) {
    const device = checkDevice(body.device);
    if (one('SELECT 1 FROM trials WHERE device = ?', device))
      throw new Refusal(409, 'trial-used', '这台电脑已经试用过了');
    meet(body);
    run('INSERT INTO trials (device, started_at) VALUES (?, ?)', device, now());
    log('trial', null, device);
    return { lease: lease(device) };
  }
  function refresh(body) {
    const device = checkDevice(body.device);
    // Only computers that activated or tried something are kept; others just get "not a member".
    if (one('SELECT 1 FROM devices WHERE device = ?', device)) meet(body);
    return { lease: lease(device) };
  }

  // What the days left of bought memberships are worth toward lifetime: each paid order's amount
  // times the share of its code's days still to come. Codes run back to back, so one not started
  // yet counts in full. Trials and given codes (no order) are worth nothing but still take time.
  function creditOf(device, at) {
    const codes = all(
      `SELECT c.plan, c.days, c.activated_at, c.revoked_at, o.amount FROM codes c
       LEFT JOIN orders o ON o.code = c.code WHERE c.device = ? ORDER BY c.activated_at`,
      device,
    );
    let paidUntil = 0;
    let credit = 0;
    for (const c of codes) {
      if (c.revoked_at || c.plan === 'life') continue;
      const start = Math.max(c.activated_at, paidUntil);
      const length = c.days * DAY;
      paidUntil = start + length;
      if (c.amount)
        credit +=
          (c.amount * Math.min(Math.max(paidUntil - Math.max(at, start), 0), length)) / length;
    }
    // Whole yuan: ¥81 off, not ¥81.37.
    return Math.round(credit / 100) * 100;
  }
  // Today's price for a computer: lifetime less its credit, less a friend's invite, never under ¥1.
  // Only a computer that has paid before has credit, and only one that hasn't can use an invite.
  function priceFor(plan, device, at, friend = null) {
    const full = priceOf(plan, at);
    const credit = plan === 'life' && device ? Math.min(creditOf(device, at), full - 100) : 0;
    const discount = friend ? Math.min(invites.discount, full - credit - 100) : 0;
    return { amount: full - credit - discount, credit, discount };
  }

  const inviting = (at) => !invites.until || at < invites.until;
  const hasPaid = (device) =>
    !!one('SELECT 1 FROM orders WHERE device = ? AND paid_at IS NOT NULL', device);
  // A computer's own invite code, made the first time it's asked for.
  function inviteOf(device) {
    let row = one('SELECT * FROM invites WHERE device = ?', device);
    while (!row) {
      run(
        'INSERT OR IGNORE INTO invites (device, code, created_at) VALUES (?, ?, ?)',
        device,
        newCode(6),
        now(),
      );
      row = one('SELECT * FROM invites WHERE device = ?', device);
    }
    return row;
  }
  // Friends who paid with a computer's code, refunded ones left out; `toward`: of them, those who
  // bought a year or lifetime. `life`: they earned it lifetime, and the code is spent.
  function invited(row) {
    const n = one(
      `SELECT count(*) AS friends, coalesce(sum(o.plan != 'month'), 0) AS toward FROM orders o
       JOIN codes c ON c.code = o.code WHERE o.inviter = ? AND c.revoked_at IS NULL`,
      row.device,
    );
    const life =
      !!row.life_code &&
      !one('SELECT revoked_at FROM codes WHERE code = ?', row.life_code).revoked_at;
    return { ...n, life };
  }
  // The friend whose code a computer typed in, if it takes something off its first purchase.
  function friendOf(device, typed, at) {
    const code = normalizeCode(typed);
    if (!code || !inviting(at)) return null;
    const row = one('SELECT * FROM invites WHERE code = ?', code);
    if (!row) throw new Refusal(404, 'invite-not-found', '没有这个邀请码，请检查有没有输错');
    if (row.device === device) throw new Refusal(409, 'invite-own', '不能用自己的邀请码');
    if (hasPaid(device))
      throw new Refusal(409, 'invite-not-first', '邀请码仅限这台电脑首次开通会员时使用');
    if (invited(row).life) throw new Refusal(410, 'invite-spent', '这个邀请码已经停用了');
    return row;
  }
  // The inviter's thanks for a friend's purchase: days, and lifetime once enough friends bought a
  // year or lifetime. The days are a code of their own on the inviter's computer, so a refund
  // takes back just them.
  function reward(row, at) {
    const days = invites.days[row.plan];
    const code = giveCode(row.inviter, 'invite', days, '邀请奖励', at);
    run('UPDATE orders SET reward = ? WHERE no = ?', code, row.no);
    log('invite-reward', code, row.inviter, `${days} 天 · ${row.no}`);
    settleLife(row.inviter, at);
  }
  // Lifetime for enough friends: given once, taken back while refunds leave too few, given back
  // when they're restored.
  function settleLife(device, at) {
    const row = inviteOf(device);
    const due = invited(row).toward >= invites.lifeAfter;
    const life = row.life_code && one('SELECT * FROM codes WHERE code = ?', row.life_code);
    if (due && !life) {
      const code = giveCode(device, 'life', 0, '邀请奖励', at);
      run('UPDATE invites SET life_code = ? WHERE device = ?', code, device);
      log('invite-life', code, device);
    } else if (due && life.revoked_at) {
      run('UPDATE codes SET revoked_at = NULL, revoke_reason = NULL WHERE code = ?', life.code);
      log('restore', life.code, life.device, '邀请的好友够了');
    } else if (!due && life && !life.revoked_at) {
      run(
        'UPDATE codes SET revoked_at = ?, revoke_reason = ? WHERE code = ?',
        at,
        '邀请的好友退款了',
        life.code,
      );
      log('revoke', life.code, life.device, '邀请的好友退款了');
    }
  }
  // After a refund or its undoing: the days a purchase earned its inviter follow it, and so does
  // the inviter's lifetime if the count of friends crosses the line.
  function followInvite(code) {
    const o = one(
      `SELECT o.inviter, o.reward, c.revoked_at FROM orders o JOIN codes c ON c.code = o.code
       WHERE o.code = ?`,
      code,
    );
    if (!o?.inviter) return;
    if (o.reward) {
      const reason = o.revoked_at ? '邀请的好友退款了' : null;
      run(
        'UPDATE codes SET revoked_at = ?, revoke_reason = ? WHERE code = ?',
        o.revoked_at,
        reason,
        o.reward,
      );
      log(o.revoked_at ? 'revoke' : 'restore', o.reward, o.inviter, reason);
    }
    settleLife(o.inviter, now());
  }

  // What the app offers to buy, at today's prices for the computer asking, with a friend's code
  // if it typed one in. `invite`: this computer's own code and what it has earned, while the
  // offer runs; `friend` is the code typed in, with why it doesn't count if it doesn't.
  function offer(body = {}) {
    const at = now();
    const device = /^[0-9a-f]{32}$/.test(body.device || '') ? body.device : null;
    let friend = null;
    let invite;
    if (device && inviting(at)) {
      const mine = inviteOf(device);
      const typed = normalizeCode(body.invite);
      let refused = '';
      try {
        friend = friendOf(device, typed, at);
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        refused = e.message;
      }
      invite = {
        code: mine.code,
        ...invited(mine),
        first: !hasPaid(device),
        ...(typed ? { friend: { code: typed, ...(refused ? { error: refused } : {}) } } : {}),
        rules: invites,
      };
    }
    return {
      ready: !!pay,
      plans: Object.entries(prices).map(([plan, p]) => {
        const { amount, credit, discount } = priceFor(plan, device, at, friend);
        return {
          plan,
          days: plans[plan],
          amount,
          ...(credit ? { credit } : {}),
          ...(discount ? { discount } : {}),
          ...(p.early && at < p.early.until ? { later: p.amount, until: p.early.until } : {}),
        };
      }),
      ...(invite ? { invite } : {}),
    };
  }
  // An order at 简付; the app shows its checkout page as a QR code to scan with WeChat or Alipay.
  async function order(body) {
    const device = checkDevice(body.device);
    if (!Object.hasOwn(prices, body.plan))
      throw new Refusal(400, 'bad-request', '请求无效，请更新页间后再试');
    if (!pay) throw new Refusal(503, 'no-pay', '暂时不能在线购买，请稍后再试');
    if (membership(device).forever) throw new Refusal(409, 'forever', '这台电脑已经是永久会员了');
    meet(body);
    const at = now();
    const no =
      'FO' +
      new Date(at).toISOString().slice(0, 10).replace(/-/g, '') +
      crypto.randomBytes(5).toString('hex').toUpperCase();
    const friend = friendOf(device, body.invite, at);
    const { amount, credit, discount } = priceFor(body.plan, device, at, friend);
    let made;
    try {
      made = await pay.create({ orderNo: no, amount, goodsName: prices[body.plan].name });
    } catch (e) {
      console.error(e);
      log('pay-error', null, device, String(e.message).slice(0, 200));
      throw new Refusal(502, 'pay', '支付服务暂时连不上，请稍后再试');
    }
    run(
      'INSERT INTO orders (no, device, plan, amount, credit, discount, inviter, created_at, pay_id, pay_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      no,
      device,
      body.plan,
      amount,
      credit || null,
      discount || null,
      friend?.device ?? null,
      at,
      made.orderId,
      made.payUrl,
    );
    return { order: { no, plan: body.plan, amount, payUrl: made.payUrl } };
  }
  // A new code, already activated on `device`.
  function giveCode(device, plan, days, batch, at) {
    let code;
    do code = newCode();
    while (one('SELECT 1 FROM codes WHERE code = ?', code));
    run(
      'INSERT INTO codes (code, plan, days, batch, created_at, device, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      code,
      plan,
      days,
      batch,
      at,
      device,
      at,
    );
    return code;
  }
  // A paid order becomes a code of its plan, already activated on the computer that ordered it.
  // The notification and the app's checks can both report the same payment; only the first counts.
  function fulfil(no, method) {
    const row = one('SELECT * FROM orders WHERE no = ?', no);
    if (row.code) return;
    const at = now();
    const code = giveCode(row.device, row.plan, plans[row.plan], '在线购买', at);
    run(
      'UPDATE orders SET paid_at = ?, method = ?, code = ? WHERE no = ?',
      at,
      method ? String(method).slice(0, 16) : null,
      code,
      no,
    );
    log('purchase', code, row.device, `${row.plan} ${row.amount}`);
    if (row.inviter) reward(row, at);
  }
  // The app asks while the QR code is on screen, and once more later if it was closed unpaid.
  // Until 简付's notification comes, the server asks 简付 itself, at most every few seconds.
  // `closed`: 简付 gave up on it (unpaid for about 15 minutes), so its QR code no longer works.
  async function orderStatus(body) {
    const device = checkDevice(body.device);
    const no = String(body.order || '');
    const find = () => one('SELECT * FROM orders WHERE no = ? AND device = ?', no, device);
    let row = find();
    if (!row) throw new Refusal(404, 'not-found', '没有这个订单');
    let closed = false;
    if (!row.code && pay && now() - (row.checked_at || 0) > 4000) {
      run('UPDATE orders SET checked_at = ? WHERE no = ?', now(), no);
      const paid = await pay.info(row.pay_id).catch((e) => console.error(e));
      if (paid?.status === 2 && Number(paid.amount) === row.amount) fulfil(no, paid.payMethod);
      closed = paid?.status === 3 || paid?.status === 4;
      row = find();
    }
    meet(body);
    return { paid: !!row.code, closed: !row.code && closed, lease: lease(device) };
  }
  // 简付's notification of a payment. Anything but "success" makes it send it again later.
  function notify(body) {
    if (!pay?.verify(body)) return 'fail';
    const row = one('SELECT * FROM orders WHERE no = ?', String(body.merchantOrderNo || ''));
    if (!row || Number(body.amount) !== row.amount) {
      log('pay-error', null, row?.device, `通知对不上订单：${body.merchantOrderNo} ${body.amount}`);
      return 'success';
    }
    if (Number(body.status) === 2) fulfil(row.no, body.payMethod);
    return 'success';
  }

  // Events with the platform of the computer involved; a move also says where it came from.
  const eventQuery = `SELECT e.at, e.type, e.code, e.device, e.detail, d.platform,
      f.platform AS fromPlatform FROM events e
    LEFT JOIN devices d ON d.device = e.device
    LEFT JOIN devices f ON e.type = 'move' AND f.device = e.detail`;
  const eventOut = (e) => ({
    ...e,
    code: e.code ? formatCode(e.code) : null,
    detail: e.type === 'move' ? null : e.detail,
  });
  const codeRow = (code) => {
    const row = one('SELECT * FROM codes WHERE code = ?', normalizeCode(code));
    if (!row) throw new Refusal(404, 'not-found', '没有这个激活码');
    return row;
  };
  // The friend's purchase a reward code thanks for.
  const rewardOrder = (code) => {
    const o = one('SELECT no, plan, amount, paid_at FROM orders WHERE reward = ?', code);
    return o ? { no: o.no, plan: o.plan, amount: o.amount, paid: o.paid_at } : null;
  };
  // A computer's invite code and what friends brought it: `days` still counting, and lifetime.
  function inviteInfo(device) {
    const row = one('SELECT * FROM invites WHERE device = ?', device);
    if (!row) return null;
    const { d } = one(
      `SELECT coalesce(sum(c.days), 0) AS d FROM orders o JOIN codes c ON c.code = o.reward
       WHERE o.inviter = ? AND c.revoked_at IS NULL`,
      device,
    );
    return { code: row.code, ...invited(row), days: d };
  }
  // China's calendar day of a time, as 2026-10-12.
  const dayOf = (ms) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
  const admin = {
    // New codes for one plan; `batch` is a note to find them by later, e.g. "送朋友 2026-10".
    codes({ plan, count, batch }) {
      if (!Object.hasOwn(plans, plan))
        throw new Refusal(400, 'bad-request', 'plan 只能是 month、year 或 life');
      const n = Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 1000)
        throw new Refusal(400, 'bad-request', 'count 要在 1 到 1000 之间');
      const made = [];
      while (made.length < n) {
        const code = newCode();
        const done = run(
          'INSERT OR IGNORE INTO codes (code, plan, days, batch, created_at) VALUES (?, ?, ?, ?, ?)',
          code,
          plan,
          plans[plan],
          batch ? String(batch).slice(0, 100) : null,
          now(),
        );
        if (done.changes) made.push(formatCode(code));
      }
      log('codes', null, null, `${plan} × ${n}${batch ? ' · ' + batch : ''}`);
      return { plan, days: plans[plan], codes: made };
    },
    info({ code }) {
      const row = codeRow(code);
      const m = row.device ? membership(row.device) : null;
      const o = one('SELECT * FROM orders WHERE code = ?', row.code);
      return {
        code: formatCode(row.code),
        plan: row.plan,
        days: row.days,
        batch: row.batch,
        created: row.created_at,
        status: row.revoked_at ? 'revoked' : row.device ? 'active' : 'unused',
        activated: row.activated_at,
        moved: row.moved_at,
        revoked: row.revoked_at,
        reason: row.revoke_reason,
        device: row.device,
        platform: row.device
          ? one('SELECT platform FROM devices WHERE device = ?', row.device)?.platform
          : null,
        memberUntil: m ? Math.max(m.paidUntil, m.trialUntil) || null : null,
        forever: !!m?.forever,
        // The purchase it came from: what to look for in the 简付 console for a refund. `invite`:
        // the friend's invite code it was bought with.
        order: o
          ? {
              no: o.no,
              payId: o.pay_id,
              amount: o.amount,
              credit: o.credit,
              discount: o.discount,
              invite: o.inviter ? inviteOf(o.inviter).code : null,
              method: o.method,
              paid: o.paid_at,
            }
          : null,
        // A code an invite gave: the friend's purchase it thanks for (none for lifetime).
        rewardFor: row.batch === '邀请奖励' ? rewardOrder(row.code) : null,
        // Its computer's own invite code and what friends brought it.
        invite: row.device ? inviteInfo(row.device) : null,
        otherCodes: m
          ? m.codes.filter((c) => c.code !== row.code).map((c) => formatCode(c.code))
          : [],
        events: all(`${eventQuery} WHERE e.code = ? ORDER BY e.id`, row.code).map(eventOut),
      };
    },
    // A refund: the code stops counting, and its computer's membership shrinks by it the next
    // time the app checks in (at most `leaseDays` later, sooner while it's online). A purchase
    // with a friend's invite code takes back what it earned that friend.
    revoke({ code, reason }) {
      const row = codeRow(code);
      run(
        'UPDATE codes SET revoked_at = ?, revoke_reason = ? WHERE code = ?',
        now(),
        reason ? String(reason).slice(0, 200) : null,
        row.code,
      );
      log('revoke', row.code, row.device, reason || null);
      followInvite(row.code);
      return admin.info({ code: row.code });
    },
    restore({ code }) {
      const row = codeRow(code);
      run('UPDATE codes SET revoked_at = NULL, revoke_reason = NULL WHERE code = ?', row.code);
      log('restore', row.code, row.device);
      followInvite(row.code);
      return admin.info({ code: row.code });
    },
    // Lets the buyer move to another computer now, without waiting out the week.
    allowMove({ code }) {
      const row = codeRow(code);
      if (row.device) run('UPDATE codes SET moved_at = NULL WHERE device = ?', row.device);
      log('allow-move', row.code, row.device);
      return admin.info({ code: row.code });
    },
    stats() {
      const at = now();
      const devices = all(
        'SELECT DISTINCT device FROM codes WHERE device IS NOT NULL AND revoked_at IS NULL',
      );
      // Paid orders and what they brought in (fen), refunded ones left out.
      const sales = (since) =>
        one(
          `SELECT count(*) AS n, coalesce(sum(o.amount), 0) AS amount FROM orders o
           JOIN codes c ON c.code = o.code WHERE c.revoked_at IS NULL AND o.paid_at > ?`,
          since,
        );
      // Each member computer by what it's on: lifetime, or the plan of the code running now.
      // `invite`: on days friends' purchases earned it.
      const memberPlans = { month: 0, year: 0, life: 0, invite: 0 };
      for (const { device } of devices) {
        const plan = runningPlan(device, at);
        if (plan) memberPlans[plan]++;
      }
      return {
        members: Object.values(memberPlans).reduce((a, b) => a + b),
        memberPlans,
        sales: sales(0),
        salesToday: sales(at - DAY),
        // Trying it now: inside the trial and not paying already (a member counts as a member).
        trialsNow: all(
          'SELECT device FROM trials WHERE started_at > ?',
          at - rules.trialDays * DAY,
        ).filter(({ device }) => !runningPlan(device, at)).length,
        codes: all(
          `SELECT plan,
             sum(device IS NULL AND revoked_at IS NULL) AS unused,
             sum(device IS NOT NULL AND revoked_at IS NULL) AS active,
             sum(revoked_at IS NOT NULL) AS revoked
           FROM codes GROUP BY plan`,
        ),
        trials: one('SELECT count(*) AS n FROM trials').n,
        trialsToday: one('SELECT count(*) AS n FROM trials WHERE started_at > ?', at - DAY).n,
        activationsToday: one(
          "SELECT count(*) AS n FROM events WHERE type = 'activate' AND at > ?",
          at - DAY,
        ).n,
      };
    },
    // Codes, newest first: by status (unused / active / revoked), plan, batch, or part of a code
    // or of the order number (ours or 简付's) it was bought with.
    list({ status, plan, batch, q, limit, offset }) {
      const where = [];
      const args = [];
      if (status === 'unused') where.push('c.device IS NULL AND c.revoked_at IS NULL');
      if (status === 'active') where.push('c.device IS NOT NULL AND c.revoked_at IS NULL');
      if (status === 'revoked') where.push('c.revoked_at IS NOT NULL');
      const add = (condition, ...values) => where.push(condition) && args.push(...values);
      if (Object.hasOwn(plans, plan)) add('c.plan = ?', plan);
      // An empty batch means the codes made without a note.
      if (batch === '') add('c.batch IS NULL');
      else if (typeof batch === 'string') add('c.batch = ?', batch);
      const part = normalizeCode(q);
      if (part)
        add(
          '(c.code LIKE ? OR c.code IN (SELECT code FROM orders WHERE no LIKE ? OR pay_id LIKE ?))',
          `%${part}%`,
          `%${part}%`,
          `%${part}%`,
        );
      const filter = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = all(
        `SELECT c.*, d.platform FROM codes c LEFT JOIN devices d ON d.device = c.device ${filter}
         ORDER BY c.created_at DESC, c.code LIMIT ? OFFSET ?`,
        ...args,
        Math.min(Math.max(Number(limit) || 200, 1), 5000),
        Math.max(Number(offset) || 0, 0),
      );
      return {
        total: one(`SELECT count(*) AS n FROM codes c ${filter}`, ...args).n,
        codes: rows.map((r) => ({
          code: formatCode(r.code),
          plan: r.plan,
          batch: r.batch,
          created: r.created_at,
          status: r.revoked_at ? 'revoked' : r.device ? 'active' : 'unused',
          activated: r.activated_at,
          revoked: r.revoked_at,
          reason: r.revoke_reason,
          platform: r.platform || null,
        })),
      };
    },
    // Numbers to read the business by, over the last `days` days, today being the last (0 or
    // none: since the start). Money is in fen; days are China's, from midnight. Refunded
    // purchases are counted apart, not as sales.
    analytics({ days }) {
      const at = now();
      const span = Math.min(Math.max(Math.floor(Number(days)) || 0, 0), 3650);
      const midnight = Date.parse(`${dayOf(at)}T00:00:00+08:00`);
      const since = span ? midnight - (span - 1) * DAY : 0;
      const orders = all(
        `SELECT o.*, c.revoked_at, r.days AS reward_days, r.revoked_at AS reward_revoked,
           d.platform FROM orders o JOIN codes c ON c.code = o.code
         LEFT JOIN codes r ON r.code = o.reward LEFT JOIN devices d ON d.device = o.device
         WHERE o.paid_at > ? ORDER BY o.paid_at`,
        since,
      );
      const sales = orders.filter((o) => !o.revoked_at);
      const sum = (list) => ({ n: list.length, amount: list.reduce((a, o) => a + o.amount, 0) });
      const by = (list, key) => {
        const out = {};
        for (const o of list) (out[o[key] ?? ''] ||= []).push(o);
        return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, sum(v)]));
      };

      // Sales a day, from the window's first day (or the first sale) to today, empty days too.
      const first = span ? since : sales[0]?.paid_at || at;
      const daily = [];
      for (let t = first; dayOf(t) <= dayOf(at); t += DAY)
        daily.push({ day: dayOf(t), n: 0, amount: 0, month: 0, year: 0, life: 0 });
      const byDay = new Map(daily.map((d) => [d.day, d]));
      for (const o of sales) {
        const d = byDay.get(dayOf(o.paid_at));
        if (!d) continue;
        d.n++;
        d.amount += o.amount;
        d[o.plan] += o.amount;
      }

      const plansOut = {};
      for (const plan of Object.keys(prices)) {
        const mine = sales.filter((o) => o.plan === plan);
        plansOut[plan] = {
          ...sum(mine),
          invited: mine.filter((o) => o.inviter).length,
          discount: mine.reduce((a, o) => a + (o.discount || 0), 0),
          upgrades: mine.filter((o) => o.credit).length,
          credit: mine.reduce((a, o) => a + (o.credit || 0), 0),
        };
      }

      // A device's first paid order, to tell new buyers from renewals and upgrades.
      const firstPaid = new Map(
        all(
          'SELECT device, min(paid_at) AS at FROM orders WHERE paid_at IS NOT NULL GROUP BY device',
        ).map((r) => [r.device, r.at]),
      );
      const trials = all('SELECT device FROM trials WHERE started_at > ?', since);
      const checkouts = one(
        `SELECT count(*) AS n, count(DISTINCT device) AS devices,
           coalesce(sum(paid_at IS NOT NULL), 0) AS paid FROM orders WHERE created_at > ?`,
        since,
      );

      // Members now, by the computer they're on; and those whose app checked in this week.
      const members = { darwin: 0, win32: 0, other: 0, seenThisWeek: 0 };
      for (const { device, platform, last_seen } of all(
        `SELECT DISTINCT c.device, d.platform, d.last_seen FROM codes c
         LEFT JOIN devices d ON d.device = c.device
         WHERE c.device IS NOT NULL AND c.revoked_at IS NULL`,
      )) {
        if (!runningPlan(device, at)) continue;
        members[platform === 'darwin' || platform === 'win32' ? platform : 'other']++;
        if (last_seen > at - 7 * DAY) members.seenThisWeek++;
      }

      const invitedSales = sales.filter((o) => o.inviter);
      const inviters = all(
        `SELECT i.*, d.platform, count(o.no) AS friends, coalesce(sum(o.amount), 0) AS amount,
           coalesce(sum(o.plan != 'month'), 0) AS toward FROM invites i
         JOIN orders o ON o.inviter = i.device JOIN codes c ON c.code = o.code
         LEFT JOIN devices d ON d.device = i.device
         WHERE c.revoked_at IS NULL GROUP BY i.device ORDER BY friends DESC, amount DESC LIMIT 20`,
      );
      return {
        days: span,
        sales: sum(sales),
        refunds: sum(orders.filter((o) => o.revoked_at)),
        daily,
        plans: plansOut,
        methods: by(sales, 'method'),
        platforms: by(sales, 'platform'),
        buyers: {
          devices: new Set(sales.map((o) => o.device)).size,
          // Sales that were the computer's first purchase; the rest renewed or upgraded.
          first: sales.filter((o) => firstPaid.get(o.device) === o.paid_at).length,
        },
        funnel: {
          // Computers seen for the first time: they tried, bought or activated something.
          newDevices: one('SELECT count(*) AS n FROM devices WHERE first_seen > ?', since).n,
          trials: trials.length,
          // Of the trials, the computers that have bought since.
          trialsPaid: trials.filter((t) => firstPaid.has(t.device)).length,
          // Payment QR codes shown, the computers they were shown on, and how many were paid.
          checkouts,
        },
        members,
        versions: all(
          `SELECT coalesce(version, '?') AS version, platform, count(*) AS n FROM devices
           WHERE last_seen > ? GROUP BY version, platform ORDER BY n DESC LIMIT 12`,
          at - 30 * DAY,
        ),
        invites: {
          ...sum(invitedSales),
          plans: Object.fromEntries(
            Object.keys(prices).map((p) => [p, invitedSales.filter((o) => o.plan === p).length]),
          ),
          discount: invitedSales.reduce((a, o) => a + (o.discount || 0), 0),
          rewardDays: invitedSales.reduce(
            (a, o) => a + (o.reward_revoked ? 0 : o.reward_days || 0),
            0,
          ),
          // Different invite codes used by the window's sales.
          codes: new Set(invitedSales.map((o) => o.inviter)).size,
          // Lifetime memberships friends earned, all time.
          lives: one(
            `SELECT count(*) AS n FROM invites i JOIN codes c ON c.code = i.life_code
             WHERE c.revoked_at IS NULL`,
          ).n,
          // The best inviters of all time: refunded friends left out.
          top: inviters.map((i) => ({
            code: i.code,
            platform: i.platform || null,
            friends: i.friends,
            toward: i.toward,
            amount: i.amount,
            life: invited(i).life,
            since: i.created_at,
          })),
        },
      };
    },
    batches() {
      return all(
        `SELECT batch, plan, count(*) AS total,
           sum(device IS NULL AND revoked_at IS NULL) AS unused,
           sum(device IS NOT NULL AND revoked_at IS NULL) AS active,
           sum(revoked_at IS NOT NULL) AS revoked,
           min(created_at) AS created
         FROM codes GROUP BY batch, plan ORDER BY created DESC`,
      );
    },
    // What happened lately: activations, moves, trials, refunds and new codes.
    events({ limit }) {
      return all(
        `${eventQuery} ORDER BY e.id DESC LIMIT ?`,
        Math.min(Math.max(Number(limit) || 50, 1), 500),
      ).map(eventOut);
    },
    // A consistent copy of the whole database, written to `file`.
    backup(file) {
      fs.rmSync(file, { force: true });
      db.prepare('VACUUM INTO ?').run(file);
      return file;
    },
  };
  return { activate, trial, refresh, offer, order, orderStatus, notify, admin, lease };
}

// 简付 (jian-pay.com, docs at jian-pay.com/docs): an order there gives a checkout page that
// takes WeChat Pay or Alipay, whichever app scans it. Requests and notifications are signed with
// the merchant key: md5 of the non-empty fields but sign and sign_type, sorted by name as
// k=v&k=v, with the key appended.
export function jianpaySign(fields, key) {
  const content = Object.keys(fields)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && fields[k] !== '' && fields[k] != null)
    .sort()
    .map((k) => `${k}=${typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]}`)
    .join('&');
  return crypto
    .createHash('md5')
    .update(content + key)
    .digest('hex');
}
export function createJianPay({
  clientNo,
  key,
  notifyUrl,
  gateways = ['https://jpay.hzjianban.com', 'https://api.jian-pay.com'],
}) {
  // The first gateway that answers; the second is 简付's backup.
  async function call(route, fields) {
    const body = { clientNo, ...fields, timestamp: String(Math.floor(Date.now() / 1000)) };
    body.sign_type = 'MD5';
    body.sign = jianpaySign(body, key);
    let failure;
    for (const gateway of gateways) {
      let response;
      try {
        response = await fetch(gateway + route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        failure = e;
        continue;
      }
      const result = await response.json().catch(() => null);
      if (result?.code !== 1000)
        throw Error(`简付 ${route}：${result?.message || `HTTP ${response.status}`}`);
      return result.data;
    }
    throw Error(`连不上简付：${failure?.message}`);
  }
  return {
    create: ({ orderNo, amount, goodsName }) =>
      call('/open/payment/pay/create', { amount, orderNo, goodsName, notifyUrl }),
    // By 简付's own order number: asking by ours (merchantOrderNo) fails its signature check.
    info: (orderId) => call('/open/payment/pay/info', { orderId }),
    verify: (body) =>
      body?.clientNo === clientNo &&
      typeof body.sign === 'string' &&
      jianpaySign(body, key) === body.sign.toLowerCase(),
  };
}

export function createServer({ service, adminToken, prefix = '/api/folio', backupDir }) {
  const tokenHash = crypto.createHash('sha256').update(adminToken).digest();
  const isAdmin = (req) => {
    const given = (req.headers.authorization || '').replace(/^Bearer /, '');
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), tokenHash);
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16_384) {
          reject(new Refusal(413, 'too-large', '请求太大'));
          req.destroy();
        } else chunks.push(chunk);
      });
      // JSON, or a form for 简付's notification in case it sends one.
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text) resolve({});
          else if (/json/.test(req.headers['content-type'] || '') || /^\s*\{/.test(text))
            resolve(JSON.parse(text));
          else resolve(Object.fromEntries(new URLSearchParams(text)));
        } catch {
          reject(new Refusal(400, 'bad-request', '请求无效'));
        }
      });
      req.on('error', reject);
    });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith(prefix + '/'))
        throw new Refusal(404, 'not-found', '没有这个地址');
      const route = url.pathname.slice(prefix.length);
      if (route === '/health') return send(res, 200, { ok: true });
      if (route.startsWith('/admin/')) {
        if (!isAdmin(req)) throw new Refusal(401, 'unauthorized', '管理口令不对');
        if (route === '/admin/backup' && req.method === 'GET') {
          const file = service.admin.backup(
            path.join(backupDir || '/tmp', `download-${process.pid}-${Date.now()}.db`),
          );
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          return fs
            .createReadStream(file)
            .on('close', () => fs.rmSync(file, { force: true }))
            .pipe(res);
        }
        const query = {
          '/admin/stats': 'stats',
          '/admin/info': 'info',
          '/admin/list': 'list',
          '/admin/batches': 'batches',
          '/admin/events': 'events',
          '/admin/analytics': 'analytics',
        }[route];
        if (query && req.method === 'GET')
          return send(res, 200, service.admin[query](Object.fromEntries(url.searchParams)));
        const action = {
          '/admin/codes': 'codes',
          '/admin/revoke': 'revoke',
          '/admin/restore': 'restore',
          '/admin/allow-move': 'allowMove',
        }[route];
        if (!action || req.method !== 'POST') throw new Refusal(404, 'not-found', '没有这个地址');
        return send(res, 200, service.admin[action](await readBody(req)));
      }
      if (route === '/pay/notify' && req.method === 'POST') {
        const answer = service.notify(await readBody(req));
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(answer);
      }
      const action = {
        '/activate': 'activate',
        '/trial': 'trial',
        '/refresh': 'refresh',
        '/offer': 'offer',
        '/order': 'order',
        '/order-status': 'orderStatus',
      }[route];
      if (!action || req.method !== 'POST') throw new Refusal(404, 'not-found', '没有这个地址');
      send(res, 200, await service[action](await readBody(req)));
    } catch (e) {
      if (e instanceof Refusal)
        return send(res, e.status, { error: e.error, message: e.message, ...e.extra });
      console.error(e);
      send(res, 500, { error: 'server', message: '激活服务器出错了，请稍后再试' });
    }
  });
}

// Run directly: settings come from the environment (server/folio-license.service).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const dataDir = env.FOLIO_LICENSE_DATA || '/var/lib/folio-license';
  const db = openDb(path.join(dataDir, 'license.db'));
  // {"clientNo": "…", "key": "…"} from the 简付 console's API安全 page. Without it the app
  // can't buy, only activate codes.
  const payFile = env.FOLIO_LICENSE_PAY || '/etc/folio-license/jianpay.json';
  const pay = fs.existsSync(payFile)
    ? createJianPay({
        notifyUrl: 'https://helloxxy.com/api/folio/pay/notify',
        ...JSON.parse(fs.readFileSync(payFile, 'utf8')),
      })
    : null;
  if (!pay) console.warn(`no ${payFile}: buying in the app is off`);
  const service = createService({
    db,
    pay,
    privateKey: fs.readFileSync(env.FOLIO_LICENSE_KEY || '/etc/folio-license/private.pem'),
  });
  const adminToken = fs
    .readFileSync(env.FOLIO_LICENSE_ADMIN_TOKEN || '/etc/folio-license/admin-token', 'utf8')
    .trim();
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  // A copy a day on the server, the last 14 kept; the admin app downloads one off it.
  const daily = () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      service.admin.backup(path.join(backupDir, `license-${day}.db`));
      for (const old of fs
        .readdirSync(backupDir)
        .filter((f) => /^license-.*\.db$/.test(f))
        .sort()
        .slice(0, -14))
        fs.rmSync(path.join(backupDir, old));
    } catch (e) {
      console.error('backup failed:', e);
    }
  };
  daily();
  setInterval(daily, DAY).unref();
  const port = Number(env.PORT) || 8787;
  const host = env.HOST || '127.0.0.1';
  createServer({ service, adminToken, backupDir }).listen(port, host, () =>
    console.log(`folio-license listening on http://${host}:${port}/api/folio`),
  );
}
