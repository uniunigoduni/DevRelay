import { spawn } from "node:child_process";
import { appendFile, access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuild } from "./prepare.mjs";
import { tailscalePath } from "./setup/provider-actions.mjs";

const guiDir = path.dirname(fileURLToPath(import.meta.url));
const internalRoot = path.resolve(guiDir, "..");
const stateDir = path.join(internalRoot, ".devrelay");
const [portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("A valid MCP port is required.");

const hostAddress = "127.0.0.1";
const mcpUrl = `http://${hostAddress}:${port}/mcp`;
const sessionDir = process.env.DEVRELAY_SESSION_DIR || "";
const sessionId = process.env.DEVRELAY_SESSION_ID || "";
const processStatePath = sessionDir ? path.join(sessionDir, "processes.json") : "";
const lifecyclePath = sessionDir ? path.join(sessionDir, "launcher-lifecycle.ndjson") : "";
const launcherScriptPath = fileURLToPath(import.meta.url);
const tracked = { runtime: null, tunnel: null };
const activeChildren = new Set();
let currentConnection = null;
let stopping = false;

function log(message) { process.stdout.write(`[DevRelay] ${message}\n`); }
function now() { return new Date().toISOString(); }
function appendLifecycle(event, detail = {}) {
  if (!lifecyclePath) return;
  const line = `${JSON.stringify({ at: now(), event, launcherPid: process.pid, sessionId: sessionId || null, ...detail })}\n`;
  void appendFile(lifecyclePath, line, "utf8").catch(() => {});
}
async function writeProcessState(status) {
  if (!processStatePath) return;
  const value = {
    sessionId: sessionId || null,
    updatedAt: now(),
    status,
    controllerPid: Number(process.env.DEVRELAY_CONTROLLER_PID) || null,
    launcher: {
      role: "launcher", pid: process.pid, parentPid: process.ppid, startedAt: startedAt,
      executableName: path.basename(process.execPath), executablePath: process.execPath,
      commandIncludes: [launcherScriptPath, String(port)]
    },
    runtime: tracked.runtime,
    tunnel: tracked.tunnel
  };
  await writeFile(processStatePath, `${JSON.stringify(value, null, 2)}\n`, "utf8").catch(() => {});
}

const startedAt = now();
async function ensureDirectory(folder) { await mkdir(folder, { recursive: true, mode: 0o700 }); }
async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

function spawnCommand(file, args, { cwd = internalRoot, env = process.env, onOutput = () => {}, logOutput = true } = {}) {
  const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let outputTail = "";
  let readyResolve;
  let readyReject;
  let hasSpawned = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const completion = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        const text = String(chunk);
        outputTail = (outputTail + text).slice(-32_768);
        onOutput(text);
        if (logOutput) for (const line of text.replace(/\r/g, "").split("\n").filter(Boolean)) log(line);
      });
    }
    child.once("spawn", () => { hasSpawned = true; readyResolve(child); });
    child.once("error", (error) => {
      if (!hasSpawned) readyReject(error);
      reject(error);
    });
    child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, outputTail }));
  });
  activeChildren.add(child);
  completion.finally(() => activeChildren.delete(child)).catch(() => {});
  completion.catch(() => {});
  return { child, ready, completion, get outputTail() { return outputTail; } };
}

async function runCommand(file, args, options = {}) {
  const result = await spawnCommand(file, args, options).completion;
  if (result.code !== 0) throw new Error(`${path.basename(file)} exited with code ${result.code}. ${result.outputTail}`.trim());
  return result;
}

function makeProcessRecord(role, file, args, child) {
  return {
    role,
    pid: child.pid,
    parentPid: process.pid,
    startedAt: now(),
    executableName: path.basename(file),
    executablePath: file,
    commandIncludes: [file, ...args]
  };
}

async function trackedSpawn(role, file, args, options = {}) {
  const running = spawnCommand(file, args, options);
  await running.ready;
  tracked[role] = makeProcessRecord(role, file, args, running.child);
  appendLifecycle(`${role}.start`, { pid: running.child.pid, startedAt: tracked[role].startedAt, executableName: tracked[role].executableName });
  await writeProcessState("running");
  running.completion.then((result) => {
    appendLifecycle(`${role}.exit`, { pid: running.child.pid, exitCode: result.code, signal: result.signal });
    if (tracked[role]?.pid === running.child.pid) tracked[role] = null;
    void writeProcessState(`${role}-exited`);
  }).catch((error) => {
    appendLifecycle(`${role}.error`, { pid: running.child.pid, message: error.message });
    if (tracked[role]?.pid === running.child.pid) tracked[role] = null;
    void writeProcessState(`${role}-error`);
  });
  return running;
}

