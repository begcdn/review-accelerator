const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("reviewAccelerator", {
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings) => ipcRenderer.invoke("settings:testConnection", settings),
  runReview: (projectPath) => ipcRenderer.invoke("review:run", projectPath),
  readEvidence: (payload) => ipcRenderer.invoke("evidence:read", payload),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("review:progress", listener);
    return () => ipcRenderer.removeListener("review:progress", listener);
  }
});
