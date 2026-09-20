import assert from "node:assert/strict";
import test from "node:test";
import { ProcessManager } from "../src/process-manager.js";

test("terminal process uses PTY and can be resized", async () => {
  const manager = new ProcessManager();
  const processInfo = await manager.start({
    command: process.execPath,
    args: ["-e", "console.log('PTY_READY'); setTimeout(() => process.exit(0), 800)"],
    shell: "direct"
  }, undefined, { terminal: true, columns: 88, rows: 26 });

  try {
    assert.equal(processInfo.terminal, true);
    assert.equal(processInfo.columns, 88);
    assert.equal(processInfo.rows, 26);

    let cursor = 0;
    let text = "";
    for (let i = 0; i < 8 && !text.includes("PTY_READY"); i++) {
      const output = await manager.read(processInfo.id, { cursor, waitMs: 400 });
      text += output.events.map((event) => event.text).join("");
      cursor = output.nextCursor;
    }
    assert.match(text, /PTY_READY/);

    const resized = await manager.write(processInfo.id, "", false, { columns: 100, rows: 40 });
    assert.equal(resized.columns, 100);
    assert.equal(resized.rows, 40);

    let running = true;
    for (let i = 0; i < 10 && running; i++) {
      const output = await manager.read(processInfo.id, { cursor, waitMs: 300 });
      cursor = output.nextCursor;
      running = output.process.running;
    }
    assert.equal(running, false);
  } finally {
    if (manager.list().some((item) => item.id === processInfo.id)) {
      await manager.stop(processInfo.id, true);
    }
  }
  assert.deepEqual(manager.list(), []);
});
