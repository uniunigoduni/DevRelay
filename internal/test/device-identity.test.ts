import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadDeviceIdentity,
  makeDefaultDeviceName,
  updateDeviceIdentity
} from "../src/device-identity.js";

test("default device names prefer meaningful hardware", () => {
  assert.equal(makeDefaultDeviceName({
    platform: "windows", arch: "x64", cpuModel: "AMD Ryzen 9 3900X 12-Core Processor"
  }), "windows-ryzen9-3900x");
  assert.equal(makeDefaultDeviceName({
    platform: "windows", arch: "x64", cpuModel: "Intel(R) Core(TM) i7-13700K"
  }), "windows-core-i7-13700k");
  assert.equal(makeDefaultDeviceName({
    platform: "linux", arch: "arm64", cpuModel: "Cortex-A76", boardModel: "Raspberry Pi 5 Model B Rev 1.0"
  }), "linux-rpi5");
});
test("Apple Silicon and architecture fallback names are stable", () => {
  assert.equal(makeDefaultDeviceName({
    platform: "macos", arch: "arm64", cpuModel: "Apple M4 Pro"
  }), "macos-m4-pro");
  assert.equal(makeDefaultDeviceName({
    platform: "linux", arch: "arm64"
  }), "linux-arm64");
});

test("node ID persists while a custom device name survives hardware refresh", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devrelay-device-"));
  try {
    const first = await loadDeviceIdentity(dir);
    const custom = await updateDeviceIdentity(dir, { name: "Development PC", aliases: ["dev", "main", "dev"] });
    const second = await loadDeviceIdentity(dir);
    assert.equal(second.nodeId, first.nodeId);
    assert.equal(second.name, "Development PC");
    assert.deepEqual(custom.aliases, ["dev", "main"]);
    assert.equal(second.defaultName.length > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
