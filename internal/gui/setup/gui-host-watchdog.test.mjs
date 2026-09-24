import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuiHostHeartbeat } from "../gui-host-watchdog.mjs";

test("native GUI host heartbeat tolerates short stalls and requests a stop only after sustained loss", () => {
  const launched = 1_000;
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 8_500, windowLaunchedAt: launched, lastHeartbeatAt: 0 }), { status: "healthy", ageMs: 7_500 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 12_000, windowLaunchedAt: launched, lastHeartbeatAt: 5_500 }), { status: "stale", ageMs: 6_500 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 26_000, windowLaunchedAt: launched, lastHeartbeatAt: 5_500 }), { status: "lost", ageMs: 20_500 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 26_000, windowLaunchedAt: launched, lastHeartbeatAt: 25_700 }), { status: "healthy", ageMs: 300 });
});
