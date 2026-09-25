import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectionLabel, connectionPublicUrl, ensureSetupState } from "./setup/setup-state.mjs";
import { classifyGuiHostHeartbeat } from "./gui-host-watchdog.mjs";
import { queryRecentWindowsEvents, queryWindowsProcesses, recoverUncleanSessions } from "./session-recovery.mjs";

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
const CONTROLLER_HEARTBEAT_INTERVAL_MS = 120_000;
const controllerStartedAt = new Date().toISOString();

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
const recoveredSessions = await recoverUncleanSessions({ logsRoot, internalRoot });

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
const lifecyclePath = path.join(sessionDir, "lifecycle.ndjson");
await writeFile(auditPath, "", "utf8");
await writeFile(commandLogPath, "", "utf8");
await writeFile(serverLogPath, "", "utf8");
await writeFile(lifecyclePath, "", "utf8");

async function pruneLogSessions() {
  const pattern = /^\d{8}-\d{6}-[0-9a-f]{8}$/i;
  const entries = await readdir(logsRoot, { withFileTypes: true });
  const sessions = entries.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name).sort().reverse();
  const previous = sessions.filter((name) => name !== sessionName);
  const keep = new Set([sessionName, ...previous.slice(0, 2)]);
  const diagnosticSessions = [];
  for (const name of previous) {
    try {
      const dir = path.join(logsRoot, name);
      const [metaText, files] = await Promise.all([
        readFile(path.join(dir, "session.json"), "utf8").catch(() => "{}"),
        readdir(dir).catch(() => [])
      ]);
      const meta = JSON.parse(metaText);
      const abnormalExit = meta.status === "unclean" || (meta.exitReason && !["GUI window closed", "SIGINT", "SIGTERM"].includes(meta.exitReason));
      if (abnormalExit || files.some((file) => file.startsWith("diagnostic-") && file.endsWith(".json"))) diagnosticSessions.push(name);
    } catch { /* malformed old session metadata is not retention-critical */ }
  }
  for (const name of diagnosticSessions.slice(0, 5)) keep.add(name);
  await Promise.all(sessions.filter((name) => !keep.has(name)).map((name) => rm(path.join(logsRoot, name), { recursive: true, force: true })));
}
await pruneLogSessions();

let settings = await loadSettings();
let sessionMeta = {
  sessionId,
  startedAt: controllerStartedAt,
  endedAt: null,
  status: "window-open",
  exitReason: null,
  connection: connectionLabel(setup.connection),
  theme: settings.theme,
  controller: { role: "controller", pid: process.pid, parentPid: process.ppid, startedAt: controllerStartedAt, executableName: path.basename(process.execPath), commandIncludes: ["devrelay-gui.mjs"] },
  windowHost: null,
  launcher: null,
  lastHeartbeatAt: controllerStartedAt
};
async function persistSessionMeta(values = {}) {
  sessionMeta = { ...sessionMeta, ...values };
  await writeFile(sessionPath, `${JSON.stringify(sessionMeta, null, 2)}\n`, "utf8");
}
function recordLifecycle(event, detail = {}) {
  try {
    appendFileSync(lifecyclePath, `${JSON.stringify({ at: new Date().toISOString(), event, controllerPid: process.pid, parentPid: process.ppid, ...detail })}\n`, "utf8");
  } catch { /* lifecycle logging must never take the controller down */ }
}
await persistSessionMeta();
recordLifecycle("controller.start", { sessionId, recoveredSessionCount: recoveredSessions.length });
let runtime = null;
let setupProcess = null;
let windowHost = null;
let shuttingDown = false;
let windowLaunchedAt = 0;
let lastHostHeartbeatAt = 0;
let lastHostHeartbeatStatus = "healthy";
let windowReady = false;
let windowCloseRequestedAt = 0;
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
let aiLogRevision = 0;
let pluginLogRevision = 0;
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
  if (target === aiLogs) aiLogRevision += 1;
  else if (target === pluginLogs) pluginLogRevision += 1;
  if (target.length > MAX_LOG_LINES) target.splice(0, target.length - MAX_LOG_LINES);
  const logPath = target === aiLogs ? commandLogPath : target === pluginLogs ? serverLogPath : null;
  if (logPath) appendFileSync(logPath, `${at} [${String(level).toUpperCase()}] ${text.replace(/\r?\n/g, "\\n")}\n`, "utf8");
}

