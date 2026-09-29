const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("peakcadDesktop", true);

let saveBeforeCloseHandler = null;
let saveBeforeCloseToken = 0;

// Main always gets exactly one reply per request, so a window-close Save never waits forever.
ipcRenderer.on("peakcad:save-before-close", (_event, requestId) => {
  const handler = saveBeforeCloseHandler;
  const reply = (ok) => ipcRenderer.send("peakcad:save-before-close-result", requestId, ok === true);
  Promise.resolve()
    .then(() => (handler ? handler() : false))
    .then(reply, () => reply(false));
});

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
  onSaveBeforeClose: (handler) => {
    saveBeforeCloseToken += 1;
    const token = saveBeforeCloseToken;
    saveBeforeCloseHandler = handler;
    return () => {
      if (saveBeforeCloseToken === token) saveBeforeCloseHandler = null;
    };
  },
});
