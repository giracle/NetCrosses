import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('appMeta', {
  platform: process.platform,
});

contextBridge.exposeInMainWorld('netcrosses', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  importToml: () => ipcRenderer.invoke('config:importToml'),
  exportToml: () => ipcRenderer.invoke('config:exportToml'),
  startClient: () => ipcRenderer.invoke('client:start'),
  stopClient: () => ipcRenderer.invoke('client:stop'),
  quickTest: () => ipcRenderer.invoke('client:quickTest'),
  deepTest: () => ipcRenderer.invoke('client:deepTest'),
  getStatus: () => ipcRenderer.invoke('client:status'),
  getLogs: () => ipcRenderer.invoke('client:logs'),
  onLog: (callback: (entry: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: unknown): void => {
      callback(entry);
    };
    ipcRenderer.on('client:log', handler);
    return () => ipcRenderer.off('client:log', handler);
  },
  onStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown): void => {
      callback(status);
    };
    ipcRenderer.on('client:status', handler);
    return () => ipcRenderer.off('client:status', handler);
  },
});
