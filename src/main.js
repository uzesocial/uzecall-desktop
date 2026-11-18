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
const clip = { key: null, down: false }; // tecla de salvar o clipe (também funciona com o jogo na frente)
function sendPtt(down) {
  if (win && !win.isDestroyed()) win.webContents.send("ptt", down);
}
function onKeyDown(e) {
  if (ptt.key !== null && e.keycode === ptt.key && !ptt.down) { ptt.down = true; sendPtt(true); }
  if (clip.key !== null && e.keycode === clip.key && !clip.down) {
    clip.down = true;
    if (win && !win.isDestroyed()) win.webContents.send("clip:key");
  }
}
function onKeyUp(e) {
  if (ptt.key !== null && e.keycode === ptt.key && ptt.down) { ptt.down = false; sendPtt(false); }
  if (clip.key !== null && e.keycode === clip.key) clip.down = false;
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
// o gancho do teclado só fica ligado se alguma tecla (falar ou clipe) estiver em uso
function syncHook(hook) {
  const need = ptt.key !== null || clip.key !== null;
  try {
    if (need && !ptt.running) { hook.start(); ptt.running = true; }
    if (!need && ptt.running) { hook.stop(); ptt.running = false; }
  } catch { /* segue sem o atalho global */ }
}
ipcMain.on("ptt:set", (e, code) => {
  if (!win || e.sender !== win.webContents) return;
  const hook = loadHook();
  if (!hook) return;
  const key = typeof code === "string" ? hookKeyFor(code, ptt.keys) : null;
  if (ptt.down && key !== ptt.key) { ptt.down = false; sendPtt(false); }
  ptt.key = key;
  syncHook(hook);
});
ipcMain.on("clip:set", (e, code) => {
  if (!win || e.sender !== win.webContents) return;
  const hook = loadHook();
  if (!hook) return;
  clip.key = typeof code === "string" ? hookKeyFor(code, ptt.keys) : null;
  clip.down = false;
  syncHook(hook);
});

/* ------------------------------------------------------------------ clipes: salva em Vídeos > UzeCall Clipes */

const clipsDir = () => path.join(app.getPath("videos"), "UzeCall Clipes");
function clipName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `UzeCall-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}
ipcMain.handle("clip:save", async (e, data, ext) => {
  if (!win || e.sender !== win.webContents) return null;
  if (ext !== "mp4" && ext !== "webm") return null;
  const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!bytes || bytes.length < 1000 || bytes.length > 600 * 1024 * 1024) return null;
  try {
    const dir = clipsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, clipName(ext));
    await fs.promises.writeFile(file, bytes);
    if (Notification.isSupported()) {
      const n = new Notification({ title: "Clipe salvo", body: "Clique para abrir a pasta.", icon: ICON, silent: true });
      n.on("click", () => shell.showItemInFolder(file));
      n.show();
    }
    return file;
  } catch {
    return null;
  }
});
ipcMain.on("clip:show", (e, file) => {
  if (!win || e.sender !== win.webContents || typeof file !== "string") return;
  const dir = clipsDir();
  const full = path.resolve(file);
  if (full.startsWith(dir + path.sep) && fs.existsSync(full)) shell.showItemInFolder(full);
});

// aviso do Windows clicado no site: traz a janela para a frente
ipcMain.on("win:focus", (e) => {
  if (win && e.sender === win.webContents) show();
});

/* ------------------------------------------------------------------ jogo aberto (para mostrar "Jogando …") */

// nome do programa (minúsculo) -> nome do jogo que aparece para os amigos
const GAMES = {
  "cs2.exe": "Counter-Strike 2",
  "valorant-win64-shipping.exe": "Valorant",
  "league of legends.exe": "League of Legends",
  "fortniteclient-win64-shipping.exe": "Fortnite",
  "gta5.exe": "GTA V",
  "gta5_enhanced.exe": "GTA V",
  "playgta5.exe": "GTA V",
  "robloxplayerbeta.exe": "Roblox",
  "dota2.exe": "Dota 2",
  "r5apex.exe": "Apex Legends",
  "r5apex_dx12.exe": "Apex Legends",
  "rocketleague.exe": "Rocket League",
  "rainbowsix.exe": "Rainbow Six Siege",
  "rainbowsix_be.exe": "Rainbow Six Siege",
  "tslgame.exe": "PUBG",
  "cod.exe": "Call of Duty",
  "overwatch.exe": "Overwatch 2",
  "fc25.exe": "EA SPORTS FC 25",
  "fc26.exe": "EA SPORTS FC 26",
  "marvel-win64-shipping.exe": "Marvel Rivals",
  "rustclient.exe": "Rust",
  "deadbydaylight-win64-shipping.exe": "Dead by Daylight",
  "eurotrucks2.exe": "Euro Truck Simulator 2",
  "pathofexile.exe": "Path of Exile",
  "pathofexile_x64steam.exe": "Path of Exile",
  "pathofexile2.exe": "Path of Exile 2",
  "wow.exe": "World of Warcraft",
  "genshinimpact.exe": "Genshin Impact",
  "eldenring.exe": "Elden Ring",
  "escapefromtarkov.exe": "Escape from Tarkov",
  "albion-online.exe": "Albion Online",
  "minecraft.windows.exe": "Minecraft",
  "rdr2.exe": "Red Dead Redemption 2",
  "cyberpunk2077.exe": "Cyberpunk 2077",
  "helldivers2.exe": "Helldivers 2",
  "deadlock.exe": "Deadlock",
  "bf2042.exe": "Battlefield 2042",
  "bf6.exe": "Battlefield 6",
  "hll-win64-shipping.exe": "Hell Let Loose",
  "brawlhalla.exe": "Brawlhalla",
  "rocketleague_be.exe": "Rocket League",
  "warframe.x64.exe": "Warframe",
  "destiny2.exe": "Destiny 2",
  "thefinals.exe": "The Finals",
  "fallguys_client_game.exe": "Fall Guys",
  "pal-win64-shipping.exe": "Palworld",
  "sotgame.exe": "Sea of Thieves",
  "forzahorizon5.exe": "Forza Horizon 5",
  "nba2k25.exe": "NBA 2K25",
  "nba2k26.exe": "NBA 2K26",
  "tibia.exe": "Tibia",
};
let currentGame = null;
let gameTimer = null;
function listProcesses() {
  return new Promise((resolve) => {
    const { execFile } = require("node:child_process");
    if (process.platform === "win32") {
      execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        resolve(String(out).split(/\r?\n/).map((line) => (line.match(/^"([^"]+)"/) || [])[1]).filter(Boolean).map((x) => x.toLowerCase()));
      });
    } else {
      // fora do Windows (só para teste): nomes dos processos
      execFile("ps", ["-eo", "comm="], { timeout: 8000 }, (err, out) => resolve(err ? [] : String(out).split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean)));
    }
  });
}
async function checkGame() {
  const names = await listProcesses();
  let found = null;
  for (const n of names) {
    if (GAMES[n]) { found = GAMES[n]; break; }
  }
  if (process.env.UZ_FAKE_GAME) found = process.env.UZ_FAKE_GAME;
  if (found !== currentGame) {
    currentGame = found;
    if (win && !win.isDestroyed()) win.webContents.send("game", currentGame);
  }
}
function startGameWatch() {
  if (gameTimer) return;
  checkGame();
  gameTimer = setInterval(checkGame, 20_000);
}
ipcMain.on("game:get", (e) => { e.returnValue = currentGame; });
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
  startGameWatch();
  checkUpdates(false);
  setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);
});

app.on("before-quit", () => {
  quitting = true;
  saveState();
  try { if (ptt.running && ptt.hook) ptt.hook.stop(); } catch { /* já parado */ }
});
app.on("window-all-closed", () => { /* continua na bandeja */ });
