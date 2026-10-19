const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('panelsApi', {
  startTerminal: (opts) => ipcRenderer.invoke('pty:start', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  onData: (fn) => ipcRenderer.on('pty:data', (_e, id, data) => fn(id, data)),
  onExit: (fn) => ipcRenderer.on('pty:exit', (_e, id, code) => fn(id, code)),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (changes) => ipcRenderer.invoke('settings:set', changes),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  folderExists: (dir) => ipcRenderer.invoke('folder:exists', dir),
  openFile: (target) => ipcRenderer.invoke('file:open', target),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  sessionActivity: (ids) => ipcRenderer.invoke('sessions:activity', ids),
  sessionMentions: (ids) => ipcRenderer.invoke('sessions:mentions', ids),
  pickFiles: (fallbackDir) => ipcRenderer.invoke('file:pick', fallbackDir),
  pathForFile: (file) => webUtils.getPathForFile(file),
  isDir: (p) => ipcRenderer.invoke('path:isDir', p),
  makeTitle: (opts) => ipcRenderer.invoke('title:make', opts),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  runUpdate: (workspace, tag) => ipcRenderer.invoke('update:run', workspace, tag),
  onUpdateAvailable: (fn) => ipcRenderer.on('update:available', (_e, info) => fn(info)),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, text) => fn(text)),

  onMenu: (name, fn) => ipcRenderer.on(`menu:${name}`, fn),
});