async function captureDiagnosticSnapshot(reason, detail = {}) {
  try {
    const [processes, recentWindowsEvents] = await Promise.all([
      queryWindowsProcesses(),
      queryRecentWindowsEvents(15, 120).catch(() => [])
    ]);
    const knownPids = new Set([process.pid, runtime?.pid, windowHost?.pid, sessionMeta.launcher?.pid, sessionMeta.windowHost?.pid].filter(Number.isInteger));
    const internalNeedle = internalRoot.replaceAll("/", "\\").toLowerCase();
    const relevantProcesses = processes.filter((item) => knownPids.has(Number(item.processId)) || String(item.commandLine ?? "").replaceAll("/", "\\").toLowerCase().includes(internalNeedle));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeReason = String(reason).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "event";
    const fileName = `diagnostic-${stamp}-${safeReason}.json`;
    await writeFile(path.join(sessionDir, fileName), `${JSON.stringify({
      capturedAt: new Date().toISOString(), reason, detail, state, sessionMeta, relevantProcesses, recentWindowsEvents
    }, null, 2)}\n`, "utf8");
    recordLifecycle("diagnostic.snapshot", { reason, fileName, processCount: relevantProcesses.length, windowsEventCount: recentWindowsEvents.length });
  } catch (error) {
    recordLifecycle("diagnostic.snapshot-error", { reason, message: error instanceof Error ? error.message : String(error) });
  }
}

