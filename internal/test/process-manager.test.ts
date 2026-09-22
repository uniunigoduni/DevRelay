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

test("execute preserves UTF-8 output from direct processes", async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write('日本語テスト'); process.stderr.write('日本語エラー')"],
    shell: "direct"
  });
  assert.equal(result.stdout, "日本語テスト");
  assert.equal(result.stderr, "日本語エラー");
});

test("Windows cmd pipe output is normalized to UTF-8", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({ command: "echo 日本語テスト", shell: "cmd" });
  assert.match(result.stdout, /日本語テスト/);
});

test("Windows PowerShell pipe output is normalized to UTF-8", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({ command: "Write-Output '日本語テスト'", shell: "powershell" });
  assert.match(result.stdout, /日本語テスト/);
});


test("Windows cmd stderr is normalized to UTF-8", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({ command: "echo 日本語エラー 1>&2", shell: "cmd" });
  assert.match(result.stderr, /日本語エラー/);
});

test("Windows cmd can relay UTF-8 after a code-page switch", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({ command: "chcp 65001>nul & echo 日本語UTF8", shell: "cmd" });
  assert.match(result.stdout, /日本語UTF8/);
});

test("managed Windows cmd output is normalized to UTF-8", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const info = await manager.start({ command: "echo 日本語管理", shell: "cmd" });
  const result = await manager.read(info.id, { waitMs: 2_000 });
  assert.match(result.events.map((event) => event.text).join(""), /日本語管理/);
  await manager.stop(info.id, true);
});


test("Windows process_stop terminates child processes", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "setInterval(() => {}, 10000);"
  ].join(" ");
  const info = await manager.start({ command: process.execPath, args: ["-e", script], shell: "direct" });
  const output = await manager.read(info.id, { waitMs: 2_000 });
  const childPid = Number(output.events.map((event) => event.text).join("").trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  await manager.stop(info.id, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.throws(() => process.kill(childPid, 0));
});


test("Windows cmd normalization handles CP932 bytes that are also valid UTF-8", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({ command: "echo 燿　", shell: "cmd" });
  assert.match(result.stdout, /燿　/);
});

test("Windows cmd normalization handles mixed legacy and UTF-8 output", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const node = `"${process.execPath}"`;
  const first = await manager.execute({
    command: `echo 前半CMD日本語 & ${node} -e "process.stdout.write('後半Node日本語\\n')"`,
    shell: "cmd"
  });
  assert.match(first.stdout, /前半CMD日本語/);
  assert.match(first.stdout, /後半Node日本語/);
  const second = await manager.execute({
    command: `${node} -e "process.stdout.write('前半Node日本語\\n')" & echo 後半CMD日本語`,
    shell: "cmd"
  });
  assert.match(second.stdout, /前半Node日本語/);
  assert.match(second.stdout, /後半CMD日本語/);
});

test("explicit outputEncoding supports legacy direct-process encodings", async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0x82]))"],
    shell: "direct",
    outputEncoding: "cp437"
  });
  assert.equal(result.stdout, "é");
});

test("Windows PowerShell normalization preserves quoted command semantics", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const result = await manager.execute({
    command: `Write-Output "A B"; Write-Output "$env:TEMP X"; Write-Output '日本語 A B'; Write-Progress -Activity '進捗' -Status '確認' -PercentComplete 50`,
    shell: "powershell"
  });
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines[0], "A B");
  assert.equal(lines[1], `${process.env.TEMP} X`);
  assert.equal(lines[2], "日本語 A B");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
});

test("Windows PowerShell normalization preserves exit semantics", { skip: process.platform !== "win32" }, async () => {
  const manager = new ProcessManager();
  const nativeFailure = await manager.execute({ command: "cmd /c exit 7", shell: "powershell" });
  assert.equal(nativeFailure.exitCode, 1);
  assert.equal(nativeFailure.ok, false);
  const writeError = await manager.execute({ command: "Write-Error 'bad'", shell: "powershell" });
  assert.equal(writeError.exitCode, 1);
  assert.equal(writeError.ok, false);
  assert.match(writeError.stderr, /bad/);
  assert.doesNotMatch(writeError.stderr, /#< CLIXML/);
  const explicitExit = await manager.execute({ command: "exit 7", shell: "powershell" });
  assert.equal(explicitExit.exitCode, 7);
});
