import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFile, cp, rm, mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  SECURE_TUNNEL_ISSUES,
  connectionLabel,
  connectionPublicUrl,
  ensureSetupState,
  resetSetupState,
  saveSetupState
} from "./setup-state.mjs";
import { extractTailscaleApprovalUrl, tailscaleApprovalMessage } from "./tailscale-setup.mjs";

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const guiDir = path.resolve(setupDir, "..");
const internalRoot = path.resolve(guiDir, "..");
const publicDir = path.join(setupDir, "public");
const stateDir = path.join(internalRoot, ".devrelay");
const setupPort = 7319;
const hostDir = path.join(guiDir, "host");
const hostSetupPath = path.join(hostDir, "Ensure-WebView2Sdk.ps1");
const fontSetupPath = path.join(hostDir, "Ensure-NotoSansMono.ps1");
const hostScriptPath = path.join(hostDir, "DevRelay-GuiHost.ps1");
const webView2Root = path.join(stateDir, "webview2-sdk");
const fontRoot = path.join(stateDir, "fonts");
const profileDir = path.join(stateDir, "setup-webview2-profile");
const windowStatePath = path.join(stateDir, "setup-window-state.json");
const setupActionsPath = path.join(internalRoot, "scripts", "DevRelay-SetupActions.ps1");
const settingsPath = path.join(stateDir, "gui-settings.json");

let currentSetup = await ensureSetupState(internalRoot);
let draftConnection = currentSetup.connection ? structuredClone(currentSetup.connection) : null;
let draftReady = currentSetup.completed === true && draftConnection !== null;
let busy = false;
let busyMessage = "";
let lastError = null;
let windowHost = null;
let shuttingDown = false;
let providerStatus = null;
let providerStatusAt = 0;
let activeSetupChild = null;
let approvalUrl = null;
let issueStates = SECURE_TUNNEL_ISSUES.map((issue) => ({ ...issue, state: "unknown" }));

const backupRoot = path.join(stateDir, "setup-backups", randomUUID());
const backupEntries = ["launcher.json", "control-plane-api-key.dpapi", "tunnel-profiles", "cloudflare-named.json", "https-named.json", "cloudflare"];
let transactionCommitted = false;

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function createConnectionBackup() {
  await mkdir(backupRoot, { recursive: true });
  const manifest = [];
  for (const name of backupEntries) {
    const source = path.join(stateDir, name);
    const present = await exists(source);
    manifest.push({ name, present });
    if (present) await cp(source, path.join(backupRoot, name), { recursive: true });
  }
  await writeFile(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest), "utf8");
}

async function restoreConnectionBackup() {
  if (transactionCommitted || !(await exists(backupRoot))) return;
  let manifest = [];
  try { manifest = JSON.parse(await readFile(path.join(backupRoot, "manifest.json"), "utf8")); } catch {}
  for (const entry of manifest) {
    const target = path.join(stateDir, entry.name);
    await rm(target, { recursive: true, force: true });
    if (entry.present) await cp(path.join(backupRoot, entry.name), target, { recursive: true });
  }
  await rm(backupRoot, { recursive: true, force: true });
}

async function commitConnectionBackup() {
  transactionCommitted = true;
  await rm(backupRoot, { recursive: true, force: true });
}

await createConnectionBackup();

async function loadPort() {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    return Number.isInteger(settings.port) ? settings.port : 7317;
  } catch { return 7317; }
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4_000_000, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function openTailscaleApproval(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "login.tailscale.com") {
    throw new Error("Refused an untrusted Tailscale approval URL.");
  }
  await execFilePromise("rundll32.exe", ["url.dll,FileProtocolHandler", parsed.href]);
}

async function runSetupAction(action, input = undefined, options = {}) {
  const port = await loadPort();
  return await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", setupActionsPath, "-Action", action, "-Port", String(port)
    ], { cwd: internalRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    activeSetupChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      if (child.pid) void taskkill(child.pid);
    }, options.timeoutMs) : null;
    timer?.unref();
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (activeSetupChild === child) activeSetupChild = null;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; options.onOutput?.(String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += chunk; options.onOutput?.(String(chunk)); });
    child.once("error", (error) => { finish(); reject(error); });
    child.once("exit", (code) => {
      finish();
      if (timedOut) return reject(new Error(`Setup action ${action} timed out.`));
      if (code !== 0) return reject(new Error((stderr || stdout || `Setup action ${action} failed with code ${code}`).trim()));
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || "{}";
      try { resolve(JSON.parse(last)); }
      catch { reject(new Error(`Setup action ${action} returned an invalid result.`)); }
    });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

async function refreshProviderStatus(force = false) {
  if (!force && providerStatus && Date.now() - providerStatusAt < 2500) return providerStatus;
  try {
    providerStatus = await runSetupAction("Status");
    providerStatusAt = Date.now();
  } catch (error) {
    providerStatus = { error: error.message };
    providerStatusAt = Date.now();
  }
  return providerStatus;
}

