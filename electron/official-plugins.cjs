// 官方插件的列表放在官网上（scripts/website-plugins.mjs 生成并签名），页间里只有它的地址和公钥：
// 官方插件更新、新增，都不用发新版页间；页间更新也不会动已经装好的插件。
//
// 官方插件不用打开「社区插件」就能装、能运行，所以只认签过名的列表。私钥只在维护者自己的电脑上，
// 不在官网服务器上：服务器被人改了，也冒充不了官方插件。列表里每个插件的 .zip 再按 SHA-256 核对。
// 旧列表不能拿来回放：seq 只往前走，比已经见过的小就不认。
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { idPattern } = require('./plugin-manifest.cjs');

const OFFICIAL_URL = 'https://helloxxy.com/works/folio/plugins/official.json';
// Ed25519 public keys (SPKI, base64). More than one while a new key takes over from an old one.
const OFFICIAL_KEYS = ['MCowBQYDK2VwAyEAH4gfqjeGpDrSF/shtTAaXOl7wmeEg5bLdQPxQs+rF58='];
const LIST_LIMIT = 2 * 1024 * 1024;
// Read again at most every half hour (the settings page and the scheduler both list plugins).
const FRESH = 30 * 60_000;

class OfficialError extends Error {}
const bad = (message) => {
  throw new OfficialError(message);
};

// What the website serves: the list as a JSON string, and the signature of exactly that string.
function signOfficial(list, privateKey) {
  const signed = JSON.stringify(list);
  const signature = crypto.sign(null, Buffer.from(signed), privateKey).toString('base64');
  return JSON.stringify({ signed, signature }, null, 1) + '\n';
}

const hex64 = /^[0-9a-f]{64}$/;
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
function cleanEntry(p) {
  if (!p || typeof p !== 'object' || !idPattern.test(p.id)) return null;
  if (!hex64.test(p.sha256) || !/^https:\/\//.test(p.url) || typeof p.version !== 'string')
    return null;
  return {
    id: p.id,
    name: text(p.name, 80) || p.id,
    version: text(p.version, 40),
    author: text(p.author, 80),
    description: text(p.description, 400),
    requires: text(p.requires, 40) || '>=0.0.0',
    url: p.url,
    sha256: p.sha256,
    digest: hex64.test(p.digest) ? p.digest : '',
    // Shown as an <img>: only a picture, inline.
    icon: /^data:image\/(svg\+xml|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.icon || '')
      ? p.icon
      : '',
  };
}

function verifyOfficial(body, keys = OFFICIAL_KEYS) {
  let outer;
  try {
    outer = JSON.parse(String(body));
  } catch {
    bad('官方插件列表不是有效的 JSON');
  }
  const { signed, signature } = outer || {};
  if (typeof signed !== 'string' || typeof signature !== 'string') bad('官方插件列表没有签名');
  const valid = keys.some((key) => {
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(key, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(null, Buffer.from(signed), publicKey, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  });
  if (!valid) bad('官方插件列表的签名不对');
  const list = JSON.parse(signed);
  if (list?.version !== 1 || !Number.isSafeInteger(list.seq) || !Array.isArray(list.plugins))
    bad('官方插件列表的格式不对');
  return { seq: list.seq, plugins: list.plugins.map(cleanEntry).filter(Boolean) };
}

// The list as last verified (kept in the user's data, so it's there offline and an older one
// can't replace it), and reading it again from the website.
function createOfficial({ fetch, file, atomicWrite, url = OFFICIAL_URL, keys = OFFICIAL_KEYS }) {
  let current = null;
  let checkedAt = 0;
  let checking = null;
  // Read from disk once, before anything fetched can replace it.
  const loaded = fs
    .readFile(file, 'utf8')
    .then((body) => (current = verifyOfficial(body, keys)))
    .catch(() => {});
  async function saved() {
    await loaded;
    return current;
  }
  const stale = () => !checking && Date.now() - checkedAt > FRESH;
  // Whether a newer list came in.
  function refresh() {
    checking ||= (async () => {
      const before = await saved();
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          credentials: 'omit',
          signal: AbortSignal.timeout(15_000),
        }).catch(() => bad('连不上页间官网'));
        if (!res.ok) bad(`页间官网回复 ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > LIST_LIMIT) bad('官方插件列表太大');
        const list = verifyOfficial(body.toString('utf8'), keys);
        if (before && list.seq <= before.seq) return false;
        current = list;
        await atomicWrite(file, body.toString('utf8'));
        return true;
      } catch {
        return false;
      } finally {
        checkedAt = Date.now();
        checking = null;
      }
    })();
    return checking;
  }
  return { saved, stale, refresh };
}

module.exports = { OFFICIAL_URL, OFFICIAL_KEYS, signOfficial, verifyOfficial, createOfficial };
