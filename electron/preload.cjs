const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('folio', {
  invoke: (action, payload = {}, token) =>
    ipcRenderer.invoke('folio:invoke', action, payload, token),
  subscribe: (callback) => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on('folio:event', listener);
    return () => ipcRenderer.removeListener('folio:event', listener);
  },
  platform: process.platform,
});
