import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuiHostHeartbeat, isGuiHostRecoverySignal, shouldResumeRuntimeAfterGuiRecovery } from "../gui-host-watchdog.mjs";

test("native GUI host heartbeat classifies short stalls and sustained loss for diagnostics", () => {
  const launched = 1_000;
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 121_000, windowLaunchedAt: launched, lastHeartbeatAt: 1_000 }), { status: "healthy", ageMs: 120_000 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 152_000, windowLaunchedAt: launched, lastHeartbeatAt: 1_000 }), { status: "stale", ageMs: 151_000 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 302_000, windowLaunchedAt: launched, lastHeartbeatAt: 1_000 }), { status: "lost", ageMs: 301_000 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 302_000, windowLaunchedAt: launched, lastHeartbeatAt: 301_700 }), { status: "healthy", ageMs: 300 });
});


test("GUI recovery is detected even when sleep prevented the watchdog from observing stale state", () => {
  assert.equal(isGuiHostRecoverySignal({ previousStatus: "healthy", gapMs: 120_000 }), false);
  assert.equal(isGuiHostRecoverySignal({ previousStatus: "healthy", gapMs: 151_000 }), true);
  assert.equal(isGuiHostRecoverySignal({ previousStatus: "lost", gapMs: 1_000 }), true);
});

test("GUI recovery resumes only the runtime state the user still wants", () => {
  const readyStopped = { running: false, starting: false, stopping: false, shuttingDown: false, windowReady: true, windowHostPresent: true };
  assert.equal(shouldResumeRuntimeAfterGuiRecovery({ desiredRunning: true, ...readyStopped }), true);
  assert.equal(shouldResumeRuntimeAfterGuiRecovery({ desiredRunning: false, ...readyStopped }), false);
  assert.equal(shouldResumeRuntimeAfterGuiRecovery({ desiredRunning: true, ...readyStopped, running: true }), false);
  assert.equal(shouldResumeRuntimeAfterGuiRecovery({ desiredRunning: true, ...readyStopped, stopping: true }), false);
  assert.equal(shouldResumeRuntimeAfterGuiRecovery({ desiredRunning: true, ...readyStopped, shuttingDown: true }), false);
  assert.equal(shouldResumeRuntimeAfterGuiRecovery({ desiredRunning: true, ...readyStopped, windowHostPresent: false }), false);
});
