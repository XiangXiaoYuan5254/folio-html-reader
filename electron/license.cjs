// Membership: PDF and every AI feature need it; reading and editing HTML never do.
// It's bought in the window (a QR code to pay with WeChat or Alipay) or comes with a code typed
// in, both through the server (server/folio-license.mjs). The server answers with a lease
// signed by its key, kept in the app's data folder and checked here against the public key
// below, so editing the file or faking the server gives nothing. A lease lasts a week at most
// (less if the membership ends sooner), and the app renews it while it runs, also when it's
// used, so a code moved to another computer or revoked stops working here at the next use
// online and within a week offline.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const publicKey = crypto.createPublicKey({
  key: Buffer.from('MCowBQYDK2VwAyEANNRLy59ZaUeiMsBkUgQKOBf13OqLYAiU3T5E2jkBgaw=', 'base64'),
  format: 'der',
  type: 'spki',
});
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RENEW_EVERY = 6 * HOUR;
// Using the app asks the server again, at most this often.
const CHECK_GAP = 60_000;
// The clock may wobble this much backwards; more means it was turned back to stretch a lease.
const CLOCK_SLACK = HOUR;
// The test switches below (FOLIO_MEMBER, FOLIO_LICENSE_DEVICE) work only run from
// the project itself, its src/ beside electron/. Not from an installed app's files, not even when
// a stock Electron runs them: that one calls itself unpackaged whatever it runs.
const fromSource = existsSync(path.join(__dirname, '../src'));

const run = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) =>
      resolve(error ? '' : String(stdout)),
    ),
  );
// The computer's own ID, which stays the same across reinstalling the app.
async function machineId() {
  if (process.platform === 'darwin')
    return (await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])).match(
      /"IOPlatformUUID" = "([^"]+)"/,
    )?.[1];
  if (process.platform === 'win32')
    return (
      await run('reg', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid',
        '/reg:64',
      ])
    ).match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
  return (await fs.readFile('/etc/machine-id', 'utf8').catch(() => '')).trim();
}

