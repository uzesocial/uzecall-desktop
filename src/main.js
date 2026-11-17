// UzeCall para Windows: abre o UzeCall numa janela própria e acrescenta o que o navegador não faz
// (apertar para falar com o jogo na frente, escolher tela para transmitir, bandeja, atualização sozinha).
const { app, BrowserWindow, Tray, Menu, shell, session, desktopCapturer, ipcMain, nativeImage, Notification, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// UZECALL_URL só vale fora do instalador (para testar com o site rodando no próprio PC)
const APP_URL = (!app.isPackaged && process.env.UZECALL_URL) || "https://uzecall.vercel.app";
const START = APP_URL + "/app";
const OUR_HOSTS = new Set([new URL(APP_URL).host]);
const ICON = path.join(__dirname, "..", "assets", "icon.png");
const startHidden = process.argv.includes("--hidden");

let win = null;
let tray = null;
let quitting = false;

// tamanho da tela (zoom): começa em 90% e a pessoa ajusta com Ctrl + / Ctrl - / Ctrl 0
const ZOOM_DEFAULT = 0.9;
const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
let zoom = ZOOM_DEFAULT;

// um UzeCall aberto por vez: abrir de novo só mostra a janela que já existe
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => show());
}

app.setAppUserModelId("com.uzecall.desktop");
// a call continua lisa com a janela minimizada ou atrás do jogo
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const isOurs = (url) => {
  try {
    const u = new URL(url);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return (u.protocol === "https:" || (local && u.protocol === "http:")) && OUR_HOSTS.has(u.host);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ tamanho e posição da janela */

const stateFile = () => path.join(app.getPath("userData"), "janela.json");
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
function saveState() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const b = maximized ? win.getNormalBounds() : win.getBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized, zoom })); } catch { /* sem disco: tudo bem */ }
}

/* ------------------------------------------------------------------ janela principal */

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function applyZoom(next) {
  zoom = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], Math.round(next * 100) / 100));
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom);
  saveState();
}
function stepZoom(dir) {
  const next = dir > 0
    ? ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
    : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_STEPS[0];
  applyZoom(next);
}

function createWindow() {
  const s = loadState();
  if (typeof s.zoom === "number" && s.zoom >= ZOOM_STEPS[0] && s.zoom <= ZOOM_STEPS[ZOOM_STEPS.length - 1]) zoom = s.zoom;
  win = new BrowserWindow({
    width: s.width || 1280,
    height: s.height || 800,
    x: s.x,
    y: s.y,
    minWidth: 940,
    minHeight: 560,
    show: false,
    title: "UzeCall",
    icon: ICON,
    backgroundColor: "#06080C",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  if (s.maximized) win.maximize();

  win.once("ready-to-show", () => { if (!startHidden) win.show(); });
  win.on("close", (e) => {
    saveState();
    // fechar no X deixa o UzeCall rodando perto do relógio (a call não cai)
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("resized", saveState);
  win.on("moved", saveState);
  // olhando para o UzeCall, o pop-out some (ele é para quando o jogo está na frente)
  win.on("focus", applyOverlay);
  win.on("blur", applyOverlay);
  win.on("hide", applyOverlay);
  win.on("show", applyOverlay);

  const wc = win.webContents;
  // links de fora (YouTube, Pix, e-mail) abrem no navegador
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (isOurs(url) || url.startsWith("file:")) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  // sem internet: mostra uma tela com "tentar de novo"
  wc.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3 = navegação cancelada
    win.loadFile(path.join(__dirname, "offline.html"), { query: { voltar: isOurs(url) ? url : START } });
  });
  // aplica o tamanho escolhido assim que a página carrega
  wc.on("dom-ready", () => wc.setZoomFactor(zoom));
  // Ctrl + rodinha do mouse também muda o tamanho
  wc.on("zoom-changed", (_e, direction) => stepZoom(direction === "in" ? 1 : -1));
  // F5 recarrega; Ctrl+Shift+I abre as ferramentas (para suporte); Ctrl +/-/0 muda o tamanho
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.control && (input.key === "=" || input.key === "+")) { stepZoom(1); e.preventDefault(); return; }
    if (input.control && input.key === "-") { stepZoom(-1); e.preventDefault(); return; }
    if (input.control && input.key === "0") { applyZoom(ZOOM_DEFAULT); e.preventDefault(); return; }
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) { wc.reload(); e.preventDefault(); }
    if (input.control && input.shift && input.key.toLowerCase() === "i") { wc.toggleDevTools(); e.preventDefault(); }
  });

  win.loadURL(START);
  return win;
}

