import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DevRelayOAuthServer } from "../src/oauth-server.js";

const ISSUER = "https://devrelay.example";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "https://chatgpt.com/oauth/callback";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function withOAuthServer(run: (base: string, oauth: DevRelayOAuthServer, stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "devrelay-oauth-"));
  const oauth = await DevRelayOAuthServer.create({
    issuer: ISSUER, resource: RESOURCE, stateDir, controlSecret: "local-control-secret"
  });
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!await oauth.handleRoute(request, response, url)) response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base, oauth, stateDir);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("OAuth protected resource metadata supports the MCP resource path", async () => {
  await withOAuthServer(async (base, oauth) => {
    assert.equal(oauth.metadataUrl, `${ISSUER}/.well-known/oauth-protected-resource/mcp`);
    for (const metadataPath of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(`${base}${metadataPath}`);
      assert.equal(response.status, 200);
      const metadata = await response.json() as { resource: string; authorization_servers: string[] };
      assert.equal(metadata.resource, RESOURCE);
      assert.deepEqual(metadata.authorization_servers, [ISSUER]);
    }
  });
});

test("Claude registration rejects callbacks outside the exact hosted callback", async () => {
  await withOAuthServer(async (base, oauth) => {
    for (const redirectUri of [
      "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai/other",
      "https://claude.ai/api/mcp/auth_callback?next=https://attacker.example",
      "https://claude.ai/api/mcp/auth_callback#fragment",
      "https://claude.ai:8443/api/mcp/auth_callback",
      "https://attacker.claude.ai/api/mcp/auth_callback",
      "https://claude.ai.attacker.example/api/mcp/auth_callback",
      "https://claude.ai@attacker.example/api/mcp/auth_callback",
      "https://attacker.example/api/mcp/auth_callback",
      "http://localhost:3118/callback"
    ]) {
      const response = await fetch(`${base}/oauth/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
      });
      assert.equal(response.status, 400, redirectUri);
      assert.equal((await response.json() as { error: string }).error, "invalid_redirect_uri");
    }
    assert.equal(oauth.listPending().length, 0);
  });
});

test("unknown OAuth clients get connection recovery guidance", async () => {
  await withOAuthServer(async (base) => {
    const response = await fetch(`${base}/oauth/authorize?client_id=drc_missing&response_type=code`);
    assert.equal(response.status, 400);
    const error = await response.json() as { error: string; error_description: string };
    assert.equal(error.error, "unauthorized_client");
    assert.match(error.error_description, /Remove and add the MCP connection again/);
    assert.match(error.error_description, /\.devrelay\/oauth/);
  });
});

test("a lost DevRelay DCR registration is restored after validating authorization", async () => {
  await withOAuthServer(async (base, _oauth, stateDir) => {
    const clientId = `drc_${"a".repeat(32)}`;
    const verifier = randomBytes(48).toString("base64url");
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    authorize.searchParams.set("scope", "devrelay offline_access");
    authorize.searchParams.set("resource", RESOURCE);
    authorize.searchParams.set("code_challenge", challenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorize);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ChatGPT \(recovered\)/);

    const registrations = JSON.parse(await readFile(path.join(stateDir, "oauth", "clients.json"), "utf8")) as Array<{
      clientId: string; redirectUris: string[]; clientName: string; createdAt: number;
    }>;
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.clientId, clientId);
    assert.deepEqual(registrations[0]?.redirectUris, [REDIRECT]);
    assert.equal(registrations[0]?.clientName, "ChatGPT (recovered)");
    assert.equal(typeof registrations[0]?.createdAt, "number");

    const hostileRedirect = new URL(authorize);
    hostileRedirect.searchParams.set("client_id", `drc_${"b".repeat(32)}`);
    hostileRedirect.searchParams.set("redirect_uri", "https://attacker.example/callback");
    const rejectedRedirect = await fetch(hostileRedirect);
    assert.equal(rejectedRedirect.status, 400);
    assert.equal((await rejectedRedirect.json() as { error: string }).error, "unauthorized_client");

    const invalidPkce = new URL(authorize);
    invalidPkce.searchParams.set("client_id", `drc_${"c".repeat(32)}`);
    invalidPkce.searchParams.set("code_challenge", "not-a-valid-challenge");
    const rejectedPkce = await fetch(invalidPkce);
    assert.equal(rejectedPkce.status, 400);
    assert.equal((await rejectedPkce.json() as { error: string }).error, "invalid_request");

    const afterRejections = JSON.parse(await readFile(path.join(stateDir, "oauth", "clients.json"), "utf8")) as Array<{ clientId: string }>;
    assert.deepEqual(afterRejections.map((registration) => registration.clientId), [clientId]);
  });
});

for (const [clientName, redirectUri] of [
  ["ChatGPT", REDIRECT],
  ["Claude", "https://claude.ai/api/mcp/auth_callback"]
] as const) {
test(`${clientName} OAuth DCR + PKCE + refresh flow`, async () => {
  await withOAuthServer(async (base, oauth) => {
    const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`).then((response) => response.json());
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.equal(metadata.registration_endpoint, `${ISSUER}/oauth/register`);
    const registrationResponse = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: `${clientName} test`
      })
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json() as { client_id: string };
    assert.ok(registration.client_id.startsWith("drc_"));

    const verifier = randomBytes(48).toString("base64url");
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", "devrelay offline_access");
    authorize.searchParams.set("state", "state-123");
    authorize.searchParams.set("resource", RESOURCE);
    authorize.searchParams.set("code_challenge", challenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    const authorizeResponse = await fetch(authorize);
    assert.equal(authorizeResponse.status, 200);
    assert.match(authorizeResponse.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.match(await authorizeResponse.text(), /Waiting for local approval/);
    const duplicateAuthorizeResponse = await fetch(authorize);
    assert.equal(duplicateAuthorizeResponse.status, 200);
    assert.match(await duplicateAuthorizeResponse.text(), /wait=25000/);

    const pendingResponse = await fetch(`${base}/oauth/internal/pending`, {
      headers: { "x-devrelay-control-secret": "local-control-secret" }
    });
    const pending = await pendingResponse.json() as { pending: Array<{ id: string }> };
    assert.equal(pending.pending.length, 1);

    const waitStarted = Date.now();
    const waitingStatus = fetch(`${base}/oauth/authorize/status?id=${encodeURIComponent(pending.pending[0]!.id)}&wait=5000`)
      .then((response) => response.json()) as Promise<{ status: string; redirect: string }>;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const decision = await fetch(`${base}/oauth/internal/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devrelay-control-secret": "local-control-secret" },
      body: JSON.stringify({ id: pending.pending[0]!.id, approve: true })
    });
    assert.equal(decision.status, 200);

    const status = await waitingStatus;
    assert.equal(status.status, "approved");
    assert.ok(Date.now() - waitStarted < 1500);
    const callback = new URL(status.redirect);
    assert.equal(callback.searchParams.get("state"), "state-123");
    const code = callback.searchParams.get("code");
    assert.ok(code);
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: RESOURCE
    });
    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; expires_in: number };
    assert.equal(tokens.expires_in, 900);
    assert.ok(oauth.verifyAccessToken(tokens.access_token));

    const refreshResponse = await fetch(`${base}/oauth/token`, {
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
    const refreshed = await refreshResponse.json() as { access_token: string; refresh_token: string };
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    assert.ok(oauth.verifyAccessToken(refreshed.access_token));

    const replay = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: tokens.refresh_token,
        resource: RESOURCE
      })
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as { error: string }).error, "invalid_grant");
  });
});
}


test("newer OAuth authorization supersedes an older pending request", async () => {
  await withOAuthServer(async (base) => {
    const registration = await fetch(`${base}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "ChatGPT test" })
    }).then((response) => response.json()) as { client_id: string };
    const authorize = async (state: string) => {
      const verifier = randomBytes(48).toString("base64url");
      const url = new URL(`${base}/oauth/authorize`);
      url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", registration.client_id);
      url.searchParams.set("redirect_uri", REDIRECT); url.searchParams.set("scope", "devrelay offline_access");
      url.searchParams.set("state", state); url.searchParams.set("resource", RESOURCE);
      url.searchParams.set("code_challenge", challenge(verifier)); url.searchParams.set("code_challenge_method", "S256");
      assert.equal((await fetch(url)).status, 200);
    };
    await authorize("older");
    const pendingUrl = `${base}/oauth/internal/pending`;
    const headers = { "x-devrelay-control-secret": "local-control-secret" };
    const older = await fetch(pendingUrl, { headers }).then((response) => response.json()) as { pending: Array<{ id: string }> };
    assert.equal(older.pending.length, 1);
    const olderId = older.pending[0]!.id;
    await authorize("newer");
    const newer = await fetch(pendingUrl, { headers }).then((response) => response.json()) as { pending: Array<{ id: string }> };
    assert.equal(newer.pending.length, 1);
    assert.notEqual(newer.pending[0]!.id, olderId);
    const oldStatus = await fetch(`${base}/oauth/authorize/status?id=${encodeURIComponent(olderId)}`).then((response) => response.json()) as { status: string; redirect: string };
    assert.equal(oldStatus.status, "denied");
    const oldRedirect = new URL(oldStatus.redirect);
    assert.equal(oldRedirect.searchParams.get("state"), "older");
    assert.match(oldRedirect.searchParams.get("error_description") ?? "", /superseded/i);
  });
});
