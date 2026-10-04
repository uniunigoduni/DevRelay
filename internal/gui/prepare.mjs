// Prepares a Linux or macOS checkout: npm dependencies, the TypeScript build, and Electron's binary.
// posix-runtime.mjs calls ensureBuild() on Start; DevRelay.sh runs this file before any window exists.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guiDir = path.dirname(fileURLToPath(import.meta.url));
const internalRoot = path.resolve(guiDir, "..");
const stateDir = path.join(internalRoot, ".devrelay");

async function exists(filePath) { try { await access(filePath); return true; } catch { return false; } }

async function sourceFiles(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const current = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(current));
    else if (entry.isFile() && current.endsWith(".ts")) files.push(current);
  }
  return files;
}

// The GUI runs Electron from node_modules, and `npm ci` deletes it. Adopt an existing install
// until a lockfile hash has been recorded; a later lockfile change still reinstalls.
export function shouldInstall({ hasNodeModules, recordedHash, lockHash }) {
  return !hasNodeModules || (recordedHash ?? lockHash) !== lockHash;
}

export async function ensureBuild({ log, run }) {
  const entryPath = path.join(internalRoot, "dist", "src", "main.js");
  const statePath = path.join(stateDir, "launcher-state.json");
  let state = {};
  try { state = JSON.parse(await readFile(statePath, "utf8")) ?? {}; } catch {}
  let lockHash = "missing";
  try { lockHash = createHash("sha256").update(await readFile(path.join(internalRoot, "package-lock.json"))).digest("hex"); } catch {}
  if (shouldInstall({ hasNodeModules: await exists(path.join(internalRoot, "node_modules")), recordedHash: state.packageLockHash, lockHash })) {
    log("Installing npm dependencies...");
    await run("npm", ["ci"]);
  }
  const entryStat = await stat(entryPath).catch(() => null);
  const inputs = [path.join(internalRoot, "package.json"), path.join(internalRoot, "tsconfig.json"), ...await sourceFiles(path.join(internalRoot, "src"))];
  let stale = !entryStat;
  for (const file of inputs) {
    const inputStat = await stat(file).catch(() => null);
    if (inputStat && entryStat && inputStat.mtimeMs > entryStat.mtimeMs) { stale = true; break; }
  }
  if (stale) {
    log("Building DevRelay...");
    await run("npm", ["run", "build"]);
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify({ packageLockHash: lockHash, lastPreparedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function guiIsRunning() {
  for (const url of ["http://127.0.0.1:7318/api/state", "http://127.0.0.1:7319/api/progress"]) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(700) })).ok) return true;
    } catch {}
  }
  return false;
}

function notify(message) {
  const [file, args] = process.platform === "darwin"
    ? ["osascript", ["-e", `display notification ${JSON.stringify(message)} with title "DevRelay"`]]
    : ["notify-send", ["DevRelay", message]];
  const child = spawn(file, args, { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function runInherited(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: internalRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${file} ${args.join(" ")} exited with code ${code}.`)));
  });
}

// Exit codes for DevRelay.sh: 0 ready, 3 a DevRelay window already owns node_modules, 1 failed.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (await guiIsRunning()) process.exit(3);
    let notified = false;
    const log = (message) => {
      console.log(message);
      if (!notified) { notified = true; notify("Preparing DevRelay. The first start can take a few minutes."); }
    };
    await ensureBuild({ log, run: runInherited });
    if (!await exists(path.join(internalRoot, "node_modules", "electron", "dist"))) log("Downloading Electron...");
    // Electron downloads its binary on first require; do it here instead of while a window is expected.
    createRequire(import.meta.url)("electron");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
