// O que o site do UzeCall pode usar quando está aberto dentro do app de Windows.
const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("app:info");

contextBridge.exposeInMainWorld("uzDesktop", {
  version: info.version,
  platform: info.platform,
  // a tecla de apertar para falar funciona mesmo com o jogo na frente
  globalPtt: info.globalPtt,
  setPtt: (code) => ipcRenderer.send("ptt:set", typeof code === "string" ? code : null),
  onPtt: (callback) => {
    const handler = (_e, down) => callback(!!down);
    ipcRenderer.on("ptt", handler);
    return () => ipcRenderer.removeListener("ptt", handler);
  },
});
