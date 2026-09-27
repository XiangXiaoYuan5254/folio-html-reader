const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
// Auto-save writes often, so a new backup is taken at most once per interval.
const interval = 10 * minute;
// Everything from the last 2 hours, then the first backup of each hour for a day and of
// each day for 30 days. The first one is the version from when that stretch of editing
// began. Newer backups are kept first until a document's backups reach the size budget.
const policy = { recent: 2 * hour, hourly: day, daily: 30 * day, maxBytes: 200 * 1024 * 1024 };
const pattern = /^(\d{13})-[0-9a-f]{8}(-restore)?\.html$/;
function parse(name) {
  const m = typeof name === 'string' ? pattern.exec(name) : null;
  return m ? { name, time: Number(m[1]), restore: !!m[2] } : null;
}
// Backups in `dir`, newest first.
async function list(dir) {
  const names = await fs.readdir(dir).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const entries = [];
  for (const name of names) {
    const entry = parse(name);
    const stat = entry && (await fs.stat(path.join(dir, name)).catch(() => null));
    if (stat?.isFile()) entries.push({ ...entry, size: stat.size });
  }
  return entries.sort((a, b) => b.time - a.time);
}
function localDay(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
// The entries that fall outside the retention policy at `now`.
function expired(entries, now = Date.now()) {
  const buckets = new Set();
  const kept = [];
  const drop = [];
  for (const e of [...entries].sort((a, b) => a.time - b.time)) {
    const age = now - e.time;
    const bucket =
      age < policy.recent
        ? null
        : age < policy.hourly
          ? `h${Math.floor(e.time / hour)}`
          : age < policy.daily
            ? `d${localDay(e.time)}`
            : undefined;
    if (bucket === undefined || buckets.has(bucket)) drop.push(e);
    else {
      if (bucket) buckets.add(bucket);
      kept.push(e);
    }
  }
  let bytes = 0;
  for (const [i, e] of kept.reverse().entries()) {
    bytes += e.size;
    if (i > 0 && bytes > policy.maxBytes) drop.push(e);
  }
  return drop;
}
async function prune(dir, now = Date.now()) {
  const drop = expired(await list(dir), now);
  await Promise.all(drop.map((e) => fs.rm(path.join(dir, e.name), { force: true })));
}
// Cleans every document's backups, including documents that no longer exist.
async function pruneAll(root, now = Date.now()) {
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const d of dirs)
    if (d.isDirectory()) await prune(path.join(root, d.name), now).catch(() => {});
}
// Saves `content` as a backup unless one was taken within the interval. `force` always
// saves (unless the newest backup already holds this content), for replacing a file on purpose.
async function snapshot(dir, content, atomicWrite, { force = false, restore = false } = {}) {
  const [latest] = await list(dir);
  const now = Date.now();
  if (latest) {
    if (!force && now >= latest.time && now - latest.time < interval) return;
    if (
      force &&
      latest.size === Buffer.byteLength(content) &&
      (await fs.readFile(path.join(dir, latest.name), 'utf8')) === content
    )
      return;
  }
  const name = `${now}-${crypto.randomUUID().slice(0, 8)}${restore ? '-restore' : ''}.html`;
  await atomicWrite(path.join(dir, name), content);
  await prune(dir, now);
}
async function read(dir, name) {
  if (!parse(name)) throw Error('无效的历史版本');
  try {
    return await fs.readFile(path.join(dir, name), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw Error('这个历史版本已被自动清理，请刷新列表');
    throw e;
  }
}
module.exports = { list, expired, prune, pruneAll, snapshot, read, parse, policy, interval };
