import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

async function withOAuthServer(run: (base: string, oauth: DevRelayOAuthServer) => Promise<void>): Promise<void> {
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
    await run(base, oauth);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("OAuth DCR + PKCE + refresh flow", async () => {
  await withOAuthServer(async (base, oauth) => {
    const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`).then((response) => response.json());
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.equal(metadata.registration_endpoint, `${ISSUER}/oauth/register`);
    const registrationResponse = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ChatGPT test"
      })
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json() as { client_id: string };
    assert.match(registration.client_id, /^drc\.local\./);

    const verifier = randomBytes(48).toString("base64url");
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    authorize.searchParams.set("scope", "devrelay offline_access");
    authorize.searchParams.set("state", "state-123");
    authorize.searchParams.set("resource", RESOURCE);
    authorize.searchParams.set("code_challenge", challenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    const authorizeResponse = await fetch(authorize);
    assert.equal(authorizeResponse.status, 200);
    assert.match(await authorizeResponse.text(), /Waiting for local approval/);

    const pendingResponse = await fetch(`${base}/oauth/internal/pending`, {
      headers: { "x-devrelay-control-secret": "local-control-secret" }
    });
    const pending = await pendingResponse.json() as { pending: Array<{ id: string }> };
    assert.equal(pending.pending.length, 1);

    const decision = await fetch(`${base}/oauth/internal/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devrelay-control-secret": "local-control-secret" },
      body: JSON.stringify({ id: pending.pending[0]!.id, approve: true })
    });
    assert.equal(decision.status, 200);

    const status = await fetch(`${base}/oauth/authorize/status?id=${encodeURIComponent(pending.pending[0]!.id)}`)
      .then((response) => response.json()) as { redirect: string };
    const callback = new URL(status.redirect);
    assert.equal(callback.searchParams.get("state"), "state-123");
    const code = callback.searchParams.get("code");
    assert.ok(code);
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code,
      redirect_uri: REDIRECT,
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
