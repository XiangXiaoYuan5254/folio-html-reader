// 使用统计: 页间 tells the website it's open, so its author can count the computers that use it
// and see which versions they're on. Sent when 页间 opens and every 4 hours while it stays open:
//   id       a random number made the first time, kept in this computer's app data (usage.json),
//            so updates keep it; nothing about the computer goes into it
//   version, platform
//   earlier  whether 页间 had been used here before the number was made (an old copy updated)
//   device   only on a computer that had a membership code (0.29 and older): the computer
//            number the activation server already knows it by, read from the license.json those
//            versions left, so the author can see which friends who were members still use it
// Nothing else: no documents, file names, settings or what AI is asked.
// There's no switch in the window. It's off with "off": true in usage.json, or FOLIO_NO_USAGE=1
// in the environment (README.md, 数据在哪里).
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const DEFAULT_SERVER = 'https://helloxxy.com/api/folio';
const every = 4 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The membership computer number in an old license.json, if a code was ever on this computer.
async function memberDevice(file) {
  try {
    const lease = JSON.parse(JSON.parse(await fs.readFile(file, 'utf8')).lease.payload);
    return lease.codes?.length && /^[0-9a-f]{32}$/.test(lease.device) ? lease.device : null;
  } catch {
    return null;
  }
}

// `earlierFile`: a file any 页间 that ran here has written (its settings). There when the number
// is made, this is an old copy that updated to a version that reports, not a new one.
function createUsage({
  file,
  earlierFile,
  memberFile,
  version,
  platform = process.platform,
  fetch: doFetch = fetch,
  server = DEFAULT_SERVER,
  env = process.env,
  write = (target, text) => fs.writeFile(target, text),
}) {
  const base = server.replace(/\/$/, '');
  let loading = null;
  async function read() {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (uuid.test(saved?.id)) return saved;
    } catch {}
    const earlier = await fs.access(earlierFile).then(
      () => true,
      () => false,
    );
    const made = { id: crypto.randomUUID(), off: false, earlier };
    await write(file, JSON.stringify(made)).catch(() => {});
    return made;
  }
  // Called before anything else is written, so `earlier` sees only what an older 页间 left.
  function load() {
    loading ||= read();
    return loading;
  }
  async function report() {
    const { id, off, earlier } = await load();
    if (off === true || (env.FOLIO_NO_USAGE && env.FOLIO_NO_USAGE !== '0')) return false;
    const device = memberFile ? await memberDevice(memberFile) : null;
    const response = await doFetch(base + '/usage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        version,
        platform,
        earlier: earlier === true,
        ...(device ? { device } : {}),
      }),
      credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  }
  const quietly = () => report().catch(() => false);
  function start() {
    setTimeout(quietly, 8000);
    setInterval(quietly, every);
  }
  return { load, report, start };
}

module.exports = { createUsage };