async function refreshIssueStates() {
  const next = [];
  for (const issue of SECURE_TUNNEL_ISSUES) {
    try {
      const response = await fetch(`https://api.github.com/repos/openai/tunnel-client/issues/${issue.number}`, {
        headers: { "user-agent": "DevRelay-Setup", accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(3500)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      next.push({ ...issue, title: value.title || issue.title, state: value.state === "closed" ? "closed" : "open" });
    } catch {
      next.push({ ...issue, state: "unknown" });
    }
  }
  issueStates = next;
}
void refreshIssueStates();

const linkTargets = {
  "openai-tunnels": "https://platform.openai.com/settings/organization/tunnels",
  "openai-api-keys": "https://platform.openai.com/settings/organization/api-keys",
  "chatgpt-settings": "https://chatgpt.com/#settings/Connectors",
  "tailscale": "https://login.tailscale.com/admin/machines",
  "cloudflare": "https://dash.cloudflare.com/",
  "issue-71": "https://github.com/openai/tunnel-client/issues/71",
  "issue-57": "https://github.com/openai/tunnel-client/issues/57",
  "issue-41": "https://github.com/openai/tunnel-client/issues/41"
};

async function openLink(target) {
  const url = linkTargets[target];
  if (!url) throw new Error("Unknown link target.");
  await execFilePromise("cmd.exe", ["/d", "/c", "start", "", url]);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function apiState() {
  return {
    theme: "white-soft",
    running: false,
    starting: false,
    stopping: false,
    current: currentSetup,
    currentLabel: connectionLabel(currentSetup.connection),
    currentEndpoint: connectionPublicUrl(currentSetup.connection),
    draft: draftConnection,
    draftReady,
    providerStatus: await refreshProviderStatus(),
    issues: issueStates,
    busy,
    busyMessage,
    approvalUrl,
    error: lastError
  };
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(req, res, url) {
  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(path.resolve(publicDir) + path.sep) && filePath !== path.join(path.resolve(publicDir), "index.html")) {
    res.writeHead(404).end(); return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}

async function withBusy(message, fn) {
  if (busy) throw new Error("Another setup operation is already running.");
  busy = true;
  busyMessage = message;
  approvalUrl = null;
  lastError = null;
  try { return await fn(); }
  catch (error) { lastError = error.message; throw error; }
  finally { busy = false; busyMessage = ""; approvalUrl = null; }
}

async function handleAction(body) {
  const action = body.action;
  if (action === "install-tailscale") return await withBusy("Installing Tailscale...", async () => {
    const result = await runSetupAction("InstallTailscale"); await refreshProviderStatus(true); return result;
  });
  if (action === "tailscale-login") return await withBusy("Waiting for Tailscale sign-in...", async () => {
    const result = await runSetupAction("TailscaleLogin"); await refreshProviderStatus(true); return result;
  });
  if (action === "tailscale-prepare") return await withBusy("Enabling and validating Tailscale Funnel...", async () => {
    let observed = "";
    let opened = false;
    const result = await runSetupAction("PrepareTailscale", undefined, {
      timeoutMs: 5 * 60 * 1000,
      onOutput(chunk) {
        observed = (observed + chunk).slice(-16_384);
        const found = extractTailscaleApprovalUrl(observed);
        if (!found) return;
        approvalUrl = found;
        busyMessage = tailscaleApprovalMessage(found);
        if (!opened) {
          opened = true;
          void openTailscaleApproval(found).catch(() => {});
        }
      }
    });
    draftConnection = { kind: "https", provider: "tailscale", publicUrl: result.publicUrl };
    draftReady = true;
    return result;
  });
  if (action === "cloudflare-install") return await withBusy("Preparing cloudflared...", async () => {
    const result = await runSetupAction("EnsureCloudflared"); await refreshProviderStatus(true); return result;
  });
  if (action === "cloudflare-login") return await withBusy("Waiting for Cloudflare sign-in...", async () => {
    const result = await runSetupAction("CloudflareLogin"); await refreshProviderStatus(true); return result;
  });
  if (action === "cloudflare-named") return await withBusy("Creating Cloudflare Named Tunnel and DNS route...", async () => {
    const result = await runSetupAction("ConfigureCloudflareNamed", { hostname: body.hostname, tunnelName: body.tunnelName || "devrelay" });
    draftConnection = { kind: "https", provider: "cloudflare", variant: "named", publicUrl: result.publicUrl };
    draftReady = true;
    return result;
  });
  if (action === "cloudflare-quick") return await withBusy("Preparing Cloudflare Quick Tunnel...", async () => {
    const result = await runSetupAction("PrepareCloudflareQuick");
    draftConnection = { kind: "https", provider: "cloudflare", variant: "quick", persistent: false };
    draftReady = true;
    return result;
  });
  if (action === "openai-configure") return await withBusy("Preparing OpenAI Secure Tunnel...", async () => {
    const result = await runSetupAction("ConfigureOpenAI", { tunnelId: body.tunnelId, apiKey: body.apiKey });
    draftConnection = { kind: "openai-secure-tunnel" };
    draftReady = true;
    return result;
  });
  throw new Error("Unknown setup action.");
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeSetupChild?.pid) await taskkill(activeSetupChild.pid);
  activeSetupChild = null;
  await restoreConnectionBackup();
  await new Promise((resolve) => server.close(resolve));
  if (windowHost?.pid) await taskkill(windowHost.pid);
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const expectedHost = `127.0.0.1:${setupPort}`;
  const expectedOrigin = `http://${expectedHost}`;
  if (req.headers.host !== expectedHost) { res.writeHead(403).end(); return; }
  if (req.method === "POST" && req.headers.origin !== expectedOrigin) { res.writeHead(403).end(); return; }
  const url = new URL(req.url || "/", expectedOrigin);
  try {
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, await apiState());
    if (req.method === "GET" && url.pathname === "/api/progress") {
      return sendJson(res, 200, { busy, busyMessage, approvalUrl, error: lastError });
    }
    if (req.method === "POST" && url.pathname === "/api/select") {
      const body = await readJson(req);
      const choice = body.choice;
      if (choice === "openai") draftConnection = { kind: "openai-secure-tunnel" };
      else if (choice === "tailscale") draftConnection = { kind: "https", provider: "tailscale" };
      else if (choice === "cloudflare-named") draftConnection = { kind: "https", provider: "cloudflare", variant: "named" };
      else if (choice === "cloudflare-quick") draftConnection = { kind: "https", provider: "cloudflare", variant: "quick", persistent: false };
      else throw new Error("Unknown connection choice.");
      draftReady = currentSetup.completed === true && JSON.stringify(draftConnection) === JSON.stringify(currentSetup.connection);
      return sendJson(res, 200, await apiState());
    }
    if (req.method === "POST" && url.pathname === "/api/open-link") {
      const body = await readJson(req); await openLink(body.target); return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readJson(req); const result = await handleAction(body); return sendJson(res, 200, { ...result, state: await apiState() });
    }
    if (req.method === "POST" && url.pathname === "/api/finish") {
      if (!draftConnection || !draftReady) throw new Error("Choose and prepare a connection before finishing.");
      if (draftConnection.kind === "https" && draftConnection.provider !== "cloudflare" && !draftConnection.publicUrl) throw new Error("Prepare the HTTPS connection before finishing.");
      if (draftConnection.kind === "https" && draftConnection.provider === "cloudflare" && draftConnection.variant === "named" && !draftConnection.publicUrl) throw new Error("Create the Named Tunnel before finishing.");
      currentSetup = await saveSetupState(internalRoot, { completed: true, connection: draftConnection });
      await commitConnectionBackup();
      sendJson(res, 200, { ok: true, setup: currentSetup });
      setTimeout(() => { void shutdown(); }, 450).unref();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      await withBusy("Resetting DevRelay connection settings...", async () => { await runSetupAction("ResetLocalConnection"); });
      currentSetup = await resetSetupState(internalRoot);
      await commitConnectionBackup();
      draftConnection = null;
      draftReady = false;
      return sendJson(res, 200, await apiState());
    }
    if (req.method === "POST" && url.pathname === "/api/cancel") {
      sendJson(res, 200, { ok: true }); setTimeout(() => { void shutdown(); }, 100).unref(); return;
    }
    if (req.method === "POST" && url.pathname === "/api/window-close") {
      sendJson(res, 202, { ok: true }); setTimeout(() => { void shutdown(); }, 100).unref(); return;
    }
    if (req.method === "GET") return await serveStatic(req, res, url);
    res.writeHead(404).end();
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

function runPowerShellFile(filePath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath, ...args], {
      cwd: internalRoot, windowsHide: true, stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(filePath)} exited with code ${code ?? "?"}.`)));
  });
}

async function launchWindow() {
  await runPowerShellFile(hostSetupPath, ["-Root", webView2Root]);
  await runPowerShellFile(fontSetupPath, ["-Root", fontRoot]);
  const url = `http://127.0.0.1:${setupPort}/`;
  windowHost = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-File", hostScriptPath,
    "-Url", url, "-SdkRoot", webView2Root, "-ProfileDir", profileDir, "-WindowStatePath", windowStatePath,
    "-Title", "DevRelay Setup", "-SetupMode", "-InitialWidth", "760", "-InitialHeight", "620", "-MinimumWidth", "560", "-MinimumHeight", "480"
  ], { cwd: internalRoot, windowsHide: true, stdio: "ignore" });
  windowHost.once("exit", () => { windowHost = null; if (!shuttingDown) void shutdown(); });
  windowHost.once("error", () => { if (!shuttingDown) void shutdown(); });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  throw error;
});

server.listen(setupPort, "127.0.0.1", () => {
  if (process.env.DEVRELAY_SETUP_HEADLESS === "1") return;
  void launchWindow().catch(() => { void shutdown(); });
});

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
