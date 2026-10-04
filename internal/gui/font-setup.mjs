import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guiDir = path.dirname(fileURLToPath(import.meta.url));
// Pinned to the google/fonts commit that added Noto Sans Mono 2.014 (same URL as host/Ensure-NotoSansMono.ps1).
export const FONT_URL = "https://raw.githubusercontent.com/google/fonts/a23c2cd328ea51097b6e32d8f9e0241261e2495e/ofl/notosansmono/NotoSansMono%5Bwdth%2Cwght%5D.ttf";
export const FONT_SHA256 = "2cb2adb378a8f574213e23df697050b83c54c27df465a2015552740b2769a081";
const INSTALLED_NAME = "NotoSansMono[wdth,wght].ttf";

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, missing: error?.code === "ENOENT", stdout: String(stdout ?? "") }));
  });
}

export function userFontDir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === "darwin") return path.join(home, "Library", "Fonts");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "fonts");
}

export function isNotoSansMonoFile(name) {
  return /^notosansmono/.test(String(name).toLowerCase().replace(/[\s_-]/g, "")) && /\.(ttf|otf|ttc)$/i.test(name);
}

async function hasFontFile(folders) {
  for (const folder of folders) {
    if ((await readdir(folder).catch(() => [])).some(isNotoSansMonoFile)) return true;
  }
  return false;
}

async function isInstalled(platform) {
  if (platform === "linux") {
    const listed = await run("fc-list", ["Noto Sans Mono", "family"]);
    if (!listed.missing) return listed.ok && listed.stdout.trim() !== "";
  }
  const folders = platform === "darwin"
    ? [userFontDir(platform), "/Library/Fonts", "/System/Library/Fonts", "/System/Library/Fonts/Supplemental"]
    : [userFontDir(platform)];
  return await hasFontFile(folders);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function downloadVerifiedFont(cachePath, { fetchImpl = fetch, url = FONT_URL, expectedSha256 = FONT_SHA256 } = {}) {
  const cached = await readFile(cachePath).catch(() => null);
  if (cached && sha256(cached) === expectedSha256) return;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Noto Sans Mono download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expectedSha256) throw new Error("Noto Sans Mono download failed its SHA-256 check.");
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.download`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, cachePath);
  } finally { await rm(temporary, { force: true }); }
}

// Installs Noto Sans Mono for the current user when it is missing, as the WPF host did on Windows.
export async function ensureNotoSansMono(stateDir, { platform = process.platform } = {}) {
  const fontRoot = path.join(stateDir, "fonts");
  if (platform === "win32") {
    const script = path.join(guiDir, "host", "Ensure-NotoSansMono.ps1");
    const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Root", fontRoot]);
    if (!result.ok) throw new Error("Ensure-NotoSansMono.ps1 failed.");
    return;
  }
  if (platform !== "darwin" && platform !== "linux") return;
  if (await isInstalled(platform)) return;
  const cachePath = path.join(fontRoot, "NotoSansMono.ttf");
  await downloadVerifiedFont(cachePath);
  const folder = userFontDir(platform);
  await mkdir(folder, { recursive: true });
  await copyFile(cachePath, path.join(folder, INSTALLED_NAME));
  if (platform === "linux") await run("fc-cache", ["-f", folder]);
}
