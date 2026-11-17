// Pop-out por cima do jogo: só recebe quem está na call (não tem acesso a mais nada).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uzOverlay", {
  onState: (callback) => {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on("overlay:state", handler);
    return () => ipcRenderer.removeListener("overlay:state", handler);
  },
});
