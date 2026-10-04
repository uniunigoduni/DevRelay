import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const internalRoot = path.resolve(setupDir, "../..");
const platformLabel = process.platform === "darwin" ? "macOS" : "Linux";
const tailscaleInstallHint = process.platform === "darwin"
  ? "Install the Tailscale app for macOS"
  : "Install the official Tailscale package for your Linux distribution";
const MACOS_TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  CRC32_TABLE[index] = value >>> 0;
}

function platformArch(platform, arch) {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`Unsupported ${platform} architecture: ${arch}`);
}

export function selectOpenAITunnelClientAsset(assets, arch, platform = process.platform) {
  const pattern = new RegExp(`^tunnel-client-v[^/]+-${platform}-${arch}\\.zip$`, "i");
  return assets.find((asset) => pattern.test(String(asset.name ?? ""))) ?? null;
}

function zipEntries(archive) {
  const firstPossibleEnd = Math.max(0, archive.length - 22 - 0xffff);
  let endRecord = -1;
  for (let offset = archive.length - 22; offset >= firstPossibleEnd; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) { endRecord = offset; break; }
  }
  if (endRecord < 0) throw new Error("The OpenAI tunnel-client archive is not a valid ZIP file.");
  const diskNumber = archive.readUInt16LE(endRecord + 4);
  const centralDisk = archive.readUInt16LE(endRecord + 6);
  const entriesOnDisk = archive.readUInt16LE(endRecord + 8);
  const entryCount = archive.readUInt16LE(endRecord + 10);
  const centralSize = archive.readUInt32LE(endRecord + 12);
  const centralOffset = archive.readUInt32LE(endRecord + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || centralOffset + centralSize > endRecord) {
    throw new Error("Multi-disk or ZIP64 tunnel-client archives are not supported.");
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralOffset + centralSize || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("The OpenAI tunnel-client archive has an invalid file index.");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > centralOffset + centralSize) throw new Error("The OpenAI tunnel-client archive has a truncated file index.");
    entries.push({
      name: archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
      flags, method, checksum, compressedSize, uncompressedSize, localOffset
    });
    offset = nextOffset;
  }
  return entries;
}

function isSafeExecutableEntry(name) {
  if (typeof name !== "string" || name.includes("\\") || name.includes("\0")) return false;
  if (name.startsWith("/") || /^[a-z]:/i.test(name)) return false;
  const parts = name.split("/");
  return parts.at(-1) === "tunnel-client" && parts.every((part) => part && part !== "." && part !== "..");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function extractOpenAITunnelClientArchive(archivePath, destination) {
  const archive = await readFile(archivePath);
  const entry = zipEntries(archive)
    .filter((item) => isSafeExecutableEntry(item.name))
    .sort((left, right) => left.name.length - right.name.length)[0];
  if (!entry) throw new Error("The OpenAI tunnel-client archive did not contain a safe tunnel-client executable.");
  if ((entry.flags & 1) !== 0) throw new Error("Encrypted tunnel-client archives are not supported.");
  if (entry.uncompressedSize <= 0 || entry.uncompressedSize > 512 * 1024 * 1024) {
    throw new Error("The OpenAI tunnel-client executable has an invalid size.");
  }
  const header = entry.localOffset;
  if (header + 30 > archive.length || archive.readUInt32LE(header) !== 0x04034b50) {
    throw new Error("The OpenAI tunnel-client archive has an invalid file header.");
  }
  const localFlags = archive.readUInt16LE(header + 6);
  const localMethod = archive.readUInt16LE(header + 8);
  const localNameLength = archive.readUInt16LE(header + 26);
  const localExtraLength = archive.readUInt16LE(header + 28);
  const localName = archive.subarray(header + 30, header + 30 + localNameLength).toString("utf8");
  if (localFlags !== entry.flags || localMethod !== entry.method || localName !== entry.name) {
    throw new Error("The OpenAI tunnel-client archive has mismatched file headers.");
  }
  const dataOffset = header + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > archive.length) throw new Error("The OpenAI tunnel-client archive has truncated executable data.");
  const compressed = archive.subarray(dataOffset, dataEnd);
  let executable;
  if (entry.method === 0) executable = Buffer.from(compressed);
  else if (entry.method === 8) executable = inflateRawSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  else throw new Error(`Unsupported tunnel-client ZIP compression method: ${entry.method}.`);
  if (executable.length !== entry.uncompressedSize || crc32(executable) !== entry.checksum) {
    throw new Error("The OpenAI tunnel-client executable failed ZIP integrity checks.");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, executable, { mode: 0o700 });
  await chmod(destination, 0o700);
}

