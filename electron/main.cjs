const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  session,
  Menu,
  shell,
  clipboard,
  safeStorage,
  systemPreferences,
  utilityProcess,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { Workspace, atomicWrite } = require('./workspace.cjs');
const { renderDocument, markSourceOffsets, mime } = require('./render.cjs');
const { renderPDFDocument, pdfAssetPath } = require('./pdf.cjs');
const { projectFor, filesFromArgv } = require('./open-file.cjs');
const { isImage, isMarkdown, renderImagePage, renderMarkdownPage } = require('./formats.cjs');
const { createUpdates } = require('./updater.cjs');
const { createAi } = require('./ai.cjs');
const { createAnnouncements } = require('./announcements.cjs');
const { createCommunity } = require('./community.cjs');
const { createUsage } = require('./usage.cjs');
const { createFonts, familiesThatShow } = require('./fonts.cjs');
const { createSpeech } = require('./speech.cjs');
const { createSpeechLog } = require('./speech-log.cjs');
const { createAiLog } = require('./ai-log.cjs');
const { createHearing } = require('./hearing.cjs');
const { limiter } = require('./cloud-voice.cjs');
const papers = require('./papers.cjs');
const { createPlugins } = require('./plugins.cjs');
const isMac = process.platform === 'darwin';
const workspace = new Workspace();
let win;
let allowClose = false;
let quitting = false;
let watcher;
let refreshTimer;
let focusWindowState = null;
let appearance = null;
// The interface's size (src/ui-type.ts): the window's zoom.
const uiZooms = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
let uiZoom = 1;
// The installed fonts' names, read when the font list opens.
let installedFonts;
const previews = new Map();
let ai;
let announcements;
let community;
let usage;
let plugins;
// The teacher's sentences said by a speech service, two at a time.
const voiceQueue = limiter(2);
let speechLog;
let voiceHushes = 0;
const toWindow = (event) => {
  if (win && !win.isDestroyed()) win.webContents.send('folio:event', event);
};
const speech = createSpeech({ app, systemPreferences, send: toWindow });
// Where the helper isn't there, the window's microphone is listened to here.
const hearing = createHearing({
  app,
  utilityProcess,
  fetch: (url, init) => net.fetch(url, init),
  speechKey: (service) => ai.hearingKey(service),
  send: toWindow,
});
if (process.env.FOLIO_USER_DATA) app.setPath('userData', process.env.FOLIO_USER_DATA);
app.setName('页间');
// Matches the Start menu shortcut the Windows installer creates, for taskbar grouping.
if (process.platform === 'win32') app.setAppUserModelId('com.folio.htmlreader');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
const updates = createUpdates((update) => {
  if (win && !win.isDestroyed()) win.webContents.send('folio:event', { type: 'update', update });
});
// Files opened from Finder or Explorer ("Open With", double-click, Dock drop). They can
// arrive before the app is ready, so they queue until the renderer asks for them.
const pendingFiles = isMac ? [] : filesFromArgv(process.argv, process.cwd());
let createMainWindow = null;
function openFiles(files) {
  pendingFiles.push(...files);
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) createMainWindow?.();
  else {
    win.webContents.send('folio:event', { type: 'open-file' });
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}
app.on('open-file', (event, file) => {
  event.preventDefault();
  openFiles([file]);
});
// On Windows, opening a file while the app runs starts a second instance with the file
// in its arguments; it quits at once and the file is handed over here.
app.on('second-instance', (_, argv, workingDirectory) => {
  const files = isMac ? [] : filesFromArgv(argv, workingDirectory);
  if (files.length) openFiles(files);
  else if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
async function knownRoots() {
  const settings = await readSettings();
  return [settings.root, ...(Array.isArray(settings.recentRoots) ? settings.recentRoots : [])];
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'folio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
async function readSettings() {
  try {
    const value = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
// The window's own colors follow the page's theme, so starting up shows no flash of another theme.
function appearanceColors(value) {
  const hex = (color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);
  return value && hex(value.window) && hex(value.titlebar) && hex(value.symbol)
    ? { window: value.window, titlebar: value.titlebar, symbol: value.symbol }
    : null;
}
async function rememberAppearance(colors) {
  const settings = await readSettings();
  if (JSON.stringify(settings.appearance) === JSON.stringify(colors)) return;
  await atomicWrite(settingsFile(), JSON.stringify({ ...settings, appearance: colors }));
}
async function rememberUiZoom(zoom) {
  const settings = await readSettings();
  if (settings.uiZoom === zoom) return;
  await atomicWrite(settingsFile(), JSON.stringify({ ...settings, uiZoom: zoom }));
}
// The page's title bar grows with the zoom; the window's own buttons stay centred in it.
const buttonsTop = () => Math.round(24 * uiZoom - 7);
const overlayHeight = () => Math.round(47 * uiZoom);
function applyUiZoom() {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomFactor(uiZoom);
  if (isMac) win.setWindowButtonPosition?.({ x: 18, y: buttonsTop() });
  else
    win.setTitleBarOverlay({
      color: appearance?.titlebar || '#ffffff',
      symbolColor: appearance?.symbol || '#5f6b77',
      height: overlayHeight(),
    });
}
async function rememberWorkspace(root) {
  const settings = await readSettings();
  const recent = [root, ...(Array.isArray(settings.recentRoots) ? settings.recentRoots : [])]
    .filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index)
    .slice(0, 5);
  await atomicWrite(settingsFile(), JSON.stringify({ ...settings, root, recentRoots: recent }));
}
async function openWorkspace(root) {
  const result = await workspace.open(root);
  previews.clear();
  await rememberWorkspace(root);
  watcher?.close();
  try {
    watcher = require('node:fs').watch(root, { recursive: true }, (_, filename) => {
      if (
        !filename ||
        filename
          .split(path.sep)
          .some((p) => p.startsWith('.') || ['node_modules', 'dist', 'release'].includes(p))
      )
        return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!win?.isDestroyed()) win.webContents.send('folio:event', { type: 'files-changed' });
      }, 350);
    });
  } catch {}
  return result;
}
async function initialWorkspace() {
  if (process.env.FOLIO_WORKSPACE) return openWorkspace(process.env.FOLIO_WORKSPACE);
  // Launched by opening a file: start in that file's project.
  if (pendingFiles.length) {
    const target = await projectFor(pendingFiles[0], null, await knownRoots()).catch(() => null);
    if (target) return openWorkspace(target.root);
  }
  try {
    const s = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    return await openWorkspace(s.root);
  } catch {}
  if (!app.isPackaged) return openWorkspace(path.join(__dirname, '../samples'));
  const sample = path.join(app.getPath('userData'), '示例文档');
  await fs.mkdir(sample, { recursive: true });
  await fs.cp(path.join(process.resourcesPath, 'samples'), sample, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  return openWorkspace(sample);
}
const isUiUrl = (url) =>
  process.env.FOLIO_DEV_URL
    ? url.startsWith(process.env.FOLIO_DEV_URL + '/') || url === process.env.FOLIO_DEV_URL
    : url.startsWith('app://ui/');
function uiSender(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame)
    throw Error('不允许的请求来源');
  if (!isUiUrl(event.senderFrame.url)) throw Error('不允许的应用页面');
}
// The whiteboard's voice conversation in a ChatGPT voice hears the student through the
// window's own microphone. Only the app's page may ask, and only for sound.
// FOLIO_SPEECH_INPUT (tests) plays a recording in instead of using the microphone.
async function microphoneAccess() {
  if (process.platform !== 'darwin' || process.env.FOLIO_SPEECH_INPUT) return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (
    status === 'granted' ||
    (status === 'not-determined' && (await systemPreferences.askForMediaAccess('microphone')))
  )
    return true;
  throw Error('没有麦克风权限：请在「系统设置 › 隐私与安全性 › 麦克风」里允许「页间」');
}
function menu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: '页间',
              submenu: [
                { role: 'about' },
                {
                  label: '检查更新…',
                  click: () => win?.webContents.send('folio:event', { type: 'check-updates' }),
                },
                {
                  label: '设置…',
                  click: () => win?.webContents.send('folio:event', { type: 'settings' }),
                },
                {
                  label: 'AI 设置…',
                  accelerator: 'Cmd+,',
                  click: () => win?.webContents.send('folio:event', { type: 'ai-settings' }),
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: '文件',
        submenu: [
          {
            label: '选择项目…',
            accelerator: 'CmdOrCtrl+O',
            click: () => win.webContents.send('folio:event', { type: 'open-folder' }),
          },
          {
            label: '保存文档',
            accelerator: 'CmdOrCtrl+S',
            click: () => win.webContents.send('folio:event', { type: 'save' }),
          },
          ...(isMac
            ? []
            : [
                {
                  label: '设置…',
                  click: () => win.webContents.send('folio:event', { type: 'settings' }),
                },
                {
                  label: 'AI 设置…',
                  accelerator: 'Ctrl+,',
                  click: () => win.webContents.send('folio:event', { type: 'ai-settings' }),
                },
              ]),
          { type: 'separator' },
          // The window menu bar is hidden on Windows; these entries keep the shortcuts working.
          isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          {
            label: '粘贴',
            accelerator: 'CmdOrCtrl+V',
            click: () => win.webContents.send('folio:event', { type: 'paste' }),
          },
          { role: 'selectAll' },
        ],
      },
      {
        label: '显示',
        submenu: [
          {
            label: '查找',
            accelerator: 'CmdOrCtrl+F',
            click: () => win.webContents.send('folio:event', { type: 'find' }),
          },
          {
            label: '界面主题…',
            click: () => win.webContents.send('folio:event', { type: 'theme-picker' }),
          },
          {
            label: '切换专注阅读',
            accelerator: 'CmdOrCtrl+Shift+F',
            click: () => win.webContents.send('folio:event', { type: 'toggle-focus' }),
          },
          { role: 'togglefullscreen' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
        ],
      },
      ...(isMac
        ? [{ label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }]
        : []),
    ]),
  );
}
app.on('before-quit', () => {
  quitting = true;
  ai?.shutdown();
  speech.stop();
  hearing.stop();
});
// A plugin's fetch checks every address before going there, so it asks for redirects to be
// handed back (`redirect: 'manual'`). net.fetch can't: it turns down any redirect with
// "Redirect was cancelled". Then net.request, which does report where a redirect goes, asks
// again, and the redirect comes back as a plain 3xx response for the plugin to check.
async function fetchOneHop(url, init) {
  try {
    return await net.fetch(url, init);
  } catch (e) {
    if (!/Redirect was cancelled/i.test(e?.message || '')) throw e;
    const { status, location } = await new Promise((resolve, reject) => {
      const req = net.request({ url, redirect: 'manual', credentials: 'omit' });
      for (const [name, value] of Object.entries(init.headers || {})) req.setHeader(name, value);
      init.signal?.addEventListener('abort', () => req.abort(), { once: true });
      req.on('redirect', (code, _method, next) => {
        req.abort();
        resolve({ status: code, location: next });
      });
      req.on('response', () => reject(e));
      req.on('abort', () => reject(e));
      req.on('error', reject);
      req.end();
    });
    return new Response(null, { status, headers: { location } });
  }
}
// On Windows keys are encrypted with the user's login (DPAPI). macOS keeps them in the app's
// data folder, readable only by this user: with an ad-hoc signed app the Keychain would ask
// for the login password again after every update.
function keyProtection() {
  const encrypted = !isMac && safeStorage.isEncryptionAvailable();
  return {
    protect: (key) =>
      encrypted
        ? 'enc:' + safeStorage.encryptString(key).toString('base64')
        : 'txt:' + Buffer.from(key, 'utf8').toString('base64'),
    unprotect: (value) => {
      if (value.startsWith('enc:'))
        return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      if (value.startsWith('txt:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
      return '';
    },
  };
}
app
  .whenReady()
  .then(async () => {
    // Made before the project's settings are written: settings already there mean 页间 ran here
    // before (electron/usage.cjs).
    usage = createUsage({
      file: path.join(app.getPath('userData'), 'usage.json'),
      earlierFile: settingsFile(),
      // What 0.29 and older kept about the membership.
      memberFile: path.join(app.getPath('userData'), 'license.json'),
      version: app.getVersion(),
      fetch: (url, init) => net.fetch(url, init),
      write: atomicWrite,
      ...(process.env.FOLIO_USAGE_SERVER ? { server: process.env.FOLIO_USAGE_SERVER } : {}),
    });
    await usage.load();
    await initialWorkspace();
    const saved = await readSettings();
    appearance = appearanceColors(saved.appearance);
    if (uiZooms.includes(saved.uiZoom)) uiZoom = saved.uiZoom;
    announcements = createAnnouncements({
      file: path.join(app.getPath('userData'), 'announcements.json'),
      fetch: (url, init) => net.fetch(url, init),
    });
    community = createCommunity({
      fetch: (url, init) => net.fetch(url, init),
      // FOLIO_COMMUNITY_QR: tests run from source read the picture from a stand-in.
      ...(!app.isPackaged && process.env.FOLIO_COMMUNITY_QR
        ? { url: process.env.FOLIO_COMMUNITY_QR }
        : {}),
    });
    speechLog = createSpeechLog(path.join(app.getPath('userData'), 'logs', 'speech.jsonl'));
    ai = createAi({
      file: path.join(app.getPath('userData'), 'ai.json'),
      kimiHome: path.join(app.getPath('userData'), 'kimi-code'),
      fetch: (url, init) => net.fetch(url, init),
      atomicWrite,
      version: app.getVersion(),
      openUrl: (url) => shell.openExternal(url),
      speechLog,
      diagnosticLog: createAiLog(path.join(app.getPath('userData'), 'logs', 'ai.jsonl')),
      ...keyProtection(),
    });
    plugins = createPlugins({
      // Plugins are optional downloads, including in development. Only load user installs.
      userDir: app.getPath('userData'),
      fetch: (url, init) =>
        init?.redirect === 'manual' ? fetchOneHop(url, init) : net.fetch(url, init),
      atomicWrite,
      appVersion: app.getVersion(),
      // FOLIO_DOCUMENTS: tests run from source keep plugin folders out of the real Documents.
      documentsDir: (!app.isPackaged && process.env.FOLIO_DOCUMENTS) || app.getPath('documents'),
      // A plugin loaded from a folder changed: the window reads the list again.
      onChange: () => toWindow({ type: 'plugins-changed' }),
      // FOLIO_PLUGIN_DIRECTORY: tests run from source read the directory from a stand-in.
      ...(!app.isPackaged && process.env.FOLIO_PLUGIN_DIRECTORY
        ? { directoryUrls: [process.env.FOLIO_PLUGIN_DIRECTORY] }
        : {}),
      // FOLIO_OFFICIAL_KEY: tests run from source sign the official plugin list with their own key.
      ...(!app.isPackaged && process.env.FOLIO_OFFICIAL_KEY
        ? { officialKeys: [process.env.FOLIO_OFFICIAL_KEY] }
        : {}),
    });
    void plugins.cleanup();
    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      // A plugin's script, alone in a sandboxed page that can't reach the network itself
      // (electron/plugins.cjs).
      if (url.host === 'plugin') {
        try {
          const id = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '');
          const { html, csp } = await plugins.sandbox(id);
          return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
          });
        } catch (e) {
          return new Response(String(e.message), { status: 403 });
        }
      }
      if (url.host !== 'ui') return new Response('', { status: 404 });
      const rel =
        decodeURIComponent(url.pathname) === '/'
          ? 'index.html'
          : decodeURIComponent(url.pathname).slice(1);
      const file = path.resolve(__dirname, '../dist', rel);
      if (!file.startsWith(path.resolve(__dirname, '../dist') + path.sep))
        return new Response('', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    protocol.handle('folio', async (request) => {
      try {
        const url = new URL(request.url);
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const token = parts.shift();
        if (token !== workspace.token) return new Response('项目已关闭', { status: 403 });
        if (url.host === 'pdfjs') {
          const file = pdfAssetPath(path.join(__dirname, '../dist'), parts.join('/'));
          return new Response(await fs.readFile(file), {
            headers: { 'Content-Type': mime(file), 'Access-Control-Allow-Origin': '*' },
          });
        }
        if (url.host === 'note-image') {
          const file = workspace.noteImagePath(parts.join('/'));
          return new Response(await fs.readFile(file), {
            headers: { 'Content-Type': mime(file) },
          });
        }
        if (url.host === 'asset') {
          const file = await workspace.asset(parts.join('/'));
          return new Response(await fs.readFile(file), {
            headers: { 'Content-Type': mime(file), 'Access-Control-Allow-Origin': '*' },
          });
        }
        let source, relative;
        if (url.host === 'preview') {
          const p = previews.get(parts[0]);
          if (!p) throw Error('预览已过期');
          ({ source, path: relative } = p);
        } else if (url.host === 'document') {
          relative = parts.join('/');
          if (/\.pdf$/i.test(relative)) {
            await workspace.asset(relative);
            const encoded = relative.split('/').map(encodeURIComponent).join('/');
            return new Response(
              renderPDFDocument(
                `folio://asset/${workspace.token}/${encoded}`,
                `folio://pdfjs/${workspace.token}/`,
                path.basename(relative),
              ),
              {
                headers: {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Content-Security-Policy':
                    "default-src 'none'; script-src folio: blob: 'wasm-unsafe-eval'; worker-src blob: folio:; style-src 'unsafe-inline' folio:; img-src data: blob: folio:; font-src data: blob: folio:; connect-src folio:; frame-src 'none'; object-src 'none'; form-action 'none'",
                },
              },
            );
          }
          const file = await workspace.asset(relative);
          // Markdown and pictures become a page of their own, read and annotated like HTML.
          source = isImage(relative)
            ? renderImagePage(relative)
            : isMarkdown(relative)
              ? renderMarkdownPage(await fs.readFile(file, 'utf8'), path.basename(relative))
              : await fs.readFile(file, 'utf8');
        } else return new Response('', { status: 404 });
        const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/') + 1) : '';
        const base = `folio://asset/${workspace.token}/${dir.split('/').map(encodeURIComponent).join('/')}`;
        const runtime = await fs.readFile(path.join(__dirname, '../dist/reader.js'), 'utf8');
        const html =
          url.host !== 'preview'
            ? source
            : isMarkdown(relative)
              ? renderMarkdownPage(source, path.basename(relative), { offsets: true })
              : markSourceOffsets(source);
        return new Response(renderDocument(html, base, runtime), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'unsafe-inline' https: folio:; style-src 'unsafe-inline' https: folio:; img-src data: blob: https: http: folio:; font-src data: https: folio:; connect-src https: folio:; media-src https: folio:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri folio:",
          },
        });
      } catch (e) {
        return new Response(`无法载入文档：${e.message}`, {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, cb, details) =>
      cb(
        contents === win?.webContents &&
          !!details.isMainFrame &&
          isUiUrl(details.requestingUrl || '') &&
          (permission === 'clipboard-sanitized-write' ||
            // The installed fonts, to pick the interface's font from.
            permission === 'local-fonts' ||
            (permission === 'media' &&
              !!details.mediaTypes?.length &&
              details.mediaTypes.every((t) => t === 'audio'))),
      ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _, details) =>
        contents === win?.webContents &&
        isUiUrl(details.requestingUrl || '') &&
        (permission === 'clipboard-sanitized-write' ||
          permission === 'local-fonts' ||
          (permission === 'media' && details.mediaType === 'audio')),
    );
    ipcMain.handle('folio:invoke', async (event, action, payload, token) => {
      uiSender(event);
      if (
        ![
          'workspace',
          'recent-workspaces',
          'choose-folder',
          'close',
          'minimize',
          'maximize',
          'focus-mode',
          'paste-text',
          'update-state',
          'check-updates',
          'update-restart',
          'update-page',
          'ai-config',
          'ai-save-provider',
          'ai-remove-provider',
          'ai-set-active',
          'ai-set-use',
          'ai-prefs',
          'ai-models',
          'ai-balance',
          'ai-test',
          'ai-chat',
          'ai-cancel',
          'ai-codex-status',
          'ai-codex-login',
          'ai-kimi-status',
          'ai-kimi-login',
          'ai-kimi-logout',
          'codex-voice',
          'microphone',
          'appearance',
          'ui-zoom',
          'installed-fonts',
          'speech-voices',
          'speech',
          'speech-listen',
          'speech-stop',
          'hearing',
          'ai-speech-key',
          'ai-paper-key',
          'cloud-voice',
          'cloud-voice-hush',
          'speech-diagnostic',
          'community-qr',
          'plugins',
          'plugin-set',
          'plugin-third-party',
          'plugin-ran',
          'plugin-load',
          'plugin-icon',
          'plugin-inspect',
          'plugin-install',
          'plugin-remove',
          'plugin-fetch',
          'choose-plugin-folder',
          'plugin-folder',
          'plugin-run-save',
          'plugin-pick-local',
          'plugin-log',
          'plugin-directory',
        ].includes(action) &&
        token !== workspace.token
      )
        throw Error('项目已切换，请重新打开文件');
      switch (action) {
        case 'workspace':
          return workspace.summary();
        case 'pending-open': {
          const roots = await knownRoots();
          return Promise.all(
            pendingFiles
              .splice(0)
              .map((file) =>
                projectFor(file, workspace.root, roots).catch((e) => ({ error: e.message })),
              ),
          );
        }
        case 'recent-workspaces': {
          const settings = await readSettings();
          const roots = Array.isArray(settings.recentRoots) ? settings.recentRoots : [];
          const projects = [];
          for (const root of roots) {
            if (typeof root !== 'string' || projects.some((project) => project.root === root))
              continue;
            try {
              const real = await fs.realpath(root);
              if (!(await fs.stat(real)).isDirectory()) continue;
              projects.push({ root: real, name: path.basename(real) || real });
            } catch {}
            if (projects.length >= 5) break;
          }
          return projects;
        }
        case 'choose-folder': {
          const r = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            title: '打开阅读项目（HTML / PDF / Markdown / 图片）',
          });
          return r.canceled ? null : openWorkspace(r.filePaths[0]);
        }
        case 'open-recent-workspace':
          if (typeof payload?.root !== 'string') throw Error('无效的项目路径');
          return openWorkspace(payload.root);
        case 'tree':
          return workspace.summary();
        case 'document':
          return workspace.document(payload.path);
        case 'save-data':
          return workspace.saveData(payload);
        case 'save-session':
          return workspace.saveSession(payload);
        case 'save-source':
          return workspace.saveSource(payload);
        case 'backups':
          return workspace.backups(payload);
        case 'backup':
          return workspace.backup(payload);
        case 'restore-backup':
          return workspace.restoreBackup(payload);
        case 'create':
          return workspace.create(payload);
        // The AI assistant finding papers and saving one into the project.
        case 'papers-search':
          return papers.search(net.fetch, payload, await ai.paperKeys());
        // Saved only once OpenAlex takes it; kept as well when OpenAlex can't be asked now.
        case 'ai-paper-key': {
          const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
          const checked = key ? await papers.checkOpenAlexKey(net.fetch, key) : true;
          if (checked === false)
            throw Error(
              'OpenAlex 不认这个 Key。请检查是否复制完整，以及是否已经点过 OpenAlex 邮件里的确认链接。',
            );
          return { config: await ai.savePaperKey({ key }), checked: checked === true };
        }
        case 'save-pdf': {
          const data = await papers.download(net.fetch, payload?.url);
          return {
            workspace: await workspace.savePdf({ path: payload?.path, data }),
            size: data.length,
          };
        }
        case 'move':
          return workspace.move(payload);
        case 'import-files':
          return workspace.importFiles(payload);
        case 'paste-files': {
          const paths = await require('./file-import.cjs').clipboardPaths(clipboard);
          return workspace.importFiles({ paths, destination: payload.destination });
        }
        case 'paste-text':
          win.webContents.paste();
          return true;
        // A rectangle of the window as the reader sees it (web pages, PDF pages, drawings),
        // for asking the AI about a figure. Coordinates are CSS pixels of the app page.
        case 'capture-region': {
          const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((k) =>
            Math.round(Number(payload?.[k]) || 0),
          );
          if (width < 4 || height < 4) throw Error('框选的区域太小');
          const image = await win.webContents.capturePage({
            x: Math.max(0, x),
            y: Math.max(0, y),
            width,
            height,
          });
          if (image.isEmpty()) throw Error('没有截到画面，请再试一次');
          return 'data:image/png;base64,' + image.toPNG().toString('base64');
        }
        case 'trash':
          return workspace.trash(payload, (file) => shell.trashItem(file));
        case 'storage':
          return workspace.storage();
        case 'clear-backups':
          return workspace.clearBackups(payload);
        case 'clear-unused':
          return workspace.clearUnused();
        case 'preview': {
          const id = require('node:crypto').randomUUID();
          previews.set(id, payload);
          if (previews.size > 30) previews.delete(previews.keys().next().value);
          return `folio://preview/${workspace.token}/${id}`;
        }
        case 'reveal':
          return shell.showItemInFolder(await workspace.resolve(payload.path));
        case 'export': {
          const r = await dialog.showSaveDialog(win, {
            defaultPath: path.basename(payload.path, path.extname(payload.path)) + '-笔记.md',
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          });
          if (r.canceled) return false;
          await atomicWrite(r.filePath, payload.content);
          return true;
        }
        case 'external': {
          const url = new URL(payload.url);
          if (!['http:', 'https:'].includes(url.protocol)) throw Error('只支持网页链接');
          await shell.openExternal(url.toString());
          return true;
        }
        case 'focus-mode': {
          if (payload.enabled === true && !focusWindowState) {
            focusWindowState = { fullscreen: win.isFullScreen() };
            win.setWindowButtonVisibility?.(false);
            win.setFullScreen(true);
          } else if (payload.enabled !== true && focusWindowState) {
            const previous = focusWindowState;
            focusWindowState = null;
            win.setWindowButtonVisibility?.(true);
            if (!previous.fullscreen) win.setFullScreen(false);
          }
          return true;
        }
        case 'minimize':
          win.minimize();
          return true;
        case 'maximize':
          win.isMaximized() ? win.unmaximize() : win.maximize();
          return true;
        case 'close':
          allowClose = true;
          quitting ? app.quit() : win.close();
          return true;
        case 'update-state':
          return { version: app.getVersion(), update: updates.state() };
        case 'check-updates':
          return updates.check();
        // The window has already saved everything, as it does before closing.
        case 'update-restart':
          allowClose = true;
          updates.restartToUpdate();
          return true;
        case 'update-page':
          await shell.openExternal(updates.downloadPage);
          return true;
        case 'announcements':
          return announcements.load(payload || {});
        case 'community-qr':
          return community.qr(payload || {});
        // Plugins (electron/plugins.cjs): what's there, switching them on, installing from a
        // GitHub or Gitee link, and the network a run may reach.
        case 'plugins':
          return plugins.list();
        case 'plugin-set':
          return plugins.set(payload || {});
        case 'plugin-third-party':
          return plugins.setThirdParty(payload || {});
        case 'plugin-ran':
          return plugins.ran(payload || {});
        case 'plugin-load':
          return plugins.load(payload || {});
        case 'plugin-icon':
          return plugins.icon(payload || {});
        case 'plugin-inspect':
          return plugins.inspect(payload || {});
        case 'plugin-install':
          return plugins.install(payload || {});
        case 'plugin-remove':
          return plugins.remove(payload || {});
        case 'plugin-fetch':
          return plugins.fetch(payload || {});
        case 'plugin-folder':
          return plugins.folder(payload || {});
        case 'plugin-run-save':
          return plugins.saveRun(payload || {});
        // A plugin on this computer: a folder being written (loaded where it is) or a .zip.
        case 'plugin-pick-local': {
          const folder = payload?.kind === 'folder';
          const r = await dialog.showOpenDialog(win, {
            title: folder ? '选择插件文件夹（里面有 folio-plugin.json）' : '选择插件压缩包',
            buttonLabel: folder ? '加载' : '安装',
            defaultPath: app.getPath('documents'),
            properties: folder ? ['openDirectory'] : ['openFile'],
            ...(folder ? {} : { filters: [{ name: '插件压缩包', extensions: ['zip'] }] }),
          });
          if (r.canceled || !r.filePaths[0]) return null;
          return plugins.inspect({ local: r.filePaths[0] });
        }
        case 'plugin-log':
          return plugins.log(payload || {});
        case 'plugin-directory':
          return plugins.directory(payload || {});
        // A folder a plugin writes into, picked (or made) in Finder / Explorer: the open
        // project or a folder in it, given relative to it ('.' for the project itself).
        case 'choose-plugin-folder': {
          // A folder plugin's own folder: anywhere on this computer, given as it is.
          if (payload?.anywhere) {
            const current = typeof payload.current === 'string' ? payload.current : '';
            const r = await dialog.showOpenDialog(win, {
              title: typeof payload.title === 'string' ? payload.title.slice(0, 80) : '选择文件夹',
              buttonLabel: '选择',
              defaultPath:
                current && path.isAbsolute(current) && (await fs.stat(current).catch(() => null))
                  ? current
                  : app.getPath('documents'),
              properties: ['openDirectory', 'createDirectory'],
            });
            if (r.canceled || !r.filePaths[0]) return null;
            return fs.realpath(r.filePaths[0]);
          }
          if (typeof payload?.root !== 'string' || !payload.root) throw Error('先打开一个项目');
          const root = await fs.realpath(payload.root).catch(() => {
            throw Error('找不到当前项目的文件夹');
          });
          const current = typeof payload.current === 'string' ? payload.current : '';
          const start = path.resolve(root, current || '.');
          const r = await dialog.showOpenDialog(win, {
            title: typeof payload.title === 'string' ? payload.title.slice(0, 80) : '选择文件夹',
            buttonLabel: '选择',
            defaultPath:
              start.startsWith(root) && (await fs.stat(start).catch(() => null)) ? start : root,
            properties: ['openDirectory', 'createDirectory'],
          });
          if (r.canceled || !r.filePaths[0]) return null;
          const chosen = await fs.realpath(r.filePaths[0]);
          const relative = path.relative(root, chosen);
          if (!relative) return '.';
          if (relative.startsWith('..') || path.isAbsolute(relative))
            throw Error(
              `「${path.basename(chosen)}」不在当前打开的项目「${path.basename(root)}」里。插件只能把文件写进打开的项目；想放到别处，先用「选择项目」把那个文件夹打开。`,
            );
          return relative.split(path.sep).join('/');
        }
        case 'ai-config':
          return ai.config();
        case 'ai-save-provider':
          return ai.saveProvider(payload);
        case 'ai-remove-provider':
          return ai.removeProvider(payload);
        case 'ai-set-active':
          return ai.setActive(payload);
        case 'ai-set-use':
          return ai.setUse(payload);
        case 'ai-prefs':
          return ai.setPrefs(payload);
        case 'ai-models':
          return ai.models(payload);
        case 'ai-balance':
          return ai.balance(payload);
        case 'ai-test':
          return ai.test(payload);
        case 'ai-chat': {
          const sender = event.sender;
          return ai.chat(payload, (delta) => {
            if (!sender.isDestroyed()) sender.send('folio:event', delta);
          });
        }
        case 'ai-cancel':
          return ai.cancel(payload);
        case 'ai-codex-status':
          return ai.codexStatus();
        case 'ai-codex-login':
          return ai.codexLogin();
        case 'ai-kimi-status':
          return ai.kimiStatus();
        case 'ai-kimi-login':
          return ai.kimiLogin();
        case 'ai-kimi-logout':
          return ai.kimiLogout();
        case 'microphone':
          return microphoneAccess();
        case 'codex-voice': {
          const sender = event.sender;
          return ai.codexVoice(payload, (e) => {
            if (!sender.isDestroyed()) sender.send('folio:event', e);
          });
        }
        // The whiteboard teacher's voice; empty where the helper isn't there, and listening
        // to the window's microphone in its place.
        case 'speech-voices':
          return {
            helper: speech.available(),
            hearing: !speech.available() && hearing.available(),
            voices: await speech.voices(),
          };
        case 'speech':
          if (payload?.type === 'hush') voiceHushes++;
          return speech.command(payload);
        case 'ai-speech-key':
          return ai.saveSpeechKey(payload || {});
        // A sentence in a speech service's voice, played by the helper or given to the
        // window. Hushing the teacher drops the sentences not made yet.
        case 'cloud-voice': {
          const at = voiceHushes;
          const sound = await voiceQueue(() =>
            at === voiceHushes ? ai.speak(payload || {}, () => at !== voiceHushes) : null,
          );
          if (!sound || at !== voiceHushes) return null;
          if (payload.to !== 'helper') return { pcm: new Uint8Array(sound.pcm), rate: sound.rate };
          speech.sound(payload.id, sound.pcm, sound.rate);
          // Kept with the board as well, to watch the lesson again.
          return payload.keep ? { pcm: new Uint8Array(sound.pcm), rate: sound.rate } : true;
        }
        case 'cloud-voice-hush':
          voiceHushes++;
          return true;
        case 'speech-diagnostic':
          await speechLog({ ...payload, event: 'client-failed' });
          return true;
        case 'speech-listen':
          return speech.listen(payload);
        case 'speech-stop':
          speech.stop();
          hearing.stop();
          return true;
        case 'hearing':
          if (payload?.type === 'audio') return hearing.audio(payload.pcm);
          if (payload?.type === 'mute') return hearing.mute(payload.on);
          if (payload?.type === 'listen') return hearing.listen(payload);
          throw Error('未知的语音操作');
        case 'appearance': {
          const colors = appearanceColors(payload);
          if (!colors) throw Error('颜色无效');
          appearance = colors;
          if (!isMac) win.setBackgroundColor(colors.window);
          if (!isMac)
            win.setTitleBarOverlay({
              color: colors.titlebar,
              symbolColor: colors.symbol,
              height: overlayHeight(),
            });
          await rememberAppearance(colors);
          return true;
        }
        case 'ui-zoom': {
          const zoom = Number(payload?.zoom);
          if (!uiZooms.includes(zoom)) throw Error('界面大小无效');
          if (zoom !== uiZoom || win.webContents.getZoomFactor() !== zoom) {
            uiZoom = zoom;
            applyUiZoom();
          }
          await rememberUiZoom(zoom);
          return true;
        }
        case 'installed-fonts':
          return (installedFonts ||= createFonts()).forList(payload?.listed, (families) =>
            familiesThatShow(families, BrowserWindow),
          );
        case 'ai-history':
          return workspace.aiHistory(payload);
        case 'ai-pairs':
          return workspace.aiPairs(payload);
        case 'ai-save-history':
          return workspace.saveAiHistory(payload);
        case 'boards':
          return workspace.boards();
        case 'board':
          return workspace.board(payload);
        case 'save-board':
          return workspace.saveBoard(payload);
        case 'delete-board':
          return workspace.deleteBoard(payload);
        case 'board-sound':
          return workspace.boardSound(payload);
        case 'save-board-sound':
          return workspace.saveBoardSound(payload);
        case 'image-data': {
          // A web picture double-clicked in a document; the window only loads local pictures.
          const url = new URL(String(payload?.url));
          if (!/^https?:$/.test(url.protocol)) throw Error('不支持的图片地址');
          const res = await net.fetch(url.href, { credentials: 'omit' });
          const type = res.headers.get('content-type') || '';
          if (!res.ok || !type.startsWith('image/')) throw Error('图片载入失败');
          return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
        }
        case 'save-note-image':
          return workspace.saveNoteImage(payload);
        case 'delete-note-image':
          return workspace.deleteNoteImage(payload);
        default:
          throw Error('未知操作');
      }
    });
    function createWindow() {
      allowClose = false;
      focusWindowState = null;
      win = new BrowserWindow({
        width: 1536,
        height: 1024,
        minWidth: 900,
        minHeight: 620,
        title: '页间 · Folio',
        // On a Mac the window is see-through: the page paints its own colors and lets the
        // system's frosted sidebar material show through the title bar and the file tree.
        backgroundColor: isMac ? '#00000000' : appearance?.window || '#f7f8fa',
        titleBarStyle: 'hidden',
        // The title bar is drawn by the page; Windows keeps its own caption buttons on top of it.
        ...(isMac
          ? { trafficLightPosition: { x: 18, y: buttonsTop() }, vibrancy: 'sidebar' }
          : {
              titleBarOverlay: {
                color: appearance?.titlebar || '#ffffff',
                symbolColor: appearance?.symbol || '#5f6b77',
                height: overlayHeight(),
              },
            }),
        webPreferences: {
          // The interface's size, from the first frame.
          zoomFactor: uiZoom,
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('enter-full-screen', () => {
        if (focusWindowState) win.setWindowButtonVisibility?.(false);
      });
      win.on('leave-full-screen', () => {
        if (focusWindowState) {
          focusWindowState = null;
          win.setWindowButtonVisibility?.(true);
          win.webContents.send('folio:event', { type: 'focus-ended' });
        }
      });
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.on('context-menu', (_, params) => {
        const { editFlags, isEditable, selectionText } = params;
        const items = isEditable
          ? [
              { role: 'cut', label: '剪切', enabled: editFlags.canCut },
              { role: 'copy', label: '拷贝', enabled: editFlags.canCopy },
              { role: 'paste', label: '粘贴', enabled: editFlags.canPaste },
              { type: 'separator' },
              { role: 'selectAll', label: '全选' },
            ]
          : selectionText.trim()
            ? [{ role: 'copy', label: '拷贝' }]
            : [];
        if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
      });
      win.on('close', (e) => {
        if (!allowClose) {
          e.preventDefault();
          win.webContents.send('folio:event', { type: 'close-request' });
        }
      });
      if (process.env.FOLIO_DEV_URL) win.loadURL(process.env.FOLIO_DEV_URL);
      else win.loadURL('app://ui/index.html');
      menu();
    }
    createMainWindow = createWindow;
    createWindow();
    updates.start();
    // Only the installed app reports. Tests and scripts give 页间 a data folder of their own
    // (FOLIO_USER_DATA), so they aren't counted; FOLIO_USAGE_SERVER is for testing this.
    if ((app.isPackaged && !process.env.FOLIO_USER_DATA) || process.env.FOLIO_USAGE_SERVER)
      usage.start();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((e) => {
    dialog.showErrorBox('页间启动失败', e.stack || e.message);
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
