// AI 设置 → 公告: the owner checks model vendors' offers and publishes them on the activation
// server; the app reads them from the public endpoint and keeps the last answer for offline
// use. Nothing about this computer is sent.
const fs = require('node:fs/promises');
const path = require('node:path');
const DEFAULT_SERVER = 'https://helloxxy.com/api/folio';
// Asked again when older than this; opening the page usually serves the copy on disk.
const freshFor = 30 * 60_000;

function createAnnouncements({
  file,
  fetch: doFetch = fetch,
  server = process.env.FOLIO_LICENSE_SERVER,
}) {
  const base = (server || DEFAULT_SERVER).replace(/\/$/, '');
  let cache = null;
  const text = (value, max) => String(value ?? '').slice(0, max);
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const clean = (raw) => {
    const url = text(raw?.url, 500);
    return {
      id: text(raw?.id, 64),
      vendor: text(raw?.vendor, 40),
      title: text(raw?.title, 120),
      benefit: text(raw?.benefit, 500),
      conditions: text(raw?.conditions, 300),
      // Only web links can be handed to the system browser.
      url: /^https?:\/\//.test(url) ? url : '',
      preset: text(raw?.preset, 40),
      evidence: text(raw?.evidence, 300),
      expires: number(raw?.expires) || null,
      checked: number(raw?.checked),
      published: number(raw?.published),
    };
  };
  async function read() {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(saved.items)) return null;
      return {
        items: saved.items.map(clean).filter((item) => item.title && item.vendor),
        updatedAt: number(saved.updatedAt),
        fetchedAt: number(saved.fetchedAt),
      };
    } catch {
      return null;
    }
  }
  async function load({ force = false } = {}) {
    if (!cache) cache = await read();
    if (!force && cache && Date.now() - cache.fetchedAt < freshFor)
      return { ...cache, cached: true };
    try {
      const response = await doFetch(base + '/announcements', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw Error(`公告服务器回复 ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.items)) throw Error('公告数据不对');
      cache = {
        items: data.items.map(clean).filter((item) => item.title && item.vendor),
        updatedAt: number(data.updatedAt),
        fetchedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(cache)).catch(() => {});
      return { ...cache, cached: false };
    } catch (error) {
      // A copy from before is better than nothing; the page says it may be old.
      if (cache) return { ...cache, cached: true, offline: true };
      throw Error('暂时连不上公告服务器，请稍后再试');
    }
  }
  return { load };
}

module.exports = { createAnnouncements };
