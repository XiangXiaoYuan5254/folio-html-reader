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
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { Workspace, atomicWrite } = require('./workspace.cjs');
const { renderDocument, mime } = require('./render.cjs');
const { renderPDFDocument, pdfAssetPath } = require('./pdf.cjs');
const workspace = new Workspace();
let win;
let allowClose = false;
let quitting = false;
let watcher;
let refreshTimer;
let focusWindowState = null;
const previews = new Map();
if (process.env.FOLIO_USER_DATA) app.setPath('userData', process.env.FOLIO_USER_DATA);
app.setName('页间');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'folio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
async function openWorkspace(root) {
  const result = await workspace.open(root);
  previews.clear();
  await atomicWrite(settingsFile(), JSON.stringify({ root }));
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
function uiSender(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame)
    throw Error('不允许的请求来源');
  const url = event.senderFrame.url;
  if (
    process.env.FOLIO_DEV_URL
      ? !url.startsWith(process.env.FOLIO_DEV_URL + '/') && url !== process.env.FOLIO_DEV_URL
      : !url.startsWith('app://ui/')
  )
    throw Error('不允许的应用页面');
}
function menu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '页间',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '文件',
        submenu: [
          {
            label: '打开文件夹…',
            accelerator: 'CmdOrCtrl+O',
            click: () => win.webContents.send('folio:event', { type: 'open-folder' }),
          },
          {
            label: '保存文档',
            accelerator: 'CmdOrCtrl+S',
            click: () => win.webContents.send('folio:event', { type: 'save' }),
          },
          { type: 'separator' },
          { role: 'close' },
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
          { role: 'paste' },
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
            label: '切换专注阅读',
            accelerator: 'CmdOrCtrl+Shift+F',
            click: () => win.webContents.send('folio:event', { type: 'toggle-focus' }),
          },
          { role: 'togglefullscreen' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
        ],
      },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
    ]),
  );
}
app.on('before-quit', () => {
  quitting = true;
});
app
  .whenReady()
  .then(async () => {
    await initialWorkspace();
    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
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
          source = await fs.readFile(await workspace.asset(relative), 'utf8');
        } else return new Response('', { status: 404 });
        const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/') + 1) : '';
        const base = `folio://asset/${workspace.token}/${dir.split('/').map(encodeURIComponent).join('/')}`;
        const runtime = await fs.readFile(path.join(__dirname, '../dist/reader.js'), 'utf8');
        return new Response(renderDocument(source, base, runtime), {
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
    session.defaultSession.setPermissionRequestHandler((_, __, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle('folio:invoke', async (event, action, payload, token) => {
      uiSender(event);
      if (
        !['workspace', 'choose-folder', 'close', 'minimize', 'maximize', 'focus-mode'].includes(
          action,
        ) &&
        token !== workspace.token
      )
        throw Error('项目已切换，请重新打开文件');
      switch (action) {
        case 'workspace':
          return workspace.summary();
        case 'choose-folder': {
          const r = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            title: '打开阅读项目（HTML / PDF）',
          });
          return r.canceled ? null : openWorkspace(r.filePaths[0]);
        }
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
        case 'create':
          return workspace.create(payload);
        case 'move':
          return workspace.move(payload);
        case 'trash':
          return workspace.trash(payload, (file) => shell.trashItem(file));
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
        backgroundColor: '#f7f8fa',
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 18, y: 17 },
        webPreferences: {
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
    createWindow();
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
