import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guiDir = path.dirname(fileURLToPath(import.meta.url));
const internalRoot = path.resolve(guiDir, "..");
const publicDir = path.join(guiDir, "public");
const stateDir = path.join(internalRoot, ".devrelay");
const settingsPath = path.join(stateDir, "gui-settings.json");
const auditPath = path.join(stateDir, "ai-command.ndjson");
const launcherPath = path.join(internalRoot, "scripts", "DevRelay-Launcher.ps1");
const guiPort = 7318;

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const requestedMode = modeArg?.split("=")[1] === "chatgpt" ? "chatgpt" : "https";
await mkdir(stateDir, { recursive: true });

let settings = await loadSettings();
settings.mode = requestedMode;
let runtime = null;
let edge = null;
let shuttingDown = false;
let closeTimer = null;
let windowLaunchedAt = 0;
let lastHeartbeatAt = 0;
let auditSeen = 0;
let autoStartPending = settings.autoStart;
let publicUrl = await resolvePublicUrl(settings.mode);
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

function pushLog(target, message, level = "info") {
  const text = String(message ?? "").trimEnd();
  if (!text) return;
  target.push({ at: new Date().toISOString(), level, text });
  if (target.length > MAX_LOG_LINES) target.splice(0, target.length - MAX_LOG_LINES);
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    return {
      mode: requestedMode,
      port: Number.isInteger(parsed.port) ? parsed.port : 7317,
      autoStart: parsed.autoStart !== false
    };
  } catch {
    return { mode: requestedMode, port: 7317, autoStart: true };
  }
}
async function saveSettings() {
  const persisted = { mode: settings.mode, port: settings.port, autoStart: settings.autoStart };
  await writeFile(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

async function resolvePublicUrl(mode) {
  if (mode !== "https") return "OpenAI Secure MCP Tunnel";
  try {
    const named = JSON.parse(await readFile(path.join(stateDir, "https-named.json"), "utf8"));
    return named.hostname ? `https://${named.hostname}/mcp` : "HTTPS Named Tunnel";
  } catch {
    return "HTTPS Named Tunnel";
  }
}

function snapshot() {
  return {
    ...state,
    mode: settings.mode,
    port: settings.port,
    autoStart: settings.autoStart,
    localUrl: `http://127.0.0.1:${settings.port}/mcp`,
    publicUrl,
    aiLogs,
    pluginLogs
  };
}

function appendProcessOutput(target, chunk, level) {
  for (const line of String(chunk).replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    let resolved = level;
    if (level === "server") {
      resolved = /\bERR\b|error=/i.test(line) ? "error" : /\bWRN\b|warning/i.test(line) ? "warn" : "info";
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
  if (event.event === "exec.start") return `▶ exec  ${event.command}`;
  if (event.event === "exec.end") {
    return `↳ exec finished  exit=${event.exitCode ?? "?"}${event.timedOut ? "  timeout" : ""}`;
  }
  if (event.event === "process.start") return `▶ process  ${event.command}  [${event.processId}]`;
  if (event.event === "process.exit") return `↳ process exited  exit=${event.exitCode ?? "?"}  [${event.processId}]`;
  if (event.event === "process.stop") return `■ process stopped  [${event.processId}]`;
  return `${event.event}`;
}

setInterval(() => { void pollAudit(); }, 350).unref();
async function startRuntime() {
  if (runtime || state.starting || state.running) return;
  state.starting = true;
  state.stopping = false;
  state.lastError = null;
  state.startedAt = null;
  aiLogs.length = 0;
  pluginLogs.length = 0;
  auditSeen = 0;
  await writeFile(auditPath, "", "utf8");
  publicUrl = await resolvePublicUrl(settings.mode);

  const args = [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", launcherPath,
    "-Port", String(settings.port)
  ];
  if (settings.mode === "https") args.push("-HttpsDirect");

  pushLog(pluginLogs, `[GUI] Starting ${settings.mode.toUpperCase()} mode...`);
  runtime = spawn("powershell.exe", args, {
    cwd: internalRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEVRELAY_AUDIT_LOG: auditPath }
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
    pushLog(pluginLogs, `[GUI] Runtime exited  code=${code ?? "?"} signal=${signal ?? "-"}`,
      code === 0 ? "info" : "error");
    runtime = null;
    state.running = false;
    state.starting = false;
    state.stopping = false;
    state.startedAt = null;
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
}

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
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, snapshot());

    if (req.method === "POST" && url.pathname === "/api/start") {
      await startRuntime();
      return sendJson(res, 202, snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      await stopRuntime("button");
      return sendJson(res, 200, snapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (runtime || state.starting || state.running) {
        return sendJson(res, 409, { error: "Stop DevRelay before changing runtime settings." });
      }
      const next = await readJson(req);
      const mode = next.mode === "chatgpt" ? "chatgpt" : "https";
      const port = Number(next.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === guiPort) {
        return sendJson(res, 400, { error: "Port must be an integer from 1024 to 65535." });
      }
      settings = { mode, port, autoStart: next.autoStart !== false };
      publicUrl = await resolvePublicUrl(settings.mode);
      await saveSettings();
      return sendJson(res, 200, snapshot());
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

function findEdge() {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function launchWindow() {
  const edgePath = findEdge();
  if (!edgePath) throw new Error("Microsoft Edge was not found. DevRelay GUI requires Edge app mode.");
  const profile = path.join(stateDir, "gui-edge-profile");
  const url = `http://127.0.0.1:${guiPort}/`;
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    "--window-size=900,620",
    "--no-first-run",
    "--disable-background-mode",
    "--disable-extensions",
    "--disable-features=msEdgeSidebarV2"
  ];
  windowLaunchedAt = Date.now();
  lastHeartbeatAt = 0;
  edge = spawn(edgePath, args, { windowsHide: false, stdio: "ignore" });
  edge.once("exit", () => { edge = null; });
  edge.once("error", (error) => {
    pushLog(pluginLogs, `[GUI] Edge launch failed: ${error.message}`, "error");
    void shutdown("GUI launch failed");
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (closeTimer) clearTimeout(closeTimer);
  pushLog(pluginLogs, `[GUI] Closing: ${reason}`);
  await stopRuntime(reason);
  await new Promise((resolve) => server.close(resolve));
  if (edge?.pid) await taskkill(edge.pid);
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
  const now = Date.now();
  if (now - windowLaunchedAt > 8000 && now - lastHeartbeatAt > 3000) {
    void shutdown("GUI heartbeat lost");
  }
}, 1000).unref();

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  throw error;
});

server.listen(guiPort, "127.0.0.1", () => {
  pushLog(pluginLogs, `[GUI] DevRelay control window ready on 127.0.0.1:${guiPort}`);
  launchWindow();
});
