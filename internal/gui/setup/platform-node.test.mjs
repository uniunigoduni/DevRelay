import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { electronSpawnEnvironment } from "../electron-environment.mjs";
import { downloadVerifiedFont, isNotoSansMonoFile, userFontDir } from "../font-setup.mjs";
import { openExternalUrl } from "../open-external.mjs";
import { shouldInstall } from "../prepare.mjs";
import { killProcessTree, queryLinuxProcesses, queryMacProcesses, trackedProcessMatches } from "../session-recovery.mjs";
import { runProviderAction } from "./provider-actions.mjs";

test("Electron window launches do not inherit Node-only Electron mode", () => {
  const env = electronSpawnEnvironment({ ELECTRON_RUN_AS_NODE: "1", DISPLAY: ":0", PATH: "/usr/bin" });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.PATH, "/usr/bin");
});

test("external links use the desktop default handler and reject non-web protocols", async () => {
  const calls = [];
  const fakeSpawn = (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  await openExternalUrl("https://example.test/path", { platform: "linux", spawnImpl: fakeSpawn });
  assert.deepEqual(calls, [{ file: "xdg-open", args: ["https://example.test/path"] }]);
  await assert.rejects(
    openExternalUrl("javascript:alert(1)", { platform: "linux", spawnImpl: fakeSpawn }),
    /Only HTTP and HTTPS/
  );
  assert.equal(calls.length, 1);
});

test("Linux process recovery reads process identity from procfs", async () => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "devrelay-procfs-"));
  try {
    const pid = 4242;
    const processDir = path.join(procRoot, String(pid));
    await mkdir(processDir);
    await writeFile(path.join(procRoot, "uptime"), "120.00 0.00\n");
    const fields = ["R", "41", ...Array(17).fill("0"), "9000"];
    await writeFile(path.join(processDir, "stat"), `${pid} (node runtime) ${fields.join(" ")}\n`);
    await writeFile(path.join(processDir, "cmdline"), Buffer.from(["/usr/bin/node", "/tmp/devrelay/linux-runtime.mjs", "7317"].join("\0")));
    await symlink("/usr/bin/node", path.join(processDir, "exe"));

    const [actual] = await queryLinuxProcesses({ procRoot });
    assert.equal(actual.processId, pid);
    assert.equal(actual.parentProcessId, 41);
    assert.equal(actual.name, "node runtime");
    assert.equal(actual.executablePath, "/usr/bin/node");
    assert.match(actual.commandLine, /linux-runtime\.mjs 7317$/);
    assert.ok(Number.isFinite(Date.parse(actual.creationDate)));

    const record = {
      role: "launcher", pid, parentPid: 41,
      startedAt: actual.creationDate,
      executableName: "node runtime",
      executablePath: "/usr/bin/node",
      commandIncludes: ["/tmp/devrelay/linux-runtime.mjs", "7317"]
    };
    assert.equal(trackedProcessMatches(record, actual, { internalRoot: "/tmp/devrelay/internal" }), true);
    assert.equal(trackedProcessMatches(record, { ...actual, commandLine: "/usr/bin/node unrelated.mjs 7317" }, { internalRoot: "/tmp/devrelay/internal" }), false);
  } finally { await rm(procRoot, { recursive: true, force: true }); }
});

test("macOS process recovery reads process identity from ps", async () => {
  const ps = async (args) => args.includes("lstart=")
    ? "   77     1 Thu Oct  1 09:05:00 2026     /usr/sbin/cfprefsd agent\n 4242    41 Fri Oct  2 22:30:08 2026     /opt/homebrew/bin/node /tmp/devrelay/gui/posix-runtime.mjs 7317\n"
    : "   77 /usr/sbin/cfprefsd\n 4242 /opt/homebrew/Cellar/node/22.0.0/bin/node\n";
  const actual = (await queryMacProcesses({ ps })).find((item) => item.processId === 4242);
  assert.equal(actual.parentProcessId, 41);
  assert.equal(actual.name, "node");
  assert.equal(actual.executablePath, "/opt/homebrew/Cellar/node/22.0.0/bin/node");
  assert.equal(actual.commandLine, "/opt/homebrew/bin/node /tmp/devrelay/gui/posix-runtime.mjs 7317");
  assert.equal(actual.creationDate, new Date(2026, 9, 2, 22, 30, 8).toISOString());

  const record = {
    role: "launcher", pid: 4242, parentPid: 41,
    startedAt: actual.creationDate,
    executableName: "node",
    executablePath: "/opt/homebrew/Cellar/node/22.0.0/bin/node",
    commandIncludes: ["/tmp/devrelay/gui/posix-runtime.mjs", "7317"]
  };
  assert.equal(trackedProcessMatches(record, actual, { internalRoot: "/tmp/devrelay" }), true);
  assert.equal(trackedProcessMatches(record, { ...actual, executablePath: "/usr/local/bin/node" }, { internalRoot: "/tmp/devrelay" }), false);
});

