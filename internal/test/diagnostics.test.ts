import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { McpDiagnostics, inspectMcpHeaders, inspectMcpPayload } from "../src/diagnostics.js";
import { VERSION } from "../src/version.js";

test("MCP payload inspection records method and tool name without arguments", () => {
  assert.deepEqual(inspectMcpPayload({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "exec", arguments: { command: "secret command" } }
  }), { method: "tools/call", toolName: "exec" });

  assert.deepEqual(inspectMcpPayload({ payload: { message: { method: "tools/list", params: {} } } }), {
    method: "tools/list"
  });
  assert.deepEqual(inspectMcpPayload({ nope: true }), { method: "unknown" });
});


test("MCP standard headers identify modern methods and tool names", () => {
  assert.deepEqual(inspectMcpHeaders("tools/list", undefined), { method: "tools/list" });
  assert.deepEqual(inspectMcpHeaders("tools/call", "exec"), { method: "tools/call", toolName: "exec" });
  assert.deepEqual(inspectMcpHeaders(undefined, undefined), { method: "unknown" });
});

test("tool entry upgrades unknown requests without double-counting calls", () => {
  let now = Date.parse("2026-09-23T00:00:00.000Z");
  const lines: string[] = [];
  const diagnostics = new McpDiagnostics(VERSION, () => 0, (line) => lines.push(line), () => now);
  diagnostics.beginRequest("r_tool", "POST");
  diagnostics.routeRequest("r_tool", "modern");
  diagnostics.enterTool("r_tool", "exec");
  diagnostics.enterTool("r_tool", "exec");
  diagnostics.finishRequest("r_tool", { statusCode: 200 } as ServerResponse);
  now += 30 * 60 * 1000;
  const heartbeat = diagnostics.emitHeartbeat();
  assert.match(heartbeat, /tools_call_30m=1/);
  assert.match(lines.find((line) => line.includes("tool-enter")) ?? "", /tool=exec/);
  assert.match(lines.find((line) => line.includes("response id=r_tool")) ?? "", /method=tools\/call tool=exec era=modern/);
});

test("heartbeat reports window counters and resets them", () => {
  let now = Date.parse("2026-09-23T00:00:00.000Z");
  const lines: string[] = [];
  const diagnostics = new McpDiagnostics(VERSION, () => 2, (line) => lines.push(line), () => now);

  diagnostics.beginRequest("r_test");
  diagnostics.identifyRequest("r_test", { method: "tools/list" });
  now += 125;
  diagnostics.finishRequest("r_test", { statusCode: 200 } as ServerResponse);
  now += 30 * 60 * 1000;

  const first = diagnostics.emitHeartbeat();
  assert.match(first, /status=healthy/);
  assert.ok(first.includes(`version=${VERSION}`));
  assert.match(first, /requests_30m=1/);
  assert.match(first, /tools_list_30m=1/);
  assert.match(first, /tools_call_30m=0/);
  assert.match(first, /active_processes=2/);

  const second = diagnostics.emitHeartbeat();
  assert.match(second, /requests_30m=0/);
  assert.match(second, /tools_list_30m=0/);
});



test("expected stateless GET or DELETE 405 responses are not counted as errors", () => {
  let now = Date.parse("2026-09-23T00:00:00.000Z");
  const lines: string[] = [];
  const diagnostics = new McpDiagnostics(VERSION, () => 0, (line) => lines.push(line), () => now);
  diagnostics.beginRequest("r_delete", "DELETE");
  now += 5;
  diagnostics.finishRequest("r_delete", { statusCode: 405 } as ServerResponse);
  now += 30 * 60 * 1000;
  const heartbeat = diagnostics.emitHeartbeat();
  assert.match(lines.find((line) => line.includes("r_delete") && line.includes("expected=true")) ?? "", /expected=true/);
  assert.match(heartbeat, /status=healthy/);
  assert.match(heartbeat, /errors_30m=0/);
});



test("subscription stream closure is expected and does not degrade health", () => {
  let now = Date.parse("2026-09-23T00:00:00.000Z");
  const lines: string[] = [];
  const diagnostics = new McpDiagnostics(VERSION, () => 0, (line) => lines.push(line), () => now);
  diagnostics.beginRequest("r_listen", "POST", { method: "subscriptions/listen" });
  diagnostics.routeRequest("r_listen", "modern");
  diagnostics.abortRequest("r_listen", new Error("stream closed"));
  now += 30 * 60 * 1000;
  const heartbeat = diagnostics.emitHeartbeat();
  assert.match(lines.find((line) => line.includes("stream-closed")) ?? "", /expected=true/);
  assert.match(heartbeat, /status=healthy/);
  assert.match(heartbeat, /errors_30m=0/);
});

test("aborted MCP responses are classified as transport errors", () => {
  let now = Date.parse("2026-09-23T00:00:00.000Z");
  const lines: string[] = [];
  const diagnostics = new McpDiagnostics(VERSION, () => 0, (line) => lines.push(line), () => now);
  diagnostics.beginRequest("r_abort", "POST");
  diagnostics.abortRequest("r_abort", new Error("socket closed"));
  now += 30 * 60 * 1000;
  const heartbeat = diagnostics.emitHeartbeat();
  assert.match(lines.find((line) => line.includes("r_abort") && line.includes("[ERROR][transport]")) ?? "", /\[ERROR\]\[transport\]/);
  assert.match(heartbeat, /status=degraded/);
  assert.match(heartbeat, /errors_30m=1/);
});

test("diagnostic errors redact bearer tokens and token query values", () => {
  const lines: string[] = [];
  const diagnostics = new McpDiagnostics(VERSION, () => 0, (line) => lines.push(line));
  diagnostics.reportError("auth", new Error("Authorization: Bearer abc.def.ghi access_token=supersecret"));
  const line = lines.at(-1) ?? "";
  assert.doesNotMatch(line, /abc\.def\.ghi/);
  assert.doesNotMatch(line, /supersecret/);
  assert.match(line, /REDACTED/);
});