async function isPortOpen() {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: hostAddress, port });
    socket.setTimeout(400);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function waitForPort(processHandle, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
      const result = await processHandle.completion;
      throw new Error(`DevRelay exited during startup with code ${result.code}.`);
    }
    if (await isPortOpen()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DevRelay did not become ready on ${mcpUrl}.`);
}

function pathCandidates(name) {
  return String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((folder) => path.join(folder, name));
}
async function findExecutable(name) {
  for (const candidate of pathCandidates(name)) {
    try { await access(candidate, 1); return candidate; } catch {}
  }
  return null;
}
async function providerExecutable(name, stateName, archSuffix) {
  const fromPath = await findExecutable(name);
  if (fromPath) return fromPath;
  const local = path.join(stateDir, "tools", stateName, `${name}-${process.platform}-${archSuffix}`);
  try { await access(local, 1); return local; } catch {}
  throw new Error(`${name} is not installed. Reopen Connection Setup.`);
}
function platformArch() {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`Unsupported ${process.platform} architecture: ${process.arch}`);
}
function getDnsName(status) { return String(status?.Self?.DNSName ?? "").replace(/\.+$/, "") || null; }

async function exists(filePath) { try { await access(filePath); return true; } catch { return false; } }

async function startDevRelay(env) {
  if (await isPortOpen()) throw new Error(`TCP port ${port} is already in use. Stop the existing listener or change the Port setting.`);
  const entry = path.join(internalRoot, "dist", "src", "main.js");
  log(`Starting DevRelay HTTP MCP at ${mcpUrl}...`);
  const runtime = await trackedSpawn("runtime", process.execPath, [entry, "--http", "--host", hostAddress, "--port", String(port)], { env });
  await waitForPort(runtime);
  log("DevRelay is ready.");
  return runtime;
}

async function startQuickTunnel(executable) {
  log("Creating Cloudflare temporary URL...");
  let foundUrl = null;
  const quick = await trackedSpawn("tunnel", executable, ["tunnel", "--url", `http://${hostAddress}:${port}`, "--loglevel", "info"], {
    onOutput(chunk) {
      const match = chunk.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) foundUrl = `${match[0]}/mcp`;
    }
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !foundUrl) {
    if (quick.child.exitCode !== null || quick.child.signalCode !== null) throw new Error("cloudflared temporary URL exited during startup.");
    const match = quick.outputTail.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) foundUrl = `${match[0]}/mcp`;
    if (!foundUrl) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!foundUrl) throw new Error("Cloudflare temporary URL did not become available within 20 seconds.");
  return { running: quick, publicUrl: foundUrl };
}

async function startNamedTunnel(executable, settings) {
  const credentialsPath = settings.credentialsPath;
  if (!settings.tunnelId || !settings.tunnelName || !settings.hostname || !credentialsPath || !await exists(credentialsPath)) {
    throw new Error("Cloudflare custom hostname settings are incomplete. Reopen Connection Setup.");
  }
  const runtimeDir = path.join(stateDir, "cloudflare-runtime");
  await ensureDirectory(runtimeDir);
  const configPath = path.join(runtimeDir, "config.yml");
  const config = `tunnel: ${settings.tunnelId}\ncredentials-file: ${JSON.stringify(credentialsPath)}\ningress:\n  - hostname: ${settings.hostname}\n    service: http://${hostAddress}:${port}\n    originRequest:\n      httpHostHeader: localhost\n  - service: http_status:404\n`;
  await writeFile(configPath, config, { encoding: "utf8", mode: 0o600 });
  const logPath = path.join(sessionDir || stateDir, "cloudflared-named.log");
  await rm(logPath, { force: true });
  const tunnel = await trackedSpawn("tunnel", executable, ["tunnel", "--config", configPath, "--loglevel", "info", "--logfile", logPath, "run", settings.tunnelName]);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) {
      const result = await tunnel.completion;
      throw new Error(`cloudflared exited during startup with code ${result.code}.`);
    }
    const details = await readFile(logPath, "utf8").catch(() => "");
    if (details.includes("Registered tunnel connection")) return { running: tunnel, publicUrl: `https://${settings.hostname}/mcp` };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Cloudflare custom hostname did not become ready within 20 seconds.");
}

