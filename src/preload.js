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
  // jogo aberto no PC agora ("Jogando CS2" para os amigos)
  game: {
    current: () => ipcRenderer.sendSync("game:get"),
    onChange: (callback) => {
      const handler = (_e, game) => callback(typeof game === "string" ? game : null);
      ipcRenderer.on("game", handler);
      return () => ipcRenderer.removeListener("game", handler);
    },
  },
  // clipe dos últimos segundos: tecla com o jogo na frente e salvar em Vídeos > UzeCall Clipes
  clips: {
    setKey: (code) => ipcRenderer.send("clip:set", typeof code === "string" ? code : null),
    onKey: (callback) => {
      const handler = () => callback();
      ipcRenderer.on("clip:key", handler);
      return () => ipcRenderer.removeListener("clip:key", handler);
    },
    save: (data, ext) => ipcRenderer.invoke("clip:save", data, ext),
    show: (file) => ipcRenderer.send("clip:show", file),
  },
  // aviso do Windows clicado: traz o UzeCall para a frente
  focus: () => ipcRenderer.send("win:focus"),
  // pop-out por cima do jogo: quem está na call e quem está falando
  overlay: {
    set: (state) => ipcRenderer.send("overlay:state", state && typeof state === "object" ? state : null),
    prefs: () => ipcRenderer.sendSync("overlay:prefs:get"),
    setPrefs: (prefs) => ipcRenderer.send("overlay:prefs:set", prefs),
    onPrefs: (callback) => {
      const handler = (_e, prefs) => callback(prefs);
      ipcRenderer.on("overlay:prefs", handler);
      return () => ipcRenderer.removeListener("overlay:prefs", handler);
    },
  },
});
