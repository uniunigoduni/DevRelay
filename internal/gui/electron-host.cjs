const { app, BrowserWindow, Menu, Notification, WebContentsView, ipcMain, screen, shell } = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

function readOption(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const targetUrl = readOption("--devrelay-url");
const mode = readOption("--devrelay-mode", "main");
const statePath = readOption("--devrelay-window-state");
const cascadeFromPath = readOption("--devrelay-cascade-from");
const userDataPath = readOption("--devrelay-user-data");
const title = readOption("--devrelay-title", "DevRelay");
const origin = targetUrl ? new URL(targetUrl).origin : "";
const initialWidth = Number(readOption("--devrelay-width", "780"));
const initialHeight = Number(readOption("--devrelay-height", "560"));
const minimumWidth = Number(readOption("--devrelay-min-width", "480"));
const minimumHeight = Number(readOption("--devrelay-min-height", "480"));
const iconPath = path.join(__dirname, "..", "assets", "devrelay-icon.png");
// Same chrome geometry as the former WPF host: a 36px title bar and a 6px frame around the page.
const TITLE_BAR_HEIGHT = 36;
const CONTENT_MARGIN = 6;
const CASCADE_OFFSET = 40;
const BACKGROUNDS = { "white-soft": "#ffffff", "black-soft": "#000000" };
let mainWindow;
let pageView;
let theme = "white-soft";
let lastState = null;
let powerBusy = false;
let notifiedOAuthId = null;
let registrationShown = false;
let pageReloads = 0;
let closing = false;
let allowClose = false;
let boundsSaveTimer = null;

if (userDataPath) {
  fsSync.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fsSync.chmodSync(userDataPath, 0o700);
  app.setPath("userData", userDataPath);
}
app.setName("DevRelay");
if (process.platform === "win32") app.setAppUserModelId("DevRelay.Desktop");

function validDimension(value, minimum, fallback) {
  return Number.isFinite(value) && value >= minimum && value <= 10000 ? Math.round(value) : fallback;
}

function validCoordinate(value) {
  return Number.isFinite(value) && value >= -32000 && value <= 32000;
}

async function readJsonFile(filePath) {
  if (!filePath) return null;
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; }
}

async function initialBounds() {
  const saved = await readJsonFile(statePath);
  const width = validDimension(Number(saved?.width), minimumWidth, initialWidth);
  const height = validDimension(Number(saved?.height), minimumHeight, initialHeight);
  let x = Number(saved?.left);
  let y = Number(saved?.top);
  const anchor = await readJsonFile(cascadeFromPath);
  if (validCoordinate(Number(anchor?.left)) && validCoordinate(Number(anchor?.top))) {
    x = Number(anchor.left) + CASCADE_OFFSET;
    y = Number(anchor.top) + CASCADE_OFFSET;
  }
  if (!validCoordinate(x) || !validCoordinate(y)) return { width, height };
  const area = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width, height }).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - width))),
    y: Math.round(Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - height))),
    width, height
  };
}

async function post(pathname, body = {}) {
  if (!origin) return;
  try {
    await fetch(`${origin}${pathname}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
  } catch { /* controller may already be shutting down */ }
}

async function saveBounds() {
  if (!statePath || !mainWindow || mainWindow.isDestroyed()) return;
  // Normal bounds, so closing while maximized or minimized reopens at the restored size.
  const bounds = mainWindow.getNormalBounds();
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify({ width: bounds.width, height: bounds.height, left: bounds.x, top: bounds.y }, null, 2)}\n`, "utf8");
  } catch { /* window-state persistence is best effort */ }
}

function scheduleBoundsSave() {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => { boundsSaveTimer = null; void saveBounds(); }, 250);
  boundsSaveTimer.unref();
}

function layout() {
  if (!mainWindow || mainWindow.isDestroyed() || !pageView) return;
  const [width, height] = mainWindow.getContentSize();
  pageView.setBounds({
    x: CONTENT_MARGIN,
    y: TITLE_BAR_HEIGHT,
    width: Math.max(0, width - CONTENT_MARGIN * 2),
    height: Math.max(0, height - TITLE_BAR_HEIGHT - CONTENT_MARGIN)
  });
}

function chromeState() {
  const oauthBlocking = mode === "main" && Boolean(lastState?.oauthPending?.length);
  const active = Boolean(lastState?.running || lastState?.starting);
  const canStartOrStop = active || Boolean(lastState?.setupComplete);
  return {
    theme,
    maximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()),
    active,
    canPower: Boolean(lastState) && canStartOrStop && !lastState.stopping && !powerBusy && !oauthBlocking,
    settingsEnabled: !oauthBlocking
  };
}

function pushChromeState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("devrelay-chrome-state", chromeState());
}

function applyTheme(value) {
  const next = value === "black-soft" ? "black-soft" : "white-soft";
  if (next === theme) return;
  theme = next;
  mainWindow?.setBackgroundColor(BACKGROUNDS[theme]);
  pageView?.setBackgroundColor(BACKGROUNDS[theme]);
}

function bringToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // Mirrors the WPF host's Topmost toggle, which gets past Windows foreground-lock rules.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  if (process.platform === "darwin") app.focus({ steal: true });
}

function revealForOAuth(pending) {
  const request = pending?.[0];
  if (!request || request.id === notifiedOAuthId) return;
  notifiedOAuthId = request.id;
  bringToFront();
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: "DevRelay access request",
      body: `${request.clientName || "An application"} is waiting for approval.`
    });
    notification.on("click", bringToFront);
    notification.show();
  }
}

async function refreshState() {
  if (!mainWindow || mainWindow.isDestroyed() || !origin) return;
  try {
    // The setup controller's /api/state probes providers, so setup mode reads the cheap progress endpoint.
    const response = await fetch(`${origin}${mode === "main" ? "/api/state" : "/api/progress"}`, {
      cache: "no-store",
      headers: mode === "main" ? { "x-devrelay-gui-host": "electron" } : {},
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    lastState = await response.json();
    if (mode === "main") {
      applyTheme(lastState.theme);
      const pending = lastState.oauthPending ?? [];
      if (!pending.length) notifiedOAuthId = null;
      else revealForOAuth(pending);
    } else {
      if (lastState.registrationReady && !registrationShown) bringToFront();
      registrationShown = Boolean(lastState.registrationReady);
    }
  } catch {
    lastState = null;
  }
  pushChromeState();
}

async function togglePower() {
  if (mode !== "main" || powerBusy || !chromeState().canPower) return;
  powerBusy = true;
  pushChromeState();
  try {
    await post(lastState.running || lastState.starting ? "/api/stop" : "/api/start");
  } finally {
    powerBusy = false;
    await refreshState();
  }
}

ipcMain.on("devrelay-chrome", (event, action) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (action === "minimize") mainWindow.minimize();
  else if (action === "toggle-maximize") {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === "close") mainWindow.close();
  else if (action === "power") void togglePower();
  else if (action === "settings" && mode === "main" && chromeState().settingsEnabled) {
    void pageView.webContents.executeJavaScript("window.DevRelayUi && window.DevRelayUi.toggleSettings && window.DevRelayUi.toggleSettings();").catch(() => {});
  }
});

function guardPage(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") void shell.openExternal(parsed.href);
    } catch { /* reject malformed destinations */ }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== origin) event.preventDefault();
    } catch { event.preventDefault(); }
  });
}

async function createWindow() {
  if (!targetUrl || !origin || !["http:", "https:"].includes(new URL(targetUrl).protocol)) {
    throw new Error("A valid DevRelay controller URL is required.");
  }
  mainWindow = new BrowserWindow({
    ...await initialBounds(),
    title,
    icon: iconPath,
    minWidth: minimumWidth,
    minHeight: minimumHeight,
    frame: false,
    show: false,
    backgroundColor: BACKGROUNDS[theme],
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  });
  pageView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false }
  });
  pageView.setBackgroundColor(BACKGROUNDS[theme]);
  mainWindow.contentView.addChildView(pageView);
  layout();

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  guardPage(pageView.webContents);
  pageView.webContents.on("did-finish-load", () => { pageReloads = 0; });
  pageView.webContents.on("render-process-gone", (_event, details) => {
    if (closing || pageReloads >= 3) return;
    pageReloads += 1;
    console.error(`[DevRelay GUI] Page renderer ${details.reason}; reloading.`);
    void pageView.webContents.loadURL(targetUrl).catch(() => {});
  });

  mainWindow.on("resize", () => { layout(); scheduleBoundsSave(); });
  mainWindow.on("move", scheduleBoundsSave);
  for (const event of ["maximize", "unmaximize", "restore"]) mainWindow.on(event, () => { layout(); pushChromeState(); });
  mainWindow.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    if (boundsSaveTimer) { clearTimeout(boundsSaveTimer); boundsSaveTimer = null; }
    void saveBounds().then(async () => {
      if (mode === "setup") await post("/api/window-close");
      else await post("/api/stop", { reason: "window closed" });
      allowClose = true;
      mainWindow?.close();
    });
  });
  mainWindow.on("closed", () => { mainWindow = null; pageView = null; });

  await mainWindow.loadFile(path.join(__dirname, "titlebar.html"), { query: { mode, title, platform: process.platform } });
  pushChromeState();
  bringToFront();
  await pageView.webContents.loadURL(targetUrl);
  pageView.webContents.focus();
  void saveBounds();
  if (mode === "main") await post("/api/window-ready");
  await refreshState();
  setInterval(() => { void refreshState(); }, 500).unref();
}

app.whenReady().then(() => {
  // The WPF host disabled browser accelerators (reload, DevTools); macOS keeps Edit roles for clipboard keys.
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  // macOS ignores BrowserWindow icons; the Dock icon is per application.
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);
  return createWindow();
}).catch((error) => {
  console.error(`[DevRelay GUI] ${error.message}`);
  app.quit();
});

app.on("activate", bringToFront);

app.on("window-all-closed", () => app.quit());
