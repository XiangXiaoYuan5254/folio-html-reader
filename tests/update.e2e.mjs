// End-to-end test of automatic updates. Packages 页间 as version 0.0.1 and 0.0.2, serves 0.0.2's
// update files from a local server, and lets an installed 0.0.1 update itself: on a normal quit
// (installs quietly) and with “立即重启” (installs and reopens). Then 0.0.2 finds nothing newer.
// On macOS a copy in a folder it cannot write to must link to the website instead. Runs on macOS
// and on Windows (.github/workflows/windows.yml); screenshots and the log go to FOLIO_EVIDENCE.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const mac = process.platform === 'darwin';
if (!mac && process.platform !== 'win32') {
  console.log('SKIP: macOS and Windows only');
  process.exit(0);
}
const run = promisify(execFile);
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-update-')));
const evidence = process.env.FOLIO_EVIDENCE || path.join(temp, 'evidence');
await fs.mkdir(evidence, { recursive: true });
const powershell = (script) =>
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]);
const quote = (s) => `'${s.replaceAll("'", "''")}'`;

// The same targets as a release; a macOS `dir` build would leave out the app's app-update.yml.
const pack = (version) =>
  run(
    process.execPath,
    [
      path.resolve('node_modules/electron-builder/cli.js'),
      ...(mac ? ['--mac', 'zip', '--arm64'] : ['--win', 'nsis', '--x64']),
      '--publish',
      'never',
      `-c.extraMetadata.version=${version}`,
      `-c.directories.output=${path.join(temp, version)}`,
    ],
    { maxBuffer: 1 << 26 },
  );
console.log('Packaging 0.0.1 and 0.0.2…');
await pack('0.0.1');
await pack('0.0.2');
const update = mac ? 'Folio-0.0.2-mac-arm64.zip' : 'Folio-0.0.2-win-x64-setup.exe';