function createLicense({ file, fetch, version, packaged, onChange }) {
  const dev = !packaged && fromSource;
  const server = (process.env.FOLIO_LICENSE_SERVER || 'https://helloxxy.com/api/folio').replace(
    /\/$/,
    '',
  );
  // Tests run from the source as a member, or as another computer; an installed app ignores both.
  const testMember = dev && process.env.FOLIO_MEMBER === '1';
  // `order`: a purchase not yet seen paid, { no, at }. `invite`: a friend's invite code typed in
  // for this computer's first purchase.
  let saved = { lease: null, seen: 0, fallbackId: null, order: null, invite: null };
  let device = '';
  let lastError = '';
  let renewing = null;
  let tried = 0;
  let timer = null;
  const ready = (async () => {
    try {
      saved = { ...saved, ...JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch {}
    let id = (dev && process.env.FOLIO_LICENSE_DEVICE) || (await machineId());
    if (!id) {
      saved.fallbackId ||= crypto.randomUUID();
      id = saved.fallbackId;
    }
    device = crypto
      .createHash('sha256')
      .update('folio-license:' + id)
      .digest('hex')
      .slice(0, 32);
  })();
  const save = () => fs.writeFile(file, JSON.stringify(saved)).catch(() => {});

  // The lease, if it's really from the server and for this computer.
  function lease() {
    const l = saved.lease;
    if (!l || typeof l.payload !== 'string' || typeof l.sig !== 'string') return null;
    try {
      if (!crypto.verify(null, Buffer.from(l.payload), publicKey, Buffer.from(l.sig, 'base64')))
        return null;
      const value = JSON.parse(l.payload);
      return value.v === 1 && value.device === device ? value : null;
    } catch {
      return null;
    }
  }
  function status() {
    if (testMember)
      return { member: true, state: 'paid', expires: null, trialUsed: true, codes: [], error: '' };
    const now = Date.now();
    const l = lease();
    if (now > saved.seen + 10 * 60_000) {
      saved.seen = now;
      void save();
    }
    const base = {
      forever: !!l?.forever,
      // What the server last said this computer had, still there while offline or clock.
      kind: l?.kind || null,
      expires: l?.expires || null,
      trialUsed: !!l?.trialUsed,
      codes: l?.codes || [],
      checked: l?.issued || null,
      // The codes went to another computer: when, and what it is.
      moved: l?.moved || null,
      error: lastError,
    };
    if (!l) return { ...base, member: false, state: 'none' };
    if (now < saved.seen - CLOCK_SLACK) return { ...base, member: false, state: 'clock' };
    if (l.member && (l.forever || now < l.expires)) {
      if (now < l.until) return { ...base, member: true, state: l.kind };
      return { ...base, member: false, state: 'offline' };
    }
    const was = l.expires || l.trialUsed || l.codes?.length;
    return { ...base, member: false, state: was ? 'expired' : 'none' };
  }

  async function request(route, body) {
    await ready;
    let response;
    try {
      response = await fetch(server + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, device, platform: process.platform, version }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw Object.assign(Error('连不上激活服务器，请检查网络后再试'), { offline: true });
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(Error(result.message || `激活服务器出错了（${response.status}）`), {
        code: result.error,
        ...result,
      });
    return result;
  }
  async function take(answer) {
    saved.lease = answer;
    saved.seen = Date.now();
    lastError = '';
    await save();
    if (!lease()) throw Error('激活服务器的回复无效，请更新页间后再试');
    changed();
  }
  async function post(route, body) {
    await take((await request(route, body)).lease);
    return status();
  }
  // Tells the window when the membership changes, including when it runs out by itself.
  let told = '';
  let boundary = null;
  function changed() {
    const now = status();
    if (JSON.stringify(now) !== told) {
      told = JSON.stringify(now);
      onChange(now);
    }
    clearTimeout(boundary);
    const l = lease();
    const next = l?.member ? (l.forever ? l.until : Math.min(l.until, l.expires)) - Date.now() : 0;
    if (next > 0) boundary = setTimeout(changed, Math.min(next + 1000, 2 ** 31 - 1));
  }

  // Asks the server again; a failure keeps the lease there is, until it runs out.
  function renew() {
    if (testMember || !lease()) return Promise.resolve(status());
    tried = Date.now();
    renewing ||= post('/refresh', {})
      .catch((e) => {
        lastError = e.offline ? e.message : '';
        changed();
        return status();
      })
      .finally(() => (renewing = null));
    return renewing;
  }
  // Using the app (its window to the front, a PDF opening, an AI feature) asks the server again,
  // at most once a CHECK_GAP, so a code moved to another computer stops working here at the
  // next use. Nothing waits for the answer, and a failure keeps the lease.
  function check() {
    if (lease()?.member && Date.now() - tried >= CHECK_GAP) void renew();
  }
  // Opening the membership window without a membership asks the server once: what this computer
  // has there comes back even if license.json was lost (a cleaner app, a reinstalled system).
  function recover() {
    if (testMember || lease()?.member) return Promise.resolve(status());
    return post('/refresh', {}).catch(() => status());
  }
  // A code on another computer comes back as `refusal`, for the window to offer moving it here.
  async function activate({ code, move }) {
    if (typeof code !== 'string' || !code.trim()) throw Error('请输入激活码');
    try {
      return { status: await post('/activate', { code, move: move === true }) };
    } catch (e) {
      if (e.code !== 'in-use') throw e;
      return { refusal: { code: e.code, message: e.message, platform: e.platform || null } };
    }
  }
  const trial = () => post('/trial', {});
  // Plans and today's prices, less what the friend's invite code takes off; and this computer's
  // own invite code.
  const offer = () => request('/offer', saved.invite ? { invite: saved.invite } : {});
  // Keeps the friend's invite code (or forgets it, given none) and asks for the prices with it.
  async function setInvite({ code } = {}) {
    saved.invite = typeof code === 'string' && code.trim() ? code.trim().slice(0, 32) : null;
    await save();
    return offer();
  }
  // `invite`: the friend's code, when the offer took something off for it.
  async function order({ plan, invite }) {
    const made = (await request('/order', { plan, invite })).order;
    saved.order = { no: made.no, at: Date.now() };
    await save();
    return made;
  }
  // Whether the purchase went through: asked while its QR code is up, and once at start in case
  // it was paid after the window closed. An unpaid one is given up after a day.
  async function checkOrder() {
    const pending = saved.order;
    if (!pending) return { paid: false, closed: false, status: status() };
    let answer;
    try {
      answer = await request('/order-status', { order: pending.no });
    } catch (e) {
      if (e.code === 'not-found') {
        saved.order = null;
        await save();
      }
      throw e;
    }
    if (answer.paid || answer.closed || Date.now() - pending.at > DAY) saved.order = null;
    // A friend's code is only for the first purchase.
    if (answer.paid) saved.invite = null;
    await take(answer.lease);
    return { paid: answer.paid, closed: !!answer.closed, status: status() };
  }

  return {
    ready,
    status: () => status(),
    member: () => status().member,
    activate,
    trial,
    offer,
    setInvite,
    order,
    checkOrder,
    renew,
    check,
    recover,
    // While there's a membership, renews it at start, every few hours, and when used (check).
    // Without one the app doesn't contact the server at all, unless a purchase is waiting.
    start() {
      void ready.then(() => {
        changed();
        if (lease()?.member) void renew();
        if (saved.order) void checkOrder().catch(() => {});
      });
      timer = setInterval(() => {
        if (lease()?.member) void renew();
      }, RENEW_EVERY);
      timer.unref?.();
    },
  };
}

module.exports = { createLicense };