/* ------------------------------------------------------------------ permissões (microfone, câmera, notificações) */

function setupPermissions() {
  const ok = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen", "display-capture", "speaker-selection", "audioCapture", "videoCapture"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ok.has(permission) && isOurs(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => ok.has(permission) && isOurs(origin || (wc && wc.getURL()) || ""));

  // compartilhar tela: abre a janelinha para escolher a tela ou a janela (o jogo)
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
      const choice = await pickSource(sources, !!request.audioRequested);
      if (!choice) return callback({});
      const source = sources.find((x) => x.id === choice.id);
      if (!source) return callback({});
      if (process.env.UZ_DEBUG) console.log("[uz] escolhido", choice, source.id);
      callback(choice.audio ? { video: source, audio: "loopback" } : { video: source });
    } catch (err) {
      if (process.env.UZ_DEBUG) console.log("[uz] erro no seletor", err);
      callback({});
    }
  }, { useSystemPicker: false });
}

let picking = null;
function pickSource(sources, wantAudio) {
  if (picking) return Promise.resolve(null);
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win || undefined,
      modal: !!win,
      width: 760,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "Compartilhar tela",
      icon: ICON,
      backgroundColor: "#111622",
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, "picker-preload.js"), contextIsolation: true, sandbox: true },
    });
    picker.setMenu(null);
    picking = picker;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler("picker:sources");
      ipcMain.removeAllListeners("picker:choose");
      picking = null;
      if (!picker.isDestroyed()) picker.close();
      resolve(value);
    };
    ipcMain.handle("picker:sources", () => ({
      wantAudio,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith("screen") ? "tela" : "janela",
        thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      })),
    }));
    ipcMain.on("picker:choose", (_e, value) => finish(value && typeof value.id === "string" ? { id: value.id, audio: !!value.audio } : null));
    picker.on("closed", () => finish(null));
    picker.once("ready-to-show", () => picker.show());
    picker.loadFile(path.join(__dirname, "picker.html"));
  });
}

/* ------------------------------------------------------------------ apertar para falar com o jogo na frente */

// nome da tecla no site (KeyboardEvent.code) -> nome da tecla no gancho do Windows
const SAME = "Backspace Tab Enter CapsLock Escape Space PageUp PageDown End Home ArrowLeft ArrowUp ArrowRight ArrowDown Insert Delete Semicolon Equal Comma Minus Period Slash Backquote BracketLeft Backslash BracketRight Quote NumLock ScrollLock PrintScreen NumpadMultiply NumpadAdd NumpadSubtract NumpadDecimal NumpadDivide NumpadEnter AltRight ShiftRight MetaRight";
function hookKeyFor(code, keys) {
  if (!code) return null;
  let name = null;
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
  else if (/^Digit\d$/.test(code)) name = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) name = code;
  else if (/^Numpad\d$/.test(code)) name = code;
  else if (SAME.split(" ").includes(code)) name = code;
  else name = { ControlLeft: "Ctrl", ControlRight: "CtrlRight", AltLeft: "Alt", ShiftLeft: "Shift", MetaLeft: "Meta" }[code] || null;
  return name && keys[name] !== undefined ? keys[name] : null;
}

