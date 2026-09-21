import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClusterRuntime } from "../src/cluster-runtime.js";
import type { DeviceIdentity } from "../src/device-identity.js";
import { ProcessManager } from "../src/process-manager.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function identity(name: string, defaultName: string, platform: string, hardware: string): DeviceIdentity {
  return {
    nodeId: randomUUID(), name, defaultName, aliases: [], updatedAt: new Date().toISOString(),
    facts: { platform, arch: platform === "linux" ? "arm64" : "x64", cpuModel: hardware }
  };
}
async function prepareNode(dir: string, listenPort: number, peerPort: number, key: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cluster.key"), `${key}\n`, "utf8");
  await writeFile(path.join(dir, "peers.json"), `${JSON.stringify({
    enabled: true,
    listenHost: "127.0.0.1",
    listenPort,
    peers: [`http://127.0.0.1:${peerPort}`]
  }, null, 2)}\n`, "utf8");
}

function resultValue(result: Awaited<ReturnType<ClusterRuntime["invoke"]>>): any {
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text);
}

test("cluster routes named-device commands and process IDs between peers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-cluster-"));
  const aDir = path.join(root, "a");
  const bDir = path.join(root, "b");
  const [aPort, bPort] = await Promise.all([freePort(), freePort()]);
  const key = randomBytes(32).toString("base64url");
  await Promise.all([prepareNode(aDir, aPort, bPort, key), prepareNode(bDir, bPort, aPort, key)]);
  const aIdentity = identity("Development PC", "windows-ryzen9-3900x", "windows", "AMD Ryzen 9 3900X");
  const bIdentity = identity("Raspberry Pi", "linux-rpi5", "linux", "Raspberry Pi 5 Model B");
  bIdentity.aliases = ["rpi5"];
  const aManager = new ProcessManager();
  const bManager = new ProcessManager();
  const a = await ClusterRuntime.create(aManager, aIdentity, aDir);
  const b = await ClusterRuntime.create(bManager, bIdentity, bDir);

  try {
    await a.start();
    await b.start();

    const execResult = await a.invoke("exec", {
      device: "Raspberry Pi",
      command: process.execPath,
      args: ["-e", "console.log('REMOTE_OK')"],
      shell: "direct"
    });
    const execValue = resultValue(execResult);
    assert.equal(execValue.device.name, "Raspberry Pi");
    assert.match(execValue.stdout, /REMOTE_OK/);

    const startResult = await a.invoke("process_start", {
      device: "linux-rpi5",
      command: process.execPath,
      args: ["-e", "console.log('REMOTE_READY'); setInterval(() => {}, 1000)"],
      shell: "direct"
    });
    const started = resultValue(startResult);
    const processId = started.process.id as string;
    assert.ok(processId.startsWith(`${bIdentity.nodeId}:p_`));

    const readResult = await a.invoke("process_read", {
      processId, cursor: 0, maxChars: 4096, waitMs: 2000
    });
    const readValue = resultValue(readResult);
    assert.equal(readValue.device.name, "Raspberry Pi");
    assert.match(readValue.events.map((event: any) => event.text).join(""), /REMOTE_READY/);

    const listValue = resultValue(await a.invoke("process_list", {}));
    assert.equal(listValue.devices.some((device: any) => device.name === "Development PC" && device.online), true);
    assert.equal(listValue.devices.some((device: any) => device.name === "Raspberry Pi" && device.online), true);
    assert.equal(listValue.processes.some((process: any) => process.id === processId), true);

    const stopped = resultValue(await a.invoke("process_stop", { processId, force: true }));
    assert.equal(stopped.device.name, "Raspberry Pi");

    await b.close();
    const offlineValue = resultValue(await a.invoke("process_list", {}));
    const offlinePi = offlineValue.devices.find((device: any) => device.name === "Raspberry Pi");
    assert.equal(offlinePi?.online, false);
  } finally {
    await a.close();
    await b.close();
    await aManager.stopAll(true);
    await bManager.stopAll(true);
    await rm(root, { recursive: true, force: true });
  }
});
