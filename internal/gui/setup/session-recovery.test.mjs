import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isUncleanSession, recoverUncleanSessions, selectSessionOwnedProcesses, trackedProcessMatches } from "../session-recovery.mjs";

test("unclean session detection requires an open session without endedAt", () => {
  assert.equal(isUncleanSession({ status: "window-open", endedAt: null }), true);
  assert.equal(isUncleanSession({ status: "closed", endedAt: null }), false);
  assert.equal(isUncleanSession({ status: "unclean", endedAt: null }), false);
  assert.equal(isUncleanSession({ status: "window-open", endedAt: "2026-09-25T00:00:00.000Z" }), false);
});

test("tracked process matching rejects PID reuse and wrong command lines", () => {
  const internalRoot = "C:\\DevRelay\\internal";
  const record = {
    role: "runtime", pid: 42, startedAt: "2026-09-25T01:00:00.000Z", executableName: "node.exe",
    commandIncludes: ["--port", "7317"]
  };
  const actual = {
    processId: 42, name: "node.exe", creationDate: "2026-09-25T01:00:01.000Z",
    commandLine: "node.exe C:\\DevRelay\\internal\\dist\\src\\main.js --http --port 7317"
  };
  assert.equal(trackedProcessMatches(record, actual, { internalRoot }), true);
  assert.equal(trackedProcessMatches(record, { ...actual, creationDate: "2026-09-25T02:00:00.000Z" }, { internalRoot }), false);
  assert.equal(trackedProcessMatches(record, { ...actual, commandLine: "node.exe other.js --port 7317" }, { internalRoot }), false);
});

test("session ownership includes tracked processes and legacy cloudflared logfile ownership", () => {
  const internalRoot = "C:\\DevRelay\\internal";
  const sessionDir = "C:\\DevRelay\\internal\\.devrelay\\logs\\20260925-010000-aaaaaaaa";
  const processes = [
    { processId: 10, name: "node.exe", creationDate: "2026-09-25T01:00:01.000Z", commandLine: "node.exe C:\\DevRelay\\internal\\dist\\src\\main.js --http --port 7317" },
    { processId: 11, name: "cloudflared.exe", creationDate: "2026-09-25T01:00:02.000Z", commandLine: `cloudflared.exe --logfile ${sessionDir}\\cloudflared-named.log run devrelay` },
    { processId: 12, name: "cloudflared.exe", creationDate: "2026-09-25T01:00:02.000Z", commandLine: "cloudflared.exe --logfile C:\\other\\cloudflared.log run other" }
  ];
  const processState = { runtime: { role: "runtime", pid: 10, startedAt: "2026-09-25T01:00:00.000Z", executableName: "node.exe", commandIncludes: ["--port", "7317"] } };
  const selected = selectSessionOwnedProcesses({ sessionDir, internalRoot, sessionMeta: {}, processState, processes });
  assert.deepEqual(selected.map((item) => item.process.processId), [11, 10]);
});

test("recovery marks an open session unclean and kills only verified owned processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-recovery-"));
  try {
    const internalRoot = path.join(root, "internal");
    const logsRoot = path.join(internalRoot, ".devrelay", "logs");
    const sessionName = "20260925-010000-aaaaaaaa";
    const sessionDir = path.join(logsRoot, sessionName);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "session.json"), JSON.stringify({ status: "window-open", endedAt: null }, null, 2));
    await writeFile(path.join(sessionDir, "processes.json"), JSON.stringify({
      runtime: { role: "runtime", pid: 77, startedAt: "2026-09-25T01:00:00.000Z", executableName: "node.exe", commandIncludes: ["--port", "7317"] }
    }, null, 2));
    const killed = [];
    const events = await recoverUncleanSessions({
      logsRoot, internalRoot,
      queryProcesses: async () => [{ processId: 77, name: "node.exe", creationDate: "2026-09-25T01:00:01.000Z", commandLine: `node.exe ${path.join(internalRoot, "dist", "src", "main.js")} --http --port 7317` }],
      killProcess: async (pid) => { killed.push(pid); return { ok: true }; },
      now: () => new Date("2026-09-25T02:00:00.000Z")
    });
    assert.deepEqual(killed, [77]);
    assert.equal(events.length, 1);
    const meta = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    assert.equal(meta.status, "unclean");
    assert.equal(meta.detectedUncleanAt, "2026-09-25T02:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
