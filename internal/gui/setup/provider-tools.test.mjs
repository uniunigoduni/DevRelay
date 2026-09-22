import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const providerTools = path.resolve(here, "../../scripts/DevRelay-ProviderTools.ps1");

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("native stderr does not abort successful provider commands", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devrelay-provider-tools-test-"));
  try {
    const cmd = path.join(dir, "stderr-ok.cmd");
    const ps1 = path.join(dir, "invoke.ps1");
    await writeFile(cmd, "@echo off\r\necho browser login progress 1>&2\r\necho done\r\nexit /b 0\r\n", "utf8");
    const script = `$ErrorActionPreference = "Stop"
. '${providerTools.replaceAll("'", "''")}'
$result = Invoke-DevRelayExternal '${cmd.replaceAll("'", "''")}' @()
$result | ConvertTo-Json -Compress
`;
    await writeFile(ps1, script, "utf8");
    const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(parsed.Code, 0);
    assert.match(parsed.Output.join("\n"), /browser login progress/);
    assert.match(parsed.Output.join("\n"), /done/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("JSON array parsing ignores native stderr warnings around stdout", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devrelay-provider-json-test-"));
  try {
    const ps1 = path.join(dir, "parse.ps1");
    const script = `$ErrorActionPreference = "Stop"
. '${providerTools.replaceAll("'", "''")}'
$output = @('[', '  {"id":"abc","name":"devrelay"}', ']', '{"level":"warn","message":"outdated"}')
$result = ConvertFrom-DevRelayJsonArrayOutput $output
$result | ConvertTo-Json -Compress
`;
    await writeFile(ps1, script, "utf8");
    const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(parsed.id, "abc");
    assert.equal(parsed.name, "devrelay");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
