import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectionLabel, connectionPublicUrl, ensureSetupState, normalizeSetupState, resetSetupState, saveSetupState } from "./setup-state.mjs";

async function tempInternal() {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-setup-test-"));
  const internal = path.join(root, "internal");
  await mkdir(path.join(internal, ".devrelay"), { recursive: true });
  return { root, internal };
}

test("normalizes supported connection shapes", () => {
  assert.deepEqual(normalizeSetupState({ completed: true, connection: { kind: "https", provider: "cloudflare", variant: "quick", publicUrl: "ignored" } }), {
    version: 1, completed: true, connection: { kind: "https", provider: "cloudflare", variant: "quick", persistent: false }
  });
  assert.equal(connectionLabel({ kind: "https", provider: "tailscale" }), "HTTPS / Tailscale Funnel");
  assert.equal(connectionLabel({ kind: "https", provider: "cloudflare", variant: "named" }), "HTTPS / Cloudflare custom hostname");
  assert.equal(connectionLabel({ kind: "https", provider: "cloudflare", variant: "quick" }), "HTTPS / Cloudflare temporary URL");
  assert.equal(connectionPublicUrl({ kind: "https", provider: "cloudflare", variant: "quick" }), "Generated when DevRelay starts");
});

test("migrates legacy HTTPS mode and removes mode from GUI settings", async () => {
  const { root, internal } = await tempInternal();
  try {
    const state = path.join(internal, ".devrelay");
    await writeFile(path.join(state, "gui-settings.json"), JSON.stringify({ mode: "https", port: 7317, autoStart: true, theme: "white-soft" }));
    await writeFile(path.join(state, "https-named.json"), JSON.stringify({ hostname: "devrelay.example.com" }));
    const migrated = await ensureSetupState(internal);
    assert.equal(migrated.completed, true);
    assert.deepEqual(migrated.connection, { kind: "https", provider: "cloudflare", variant: "named", publicUrl: "https://devrelay.example.com/mcp" });
    const settings = JSON.parse(await readFile(path.join(state, "gui-settings.json"), "utf8"));
    assert.equal("mode" in settings, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migrates legacy OpenAI Secure Tunnel mode", async () => {
  const { root, internal } = await tempInternal();
  try {
    const state = path.join(internal, ".devrelay");
    await writeFile(path.join(state, "gui-settings.json"), JSON.stringify({ mode: "chatgpt", port: 7317, autoStart: true, theme: "white-soft" }));
    await writeFile(path.join(state, "launcher.json"), JSON.stringify({ tunnelId: "tunnel_0123456789abcdef0123456789abcdef" }));
    const migrated = await ensureSetupState(internal);
    assert.deepEqual(migrated, { version: 1, completed: true, connection: { kind: "openai-secure-tunnel" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh installs remain incomplete until wizard commits a connection", async () => {
  const { root, internal } = await tempInternal();
  try {
    assert.deepEqual(await ensureSetupState(internal), { version: 1, completed: false, connection: null });
    const saved = await saveSetupState(internal, { completed: true, connection: { kind: "https", provider: "tailscale", publicUrl: "https://pc.tailnet.ts.net/mcp" } });
    assert.equal(saved.completed, true);
    assert.equal(saved.connection.publicUrl, "https://pc.tailnet.ts.net/mcp");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("existing setup state still scrubs a legacy mode key reintroduced by an older GUI", async () => {
  const { root, internal } = await tempInternal();
  try {
    const state = path.join(internal, ".devrelay");
    await writeFile(path.join(state, "setup.json"), JSON.stringify({ version: 1, completed: true, connection: { kind: "https", provider: "tailscale", publicUrl: "https://pc.tailnet.ts.net/mcp" } }));
    await writeFile(path.join(state, "gui-settings.json"), JSON.stringify({ mode: "https", port: 7317, autoStart: true, theme: "white-soft" }));
    const loaded = await ensureSetupState(internal);
    assert.equal(loaded.completed, true);
    const settings = JSON.parse(await readFile(path.join(state, "gui-settings.json"), "utf8"));
    assert.equal("mode" in settings, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reset clears the current connection state", async () => {
  const { root, internal } = await tempInternal();
  try {
    await saveSetupState(internal, {
      completed: true,
      connection: { kind: "https", provider: "tailscale", publicUrl: "https://pc.tailnet.ts.net/mcp" }
    });
    const reset = await resetSetupState(internal);
    assert.deepEqual(reset, { version: 1, completed: false, connection: null });
    const persisted = JSON.parse(await readFile(path.join(internal, ".devrelay", "setup.json"), "utf8"));
    assert.deepEqual(persisted, reset);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
