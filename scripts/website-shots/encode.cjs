// 截图脚本用的空白窗口：在 Chromium 里裁剪、缩放、编码 WebP，并渲染分享图。
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1200, height: 630, useContentSize: true, resizable: false });
  w.loadURL('data:text/html,<title>encode</title>');
});
