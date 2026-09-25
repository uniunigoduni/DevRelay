import assert from "node:assert/strict";
import test from "node:test";
import { classifyGuiHostHeartbeat } from "../gui-host-watchdog.mjs";

test("native GUI host heartbeat tolerates short stalls and requests a stop only after sustained loss", () => {
  const launched = 1_000;
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 121_000, windowLaunchedAt: launched, lastHeartbeatAt: 1_000 }), { status: "healthy", ageMs: 120_000 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 152_000, windowLaunchedAt: launched, lastHeartbeatAt: 1_000 }), { status: "stale", ageMs: 151_000 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 302_000, windowLaunchedAt: launched, lastHeartbeatAt: 1_000 }), { status: "lost", ageMs: 301_000 });
  assert.deepEqual(classifyGuiHostHeartbeat({ now: 302_000, windowLaunchedAt: launched, lastHeartbeatAt: 301_700 }), { status: "healthy", ageMs: 300 });
});
