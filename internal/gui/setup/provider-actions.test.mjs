import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cloudflaredAssetName, copyPrivateCredential, ensureCloudflareCredential, extractCloudflaredArchive,
  extractOpenAITunnelClientArchive, selectOpenAITunnelClientAsset, tailscalePath
} from "./provider-actions.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8");
    const data = Buffer.from(item.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localRecords.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

test("OpenAI tunnel-client release selection excludes bundled runtime variants", () => {
  const assets = [
    { name: "tunnel-client-runtime-cloudflared-v0.0.15-linux-amd64.zip" },
    { name: "tunnel-client-runtime-v0.0.15-linux-amd64.zip" },
    { name: "tunnel-client-v0.0.15-linux-arm64.zip" },
    { name: "tunnel-client-v0.0.15-linux-amd64.zip" }
  ];
  assert.equal(selectOpenAITunnelClientAsset(assets, "amd64", "linux"), assets[3]);
  assert.equal(selectOpenAITunnelClientAsset(assets, "arm64", "linux"), assets[2]);
});

test("provider downloads select the macOS release assets", () => {
  const assets = [
    { name: "tunnel-client-runtime-v0.0.15-darwin-arm64.zip" },
    { name: "tunnel-client-v0.0.15-linux-arm64.zip" },
    { name: "tunnel-client-v0.0.15-darwin-arm64.zip" }
  ];
  assert.equal(selectOpenAITunnelClientAsset(assets, "arm64", "darwin"), assets[2]);
  assert.equal(selectOpenAITunnelClientAsset(assets, "amd64", "darwin"), null);
  assert.equal(cloudflaredAssetName("darwin", "arm64"), "cloudflared-darwin-arm64.tgz");
  assert.equal(cloudflaredAssetName("linux", "amd64"), "cloudflared-linux-amd64");
});

test("cloudflared macOS archives yield only a regular cloudflared executable", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-cloudflared-tgz-"));
  const tools = path.join(root, "tools");
  const destination = path.join(tools, "cloudflared-darwin-arm64");
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(tools);
    await writeFile(path.join(root, "src", "cloudflared"), "test executable contents");
    execFileSync("tar", ["-czf", path.join(root, "good.tgz"), "-C", path.join(root, "src"), "cloudflared"]);
    await extractCloudflaredArchive(path.join(root, "good.tgz"), destination);
    assert.equal(await readFile(destination, "utf8"), "test executable contents");
    assert.equal((await stat(destination)).mode & 0o777, 0o700);

    await writeFile(path.join(root, "src", "other"), "unrelated");
    execFileSync("tar", ["-czf", path.join(root, "bad.tgz"), "-C", path.join(root, "src"), "other"]);
    await assert.rejects(extractCloudflaredArchive(path.join(root, "bad.tgz"), path.join(tools, "rejected")), /did not contain a cloudflared executable/);
    assert.deepEqual(await readdir(tools), ["cloudflared-darwin-arm64"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Tailscale lookup falls back to the macOS app CLI only on macOS", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-tailscale-app-"));
  const appCli = path.join(root, "Tailscale");
  try {
    await writeFile(appCli, "#!/bin/sh\n", { mode: 0o700 });
    assert.equal(await tailscalePath({ env: { PATH: "" }, platform: "darwin", appCli }), appCli);
    assert.equal(await tailscalePath({ env: { PATH: "" }, platform: "linux", appCli }), null);
    assert.equal(await tailscalePath({ env: { PATH: "" }, platform: "darwin", appCli: path.join(root, "missing") }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cloudflare credentials copy into a private directory with restricted permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-private-credential-"));
  const source = path.join(root, "source.json");
  const destination = path.join(root, "private", "tunnel.json");
  try {
    await writeFile(source, "credential contents", { mode: 0o600 });
    await copyPrivateCredential(source, destination);
    assert.equal(await readFile(destination, "utf8"), "credential contents");
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(destination))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cloudflare tunnel credentials recover from cloudflared without exposing token output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-cloudflare-recovery-"));
  const tunnelId = "4328d25c-cdca-4e1a-8098-04bd7a2b888d";
  const executable = path.join(root, "fake-cloudflared");
  const source = path.join(root, "missing", `${tunnelId}.json`);
  const destination = path.join(root, "private", `${tunnelId}.json`);
  try {
    await writeFile(executable, `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nif (args[0] !== "tunnel" || args[1] !== "token" || args[2] !== "--cred-file" || args[4] !== ${JSON.stringify(tunnelId)}) process.exit(2);\nawait writeFile(args[3], JSON.stringify({ TunnelID: args[4], AccountTag: "account", TunnelSecret: "test-secret" }), { mode: 0o600 });\nprocess.stdout.write("credential-token-must-not-be-forwarded");\n`, { mode: 0o700 });
    await ensureCloudflareCredential(executable, tunnelId, source, destination);
    assert.equal(JSON.parse(await readFile(destination, "utf8")).TunnelID, tunnelId);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(destination))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OpenAI tunnel-client extraction writes only a safe executable entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-openai-zip-"));
  const archivePath = path.join(root, "client.zip");
  const destination = path.join(root, "tools", "tunnel-client");
  try {
    const executable = Buffer.from("test executable contents");
    await writeFile(archivePath, makeStoredZip([
      { name: "../../tunnel-client", data: "unsafe entry" },
      { name: "bin/tunnel-client", data: executable }
    ]));
    await extractOpenAITunnelClientArchive(archivePath, destination);
    assert.deepEqual(await readFile(destination), executable);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);

    await writeFile(archivePath, makeStoredZip([{ name: "../tunnel-client", data: "unsafe entry" }]));
    await assert.rejects(extractOpenAITunnelClientArchive(archivePath, path.join(root, "rejected")), /safe tunnel-client executable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
