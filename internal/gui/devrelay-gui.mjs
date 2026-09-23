import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectionLabel, connectionPublicUrl, ensureSetupState } from "./setup/setup-state.mjs";
import { classifyGuiHeartbeat } from "./heartbeat-watchdog.mjs";

const guiDir = path.dirname(fileURLToPath(import.meta.url));
const internalRoot = path.resolve(guiDir, "..");
const publicDir = path.join(guiDir, "public");
const stateDir = path.join(internalRoot, ".devrelay");
const windowStatePath = path.join(stateDir, "window-state.json");
const setupWindowStatePath = path.join(stateDir, "setup-window-state.json");
const settingsPath = path.join(stateDir, "gui-settings.json");
const devicePath = path.join(stateDir, "device.json");
const updateStatePath = path.join(stateDir, "update-state.json");
const launcherPath = path.join(internalRoot, "scripts", "DevRelay-Launcher.ps1");
const setupWizardPath = path.join(guiDir, "setup", "setup-wizard.mjs");
const guiPort = 7318;
const hostDir = path.join(guiDir, "host");
const hostSetupPath = path.join(hostDir, "Ensure-WebView2Sdk.ps1");
const fontSetupPath = path.join(hostDir, "Ensure-NotoSansMono.ps1");
const hostScriptPath = path.join(hostDir, "DevRelay-GuiHost.ps1");
const webView2Root = path.join(stateDir, "webview2-sdk");
const fontRoot = path.join(stateDir, "fonts");
const logsRoot = path.join(stateDir, "logs");

async function existingGuiIsRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: guiPort, path: "/api/state", timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once("error", () => resolve(false));
    req.once("timeout", () => { req.destroy(); resolve(false); });
  });
}
if (await existingGuiIsRunning()) process.exit(0);

await mkdir(stateDir, { recursive: true });
await mkdir(logsRoot, { recursive: true });

let setup = await ensureSetupState(internalRoot);
if (!setup.completed) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [setupWizardPath], { cwd: internalRoot, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  if (await existingGuiIsRunning()) process.exit(0);
  setup = await ensureSetupState(internalRoot);
  if (!setup.completed) process.exit(0);
}

function localStamp(date) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

const sessionId = randomUUID();
const sessionName = `${localStamp(new Date())}-${sessionId.slice(0, 8)}`;
const sessionDir = path.join(logsRoot, sessionName);
await mkdir(sessionDir, { recursive: true });
const auditPath = path.join(sessionDir, "audit.ndjson");
const commandLogPath = path.join(sessionDir, "command.log");
const serverLogPath = path.join(sessionDir, "server.log");
const sessionPath = path.join(sessionDir, "session.json");
await writeFile(auditPath, "", "utf8");
await writeFile(commandLogPath, "", "utf8");
await writeFile(serverLogPath, "", "utf8");

async function pruneLogSessions() {
  const pattern = /^\d{8}-\d{6}-[0-9a-f]{8}$/i;
  const entries = await readdir(logsRoot, { withFileTypes: true });
  const sessions = entries.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name).sort().reverse();
  const keep = new Set([sessionName, ...sessions.filter((name) => name !== sessionName).slice(0, 2)]);
  await Promise.all(sessions.filter((name) => !keep.has(name)).map((name) => rm(path.join(logsRoot, name), { recursive: true, force: true })));
}
await pruneLogSessions();

let settings = await loadSettings();
let sessionMeta = { sessionId, startedAt: new Date().toISOString(), endedAt: null, status: "window-open", exitReason: null, connection: connectionLabel(setup.connection), theme: settings.theme };
async function persistSessionMeta(values = {}) {
  sessionMeta = { ...sessionMeta, ...values };
  await writeFile(sessionPath, `${JSON.stringify(sessionMeta, null, 2)}\n`, "utf8");
}
await persistSessionMeta();
let runtime = null;
let setupProcess = null;
let windowHost = null;
let shuttingDown = false;
let closeTimer = null;
let windowLaunchedAt = 0;
let lastHeartbeatAt = 0;
let lastHeartbeatStatus = "healthy";
let auditSeen = 0;
let autoStartPending = settings.autoStart;
let publicUrl = connectionPublicUrl(setup.connection);
let oauthControlSecret = null;
let oauthPending = [];
let deviceInfo = await readDeviceInfo();
const state = {
  running: false,
  starting: false,
  stopping: false,
  startedAt: null,
  lastError: null
};

