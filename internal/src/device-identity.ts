import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DeviceFacts {
  platform: "windows" | "linux" | "macos" | string;
  arch: string;
  cpuModel?: string;
  boardModel?: string;
}

export interface DeviceIdentity {
  nodeId: string;
  name: string;
  defaultName: string;
  aliases: string[];
  facts: DeviceFacts;
  updatedAt: string;
}

interface StoredIdentity extends Partial<DeviceIdentity> {}
function platformName(value = process.platform): DeviceFacts["platform"] {
  if (value === "win32") return "windows";
  if (value === "darwin") return "macos";
  if (value === "linux") return "linux";
  return value;
}

function compactWords(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/\(r\)|\(tm\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function raspberryPiSlug(value: string): string | undefined {
  const match = value.match(/raspberry\s+pi\s+(\d+)(?:\s+model\s+([a-z]))?/i);
  if (!match) return undefined;
  return `rpi${match[1]}`;
}
function cpuSlug(value: string): string | undefined {
  const clean = value.trim();
  if (!clean) return undefined;

  const apple = clean.match(/apple\s+(m\d+(?:\s+(?:pro|max|ultra))?)/i);
  if (apple) return compactWords(apple[1]!);

  const ryzen = clean.match(/ryzen\s+(\d+)\s+([0-9a-z]+)/i);
  if (ryzen) return `ryzen${ryzen[1]}-${compactWords(ryzen[2]!)}`;

  const core = clean.match(/core(?:\(tm\))?\s+(i[3579])-([0-9a-z]+)/i);
  if (core) return `core-${core[1]!.toLowerCase()}-${core[2]!.toLowerCase()}`;

  const xeon = clean.match(/xeon(?:\(r\))?\s+(?:cpu\s+)?([a-z0-9-]+(?:\s+v\d+)?)/i);
  if (xeon) return `xeon-${compactWords(xeon[1]!)}`;

  const snapdragon = clean.match(/snapdragon\s+(.+?)(?:\s+processor)?$/i);
  if (snapdragon) return `snapdragon-${compactWords(snapdragon[1]!)}`;

  return compactWords(clean
    .replace(/\b(?:amd|intel|processor|cpu|with radeon graphics|\d+-core)\b/gi, " ")) || undefined;
}
export function makeDefaultDeviceName(facts: DeviceFacts): string {
  const board = facts.boardModel ? raspberryPiSlug(facts.boardModel) : undefined;
  const hardware = board ?? (facts.cpuModel ? cpuSlug(facts.cpuModel) : undefined) ?? (compactWords(facts.arch) || "unknown");
  return `${compactWords(facts.platform) || "unknown"}-${hardware}`;
}

async function firstReadable(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      const value = (await readFile(candidate, "utf8")).replace(/\0/g, "").trim();
      if (value) return value;
    } catch {}
  }
  return undefined;
}

async function macValue(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", name], { timeout: 1500 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

export async function detectDeviceFacts(): Promise<DeviceFacts> {
  const platform = platformName();
  let cpuModel = os.cpus()[0]?.model?.trim() || undefined;
  let boardModel: string | undefined;
  if (platform === "linux") {
    boardModel = await firstReadable([
      "/proc/device-tree/model",
      "/sys/firmware/devicetree/base/model",
      "/sys/devices/virtual/dmi/id/product_name"
    ]);
  } else if (platform === "macos") {
    cpuModel = await macValue("machdep.cpu.brand_string") ?? cpuModel;
    boardModel = await macValue("hw.model");
  }

  return { platform, arch: process.arch, cpuModel, boardModel };
}

function normalizeAliases(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const alias = value.trim();
    if (!alias || seen.has(alias.toLocaleLowerCase())) continue;
    seen.add(alias.toLocaleLowerCase());
    output.push(alias);
  }
  return output.slice(0, 16);
}
async function readStored(filePath: string): Promise<StoredIdentity> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export async function loadDeviceIdentity(stateDir: string): Promise<DeviceIdentity> {
  await mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, "device.json");
  const stored = await readStored(filePath);
  const facts = await detectDeviceFacts();
  const defaultName = makeDefaultDeviceName(facts);
  const previousDefault = typeof stored.defaultName === "string" ? stored.defaultName : undefined;
  const storedName = typeof stored.name === "string" ? stored.name.trim() : "";
  const name = !storedName || storedName === previousDefault ? defaultName : storedName;
  const identity: DeviceIdentity = {
    nodeId: typeof stored.nodeId === "string" && stored.nodeId ? stored.nodeId : randomUUID(),
    name,
    defaultName,
    aliases: normalizeAliases(stored.aliases),
    facts,
    updatedAt: new Date().toISOString()
  };
  await writeFile(filePath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return identity;
}
export async function updateDeviceIdentity(
  stateDir: string,
  updates: { name?: string; aliases?: string[] }
): Promise<DeviceIdentity> {
  const current = await loadDeviceIdentity(stateDir);
  const nextName = updates.name === undefined ? current.name : updates.name.trim();
  if (!nextName) throw new Error("Device name cannot be empty.");
  const next: DeviceIdentity = {
    ...current,
    name: nextName,
    aliases: updates.aliases === undefined ? current.aliases : normalizeAliases(updates.aliases),
    updatedAt: new Date().toISOString()
  };
  await writeFile(path.join(stateDir, "device.json"), `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600
  });
  return next;
}

export function identityLabels(identity: DeviceIdentity): string[] {
  return [identity.name, identity.defaultName, ...identity.aliases]
    .map((value) => value.trim())
    .filter(Boolean);
}
