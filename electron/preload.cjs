const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("peakcadDesktop", true);

contextBridge.exposeInMainWorld("peakcadFile", {
  isDesktop: true,
  defaultDir: () => ipcRenderer.invoke("peakcad:file-default-dir"),
  open: () => ipcRenderer.invoke("peakcad:file-open"),
  read: (filePath) => ipcRenderer.invoke("peakcad:file-read", filePath),
  write: (payload) => ipcRenderer.invoke("peakcad:file-write", payload),
  saveAs: (payload) => ipcRenderer.invoke("peakcad:file-save-as", payload),
  writeNew: (payload) => ipcRenderer.invoke("peakcad:file-write-new", payload),
  resolveName: (defaultName) => ipcRenderer.invoke("peakcad:file-resolve-name", defaultName),
  reveal: (filePath) => ipcRenderer.invoke("peakcad:file-reveal", filePath),
  onOpenPath: (listener) => {
    const wrapped = (_event, filePath) => listener(filePath);
    ipcRenderer.on("peakcad:open-path", wrapped);
    return () => ipcRenderer.removeListener("peakcad:open-path", wrapped);
  },
  onMenu: (listener) => {
    const wrapped = (_event, action) => listener(action);
    ipcRenderer.on("peakcad:menu", wrapped);
    return () => ipcRenderer.removeListener("peakcad:menu", wrapped);
  },
});
