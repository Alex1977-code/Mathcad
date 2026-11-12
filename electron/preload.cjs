/** Bridge between the desktop program and the app: files opened by double click. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('formelwerkDesktop', {
  /** File the program was started with (once), or null. */
  takeOpenFile: () => ipcRenderer.invoke('take-open-file'),
  /** Files opened while the program is running. */
  onOpenFile: (cb) => { ipcRenderer.on('open-file', (_e, doc) => cb(doc)); },
});
