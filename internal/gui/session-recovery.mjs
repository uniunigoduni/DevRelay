import { execFile } from "node:child_process";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SESSION_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}$/i;
const PROCESS_START_TOLERANCE_MS = 30_000;

function normalize(value) {
  return String(value ?? "").replaceAll("/", "\\").toLowerCase();
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function isUncleanSession(meta) {
  if (!meta || meta.endedAt) return false;
  return meta.status === "window-open" || meta.status === "starting" || meta.status === "running";
}

export function trackedProcessMatches(record, actual, { internalRoot }) {
  if (!record || !actual || Number(record.pid) !== Number(actual.processId)) return false;

  const expectedName = String(record.executableName ?? "").toLowerCase();
  const actualName = String(actual.name ?? "").toLowerCase();
  if (expectedName && expectedName !== actualName) return false;
  if (Number(record.parentPid) > 0 && Number(actual.parentProcessId) > 0 && Number(record.parentPid) !== Number(actual.parentProcessId)) return false;

  const expectedPath = normalize(record.executablePath);
  const actualPath = normalize(actual.executablePath);
  if (expectedPath && (!actualPath || expectedPath !== actualPath)) return false;

  const expectedStart = Date.parse(record.startedAt ?? "");
  const actualStart = Date.parse(actual.creationDate ?? "");
  if (Number.isFinite(expectedStart)) {
    if (!Number.isFinite(actualStart) || Math.abs(actualStart - expectedStart) > PROCESS_START_TOLERANCE_MS) return false;
  }

  const commandLine = normalize(actual.commandLine);
  for (const fragment of Array.isArray(record.commandIncludes) ? record.commandIncludes : []) {
    if (fragment && !commandLine.includes(normalize(fragment))) return false;
  }

  if (record.role === "launcher") {
    const launcherPath = normalize(path.join(internalRoot, "scripts", "DevRelay-Launcher.ps1"));
    if (!commandLine.includes(launcherPath)) return false;
  } else if (record.role === "runtime") {
    const runtimePath = normalize(path.join(internalRoot, "dist", "src", "main.js"));
    if (!commandLine.includes(runtimePath)) return false;
  } else if (record.role === "window-host") {
    const hostPath = normalize(path.join(internalRoot, "gui", "host", "DevRelay-GuiHost.ps1"));
    if (!commandLine.includes(hostPath)) return false;
  } else if (record.role === "controller") {
    const controllerPath = normalize(path.join(internalRoot, "gui", "devrelay-gui.mjs"));
    if (!commandLine.includes(controllerPath)) return false;
  }

  return true;
}

export function selectSessionOwnedProcesses({ sessionDir, internalRoot, sessionMeta, processState, processes }) {
  const selected = new Map();
  const records = [
    processState?.tunnel,
    processState?.runtime,
    processState?.launcher,
    sessionMeta?.windowHost,
    sessionMeta?.controller
  ].filter(Boolean);

  for (const record of records) {
    const actual = processes.find((process) => Number(process.processId) === Number(record.pid));
    if (actual && trackedProcessMatches(record, actual, { internalRoot })) {
      selected.set(Number(actual.processId), { role: record.role ?? "tracked", process: actual });
    }
  }

  // v0.4.0 and earlier did not persist child PIDs. A cloudflared process is still
  // safely attributable to a session when its command line contains that exact
  // session directory as the --logfile location.
  const sessionNeedle = normalize(sessionDir);
  for (const actual of processes) {
    if (String(actual.name ?? "").toLowerCase() !== "cloudflared.exe") continue;
    if (!normalize(actual.commandLine).includes(sessionNeedle)) continue;
    selected.set(Number(actual.processId), { role: "legacy-tunnel", process: actual });
  }

  const priority = new Map([["tunnel", 0], ["legacy-tunnel", 0], ["runtime", 1], ["launcher", 2], ["window-host", 3], ["controller", 4]]);
  return [...selected.values()].sort((a, b) => (priority.get(a.role) ?? 10) - (priority.get(b.role) ?? 10));
}

export async function queryWindowsProcesses() {
  if (process.platform !== "win32") return [];
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$names = @('node.exe','powershell.exe','pwsh.exe','cloudflared.exe','tailscale.exe','tunnel-client.exe')",
    "$items = Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | ForEach-Object {",
    "  [pscustomobject]@{ processId=[int]$_.ProcessId; parentProcessId=[int]$_.ParentProcessId; name=[string]$_.Name; executablePath=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine; creationDate=if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }",
    "}",
    "@($items) | ConvertTo-Json -Compress -Depth 4"
  ].join("; ");

  return await new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const parsed = JSON.parse(String(stdout || "[]"));
          resolve(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
        } catch (parseError) {
          reject(parseError);
        }
      });
  });
}

