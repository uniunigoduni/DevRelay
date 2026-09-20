import assert from "node:assert/strict";
import test from "node:test";
import { ProcessManager } from "../src/process-manager.js";

test("execute runs an arbitrary executable and captures both streams", async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hello'); process.stderr.write('warn')"],
    shell: "direct"
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warn");
});

test("managed process supports incremental output and stdin", async () => {
  const manager = new ProcessManager();
  const processInfo = await manager.start({
    command: process.execPath,
    args: ["-e", "process.stdin.setEncoding('utf8'); console.log('ready'); process.stdin.on('data', d => process.stdout.write('echo:' + d))"],
    shell: "direct"
  });

  const initial = await manager.read(processInfo.id, { waitMs: 2_000 });
  assert.match(initial.events.map((event) => event.text).join(""), /ready/);

  await manager.write(processInfo.id, "ping\n");
  const next = await manager.read(processInfo.id, {
    cursor: initial.nextCursor,
    waitMs: 2_000
  });
  assert.match(next.events.map((event) => event.text).join(""), /echo:ping/);

  const stopped = await manager.stop(processInfo.id, true);
  assert.equal(stopped.running, false);
  assert.deepEqual(manager.list(), []);
});

test("execute enforces timeout", async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    shell: "direct"
  }, { timeoutMs: 100 });

  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});
