import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SETUP_VERSION = 1;
export const SECURE_TUNNEL_ISSUES = [
  {
    number: 71,
    title: "[Windows / Plus / v0.0.14] Tunnel connector creation fails in both No Auth and OAuth: server/discover 424 and DCR 404",
    url: "https://github.com/openai/tunnel-client/issues/71"
  },
  {
    number: 57,
    title: "ChatGPT Manual Refresh fails after successful main/server/discover; no main/tools/list follows on v0.0.14",
    url: "https://github.com/openai/tunnel-client/issues/57"
  },
  {
    number: 41,
    title: "ChatGPT no-auth tunnel plugin immediately enters reconnect loop",
    url: "https://github.com/openai/tunnel-client/issues/41"
  }
];

async function readJson(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeConnection(connection) {
  if (!connection || typeof connection !== "object") return null;
  if (connection.kind === "openai-secure-tunnel") return { kind: "openai-secure-tunnel" };
  if (connection.kind !== "https") return null;
  if (connection.provider === "tailscale") {
    const result = { kind: "https", provider: "tailscale" };
    if (typeof connection.publicUrl === "string" && /^https:\/\//i.test(connection.publicUrl)) result.publicUrl = connection.publicUrl;
    return result;
  }
  if (connection.provider === "cloudflare" && connection.variant === "quick") {
    return { kind: "https", provider: "cloudflare", variant: "quick", persistent: false };
  }
  if (connection.provider === "cloudflare" && connection.variant === "named") {
    const result = { kind: "https", provider: "cloudflare", variant: "named" };
    if (typeof connection.publicUrl === "string" && /^https:\/\//i.test(connection.publicUrl)) result.publicUrl = connection.publicUrl;
    return result;
  }
  return null;
}

export function normalizeSetupState(value) {
  const connection = normalizeConnection(value?.connection);
  return { version: SETUP_VERSION, completed: value?.completed === true && connection !== null, connection };
}

export function connectionLabel(connection) {
  if (!connection) return "Not configured";
  if (connection.kind === "openai-secure-tunnel") return "OpenAI Secure Tunnel";
  if (connection.provider === "tailscale") return "HTTPS · Tailscale Funnel";
  if (connection.provider === "cloudflare" && connection.variant === "quick") return "HTTPS · Cloudflare Quick Tunnel";
  if (connection.provider === "cloudflare" && connection.variant === "named") return "HTTPS · Cloudflare Named Tunnel";
  return "Unknown connection";
}

export function connectionPublicUrl(connection) {
  if (!connection) return "-";
  if (connection.kind === "openai-secure-tunnel") return "OpenAI Secure MCP Tunnel";
  if (connection.provider === "cloudflare" && connection.variant === "quick") return "Generated when DevRelay starts";
  return connection.publicUrl || "HTTPS endpoint not prepared";
}

async function scrubLegacyMode(internalRoot) {
  const settingsPath = path.join(internalRoot, ".devrelay", "gui-settings.json");
  const settings = await readJson(settingsPath);
  if (settings && Object.prototype.hasOwnProperty.call(settings, "mode")) {
    const { mode: _mode, ...rest } = settings;
    await writeJson(settingsPath, rest);
  }
}

async function migrateLegacyState(internalRoot) {
  const stateDir = path.join(internalRoot, ".devrelay");
  const settingsPath = path.join(stateDir, "gui-settings.json");
  const settings = await readJson(settingsPath);
  const oldMode = settings?.mode;
  const named = await readJson(path.join(stateDir, "https-named.json"));
  const launcher = await readJson(path.join(stateDir, "launcher.json"));
  let connection = null;

  if (oldMode === "https" && named?.hostname) {
    connection = { kind: "https", provider: "cloudflare", variant: "named", publicUrl: `https://${named.hostname}/mcp` };
  } else if (oldMode === "chatgpt" && launcher?.tunnelId) {
    connection = { kind: "openai-secure-tunnel" };
  } else if (named?.hostname) {
    connection = { kind: "https", provider: "cloudflare", variant: "named", publicUrl: `https://${named.hostname}/mcp` };
  } else if (launcher?.tunnelId) {
    connection = { kind: "openai-secure-tunnel" };
  }

  await scrubLegacyMode(internalRoot);
  return { version: SETUP_VERSION, completed: connection !== null, connection };
}

export async function ensureSetupState(internalRoot) {
  const stateDir = path.join(internalRoot, ".devrelay");
  const setupPath = path.join(stateDir, "setup.json");
  const existing = await readJson(setupPath);
  if (existing) {
    const normalized = normalizeSetupState(existing);
    if (JSON.stringify(normalized) !== JSON.stringify(existing)) await writeJson(setupPath, normalized);
    await scrubLegacyMode(internalRoot);
    return normalized;
  }
  const migrated = await migrateLegacyState(internalRoot);
  await writeJson(setupPath, migrated);
  return migrated;
}

export async function saveSetupState(internalRoot, value) {
  const normalized = normalizeSetupState(value);
  await writeJson(path.join(internalRoot, ".devrelay", "setup.json"), normalized);
  return normalized;
}

export async function resetSetupState(internalRoot) {
  return await saveSetupState(internalRoot, { version: SETUP_VERSION, completed: false, connection: null });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const internalRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const state = await ensureSetupState(internalRoot);
  process.stdout.write(`${JSON.stringify(state)}\n`);
  process.exitCode = state.completed ? 0 : 10;
}
