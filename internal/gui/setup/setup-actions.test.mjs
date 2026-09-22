import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const setupActions = path.resolve(setupDir, "../../scripts/DevRelay-SetupActions.ps1");

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
test("SetupActions reads JSON input from a file without PowerShell pipeline binding noise", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devrelay-setup-action-test-"));
  const inputPath = path.join(dir, "input.json");
  try {
    await writeFile(inputPath, JSON.stringify({ hostname: "invalid", tunnelName: "devrelay" }), "utf8");
    const result = await run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", setupActions,
      "-Action", "ConfigureCloudflareNamed",
      "-InputPath", inputPath
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /Enter a valid full hostname such as devrelay\.example\.com\./);
    assert.doesNotMatch(result.stderr, /ParameterBindingException|CategoryInfo|FullyQualifiedErrorId/);
    await assert.rejects(access(inputPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