const ptt = { hook: null, keys: null, key: null, down: false, running: false };
function sendPtt(down) {
  if (win && !win.isDestroyed()) win.webContents.send("ptt", down);
}
function onKeyDown(e) {
  if (ptt.key !== null && e.keycode === ptt.key && !ptt.down) { ptt.down = true; sendPtt(true); }
}
function onKeyUp(e) {
  if (ptt.key !== null && e.keycode === ptt.key && ptt.down) { ptt.down = false; sendPtt(false); }
}
// só para teste fora do instalador: "down 47" / "up 47" na entrada simula a tecla
if (!app.isPackaged && process.env.UZ_DEBUG) {
  process.stdin.on("data", (buf) => String(buf).split("\n").forEach((line) => {
    const [type, code] = line.trim().split(" ");
    if (type === "down") onKeyDown({ keycode: Number(code) });
    if (type === "up") onKeyUp({ keycode: Number(code) });
  }));
}
function loadHook() {
  if (ptt.hook !== null) return ptt.hook;
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    ptt.keys = UiohookKey;
    uIOhook.on("keydown", onKeyDown);
    uIOhook.on("keyup", onKeyUp);
    ptt.hook = uIOhook;
  } catch {
    ptt.hook = false; // sem o gancho: o site continua usando a tecla com a janela em foco
  }
  return ptt.hook;
}
ipcMain.on("ptt:set", (e, code) => {
  if (!win || e.sender !== win.webContents) return;
  const hook = loadHook();
  if (!hook) return;
  const key = typeof code === "string" ? hookKeyFor(code, ptt.keys) : null;
  if (ptt.down && key !== ptt.key) { ptt.down = false; sendPtt(false); }
  ptt.key = key;
  try {
    if (key !== null && !ptt.running) { hook.start(); ptt.running = true; }
    if (key === null && ptt.running) { hook.stop(); ptt.running = false; }
  } catch { /* segue sem o atalho global */ }
});
ipcMain.on("app:info", (e) => {
  e.returnValue = { version: app.getVersion(), platform: process.platform, globalPtt: !!loadHook() };
});

/* ------------------------------------------------------------------ pop-out por cima do jogo (quem está na call e quem fala) */

const OVERLAY_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const overlayFile = () => path.join(app.getPath("userData"), "popout.json");
let overlayPrefs = { on: false, corner: "top-left" };
try {
  const saved = JSON.parse(fs.readFileSync(overlayFile(), "utf8"));
  overlayPrefs = { on: saved.on === true, corner: OVERLAY_CORNERS.includes(saved.corner) ? saved.corner : "top-left" };
} catch { /* primeira vez: desligado */ }
let overlayWin = null;
let overlayState = null;

function saveOverlayPrefs(next) {
  overlayPrefs = { on: next.on === true, corner: OVERLAY_CORNERS.includes(next.corner) ? next.corner : overlayPrefs.corner };
  try { fs.writeFileSync(overlayFile(), JSON.stringify(overlayPrefs)); } catch { /* sem disco: vale até fechar */ }
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (win && !win.isDestroyed()) win.webContents.send("overlay:prefs", overlayPrefs);
  applyOverlay();
}

/** Só deixa passar o que o pop-out mostra (nome, foto, falando, mudo, surdo). */
function cleanOverlayState(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.people)) return null;
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const people = raw.people.slice(0, 10).map((p) => ({
    name: str(p && p.name, 40) || "Alguém",
    avatar: /^https:\/\//.test(str(p && p.avatar, 600)) ? str(p.avatar, 600) : null,
    speaking: !!(p && p.speaking),
    mudo: !!(p && p.mudo),
    surdo: !!(p && p.surdo),
  }));
  const total = Number.isFinite(raw.total) ? Math.max(people.length, Math.min(999, Math.floor(raw.total))) : people.length;
  return { channel: str(raw.channel, 60), people, more: total - people.length };
}

function overlayBounds(rows, extra) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 270;
  const height = 6 * 2 + 22 + rows * 36 + (extra ? 22 : 0);
  const m = 16;
  const right = overlayPrefs.corner.endsWith("right");
  const bottom = overlayPrefs.corner.startsWith("bottom");
  return { width, height, x: right ? area.x + area.width - width - m : area.x + m, y: bottom ? area.y + area.height - height - m : area.y + m };
}