async function startTailscaleTunnel(executable) {
  log("Starting Tailscale Funnel...");
  return await trackedSpawn("tunnel", executable, ["funnel", "--yes", "--https=443", `127.0.0.1:${port}`]);
}

async function startOpenAITunnel(executable, profile, env) {
  await runCommand(executable, ["doctor", "--profile", profile, "--profile-dir", path.join(stateDir, "tunnel-profiles"), "--explain"], { env });
  const tunnel = await trackedSpawn("tunnel", executable, ["run", "--profile", profile, "--profile-dir", path.join(stateDir, "tunnel-profiles")], { env });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) {
    const result = await tunnel.completion;
    throw new Error(`OpenAI tunnel-client exited during startup with code ${result.code}.`);
  }
  return tunnel;
}

async function runLauncher() {
  await ensureDirectory(stateDir);
  await chmod(stateDir, 0o700).catch(() => {});
  appendLifecycle("launcher.start", { parentPid: process.ppid, startedAt, port });
  await writeProcessState("launcher-started");
  await ensureBuild({ log, run: (file, args) => runCommand(file, args, { env: process.env }) });
  const setup = await readJson(path.join(stateDir, "setup.json"));
  if (!setup?.completed || !setup.connection) throw new Error("DevRelay connection setup is incomplete. Open Connection Setup first.");
  currentConnection = setup.connection;
  const connection = currentConnection;
  const description = connection.kind === "openai-secure-tunnel" ? "OpenAI Secure Tunnel"
    : connection.provider === "tailscale" ? "HTTPS / Tailscale Funnel"
    : connection.provider === "cloudflare" && connection.variant === "quick" ? "HTTPS / Cloudflare temporary URL"
    : connection.provider === "cloudflare" && connection.variant === "named" ? "HTTPS / Cloudflare custom hostname"
    : null;
  if (!description) throw new Error("Unsupported connection setup. Reopen Connection Setup.");
  log(`Using ${description}.`);

  let publicUrl = null;
  let tunnel = null;
  let runtime = null;
  const runtimeEnv = { ...process.env, DEVRELAY_STATE_DIR: stateDir };
  const isHttps = connection.kind === "https";

  if (connection.kind === "openai-secure-tunnel") {
    const config = await readJson(path.join(stateDir, "launcher.json"));
    const apiKey = await readFile(path.join(stateDir, "control-plane-api-key"), "utf8").catch(() => "");
    if (!config?.tunnelId || !apiKey.trim()) throw new Error("OpenAI Secure Tunnel credentials are incomplete. Reopen Connection Setup.");
    const tunnelExe = path.join(internalRoot, "tools", "tunnel-client", "tunnel-client");
    if (!await exists(tunnelExe)) throw new Error("OpenAI tunnel-client is missing. Reopen Connection Setup.");
    const profile = String(config.profile || "devrelay");
    const profileDir = path.join(stateDir, "tunnel-profiles");
    await ensureDirectory(profileDir);
    const apiEnv = { ...runtimeEnv, CONTROL_PLANE_API_KEY: apiKey };
    await runCommand(tunnelExe, ["init", "--sample", "sample_mcp_remote_no_auth", "--profile", profile, "--profile-dir", profileDir, "--tunnel-id", config.tunnelId, "--mcp-server-url", mcpUrl, "--health-listen-addr", "127.0.0.1:0", "--force"], { env: apiEnv });
    runtime = await startDevRelay(runtimeEnv);
    tunnel = await startOpenAITunnel(tunnelExe, profile, apiEnv);
    log("DevRelay is online for ChatGPT.");
    log(`Local MCP: ${mcpUrl}`);
    log(`Tunnel ID: ${config.tunnelId}`);
  } else if (connection.provider === "cloudflare" && connection.variant === "quick") {
    const cloudflared = await providerExecutable("cloudflared", "cloudflared", platformArch());
    const quick = await startQuickTunnel(cloudflared);
    publicUrl = quick.publicUrl;
    tunnel = quick.running;
  } else if (connection.provider === "tailscale") {
    const tailscale = await tailscalePath();
    if (!tailscale) throw new Error("Tailscale is not installed. Reopen Connection Setup.");
    const statusResult = await spawnCommand(tailscale, ["status", "--json"], { logOutput: false }).completion;
    if (statusResult.code !== 0) throw new Error("Tailscale is not signed in.");
    let status;
    try { status = JSON.parse(statusResult.outputTail); }
    catch { throw new Error("Tailscale returned invalid status JSON."); }
    const dnsName = getDnsName(status);
    if (!dnsName) throw new Error("Tailscale is not signed in. Reopen Connection Setup.");
    publicUrl = `https://${dnsName}/mcp`;
  } else if (connection.provider === "cloudflare" && connection.variant === "named") {
    const cloudflared = await providerExecutable("cloudflared", "cloudflared", platformArch());
    const named = await readJson(path.join(stateDir, "cloudflare-named.json")) || await readJson(path.join(stateDir, "https-named.json"));
    if (!named?.hostname) throw new Error("Cloudflare custom hostname setup is incomplete. Reopen Connection Setup.");
    publicUrl = `https://${named.hostname}/mcp`;
  }

  if (isHttps) {
    const publicUri = new URL(publicUrl);
    runtimeEnv.DEVRELAY_OAUTH_ISSUER = publicUri.origin;
    runtimeEnv.DEVRELAY_OAUTH_RESOURCE = publicUrl;
  }

  if (!runtime) runtime = await startDevRelay(runtimeEnv);

  if (connection.provider === "tailscale") {
    const tailscale = await tailscalePath();
    tunnel = await startTailscaleTunnel(tailscale);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) throw new Error("Tailscale Funnel exited during startup.");
  } else if (connection.provider === "cloudflare" && connection.variant === "named") {
    const cloudflared = await providerExecutable("cloudflared", "cloudflared", platformArch());
    const named = await readJson(path.join(stateDir, "cloudflare-named.json")) || await readJson(path.join(stateDir, "https-named.json"));
    tunnel = (await startNamedTunnel(cloudflared, named)).running;
  }

  log("DevRelay HTTPS is online.");
  log(`Local MCP: ${mcpUrl}`);
  log(`Public MCP: ${publicUrl}`);
  const result = await Promise.race([runtime.completion.then((value) => ({ role: "runtime", value })), tunnel.completion.then((value) => ({ role: "tunnel", value }))]);
  if (!stopping) throw new Error(`${result.role} process exited with code ${result.value.code}.`);
}