test("macOS ps reports the full executable path and start time of a child", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)", "devrelay-ps-probe"], { stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const actual = (await queryMacProcesses()).find((item) => item.processId === child.pid);
    assert.equal(actual.parentProcessId, process.pid);
    assert.equal(actual.executablePath, process.execPath);
    assert.match(actual.commandLine, /devrelay-ps-probe$/);
    assert.ok(Math.abs(Date.parse(actual.creationDate) - Date.now()) < 30_000);
  } finally { child.kill("SIGKILL"); }
});

test("Linux and macOS process recovery terminates the verified process tree", { skip: process.platform === "win32" }, async () => {
  const script = `const { spawn } = require("node:child_process"); const child = spawn("sleep", ["60"], { stdio: "ignore" }); process.stdout.write(String(child.pid) + "\\n"); setInterval(() => {}, 10000);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  let announcedChildPid = "";
  let announceChild;
  const announced = new Promise((resolve) => { announceChild = resolve; });
  const closed = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { announcedChildPid += chunk; if (announcedChildPid.trim()) announceChild(); });
  await Promise.race([
    announced,
    new Promise((_, reject) => setTimeout(() => reject(new Error("test process did not start")), 2000))
  ]);
  const result = await killProcessTree(child.pid);
  assert.equal(result.ok, true);
  const exit = await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("test process tree did not stop")), 2000))
  ]);
  assert.ok(["SIGTERM", "SIGKILL"].includes(exit.signal));
  assert.notEqual(announcedChildPid.trim(), "");
});

test("Linux and macOS Cloudflare setup validates the hostname before invoking provider commands", { skip: process.platform === "win32" }, async () => {
  const internalRoot = await mkdtemp(path.join(os.tmpdir(), "devrelay-provider-test-"));
  try {
    await assert.rejects(
      runProviderAction("ConfigureCloudflareNamed", { hostname: "example.test;touch /tmp/pwned", tunnelName: "devrelay" }, { internalRoot }),
      /Enter a valid full hostname/
    );
    await assert.rejects(
      runProviderAction("ConfigureCloudflareNamed", { hostname: "devrelay.example.com", tunnelName: "devrelay" }, { internalRoot }),
      /example hostname is a placeholder/
    );
    assert.deepEqual(await readFile(path.join(internalRoot, ".devrelay", "launcher.json")).then(() => "present", () => "missing"), "missing");
  } finally { await rm(internalRoot, { recursive: true, force: true }); }
});

test("an existing node_modules is adopted until a lockfile change is recorded", () => {
  assert.equal(shouldInstall({ hasNodeModules: false, recordedHash: undefined, lockHash: "a" }), true);
  assert.equal(shouldInstall({ hasNodeModules: true, recordedHash: undefined, lockHash: "a" }), false);
  assert.equal(shouldInstall({ hasNodeModules: true, recordedHash: "a", lockHash: "a" }), false);
  assert.equal(shouldInstall({ hasNodeModules: true, recordedHash: "a", lockHash: "b" }), true);
});

test("Noto Sans Mono installs into each platform's per-user font folder", () => {
  assert.equal(userFontDir("darwin", "/Users/dev"), "/Users/dev/Library/Fonts");
  assert.equal(userFontDir("linux", "/home/dev", {}), "/home/dev/.local/share/fonts");
  assert.equal(userFontDir("linux", "/home/dev", { XDG_DATA_HOME: "/data" }), "/data/fonts");
  for (const name of ["NotoSansMono[wdth,wght].ttf", "NotoSansMono-Regular.ttf", "Noto Sans Mono Bold.otf", "noto_sans_mono.ttc"]) {
    assert.equal(isNotoSansMonoFile(name), true, name);
  }
  for (const name of ["NotoSans-Regular.ttf", "NotoSansMono.txt", "Menlo.ttc"]) assert.equal(isNotoSansMonoFile(name), false, name);
});

test("the Noto Sans Mono download is cached only when its SHA-256 matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-font-"));
  const cachePath = path.join(root, "fonts", "NotoSansMono.ttf");
  const bytes = Buffer.from("font bytes");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return new Response(bytes); };
  try {
    await assert.rejects(
      downloadVerifiedFont(cachePath, { expectedSha256, fetchImpl: async () => { fetches += 1; return new Response("tampered"); } }),
      /SHA-256/
    );
    await assert.rejects(readFile(cachePath), { code: "ENOENT" });
    await downloadVerifiedFont(cachePath, { expectedSha256, fetchImpl });
    assert.deepEqual(await readFile(cachePath), bytes);
    await downloadVerifiedFont(cachePath, { expectedSha256, fetchImpl });
    assert.equal(fetches, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