const requests = [];
const server = http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent(new URL(req.url, 'http://local').pathname));
  requests.push(name);
  const file = path.join(temp, '0.0.2', name);
  fs.stat(file).then(
    (stat) => {
      res.writeHead(200, { 'Content-Length': stat.size });
      createReadStream(file).pipe(res);
    },
    () => res.writeHead(404).end(),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${server.address().port}/`;

// Installs 0.0.1: into a folder of the test on macOS, with its installer on Windows.
const applications = path.join(temp, 'Applications');
const bundle = path.join(applications, '页间.app');
let executable = path.join(bundle, 'Contents/MacOS/页间');
async function install() {
  if (mac) {
    await fs.rm(bundle, { recursive: true, force: true });
    await fs.mkdir(applications, { recursive: true });
    await run('ditto', [path.join(temp, '0.0.1/mac-arm64/页间.app'), bundle]);
    return;
  }
  await run(path.join(temp, '0.0.1/Folio-0.0.1-win-x64-setup.exe'), ['/S']);
  const programs = path.join(process.env.LOCALAPPDATA, 'Programs');
  for (const dir of await fs.readdir(programs)) {
    const exe = path.join(programs, dir, 'Folio.exe');
    if (await fs.stat(exe).catch(() => null)) executable = exe;
  }
}
async function installedVersion() {
  try {
    if (mac) {
      const plist = path.join(bundle, 'Contents/Info.plist');
      const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', plist]);
      return JSON.parse(stdout).CFBundleShortVersionString;
    }
    // Windows file versions have four parts: 0.0.1 is 0.0.1.0.
    const script = `(Get-Item -LiteralPath ${quote(executable)}).VersionInfo.ProductVersion`;
    return (await powershell(script)).stdout.trim().replace(/^(\d+\.\d+\.\d+)\.0$/, '$1');
  } catch {
    return '';
  }
}
// Process ids of 页间 at the installed location, not counting its helper processes.
async function running() {
  try {
    const { stdout } = mac
      ? await run('pgrep', ['-f', '-x', executable])
      : await powershell(
          `Get-CimInstance Win32_Process -Filter "Name='Folio.exe'" | Where-Object { $_.ExecutablePath -eq ${quote(executable)} -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }`,
        );
    return stdout.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}
async function waitFor(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error('Timeout: ' + label);
}

// `open` hands 页间's environment to the reopened app on macOS but garbles non-ASCII values,
// so this path, which the reopened app gets as FOLIO_WORKSPACE, stays ASCII.
const project = path.join(temp, 'project');
await fs.mkdir(project);
await fs.writeFile(
  path.join(project, '首页.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>首页</title></head><body><h1>首页</h1></body></html>',
);
const userData = path.join(temp, 'user data');
const settings = path.join(userData, 'settings.json');
let app, win;
const errors = [];
// The main process's output, including electron-updater's log, saved for when a step fails.
const log = [];
async function launch() {
  app = await electron.launch({
    executablePath: executable,
    args: mac ? ['--use-mock-keychain'] : [],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      // electron-updater keeps downloads in ~/Library/Caches; keep the test's apart.
      ...(mac ? { HOME: path.join(temp, 'home') } : {}),
      FOLIO_USER_DATA: userData,
      FOLIO_WORKSPACE: project,
      FOLIO_UPDATE_URL: feed,
    },
  });
  for (const stream of [app.process().stdout, app.process().stderr])
    stream.on('data', (chunk) => log.push(chunk.toString()));
  win = await app.firstWindow();
  win.setDefaultTimeout(120000);
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.document-frame, .welcome');
}
const exited = () =>
  new Promise((resolve) =>
    app.process().exitCode !== null ? resolve() : app.process().once('exit', resolve),
  );
async function quit() {
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited();
}
const card = () => win.locator('.update-card');
let passed = false;

try {
  await install();
  assert.equal(await installedVersion(), '0.0.1');

  if (mac) {
    // A copy in a folder it cannot write to points to the website and downloads nothing.
    await fs.chmod(applications, 0o555);
    await launch();
    await card().getByText('页间 0.0.2 已发布').waitFor();
    await card().getByRole('button', { name: '去官网下载' }).waitFor();
    assert.ok(!requests.includes(update), 'nothing downloaded');
    await win.screenshot({ path: path.join(evidence, 'update-manual.png') });
    await quit();
    await fs.chmod(applications, 0o755);
    assert.equal(await installedVersion(), '0.0.1');
    console.log('PASS: a copy that cannot be replaced links to the website');
  }

  // Downloads in the background, then installs on a normal quit without reopening.
  await launch();
  await card().getByText('页间 0.0.2 已准备好').waitFor();
  const notes = await card().locator('li').allInnerTexts();
  assert.ok(notes.length >= 1 && notes[0].includes('后台下载'), `release notes: ${notes}`);
  assert.ok(requests.includes(update), 'update downloaded');
  await win.screenshot({ path: path.join(evidence, 'update-ready.png') });
  await card().getByRole('button', { name: '稍后', exact: true }).click();
  await card().waitFor({ state: 'detached' });
  const chip = win.locator('.update-chip');
  assert.equal((await chip.innerText()).trim(), '重启以更新 0.0.2');
  await win.screenshot({ path: path.join(evidence, 'update-later.png') });
  await chip.click();
  await card().getByText('页间 0.0.2 已准备好').waitFor();
  await quit();
  await waitFor(async () => (await installedVersion()) === '0.0.2', 'installed on quit', 120000);
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual(await running(), [], 'not reopened after a normal quit');
  console.log('PASS: the update installs when 页间 quits');

  // “立即重启” installs and reopens.
  await install();
  assert.equal(await installedVersion(), '0.0.1');
  await launch();
  await card().getByText('页间 0.0.2 已准备好').waitFor();
  const before = (await fs.stat(settings)).mtimeMs;
  await card().getByRole('button', { name: '立即重启' }).click();
  await exited();
  await waitFor(async () => (await installedVersion()) === '0.0.2', 'installed', 120000);
  await waitFor(async () => (await running()).length === 1, 'reopened', 60000);
  if (mac) {
    // `open` passes on the environment, so the reopened app keeps the test's user data. The
    // Windows installer reopens 页间 through Explorer, which does not.
    await waitFor(
      async () => (await fs.stat(settings)).mtimeMs > before,
      'reopened app uses the same user data',
    );
    const staged = path.join(temp, 'home/Library/Caches/folio-html-reader-updater/staged');
    assert.deepEqual(await fs.readdir(staged), [], 'nothing left next to the staged update');
  }
  console.log('PASS: 立即重启 installs the update and reopens 页间');
  for (const pid of await running()) process.kill(Number(pid), 'SIGKILL');
  await waitFor(async () => (await running()).length === 0, 'reopened app closed');

  // The installed 0.0.2 is the newest; clicking the name in the title bar says so.
  await launch();
  await win.locator('button.brand').click();
  await win.locator('.toast').getByText('页间 0.0.2 已是最新版本').waitFor();
  assert.equal(await card().count(), 0);
  await quit();
  console.log('PASS: checking by hand reports the newest version');
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  for (const pid of await running()) process.kill(Number(pid), 'SIGKILL');
  await app?.close().catch(() => {});
  if (mac) await fs.chmod(applications, 0o755).catch(() => {});
  else {
    const dir = path.dirname(executable);
    const uninstaller = (await fs.readdir(dir).catch(() => [])).find((name) =>
      /^Uninstall.*\.exe$/.test(name),
    );
    if (uninstaller) await run(path.join(dir, uninstaller), ['/S']).catch(() => {});
  }
  server.close();
  await fs.writeFile(path.join(evidence, 'update-main.log'), log.join(''));
  console.log(`Screenshots and log: ${evidence}`);
  // The two packaged versions take about 1 GB; they are kept only to look into a failure.
  if (passed)
    for (const dir of ['0.0.1', '0.0.2', 'Applications', 'home'])
      await fs.rm(path.join(temp, dir), { recursive: true, force: true });
}