async function stopChildren() {
  for (const child of activeChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill("SIGTERM"); } catch {}
  }
  await Promise.race([
    Promise.all([...activeChildren].map((child) => new Promise((resolve) => child.once("exit", resolve)))),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) try { child.kill("SIGKILL"); } catch {}
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  appendLifecycle("launcher.signal", { signal });
  await stopChildren();
  if (currentConnection?.provider === "tailscale") {
    const tailscale = await tailscalePath();
    if (tailscale) await spawnCommand(tailscale, ["funnel", "reset"], { logOutput: false }).completion.catch(() => {});
  }
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

try {
  await runLauncher();
} catch (error) {
  log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  appendLifecycle("launcher.error", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  stopping = true;
  await stopChildren();
  await writeProcessState(process.exitCode ? "error" : "stopped");
  if (tracked.runtime) appendLifecycle("runtime.clear", { pid: tracked.runtime.pid, reason: "launcher-exit" });
  if (tracked.tunnel) appendLifecycle("tunnel.clear", { pid: tracked.tunnel.pid, reason: "launcher-exit" });
  if (currentConnection?.provider === "tailscale") {
    const tailscale = await tailscalePath();
    if (tailscale) await spawnCommand(tailscale, ["funnel", "reset"], { logOutput: false }).completion.catch(() => {});
  }
  tracked.runtime = null;
  tracked.tunnel = null;
  await writeProcessState(process.exitCode ? "error" : "stopped");
  appendLifecycle("launcher.exit", { exitCode: process.exitCode || 0 });
}
