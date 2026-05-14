const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("discordPostTool", {
  getDefaults: () => ipcRenderer.invoke("app:get-defaults"),
  getGuildInfo: (request) => ipcRenderer.invoke("discord:get-guild-info", request),
  chooseFolder: (currentPath) => ipcRenderer.invoke("dialog:choose-folder", currentPath),
  startJob: (request) => ipcRenderer.invoke("job:start", request),
  stopJob: () => ipcRenderer.invoke("job:stop"),
  onJobEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("job:event", listener);
    return () => ipcRenderer.removeListener("job:event", listener);
  },
});
