import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ISSUER = "https://devrelay.cluster.test";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "https://chatgpt.com/oauth/callback";
const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for port ${port}.`);
}

async function prepareState(dir: string, peerPort: number, otherPeerPort: number, key: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cluster.key"), `${key}\n`, "utf8");
  await writeFile(path.join(dir, "peers.json"), `${JSON.stringify({
    enabled: true, listenHost: "127.0.0.1", listenPort: peerPort,
    peers: [`http://127.0.0.1:${otherPeerPort}`]
  }, null, 2)}\n`, "utf8");
}
function startNode(stateDir: string, port: number, controlSecret: string): ChildProcess {
  return spawn(process.execPath, [MAIN, "--http", "--host", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env,
      DEVRELAY_STATE_DIR: stateDir,
      DEVRELAY_OAUTH_ISSUER: ISSUER,
      DEVRELAY_OAUTH_RESOURCE: RESOURCE,
      DEVRELAY_OAUTH_CONTROL_SECRET: controlSecret
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("OAuth flow survives requests landing on different cluster nodes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devrelay-oauth-cluster-"));
  const [mcpA, mcpB, peerA, peerB] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const key = randomBytes(32).toString("base64url");
  const stateA = path.join(root, "a");
  const stateB = path.join(root, "b");
  await Promise.all([
    prepareState(stateA, peerA, peerB, key),
    prepareState(stateB, peerB, peerA, key)
  ]);

  const a = startNode(stateA, mcpA, "control-a");
  const b = startNode(stateB, mcpB, "control-b");
  try {
    await Promise.all([waitPort(mcpA), waitPort(mcpB), waitPort(peerA), waitPort(peerB)]);
    const baseA = `http://127.0.0.1:${mcpA}`;
    const baseB = `http://127.0.0.1:${mcpB}`;

    const registrationResponse = await fetch(`${baseA}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Cluster OAuth test"
      })
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json() as { client_id: string };
    assert.ok(registration.client_id.startsWith("drc."));
    const verifier = randomBytes(48).toString("base64url");
    const authorize = new URL(`${baseB}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    authorize.searchParams.set("scope", "devrelay offline_access");
    authorize.searchParams.set("state", "cluster-state");
    authorize.searchParams.set("resource", RESOURCE);
    authorize.searchParams.set("code_challenge", challenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    const authorizeResponse = await fetch(authorize);
    assert.equal(authorizeResponse.status, 200);
    assert.match(await authorizeResponse.text(), /Waiting for local approval/);

    const pending = await fetch(`${baseB}/oauth/internal/pending`, {
      headers: { "x-devrelay-control-secret": "control-b" }
    }).then((response) => response.json()) as { pending: Array<{ id: string }> };
    assert.equal(pending.pending.length, 1);
    const pendingId = pending.pending[0]!.id;

    const decision = await fetch(`${baseB}/oauth/internal/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devrelay-control-secret": "control-b" },
      body: JSON.stringify({ id: pendingId, approve: true })
    });
    assert.equal(decision.status, 200);
    const status = await fetch(`${baseB}/oauth/authorize/status?id=${encodeURIComponent(pendingId)}`)
      .then((response) => response.json()) as { redirect: string };
    const callback = new URL(status.redirect);
    assert.equal(callback.searchParams.get("state"), "cluster-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await fetch(`${baseB}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: RESOURCE
      })
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    assert.ok(tokens.access_token);

    const mcpResponse = await fetch(`${baseB}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cluster-test", version: "1" } }
      })
    });
    assert.notEqual(mcpResponse.status, 401);
    assert.equal(mcpResponse.status, 200);

    const refreshResponse = await fetch(`${baseB}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: tokens.refresh_token,
        resource: RESOURCE
      })
    });
    assert.equal(refreshResponse.status, 200);
  } finally {
    await Promise.all([stopNode(a), stopNode(b)]);
    await rm(root, { recursive: true, force: true });
  }
});
