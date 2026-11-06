// 设置 › 用户交流群: the WeChat group's QR code. WeChat codes expire after 7 days, so the owner
// replaces the picture on the website every week and the app reads it from there, never from
// its own files. Nothing about this computer is sent.
const DEFAULT_QR = 'https://helloxxy.com/works/folio/community/qr.jpg';
const LIMIT = 4 * 1024 * 1024;
// Kept for a while, so going back and forth between pages doesn't fetch it again.
const freshFor = 10 * 60_000;

function createCommunity({ fetch: doFetch = fetch, url = DEFAULT_QR } = {}) {
  let cache = null;
  async function qr({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < freshFor) return cache.image;
    let response;
    try {
      // The query keeps a cached picture from last week out of the way.
      response = await doFetch(`${url}?t=${Math.floor(Date.now() / 60_000)}`, {
        signal: AbortSignal.timeout(12_000),
        credentials: 'omit',
      });
    } catch {
      throw Error('连不上页间官网，检查一下网络');
    }
    if (!response.ok) throw Error(`页间官网回复 ${response.status}`);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw Error('官网上的二维码不是图片');
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > LIMIT) throw Error('官网上的二维码图片不对');
    cache = { at: Date.now(), image: `data:${type};base64,${data.toString('base64')}` };
    return cache.image;
  }
  return { qr };
}

module.exports = { createCommunity };