export async function queryRecentWindowsEvents(minutes = 15, limit = 120) {
  if (process.platform !== "win32") return [];
  const safeMinutes = Math.max(1, Math.min(360, Number(minutes) || 15));
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 120));
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    `$start = (Get-Date).AddMinutes(-${safeMinutes})`,
    "$powerIds = @(1,12,13,41,42,107,109,506,507,6005,6006,6008)",
    "$events = @()",
    "$events += Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=$start} -ErrorAction SilentlyContinue | Where-Object { $_.Level -le 3 }",
    "$events += Get-WinEvent -FilterHashtable @{LogName='System';StartTime=$start} -ErrorAction SilentlyContinue | Where-Object { $_.Level -le 3 -or $powerIds -contains $_.Id -or $_.ProviderName -match 'Kernel-Power|Power-Troubleshooter' }",
    "$events += Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-PowerShell/Operational';StartTime=$start} -ErrorAction SilentlyContinue | Where-Object { $_.Level -le 3 }",
    `$items = $events | Sort-Object TimeCreated -Descending | Select-Object -First ${safeLimit} | ForEach-Object {`,
    "  $message = [string]$_.Message; if ($message.Length -gt 2000) { $message = $message.Substring(0,2000) }",
    "  [pscustomobject]@{ at=if ($_.TimeCreated) { $_.TimeCreated.ToUniversalTime().ToString('o') } else { $null }; log=[string]$_.LogName; provider=[string]$_.ProviderName; id=[int]$_.Id; level=[string]$_.LevelDisplayName; message=$message }",
    "}",
    "@($items) | ConvertTo-Json -Compress -Depth 4"
  ].join("; ");
  return await new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const parsed = JSON.parse(String(stdout || "[]"));
          resolve(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
        } catch (parseError) { reject(parseError); }
      });
  });
}

async function killProcessTree(pid) {
  return await new Promise((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      resolve({ ok: !error, error: error?.message ?? null });
    });
  });
}

export async function recoverUncleanSessions({
  logsRoot,
  internalRoot,
  queryProcesses = queryWindowsProcesses,
  killProcess = killProcessTree,
  now = () => new Date()
}) {
  let entries = [];
  try { entries = await readdir(logsRoot, { withFileTypes: true }); }
  catch { return []; }

  const sessionNames = entries
    .filter((entry) => entry.isDirectory() && SESSION_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (!sessionNames.length) return [];

  let processes = [];
  try { processes = await queryProcesses(); }
  catch (error) {
    return [{ type: "recovery-scan-error", message: error instanceof Error ? error.message : String(error) }];
  }

  const events = [];
  for (const sessionName of sessionNames) {
    const sessionDir = path.join(logsRoot, sessionName);
    const sessionPath = path.join(sessionDir, "session.json");
    const meta = await readJson(sessionPath);
    if (!isUncleanSession(meta)) continue;

    const processState = await readJson(path.join(sessionDir, "processes.json"));
    const owned = selectSessionOwnedProcesses({ sessionDir, internalRoot, sessionMeta: meta, processState, processes });
    const cleaned = [];
    for (const item of owned) {
      const result = await killProcess(item.process.processId);
      cleaned.push({ role: item.role, pid: item.process.processId, name: item.process.name, ok: result?.ok !== false, error: result?.error ?? null });
    }

    const detectedAt = now().toISOString();
    const nextMeta = {
      ...meta,
      status: "unclean",
      exitReason: meta.exitReason ?? "unclean controller exit detected on next launch",
      detectedUncleanAt: detectedAt,
      recovery: { detectedAt, cleaned }
    };
    await writeFile(sessionPath, `${JSON.stringify(nextMeta, null, 2)}\n`, "utf8");
    try {
      await appendFile(path.join(sessionDir, "lifecycle.ndjson"), `${JSON.stringify({ at: detectedAt, event: "session.unclean-detected", cleaned })}\n`, "utf8");
    } catch { /* best effort postmortem record */ }
    events.push({ type: "unclean-session", sessionName, sessionDir, cleaned, lastHeartbeatAt: meta.lastHeartbeatAt ?? meta.startedAt ?? null });
  }
  return events;
}
