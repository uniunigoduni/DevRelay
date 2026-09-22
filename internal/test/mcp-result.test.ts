import assert from "node:assert/strict";
import test from "node:test";
import { compactExec, compactProcessListItem, compactProcessRead } from "../src/mcp-server.js";
import type { ProcessSnapshot } from "../src/types.js";

function snapshot(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    id: "p_test", pid: 1234, command: "node server.js", cwd: "C:\\work", shell: "direct",
    terminal: false, columns: null, rows: null, running: true, exitCode: null, signal: null,
    startedAt: "2026-09-22T00:00:00.000Z", endedAt: null, ...overrides
  };
}

test("compact exec omits default metadata without dropping output or failures", () => {
  assert.deepEqual(compactExec("dev", {
    ok: true, exitCode: 0, signal: null, timedOut: false, stdout: "hello\n", stderr: "",
    truncated: false, startedAt: "start", endedAt: "end"
  }), { device: "dev", ok: true, stdout: "hello\n" });

  assert.deepEqual(compactExec("dev", {
    ok: false, exitCode: 7, signal: null, timedOut: false, stdout: "", stderr: "bad\n",
    truncated: true, startedAt: "start", endedAt: "end"
  }), { device: "dev", ok: false, exitCode: 7, stderr: "bad\n", truncated: true });
});

test("compact process read keeps cursor, output, truncation, and final status", () => {
  assert.deepEqual(compactProcessRead("dev", {
    events: [{ cursor: 8, stream: "stdout", text: "done\n", timestamp: "ignored" }],
    nextCursor: 9, oldestCursor: 5, truncated: true,
    process: snapshot({ running: false, exitCode: 0, endedAt: "end" })
  }), {
    device: "dev", nextCursor: 9, running: false,
    events: [{ stream: "stdout", text: "done\n" }],
    truncated: true, oldestCursor: 5, exitCode: 0
  });
});

test("compact process list item keeps identification while omitting running defaults", () => {
  assert.deepEqual(compactProcessListItem(snapshot()), {
    processId: "p_test", pid: 1234, command: "node server.js", cwd: "C:\\work", shell: "direct"
  });
  assert.deepEqual(compactProcessListItem(snapshot({ running: false, exitCode: 3, endedAt: "end" })), {
    processId: "p_test", pid: 1234, command: "node server.js", cwd: "C:\\work", shell: "direct", running: false, exitCode: 3
  });
});