for (const recovery of recoveredSessions) {
  if (recovery.type === "unclean-session") {
    const cleaned = recovery.cleaned.filter((item) => item.ok).map((item) => `${item.role}:${item.pid}`).join(", ") || "none";
    pushLog(pluginLogs, `[Recovery] Previous session ${recovery.sessionName} ended uncleanly; verified orphan cleanup: ${cleaned}.`, "warn");
    recordLifecycle("session.recovery", { previousSession: recovery.sessionName, cleaned: recovery.cleaned, lastHeartbeatAt: recovery.lastHeartbeatAt });
    void captureDiagnosticSnapshot("unclean-session-recovery", { previousSession: recovery.sessionName, previousLastHeartbeatAt: recovery.lastHeartbeatAt, cleaned: recovery.cleaned });
  } else {
    pushLog(pluginLogs, `[Recovery] Previous-session scan failed: ${recovery.message}`, "warn");
    recordLifecycle("session.recovery-error", { message: recovery.message });
  }
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
    windowReady,
    sessionDir,
    localUrl: `http://127.0.0.1:${settings.port}/mcp`,
    publicUrl,
    device: deviceInfo ? { ...deviceInfo, online: state.running } : null,
    oauthPending,
    aiLogRevision,
    pluginLogRevision,
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
  const launcherStartedAt = new Date().toISOString();
  runtime = spawn("powershell.exe", args, {
    cwd: internalRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, DEVRELAY_STATE_DIR: stateDir, ...oauthEnv, DEVRELAY_AUDIT_LOG: auditPath, DEVRELAY_SESSION_DIR: sessionDir,
      DEVRELAY_SESSION_ID: sessionId, DEVRELAY_CONTROLLER_PID: String(process.pid), DEVRELAY_CONTROLLER_STARTED_AT: controllerStartedAt
    }
  });
  const launcherRecord = { role: "launcher", pid: runtime.pid, startedAt: launcherStartedAt, executableName: "powershell.exe", commandIncludes: [launcherPath, "-Port", String(settings.port)] };
  await persistSessionMeta({ launcher: launcherRecord, runtimeState: "starting" });
  recordLifecycle("launcher.start", { pid: runtime.pid, startedAt: launcherStartedAt, port: settings.port });

  runtime.stdout.setEncoding("utf8");
  runtime.stderr.setEncoding("utf8");
  runtime.stdout.on("data", (chunk) => handlePluginChunk(chunk, "server"));
  runtime.stderr.on("data", (chunk) => handlePluginChunk(chunk, "server"));
  runtime.once("error", (error) => {
    const failedPid = runtime?.pid ?? launcherRecord.pid;
    state.lastError = error.message;
    state.starting = false;
    state.running = false;
    pushLog(pluginLogs, `[GUI] ${error.message}`, "error");
    recordLifecycle("launcher.error", { pid: failedPid, message: error.message });
    void persistSessionMeta({ launcher: null, runtimeState: "error", lastLauncherError: { at: new Date().toISOString(), pid: failedPid, message: error.message } });
    void captureDiagnosticSnapshot("launcher-error", { pid: failedPid, message: error.message });
    runtime = null;
  });

  runtime.once("exit", (code, signal) => {
    const exitedPid = runtime?.pid ?? launcherRecord.pid;
    const expectedStop = state.stopping;
    if (expectedStop) pushLog(pluginLogs, "[GUI] Runtime stopped.");
    else pushLog(pluginLogs, `[GUI] Runtime exited  code=${code ?? "?"} signal=${signal ?? "-"}`,
      code === 0 ? "info" : "error");
    recordLifecycle("launcher.exit", { pid: exitedPid, code, signal, expected: expectedStop });
    void persistSessionMeta({ launcher: null, runtimeState: expectedStop ? "stopped" : "exited", lastLauncherExit: { at: new Date().toISOString(), pid: exitedPid, code, signal, expected: expectedStop } });
    if (!expectedStop) void captureDiagnosticSnapshot("unexpected-launcher-exit", { pid: exitedPid, code, signal });
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
    void persistSessionMeta({ runtimeState: "running", runtimeStartedAt: state.startedAt });
    recordLifecycle("runtime.online", { startedAt: state.startedAt, publicUrl });
  }
  const match = text.match(/Public MCP:\s*(https:\/\/\S+)/);
  if (match) publicUrl = match[1];
}
function taskkill(pid) {
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => resolve({ ok: !error, error: error?.message ?? null }));
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
  recordLifecycle("runtime.stop-request", { reason, launcherPid: child.pid });
  const stopResult = await taskkill(child.pid);
  recordLifecycle("runtime.stop-result", { reason, launcherPid: child.pid, ...stopResult });
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (runtime === child) runtime = null;
  state.running = false;
  state.starting = false;
  state.stopping = false;
  state.startedAt = null;
  oauthControlSecret = null;
  oauthPending = [];
  await persistSessionMeta({ launcher: null, runtimeState: "stopped", lastStop: { at: new Date().toISOString(), reason } });
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
      if (req.headers["x-devrelay-gui-host"] === "wpf") { lastHostHeartbeatAt = Date.now(); recordLifecycle("gui-host.heartbeat", { hostPid: windowHost?.pid ?? null }); }
      await refreshSetupFromDisk();
      return sendJson(res, 200, snapshot());
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      if (!windowReady || lastHostHeartbeatStatus === "lost") {
        return sendJson(res, 409, { error: "The visible GUI host is not ready." });
      }
      await startRuntime();
      return sendJson(res, 202, snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const body = await readJson(req);
      const reason = body.reason === "window closed" ? "window closed" : "button";
      if (reason === "window closed") {
        windowCloseRequestedAt = Date.now();
        recordLifecycle("gui-host.close-request", { hostPid: windowHost?.pid ?? null });
      }
      await stopRuntime(reason);
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

    if (req.method === "POST" && url.pathname === "/api/window-ready") {
      windowReady = true;
      lastHostHeartbeatAt = Date.now();
      lastHostHeartbeatStatus = "healthy";
      recordLifecycle("gui-host.window-ready", { hostPid: windowHost?.pid ?? null });
      void persistSessionMeta({ windowReadyAt: new Date().toISOString() });
      if (autoStartPending) {
        autoStartPending = false;
        void startRuntime();
      }
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404).end();
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
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
  windowCloseRequestedAt = 0;
  lastHostHeartbeatAt = 0;
  lastHostHeartbeatStatus = "healthy";
  windowReady = false;
  const hostArgs = [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta",
    "-File", hostScriptPath, "-Url", url, "-SdkRoot", webView2Root, "-ProfileDir", profile, "-WindowStatePath", windowStatePath
  ];
  if (process.env.DEVRELAY_CASCADE_WINDOW === "1") hostArgs.push("-CascadeFromStatePath", setupWindowStatePath);
  const hostStartedAt = new Date().toISOString();
  windowHost = spawn("powershell.exe", hostArgs, { cwd: internalRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const hostRecord = { role: "window-host", pid: windowHost.pid, startedAt: hostStartedAt, executableName: "powershell.exe", commandIncludes: [hostScriptPath, url] };
  await persistSessionMeta({ windowHost: hostRecord });
  recordLifecycle("gui-host.start", { pid: windowHost.pid, startedAt: hostStartedAt });
  windowHost.stdout.setEncoding("utf8");
  windowHost.stderr.setEncoding("utf8");
  windowHost.stdout.on("data", (chunk) => appendProcessOutput(pluginLogs, chunk, "server"));
  windowHost.stderr.on("data", (chunk) => appendProcessOutput(pluginLogs, chunk, "server"));
  windowHost.once("exit", (code, signal) => {
    const exitedPid = windowHost?.pid ?? hostRecord.pid;
    const closeRequested = windowCloseRequestedAt > 0 && Date.now() - windowCloseRequestedAt <= 15_000;
    const expectedHostExit = shuttingDown || closeRequested;
    recordLifecycle("gui-host.exit", { pid: exitedPid, code, signal, shuttingDown, closeRequested, expected: expectedHostExit });
    void persistSessionMeta({ windowHost: null, lastWindowHostExit: { at: new Date().toISOString(), pid: exitedPid, code, signal, expected: expectedHostExit } });
    if (!expectedHostExit) void captureDiagnosticSnapshot("unexpected-gui-host-exit", { pid: exitedPid, code, signal });
    windowHost = null;
    windowReady = false;
    if (!shuttingDown) void shutdown("GUI window closed");
  });
  windowHost.once("error", (error) => {
    pushLog(pluginLogs, `[GUI] Window launch failed: ${error.message}`, "error");
    recordLifecycle("gui-host.error", { pid: hostRecord.pid, message: error.message });
    void captureDiagnosticSnapshot("gui-host-error", { pid: hostRecord.pid, message: error.message });
    void shutdown("GUI launch failed");
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  recordLifecycle("controller.shutdown-begin", { reason, windowHostPid: windowHost?.pid ?? null, launcherPid: runtime?.pid ?? null });
  pushLog(pluginLogs, `[GUI] Closing: ${reason}`);
  await stopRuntime(reason);
  const endedAt = new Date().toISOString();
  await persistSessionMeta({ endedAt, status: "closed", exitReason: reason, launcher: null });
  recordLifecycle("controller.shutdown-complete", { reason, endedAt });
  if (setupProcess?.pid) await taskkill(setupProcess.pid);
  await new Promise((resolve) => server.close(resolve));
  if (windowHost?.pid) await taskkill(windowHost.pid);
  process.exit(0);
}

process.on("SIGINT", () => { recordLifecycle("controller.signal", { signal: "SIGINT" }); void shutdown("SIGINT"); });
process.on("SIGTERM", () => { recordLifecycle("controller.signal", { signal: "SIGTERM" }); void shutdown("SIGTERM"); });
process.on("uncaughtException", (error) => {
  pushLog(pluginLogs, `[GUI] Fatal: ${error.stack ?? error.message}`, "error");
  recordLifecycle("controller.uncaught-exception", { message: error.message, stack: error.stack ?? null });
  void captureDiagnosticSnapshot("uncaught-exception", { message: error.message });
  void shutdown("uncaught exception");
});
process.on("unhandledRejection", (error) => {
  pushLog(pluginLogs, `[GUI] Rejection: ${String(error)}`, "error");
  recordLifecycle("controller.unhandled-rejection", { message: String(error) });
  void captureDiagnosticSnapshot("unhandled-rejection", { message: String(error) });
});
process.on("exit", (code) => { recordLifecycle("controller.exit", { code, shuttingDown }); });
setInterval(() => {
  if (shuttingDown || !windowLaunchedAt || !windowReady) return;
  const heartbeat = classifyGuiHostHeartbeat({ now: Date.now(), windowLaunchedAt, lastHeartbeatAt: lastHostHeartbeatAt });
  if (heartbeat.status === "stale" && lastHostHeartbeatStatus === "healthy") {
    pushLog(pluginLogs, `[GUI] Host heartbeat stale: no native GUI signal for ${heartbeat.ageMs}ms.`, "warn");
    recordLifecycle("gui-host.heartbeat-stale", { ageMs: heartbeat.ageMs, hostPid: windowHost?.pid ?? null });
  } else if (heartbeat.status === "healthy" && lastHostHeartbeatStatus !== "healthy") {
    pushLog(pluginLogs, "[GUI] Host heartbeat recovered. Runtime remains stopped until explicitly started.");
    recordLifecycle("gui-host.heartbeat-recovered", { ageMs: heartbeat.ageMs, hostPid: windowHost?.pid ?? null });
  } else if (heartbeat.status === "lost" && lastHostHeartbeatStatus !== "lost") {
    pushLog(pluginLogs, `[GUI] Host heartbeat lost after ${heartbeat.ageMs}ms; stopping runtime without closing the controller.`, "warn");
    recordLifecycle("gui-host.heartbeat-lost", { ageMs: heartbeat.ageMs, hostPid: windowHost?.pid ?? null });
    void captureDiagnosticSnapshot("gui-host-heartbeat-lost", { ageMs: heartbeat.ageMs });
    void stopRuntime("GUI host heartbeat lost").catch((error) => {
      pushLog(pluginLogs, `[GUI] Failed to stop runtime after GUI host heartbeat loss: ${error.message}`, "error");
    });
  }
  lastHostHeartbeatStatus = heartbeat.status;
}, 10_000).unref();

setInterval(() => {
  const at = new Date().toISOString();
  const summary = {
    windowReady, hostHeartbeatStatus: lastHostHeartbeatStatus, hostHeartbeatAgeMs: lastHostHeartbeatAt ? Date.now() - lastHostHeartbeatAt : null,
    windowHostPid: windowHost?.pid ?? null, launcherPid: runtime?.pid ?? null, running: state.running, starting: state.starting, stopping: state.stopping
  };
  recordLifecycle("controller.heartbeat", summary);
  void persistSessionMeta({ lastHeartbeatAt: at, lastKnownState: summary }).catch((error) => recordLifecycle("session.persist-error", { message: error.message }));
}, CONTROLLER_HEARTBEAT_INTERVAL_MS).unref();

server.on("error", (error) => {
  recordLifecycle("controller.server-error", { code: error.code ?? null, message: error.message });
  if (error.code === "EADDRINUSE") process.exit(0);
  throw error;
});

server.listen(guiPort, "127.0.0.1", () => {
  recordLifecycle("controller.listen", { host: "127.0.0.1", port: guiPort });
  pushLog(pluginLogs, `[GUI] DevRelay control window ready on 127.0.0.1:${guiPort}`);
  void launchWindow().catch((error) => {
    pushLog(pluginLogs, `[GUI] Window launch failed: ${error.message}`, "error");
    void shutdown("GUI launch failed");
  });
});
