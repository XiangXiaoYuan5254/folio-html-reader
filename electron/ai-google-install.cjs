// Google's native CLI includes the maintained ACP transport and model-request retries.
// Releases and SHA-512 values come from the official CLI installer's manifests.
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const version = '1.5.5';
const releaseRoot = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-6740358537805824`;
const releases = {
  'darwin-arm64': [
    'darwin-arm/cli_mac_arm64.tar.gz',
    'ca6424867a4527698e54b805c2456605b905a49ffc9b664ae2ee0fd4510fcd7b82d9721b2622a1d46048156a44431dc894359177fae44207363c8c878687b647',
  ],
  'darwin-x64': [
    'darwin-x64/cli_mac_x64.tar.gz',
    '54bbe42eee81d75d746ed560995bfa7cc9d14c601b4b1a3756f5e9c0f2b79ffb9ca64894368e326e211445de2075cf54ecaecb0c26ad79d231ed819feba3618d',
  ],
  'win32-x64': [
    'windows-x64/cli_windows_x64.exe',
    '11e01089801b86db04d92d4cec3f67bbeff90ca1076ae46bc7475415ab5f3ad7b53419252b7b2c2a68066375b2b6821a6e74a0a959892dad656d3ef769d44955',
  ],
  'win32-arm64': [
    'windows-arm/cli_windows_arm64.exe',
    'dd195d009c1b39e205916882adc7d2cc193ca768b39242fa695d412e6e4522621e5042ee948e4c915776f83d0efd7a2f02022409217b0c5d318e04c48af43dab',
  ],
  'linux-x64': [
    'linux-x64/cli_linux_x64.tar.gz',
    '746a2bd73f83b65d9b44f2fc55d0f0f511ff7f89702846213eeabd76d06bc9c98576b424c2babc7b947f15e518447b946ba02dca260b778363c55c07a7f7a277',
  ],
  'linux-arm64': [
    'linux-arm/cli_linux_arm64.tar.gz',
    'eb3e025c125c1c60a1493a0c1d9cdf15e8372277d6d3b015e8d29e1bd095344eece5cbc2447f238148bd259d5f2daa0f75641adc0ac02b5fad57edc4ed842d59',
  ],
};
const release = releases[process.platform + '-' + process.arch];
const windows = process.platform === 'win32';
const name = windows ? 'agy.exe' : 'agy';
const installedDir = (home) => path.join(home, 'bin', `cli-${version}`);
const binary = (home) => process.env.FOLIO_GOOGLE_ACP_PATH || path.join(installedDir(home), name);
const supported = !!release || !!process.env.FOLIO_GOOGLE_ACP_PATH;
const found = (home) =>
  fs.access(binary(home)).then(
    () => true,
    () => false,
  );

async function install(home, fetch) {
  if (await found(home)) return;
  if (!release || process.env.FOLIO_GOOGLE_ACP_PATH)
    throw Error('这台电脑没有可用的 Google 登录组件');
  const [artifact, sha512] = release;
  const root = path.dirname(installedDir(home));
  await fs.mkdir(root, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(root, 'download-'));
  try {
    const url = `${releaseRoot}/${artifact}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok || !res.body) throw Error(`下载 Google 登录组件失败（HTTP ${res.status}）`);
    const payload = path.join(tmp, windows ? name : 'agent.tar.gz');
    const hash = createHash('sha512');
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, createWriteStream(payload));
    if (hash.digest('hex') !== sha512) throw Error('Google 登录组件校验失败，请重新下载');
    const unpacked = path.join(tmp, 'unpacked');
    await fs.mkdir(unpacked);
    if (windows) {
      await fs.rename(payload, path.join(unpacked, name));
    } else {
      await exec('tar', ['-xzf', payload, '-C', unpacked, 'antigravity']);
      await fs.rename(path.join(unpacked, 'antigravity'), path.join(unpacked, name));
      await fs.chmod(path.join(unpacked, name), 0o755);
    }
    await fs.access(path.join(unpacked, name));
    await fs.rename(unpacked, installedDir(home));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { binary, found, install, supported };