function executableCandidates(name, env = process.env) {
  return String(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((folder) => path.join(folder, name));
}

async function findExecutable(name, env = process.env) {
  for (const candidate of executableCandidates(name, env)) {
    try { await access(candidate, 1); return candidate; } catch {}
  }
  return null;
}

async function run(file, args, { cwd = internalRoot, env = process.env, onOutput = () => {}, signal } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; onOutput(String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += chunk; onOutput(String(chunk)); });
    const abort = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
    child.once("exit", (code, childSignal) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code: code ?? (childSignal ? 1 : 0), stdout, stderr });
    });
  });
}

async function runChecked(file, args, options = {}) {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    throw new Error(detail || `${path.basename(file)} exited with code ${result.code}.`);
  }
  return result;
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function writeJson(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await chmod(filePath, mode).catch(() => {});
}

export async function copyPrivateCredential(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

export async function ensureCloudflareCredential(executable, tunnelId, source, destination, { signal } = {}) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(destination), 0o700).catch(() => {});
  const sourceExists = await access(source).then(() => true, () => false);
  if (sourceExists) {
    await copyPrivateCredential(source, destination);
  } else {
    await rm(destination, { force: true });
    const recovered = await run(executable, ["tunnel", "token", "--cred-file", destination, tunnelId], { signal });
    if (recovered.code !== 0) {
      await rm(destination, { force: true });
      throw new Error("Cloudflare's local tunnel credentials are missing, and cloudflared could not restore them. Sign in to Cloudflare again or choose a tunnel with available credentials.");
    }
    await chmod(destination, 0o600).catch(() => {});
  }

  const credentials = await readJson(destination);
  if (String(credentials?.TunnelID ?? credentials?.tunnelId ?? "").toLowerCase() !== String(tunnelId).toLowerCase()) {
    await rm(destination, { force: true });
    throw new Error("Cloudflare returned credentials for a different or invalid tunnel.");
  }
  await chmod(destination, 0o600).catch(() => {});
  return destination;
}

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "DevRelay-Setup", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Release lookup failed with HTTP ${response.status}.`);
  return await response.json();
}

async function downloadAsset(asset, destination) {
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== "https:" || !["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(url.hostname)) {
    throw new Error("The provider release returned an untrusted download URL.");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(finalUrl.hostname)) {
    throw new Error("The provider download redirected to an untrusted host.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes, { mode: 0o600 });
  const digest = String(asset.digest ?? "");
  if (digest.startsWith("sha256:")) {
    const expected = digest.slice(7).toLowerCase();
    if (await sha256(destination) !== expected) {
      await rm(destination, { force: true });
      throw new Error("Provider download checksum mismatch.");
    }
  }
}

function parseJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("External command did not return a JSON array.");
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { throw new Error("External command returned invalid JSON."); }
}

// The macOS app bundles its CLI without adding it to PATH.
export async function tailscalePath({ env = process.env, platform = process.platform, appCli = MACOS_TAILSCALE_CLI } = {}) {
  const fromPath = await findExecutable("tailscale", env);
  if (fromPath || platform !== "darwin") return fromPath;
  try { await access(appCli, 1); return appCli; } catch { return null; }
}

async function tailscaleStatus(executable) {
  const result = await run(executable, ["status", "--json"]);
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function tailscaleDnsName(status) {
  return String(status?.Self?.DNSName ?? "").replace(/\.+$/, "") || null;
}

export function cloudflaredAssetName(platform, arch) {
  return platform === "darwin" ? `cloudflared-darwin-${arch}.tgz` : `cloudflared-linux-${arch}`;
}

function cloudflaredPath(stateDir) {
  const arch = platformArch(process.platform, process.arch);
  return path.join(stateDir, "tools", "cloudflared", `cloudflared-${process.platform}-${arch}`);
}

export async function extractCloudflaredArchive(archivePath, destination) {
  const workDir = await mkdtemp(path.join(path.dirname(destination), ".extract-"));
  try {
    await runChecked("tar", ["-xzf", archivePath, "-C", workDir]);
    const extracted = path.join(workDir, "cloudflared");
    const info = await lstat(extracted).catch(() => null);
    if (!info?.isFile()) throw new Error("The cloudflared archive did not contain a cloudflared executable.");
    await chmod(extracted, 0o700);
    await rename(extracted, destination);
  } finally { await rm(workDir, { recursive: true, force: true }); }
}

async function ensureCloudflared(stateDir) {
  const existing = await findExecutable("cloudflared");
  if (existing) return existing;
  const executable = cloudflaredPath(stateDir);
  try { await access(executable, 1); return executable; } catch {}

  const arch = platformArch(process.platform, process.arch);
  const release = await fetchJson("https://api.github.com/repos/cloudflare/cloudflared/releases/latest");
  const assetName = cloudflaredAssetName(process.platform, arch);
  const asset = release.assets?.find((item) => item.name === assetName);
  if (!asset) throw new Error(`No official cloudflared ${platformLabel} ${arch} release was found.`);
  await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
  const temporary = `${executable}.download`;
  try {
    await downloadAsset(asset, temporary);
    if (assetName.endsWith(".tgz")) {
      await extractCloudflaredArchive(temporary, executable);
    } else {
      await chmod(temporary, 0o700);
      await rename(temporary, executable);
    }
  } finally { await rm(temporary, { force: true }); }
  return executable;
}

async function ensureOpenAIClient(root = internalRoot) {
  const binary = path.join(root, "tools", "tunnel-client", "tunnel-client");
  try { await access(binary, 1); return binary; } catch {}
  const arch = platformArch(process.platform, process.arch);
  const release = await fetchJson("https://api.github.com/repos/openai/tunnel-client/releases/latest");
  const asset = selectOpenAITunnelClientAsset(release.assets ?? [], arch);
  if (!asset) throw new Error(`No official OpenAI tunnel-client ${platformLabel} ${arch} archive was found.`);
  const toolDir = path.dirname(binary);
  await mkdir(toolDir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "devrelay-openai-tunnel-"));
  const archive = path.join(tempDir, "tunnel-client.zip");
  try {
    await downloadAsset(asset, archive);
    await extractOpenAITunnelClientArchive(archive, binary);
    return binary;
  } finally { await rm(tempDir, { recursive: true, force: true }); }
}

export async function runProviderAction(action, input = {}, {
  port = 7317,
  internalRoot: root = internalRoot,
  onOutput = () => {},
  signal
} = {}) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("The Node provider setup path currently targets Linux and macOS.");
  const stateDir = path.join(root, ".devrelay");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700).catch(() => {});
  const launcherPath = path.join(stateDir, "launcher.json");
  const secretPath = path.join(stateDir, "control-plane-api-key");
  const profileDir = path.join(stateDir, "tunnel-profiles");
  const cloudflareDir = path.join(stateDir, "cloudflare");
  const cloudflareNamedPath = path.join(stateDir, "cloudflare-named.json");
  const legacyNamedPath = path.join(stateDir, "https-named.json");
  const certPath = path.join(os.homedir(), ".cloudflared", "cert.pem");

  if (action === "Status") {
    const tailscale = await tailscalePath();
    const status = tailscale ? await tailscaleStatus(tailscale) : null;
    let cloudflaredInstalled = Boolean(await findExecutable("cloudflared"));
    if (!cloudflaredInstalled) {
      try { await access(cloudflaredPath(stateDir), 1); cloudflaredInstalled = true; } catch {}
    }
    let openaiClientInstalled = false;
    try { await access(path.join(root, "tools", "tunnel-client", "tunnel-client"), 1); openaiClientInstalled = true; } catch {}
    let cloudflareLoggedIn = false;
    try { await access(certPath); cloudflareLoggedIn = true; } catch {}
    return {
      openaiClientInstalled,
      cloudflaredInstalled,
      cloudflareLoggedIn,
      tailscaleInstalled: Boolean(tailscale),
      tailscaleLoggedIn: Boolean(tailscaleDnsName(status)),
      tailscaleDnsName: tailscaleDnsName(status)
    };
  }

  if (action === "InstallTailscale") {
    throw new Error(`${tailscaleInstallHint}, then reopen Connection Setup.`);
  }

  if (action === "ConfigureOpenAI") {
    const tunnelId = String(input.tunnelId ?? "");
    const apiKey = String(input.apiKey ?? "");
    if (!/^tunnel_[a-z0-9]{32}$/.test(tunnelId)) throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase letters or digits.");
    if (!apiKey.trim()) throw new Error("Runtime API key is required.");
    const executable = await ensureOpenAIClient(root);
    await writeJson(launcherPath, { profile: "devrelay", tunnelId, mcpUrl: `http://127.0.0.1:${port}/mcp` });
    await writeFile(secretPath, apiKey, { encoding: "utf8", mode: 0o600 });
    await chmod(secretPath, 0o600);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, CONTROL_PLANE_API_KEY: apiKey };
    await runChecked(executable, ["init", "--sample", "sample_mcp_remote_no_auth", "--profile", "devrelay", "--profile-dir", profileDir, "--tunnel-id", tunnelId, "--mcp-server-url", `http://127.0.0.1:${port}/mcp`, "--health-listen-addr", "127.0.0.1:0", "--force"], { env, onOutput, signal });
    return { ok: true, tunnelId };
  }

  if (action === "TailscaleLogin" || action === "PrepareTailscale") {
    const executable = await tailscalePath();
    if (!executable) throw new Error(`Tailscale is not installed. ${tailscaleInstallHint} first.`);
    if (action === "TailscaleLogin") {
      const login = await run(executable, ["login", "--timeout=10m"], { onOutput, signal });
      if (login.code !== 0) throw new Error("Tailscale sign-in did not complete. Finish the browser approval, then try again.");
      const dnsName = tailscaleDnsName(await tailscaleStatus(executable));
      if (!dnsName) throw new Error("Tailscale sign-in finished but the device is not connected yet.");
      return { ok: true, dnsName, publicUrl: `https://${dnsName}/mcp` };
    }
    const dnsName = tailscaleDnsName(await tailscaleStatus(executable));
    if (!dnsName) throw new Error("Sign in to Tailscale before enabling Funnel.");
    try {
      await runChecked(executable, ["funnel", "--bg", "--yes", "--https=443", `127.0.0.1:${port}`], { onOutput, signal });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await run(executable, ["funnel", "status", "--json"], { signal });
        if (status.code === 0 && status.stdout.trim() && !["{}", "null"].includes(status.stdout.trim())) {
          return { ok: true, dnsName, publicUrl: `https://${dnsName}/mcp`, funnelStatusAvailable: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Tailscale Funnel command completed but no Funnel configuration became active.");
    } finally { await run(executable, ["funnel", "reset"], { signal }).catch(() => {}); }
  }

  if (action === "EnsureCloudflared" || action === "PrepareCloudflareQuick") {
    const executable = await ensureCloudflared(stateDir);
    return action === "EnsureCloudflared" ? { ok: true, executable } : { ok: true, persistent: false };
  }

  if (action === "CloudflareLogin") {
    const existing = await readFile(certPath).then(() => true, () => false);
    if (existing) return { ok: true, alreadySignedIn: true };
    const executable = await ensureCloudflared(stateDir);
    const login = await run(executable, ["tunnel", "login"], { onOutput, signal });
    if (login.code !== 0) throw new Error("Cloudflare sign-in did not complete. Finish the browser approval, then try again.");
    if (!(await readFile(certPath).then(() => true, () => false))) throw new Error("Cloudflare sign-in finished but cert.pem was not created.");
    return { ok: true, alreadySignedIn: false };
  }

  if (action === "ConfigureCloudflareNamed") {
    const hostname = String(input.hostname ?? "").trim().toLowerCase();
    const tunnelName = String(input.tunnelName ?? "devrelay").trim() || "devrelay";
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) || !hostname.includes(".")) throw new Error("Enter a valid full hostname such as devrelay.example.com.");
    if (/(?:^|\.)example\.(?:com|net|org)$/.test(hostname)) throw new Error("The example hostname is a placeholder. Enter a real hostname in a Cloudflare-managed zone.");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tunnelName)) throw new Error("Tunnel name may contain letters, numbers, underscores, and hyphens.");
    if (!(await readFile(certPath).then(() => true, () => false))) throw new Error("Sign in to Cloudflare before using this hostname.");
    const executable = await ensureCloudflared(stateDir);
    const list = await runChecked(executable, ["tunnel", "list", "--output", "json"], { signal });
    const existing = parseJsonArray(list.stdout).find((item) => item.name === tunnelName);
    let tunnelId = existing?.id;
    if (!tunnelId) {
      const created = await runChecked(executable, ["tunnel", "create", tunnelName], { onOutput, signal });
      tunnelId = created.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (!tunnelId) throw new Error("Cloudflare connection was created but its ID could not be determined.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tunnelId ?? ""))) {
      throw new Error("Cloudflare returned an invalid tunnel ID.");
    }
    const sourceCredentials = path.join(os.homedir(), ".cloudflared", `${tunnelId}.json`);
    const credentialsPath = path.join(cloudflareDir, `${tunnelId}.json`);
    await ensureCloudflareCredential(executable, tunnelId, sourceCredentials, credentialsPath, { signal });

    const routeStatePath = path.join(cloudflareDir, "route-state.json");
    const previousRoute = await readJson(routeStatePath);
    if (previousRoute?.tunnelId !== tunnelId || previousRoute?.hostname !== hostname) {
      const route = await run(executable, ["tunnel", "route", "dns", tunnelId, hostname], { onOutput, signal });
      if (route.code !== 0) {
        const details = `${route.stdout} ${route.stderr}`;
        if (/code:\s*1003|already exists/i.test(details)) throw new Error(`The exact hostname ${hostname} already has a DNS record in Cloudflare. Check that record in Cloudflare DNS, then remove it or use another hostname if it points elsewhere.`);
        throw new Error(`Cloudflare could not create the DNS route: ${details.trim()}`);
      }
      await writeJson(routeStatePath, { tunnelId, hostname });
    }
    const configPath = path.join(cloudflareDir, "config.yml");
    const config = `tunnel: ${tunnelId}\ncredentials-file: ${JSON.stringify(credentialsPath)}\ningress:\n  - hostname: ${hostname}\n    service: http://127.0.0.1:${port}\n    originRequest:\n      httpHostHeader: localhost\n  - service: http_status:404\n`;
    await writeFile(configPath, config, { encoding: "utf8", mode: 0o600 });
    const saved = { tunnelId, tunnelName, hostname, configPath, credentialsPath };
    await writeJson(cloudflareNamedPath, saved);
    await writeJson(legacyNamedPath, saved);
    return { ok: true, publicUrl: `https://${hostname}/mcp`, tunnelId, tunnelName };
  }

  if (action === "ResetLocalConnection") {
    await Promise.all([
      launcherPath, secretPath, path.join(stateDir, "control-plane-api-key.dpapi"), profileDir,
      cloudflareNamedPath, legacyNamedPath, cloudflareDir, path.join(stateDir, "cloudflare-runtime")
    ].map((item) => rm(item, { recursive: true, force: true })));
    return { ok: true };
  }

  throw new Error(`Unknown setup action: ${action}`);
}