function applyOverlay() {
  const lookingAtUzeCall = !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  const want = overlayPrefs.on && !!overlayState && overlayState.people.length > 0 && !lookingAtUzeCall;
  if (!want) {
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.hide();
    return;
  }
  if (!overlayWin || overlayWin.isDestroyed()) {
    overlayWin = new BrowserWindow({
      ...overlayBounds(overlayState.people.length, overlayState.more > 0),
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: "#00000000",
      title: "UzeCall: pop-out",
      webPreferences: { preload: path.join(__dirname, "overlay-preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.setIgnoreMouseEvents(true); // o clique passa direto para o jogo
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWin.on("closed", () => { overlayWin = null; });
    overlayWin.webContents.on("did-finish-load", () => applyOverlay());
    overlayWin.loadFile(path.join(__dirname, "overlay.html"));
    return;
  }
  if (overlayWin.webContents.isLoading()) return;
  overlayWin.setBounds(overlayBounds(overlayState.people.length, overlayState.more > 0));
  overlayWin.webContents.send("overlay:state", { ...overlayState, corner: overlayPrefs.corner });
  if (!overlayWin.isVisible()) overlayWin.showInactive(); // aparece sem tirar o foco do jogo
  overlayWin.setAlwaysOnTop(true, "screen-saver");
}

ipcMain.on("overlay:state", (e, raw) => {
  if (!win || e.sender !== win.webContents) return;
  overlayState = cleanOverlayState(raw);
  applyOverlay();
});
ipcMain.on("overlay:prefs:get", (e) => { e.returnValue = overlayPrefs; });
ipcMain.on("overlay:prefs:set", (e, next) => {
  if (!win || e.sender !== win.webContents || !next || typeof next !== "object") return;
  saveOverlayPrefs(next);
});

/* ------------------------------------------------------------------ ícone perto do relógio */

function startsWithWindows() {
  return app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
}
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Abrir UzeCall", click: show },
    { type: "separator" },
    {
      label: "Abrir junto com o Windows",
      type: "checkbox",
      checked: startsWithWindows(),
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
        tray.setContextMenu(buildTrayMenu());
      },
    },
    {
      label: "Pop-out no jogo (quem está na call)",
      type: "checkbox",
      checked: overlayPrefs.on,
      click: (item) => saveOverlayPrefs({ ...overlayPrefs, on: item.checked }),
    },
    { label: "Procurar atualização", click: () => checkUpdates(true) },
    { type: "separator" },
    { label: "Sair do UzeCall", click: () => { quitting = true; app.quit(); } },
  ]);
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("UzeCall");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", show);
}

/* ------------------------------------------------------------------ atualização automática */

let updater = null;
function checkUpdates(manual) {
  if (!app.isPackaged) return;
  try {
    if (!updater) {
      updater = require("electron-updater").autoUpdater;
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.on("update-downloaded", (info) => {
        if (Notification.isSupported()) {
          new Notification({ title: "UzeCall atualizado", body: `A versão ${info.version} entra quando você fechar e abrir o UzeCall.`, icon: ICON }).show();
        }
      });
      updater.on("update-not-available", () => {
        if (manualCheck && Notification.isSupported()) new Notification({ title: "UzeCall", body: "Você já está na versão mais nova.", icon: ICON }).show();
        manualCheck = false;
      });
      updater.on("error", () => { manualCheck = false; });
    }
    manualCheck = !!manual;
    updater.checkForUpdates().catch(() => {});
  } catch { /* sem atualizador: segue normal */ }
}
let manualCheck = false;

/* ------------------------------------------------------------------ início */

app.whenReady().then(() => {
  setupPermissions();
  createWindow();
  createTray();
  checkUpdates(false);
  setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);
});

app.on("before-quit", () => {
  quitting = true;
  saveState();
  try { if (ptt.running && ptt.hook) ptt.hook.stop(); } catch { /* já parado */ }
});
app.on("window-all-closed", () => { /* continua na bandeja */ });
