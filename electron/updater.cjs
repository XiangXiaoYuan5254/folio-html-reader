// Automatic updates from the website's downloads folder (the `publish` setting in package.json).
// A new version downloads in the background and installs when 页间 quits, or right away with
// “立即重启”. A release that comes out before then replaces the downloaded one, so two releases in
// a row install once. Windows uses electron-updater's NSIS updater. macOS's own updater only
// installs Developer ID-signed apps and 页间 is signed ad hoc, so there electron-updater downloads
// the zip and the app bundle is swapped for the new one after 页间 quits.
const { app, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
// Electron's fs reads app.asar as a folder, so only the original one can delete an unpacked app.
const realFs = require('original-fs');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { BaseUpdater, MacUpdater, NsisUpdater } = require('electron-updater');

const run = promisify(execFile);
const appId = 'com.folio.htmlreader';
const downloadPage = 'https://helloxxy.com/works/folio/';
const checkEvery = 4 * 60 * 60 * 1000;

// The installed 页间.app when it can be replaced in place. Not when running unpackaged, from the
// DMG, or from a folder the user cannot write to (macOS runs apps that were never moved out of
// Downloads from a read-only copy); those users are sent to the website instead.
function macBundle() {
  if (!app.isPackaged) return null;
  const bundle = path.resolve(process.execPath, '../../..');
  if (!bundle.endsWith('.app')) return null;
  try {
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return bundle;
  } catch {
    return null;
  }
}

// Waits for 页间 to exit, puts the new bundle in place of the old one (restoring the old one if
// that fails), and reopens it when asked.
const swapScript = `
i=0
while kill -0 "$1" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 300 ] && exit 1
  sleep 0.1
done
old="$3.old"
rm -rf "$old"
if mv "$2" "$old"; then
  if mv "$3" "$2"; then rm -rf "$old"; else mv "$old" "$2"; fi
fi
[ -n "$4" ] && open "$2"
`;

class MacBundleUpdater extends BaseUpdater {
  // What install() needs to go ahead: the checked bundle, even while a newer zip downloads.
  get installerPath() {
    return this.staged?.bundle ?? null;
  }
  async doDownloadUpdate(options) {
    const { provider, info } = options.updateInfoAndProvider;
    const files = MacUpdater.filterFilesForArch(
      provider.resolveFiles(info),
      process.arch === 'arm64',
    );
    const zip = files.find((file) => file.url.pathname.toLowerCase().endsWith('.zip'));
    if (!zip) throw Error('更新信息里没有 macOS 的 zip 文件');
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo: zip,
      downloadUpdateOptions: options,
      task: async (file, downloadOptions) => {
        // With the previous update's zip still cached, only the changed blocks are downloaded.
        const previous = path.join(this.downloadedUpdateHelper.cacheDir, 'update.zip');
        const full =
          options.disableDifferentialDownload ||
          !fs.existsSync(previous) ||
          (await this.differentialDownloadInstaller(zip, options, file, provider, 'update.zip'));
        if (full) await this.httpExecutor.download(zip.url, file, downloadOptions);
      },
    });
  }
  // The download is announced only once the new app is unpacked and checked, so a broken update
  // is reported before anyone restarts for it.
  dispatchUpdateDownloaded(event) {
    this.stage(event).then(
      () => super.dispatchUpdateDownloaded(event),
      (e) => this.dispatchError(e),
    );
  }
  async stage(event) {
    this.staged = null;
    const cache = this.downloadedUpdateHelper.cacheDir;
    const dir = path.join(cache, 'staged');
    // An update downloaded earlier may still be unpacked here.
    await realFs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
    await run('/usr/bin/ditto', ['-x', '-k', event.downloadedFile, dir]);
    const bundles = (await fs.promises.readdir(dir)).filter((name) => name.endsWith('.app'));
    if (bundles.length !== 1) throw Error('更新包里没有找到页间');
    const bundle = path.join(dir, bundles[0]);
    const { stdout } = await run('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      path.join(bundle, 'Contents/Info.plist'),
    ]);
    const plist = JSON.parse(stdout);
    if (plist.CFBundleIdentifier !== appId || plist.CFBundleShortVersionString !== event.version)
      throw Error('更新包的应用或版本不符');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    // 页间 downloads the zip itself, so macOS does not quarantine it. Clear the flag in case it
    // ever does: the reopened app would otherwise be blocked as damaged.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle]).catch(() => {});
    await fs.promises
      .copyFile(event.downloadedFile, path.join(cache, 'update.zip'))
      .catch(() => {});
    this.staged = { bundle, version: event.version };
  }
  doInstall({ isForceRunAfter }) {
    const bundle = macBundle();
    if (!bundle || !this.staged) return false;
    spawn(
      '/bin/sh',
      [
        '-c',
        swapScript,
        'folio-update',
        String(process.pid),
        bundle,
        this.staged.bundle,
        isForceRunAfter ? '1' : '',
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();
    return true;
  }
}

const releaseNotes = (info) =>
  typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((entry) => entry.note || '').join('\n')
      : '';
// Whether version a (x.y.z) comes after b.
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// What changed in every release since the installed one, newest first: the update's own notes
// and, from release-notes.json next to the update files (scripts/website-downloads.mjs), the
// releases in between. Just the update's own when that list can't be read.
async function releasesSince(info, provider) {
  const own = { version: info.version, notes: releaseNotes(info) };
  try {
    const [file] = provider.resolveFiles(info);
    const response = await net.fetch(new URL('release-notes.json', file.url).href, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [own];
    const listed = await response.json();
    const between = (Array.isArray(listed) ? listed : []).filter(
      (r) =>
        typeof r?.version === 'string' &&
        typeof r.notes === 'string' &&
        newer(r.version, app.getVersion()) &&
        newer(info.version, r.version),
    );
    return [own, ...between.sort((a, b) => (newer(a.version, b.version) ? -1 : 1))];
  } catch {
    return [own];
  }
}

// State sent to the window:
//   idle · downloading { version } · ready { version, releases }
//   manual { version, releases, url }: a new version this copy cannot install by itself
// releases: [{ version, notes }], newest first, every release since the installed one.
function createUpdates(send) {
  let state = { status: 'idle' };
  let restart = false;
  // Counts what was published, so notes still being read don't replace a newer state.
  let published = 0;
  let settling = Promise.resolve();
  const publish = (next) => {
    published++;
    state = next;
    send(state);
  };
  // Publishes a state that shows the releases' notes once they are read.
  const withNotes = (info, make) => {
    const turn = ++published;
    settling = releasesSince(info, updater.updateInfoAndProvider?.provider).then((releases) => {
      if (turn === published) publish(make(releases));
    });
  };
  const updater =
    process.platform === 'win32'
      ? new NsisUpdater()
      : process.platform === 'darwin'
        ? new MacBundleUpdater()
        : null;
  const installs = process.platform === 'win32' || !!macBundle();
  if (updater) {
    updater.autoDownload = installs;
    updater.autoInstallOnAppQuit = true;
    if (process.env.FOLIO_UPDATE_URL) {
      updater.forceDevUpdateConfig = !app.isPackaged;
      updater.setFeedURL({ provider: 'generic', url: process.env.FOLIO_UPDATE_URL });
    }
    updater.on('update-available', (info) => {
      if (state.status === 'ready' && state.version === info.version) return;
      if (installs) publish({ status: 'downloading', version: info.version });
      else
        withNotes(info, (releases) => ({
          status: 'manual',
          version: info.version,
          releases,
          url: downloadPage,
        }));
    });
    updater.on('update-downloaded', (info) =>
      withNotes(info, (releases) => ({ status: 'ready', version: info.version, releases })),
    );
    // Offline or a failed download: stay quiet and try again at the next check.
    updater.on('error', () => {
      if (state.status === 'downloading') publish({ status: 'idle' });
    });
  }

  // Resolves to the state after checking, or { status: 'latest' } when this is the newest version.
  // A downloaded update keeps being checked against the website: a newer release downloads in
  // its place, and the same one isn't downloaded again.
  async function check() {
    if (!updater) throw Error('这个系统不支持自动更新');
    if (state.status === 'manual') return state;
    const ready = state.status === 'ready' ? state.version : null;
    updater.autoDownload = installs && !ready;
    let result;
    try {
      result = await updater.checkForUpdates();
    } catch (e) {
      throw Error(`检查更新失败，请检查网络后重试（${e.code || e.message}）`);
    } finally {
      updater.autoDownload = installs;
    }
    if (!result) throw Error('开发版本不检查更新');
    await settling;
    if (ready && result.isUpdateAvailable && result.updateInfo.version !== ready)
      result.downloadPromise = updater.downloadUpdate();
    result.downloadPromise?.catch(() => {});
    return result.isUpdateAvailable ? state : { status: 'latest', version: app.getVersion() };
  }
  function start() {
    if (!updater || (!app.isPackaged && !process.env.FOLIO_UPDATE_URL)) return;
    const quietly = () => check().catch(() => {});
    setTimeout(quietly, 5000);
    setInterval(quietly, checkEvery);
  }
  // Called once the window has saved everything; the quit that follows installs and reopens.
  function restartToUpdate() {
    restart = true;
    app.quit();
  }
  app.on('will-quit', () => {
    if (restart && state.status === 'ready') updater?.install(true, true);
  });
  return {
    start,
    check,
    restartToUpdate,
    state: () => state,
    downloadPage,
  };
}

module.exports = { createUpdates };
