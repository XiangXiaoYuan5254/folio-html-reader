const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('folio', {
  invoke: (action, payload = {}, token) =>
    ipcRenderer.invoke('folio:invoke', action, payload, token),
  importFiles: (files, destination, token) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke('folio:invoke', 'import-files', { paths, destination }, token);
  },
  subscribe: (callback) => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on('folio:event', listener);
    return () => ipcRenderer.removeListener('folio:event', listener);
  },
  platform: process.platform,
});