const aiLogs = [];
const pluginLogs = [];
const MAX_LOG_LINES = 900;

async function readDeviceInfo() {
  try {
    const value = JSON.parse(await readFile(devicePath, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

function pushLog(target, message, level = "info") {
  const text = String(message ?? "").trimEnd();
  if (!text) return;
  const at = new Date().toISOString();
  target.push({ at, level, text });
  if (target.length > MAX_LOG_LINES) target.splice(0, target.length - MAX_LOG_LINES);
  const logPath = target === aiLogs ? commandLogPath : target === pluginLogs ? serverLogPath : null;
  if (logPath) appendFileSync(logPath, `${at} [${String(level).toUpperCase()}] ${text.replace(/\r?\n/g, "\\n")}\n`, "utf8");
}

async function logUpdateState() {
  try {
    const value = JSON.parse(await readFile(updateStatePath, "utf8"));
    const suffix = value.tag ? ` (${value.tag})` : "";
    const level = value.status === "error" ? "error" : "info";
    pushLog(pluginLogs, `[Update] ${value.message ?? value.status}${suffix}`, level);
  } catch { }
}
await logUpdateState();

async function loadSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    return {
      port: Number.isInteger(parsed.port) ? parsed.port : 7317,
      autoStart: parsed.autoStart !== false,
      theme: parsed.theme === "black-soft" ? "black-soft" : "white-soft"
    };
  } catch {
    return { port: 7317, autoStart: true, theme: "white-soft" };
  }
}
async function saveSettings() {
  const persisted = { port: settings.port, autoStart: settings.autoStart, theme: settings.theme };
  await writeFile(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

async function refreshSetupFromDisk() {
  const latest = await ensureSetupState(internalRoot);
  const changed = JSON.stringify(latest) !== JSON.stringify(setup);
  if (!changed) return false;
  setup = latest;
  if (!runtime && !state.starting && !state.running && !state.stopping) {
    publicUrl = connectionPublicUrl(setup.connection);
  }
  return true;
}

function snapshot() {
  return {
    ...state,
    port: settings.port,
    autoStart: settings.autoStart,
    theme: settings.theme,
    connection: setup.connection,
    connectionLabel: connectionLabel(setup.connection),
    setupComplete: setup.completed,
    setupOpen: setupProcess !== null,
    sessionDir,
    localUrl: `http://127.0.0.1:${settings.port}/mcp`,
    publicUrl,
    device: deviceInfo ? { ...deviceInfo, online: state.running } : null,
    oauthPending,
    aiLogs,
    pluginLogs
  };
}

function appendProcessOutput(target, chunk, level) {
  for (const line of String(chunk).replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    let resolved = level;
    if (level === "server") {
      resolved = /\bERR\b|\[ERROR\]|fatal:/i.test(line) ? "error"
        : /\bWRN\b|\bWARN(?:ING)?\b/i.test(line) ? "warn"
        : /error=/i.test(line) ? "error" : "info";
    }
    pushLog(target, line, resolved);
  }
}
async function pollAudit() {
  try {
    const text = await readFile(auditPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(auditSeen)) {
      try {
        const event = JSON.parse(line);
        pushLog(aiLogs, formatAudit(event));
      } catch {
        pushLog(aiLogs, line, "warn");
      }
    }
    auditSeen = lines.length;
  } catch {
    // The audit file appears only while the MCP server is active.
  }
}

function formatAudit(event) {
  if (event.event === "exec.start") return `> exec  ${event.command}`;
  if (event.event === "exec.end") {
    return `< exec finished  exit=${event.exitCode ?? "?"}${event.timedOut ? "  timeout" : ""}`;
  }
  if (event.event === "process.start") return `${event.terminal ? "> terminal" : "> process"}  ${event.command}  [${event.processId}]`;
  if (event.event === "process.exit") return `< process exited  exit=${event.exitCode ?? "?"}  [${event.processId}]`;
  if (event.event === "process.stop") return `x process stopped  [${event.processId}]`;
  return `${event.event}`;
}

setInterval(() => { void pollAudit(); }, 350).unref();
async function startRuntime() {
  if (runtime || state.starting || state.running) return;
  state.starting = true;
  state.stopping = false;
  state.lastError = null;
  state.startedAt = null;
  setup = await ensureSetupState(internalRoot);
  if (!setup.completed || !setup.connection) {
    state.starting = false;
    throw new Error("Connection setup is incomplete. Open Connection Setup first.");
  }
  publicUrl = connectionPublicUrl(setup.connection);

  const args = [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", launcherPath,
    "-Port", String(settings.port)
  ];

  const usesOAuth = setup.connection.kind === "https";
  oauthControlSecret = usesOAuth ? `${randomUUID()}${randomUUID()}`.replaceAll("-", "") : null;
  oauthPending = [];
  const oauthEnv = usesOAuth ? {
    DEVRELAY_OAUTH_CONTROL_SECRET: oauthControlSecret,
    DEVRELAY_STATE_DIR: stateDir
  } : {};
  pushLog(pluginLogs, `[GUI] Starting ${connectionLabel(setup.connection)}...`);
  runtime = spawn("powershell.exe", args, {
    cwd: internalRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEVRELAY_STATE_DIR: stateDir, ...oauthEnv, DEVRELAY_AUDIT_LOG: auditPath, DEVRELAY_SESSION_DIR: sessionDir }
  });

  runtime.stdout.setEncoding("utf8");
  runtime.stderr.setEncoding("utf8");
  runtime.stdout.on("data", (chunk) => handlePluginChunk(chunk, "server"));
  runtime.stderr.on("data", (chunk) => handlePluginChunk(chunk, "server"));
  runtime.once("error", (error) => {
    state.lastError = error.message;
    state.starting = false;
    state.running = false;
    pushLog(pluginLogs, `[GUI] ${error.message}`, "error");
    runtime = null;
  });

  runtime.once("exit", (code, signal) => {
    const expectedStop = state.stopping;
    if (expectedStop) pushLog(pluginLogs, "[GUI] Runtime stopped.");
    else pushLog(pluginLogs, `[GUI] Runtime exited  code=${code ?? "?"} signal=${signal ?? "-"}`,
      code === 0 ? "info" : "error");
    runtime = null;
    state.running = false;
    state.starting = false;
    state.stopping = false;
    state.startedAt = null;
    oauthControlSecret = null;
    oauthPending = [];
  });
}

function handlePluginChunk(chunk, level) {
  const text = String(chunk);
  appendProcessOutput(pluginLogs, text, level);
  if (text.includes("DevRelay HTTPS is online.") || text.includes("DevRelay is online for ChatGPT.")) {
    state.starting = false;
    state.running = true;
    state.startedAt ??= new Date().toISOString();
  }
  const match = text.match(/Public MCP:\s*(https:\/\/\S+)/);
  if (match) publicUrl = match[1];
}
function taskkill(pid) {
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

async function stopRuntime(reason = "user") {
  if (!runtime) {
    state.running = false;
    state.starting = false;
    state.stopping = false;
    return;
  }
  const child = runtime;
  state.stopping = true;
  pushLog(pluginLogs, `[GUI] Stopping runtime (${reason})...`);
  await taskkill(child.pid);
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (runtime === child) runtime = null;
  state.running = false;
  state.starting = false;
  state.stopping = false;
  state.startedAt = null;
  oauthControlSecret = null;
  oauthPending = [];
}

async function pollOAuthPending() {
  if (!runtime || !oauthControlSecret || setup.connection?.kind !== "https") { oauthPending = []; return; }
  try {
    const response = await fetch(`http://127.0.0.1:${settings.port}/oauth/internal/pending`, {
      headers: { "x-devrelay-control-secret": oauthControlSecret }, cache: "no-store"
    });
    if (response.ok) oauthPending = (await response.json()).pending ?? [];
  } catch {}
}
setInterval(() => { void pollOAuthPending(); }, 500).unref();
setInterval(() => {
  void readDeviceInfo().then((value) => { deviceInfo = value; }).catch(() => {});
}, 500).unref();

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Request body too large.");
  }
  return body ? JSON.parse(body) : {};
}
async function serveStatic(res, fileName, contentType) {
  try {
    const body = await readFile(path.join(publicDir, fileName));
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const expectedHost = `127.0.0.1:${guiPort}`;
    const expectedOrigin = `http://${expectedHost}`;
    if (req.headers.host !== expectedHost) { res.writeHead(403).end(); return; }
    if (req.method === "POST" && req.headers.origin !== expectedOrigin) { res.writeHead(403).end(); return; }
    const url = new URL(req.url ?? "/", expectedOrigin);
    if (req.method === "GET" && url.pathname === "/") return void await serveStatic(res, "index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/app.js") return void await serveStatic(res, "app.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/styles.css") return void await serveStatic(res, "styles.css", "text/css; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/state") {
      await refreshSetupFromDisk();
      return sendJson(res, 200, snapshot());
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      await startRuntime();
      return sendJson(res, 202, snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      await stopRuntime("button");
      return sendJson(res, 200, snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/oauth/decision") {
      if (!oauthControlSecret || setup.connection?.kind !== "https") return sendJson(res, 409, { error: "OAuth runtime is not active." });
      const body = await readJson(req);
      const response = await fetch(`http://127.0.0.1:${settings.port}/oauth/internal/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-devrelay-control-secret": oauthControlSecret },
        body: JSON.stringify({ id: body.id, approve: body.approve === true })
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) return sendJson(res, response.status, value);
      await pollOAuthPending();
      return sendJson(res, 200, { ...value, state: snapshot() });
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      const next = await readJson(req);
      const port = Number(next.port);
      const autoStart = next.autoStart !== false;
      const theme = next.theme === "black-soft" ? "black-soft" : "white-soft";
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === guiPort) {
        return sendJson(res, 400, { error: "Port must be an integer from 1024 to 65535." });
      }
      const deviceName = typeof next.deviceName === "string" ? next.deviceName.trim() : deviceInfo?.name;
      const deviceAliases = Array.isArray(next.deviceAliases)
        ? [...new Set(next.deviceAliases.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))].slice(0, 16)
        : (deviceInfo?.aliases ?? []);
      const runtimeSettingChanged = port !== settings.port || autoStart !== settings.autoStart;
      const deviceChanged = deviceInfo && (deviceName !== deviceInfo.name || JSON.stringify(deviceAliases) !== JSON.stringify(deviceInfo.aliases ?? []));
      if ((runtime || state.starting || state.running) && (runtimeSettingChanged || deviceChanged)) {
        return sendJson(res, 409, { error: "Stop DevRelay before changing runtime or device settings." });
      }
      if (deviceInfo && deviceChanged) {
        if (!deviceName) return sendJson(res, 400, { error: "Device name cannot be empty." });
        deviceInfo = { ...deviceInfo, name: deviceName, aliases: deviceAliases, updatedAt: new Date().toISOString() };
        await writeFile(devicePath, `${JSON.stringify(deviceInfo, null, 2)}\n`, "utf8");
      }
      settings = { port, autoStart, theme };
      await saveSettings();
      await persistSessionMeta({ connection: connectionLabel(setup.connection), theme: settings.theme });
      return sendJson(res, 200, snapshot());
    }

    if (req.method === "POST" && url.pathname === "/api/setup") {
      if (runtime || state.starting || state.running || state.stopping) {
        return sendJson(res, 409, { error: "Stop DevRelay before changing connection setup." });
      }
      if (!setupProcess) {
        setupProcess = spawn(process.execPath, [setupWizardPath], { cwd: internalRoot, windowsHide: true, stdio: "ignore", env: { ...process.env, DEVRELAY_CASCADE_WINDOW: "1" } });
        setupProcess.once("error", (error) => { pushLog(pluginLogs, `[GUI] Setup window failed: ${error.message}`, "error"); setupProcess = null; });
        setupProcess.once("exit", async () => {
          setupProcess = null;
          setup = await ensureSetupState(internalRoot);
          if (!runtime && !state.starting && !state.running && !state.stopping) {
            publicUrl = connectionPublicUrl(setup.connection);
          }
          await persistSessionMeta({ connection: connectionLabel(setup.connection) });
          pushLog(pluginLogs, `[GUI] Connection setup: ${connectionLabel(setup.connection)}`);
        });
      }
      return sendJson(res, 202, snapshot());
    }

    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
      lastHeartbeatAt = Date.now();
      if (autoStartPending) {
        autoStartPending = false;
        void startRuntime();
      }
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/window-close") {
      scheduleWindowClose();
      return sendJson(res, 202, { ok: true });
    }

    res.writeHead(404).end();
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
function scheduleWindowClose() {
  if (closeTimer || shuttingDown) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    void shutdown("window closed");
  }, 1400);
}

function runPowerShellFile(filePath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath, ...args
    ], { cwd: internalRoot, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(filePath)} exited with code ${code ?? "?"}.`)));
  });
}

async function launchWindow() {
  await runPowerShellFile(hostSetupPath, ["-Root", webView2Root]);
  await runPowerShellFile(fontSetupPath, ["-Root", fontRoot]);
  const profile = path.join(stateDir, "webview2-profile");
  const url = `http://127.0.0.1:${guiPort}/`;
  windowLaunchedAt = Date.now();
  lastHeartbeatAt = 0;
  const hostArgs = [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta",
    "-File", hostScriptPath, "-Url", url, "-SdkRoot", webView2Root, "-ProfileDir", profile, "-WindowStatePath", windowStatePath
  ];
  if (process.env.DEVRELAY_CASCADE_WINDOW === "1") hostArgs.push("-CascadeFromStatePath", setupWindowStatePath);
  windowHost = spawn("powershell.exe", hostArgs, { cwd: internalRoot, windowsHide: true, stdio: "ignore" });
  windowHost.once("exit", () => {
    windowHost = null;
    if (!shuttingDown) void shutdown("GUI window closed");
  });
  windowHost.once("error", (error) => {
    pushLog(pluginLogs, `[GUI] Window launch failed: ${error.message}`, "error");
    void shutdown("GUI launch failed");
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (closeTimer) clearTimeout(closeTimer);
  pushLog(pluginLogs, `[GUI] Closing: ${reason}`);
  await stopRuntime(reason);
  await persistSessionMeta({ endedAt: new Date().toISOString(), status: "closed", exitReason: reason });
  if (setupProcess?.pid) await taskkill(setupProcess.pid);
  await new Promise((resolve) => server.close(resolve));
  if (windowHost?.pid) await taskkill(windowHost.pid);
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("uncaughtException", (error) => {
  pushLog(pluginLogs, `[GUI] Fatal: ${error.stack ?? error.message}`, "error");
  void shutdown("uncaught exception");
});
process.on("unhandledRejection", (error) => {
  pushLog(pluginLogs, `[GUI] Rejection: ${String(error)}`, "error");
});
setInterval(() => {
  if (shuttingDown || !windowLaunchedAt) return;
  const heartbeat = classifyGuiHeartbeat({ now: Date.now(), windowLaunchedAt, lastHeartbeatAt });
  if (heartbeat.status === "stale" && lastHeartbeatStatus !== "stale") {
    pushLog(pluginLogs, `[GUI] Heartbeat stale: no signal for ${heartbeat.ageMs}ms.`, "warn");
  } else if (heartbeat.status === "healthy" && lastHeartbeatStatus === "stale") {
    pushLog(pluginLogs, "[GUI] Heartbeat recovered.");
  } else if (heartbeat.status === "lost") {
    lastHeartbeatStatus = "lost";
    void shutdown("GUI heartbeat lost");
    return;
  }
  lastHeartbeatStatus = heartbeat.status;
}, 1000).unref();

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  throw error;
});

server.listen(guiPort, "127.0.0.1", () => {
  pushLog(pluginLogs, `[GUI] DevRelay control window ready on 127.0.0.1:${guiPort}`);
  void launchWindow().catch((error) => {
    pushLog(pluginLogs, `[GUI] Window launch failed: ${error.message}`, "error");
    void shutdown("GUI launch failed");
  });
});
