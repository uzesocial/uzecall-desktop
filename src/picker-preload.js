const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("picker", {
  sources: () => ipcRenderer.invoke("picker:sources"),
  choose: (id, audio) => ipcRenderer.send("picker:choose", id ? { id, audio: !!audio } : null),
});
