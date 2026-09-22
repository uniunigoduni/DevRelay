import assert from "node:assert/strict";
import test from "node:test";
import { checkPublicOAuthReady, protectedResourceMetadataUrl } from "./registration-readiness.mjs";

test("protected resource metadata URL follows the MCP resource path", () => {
  assert.equal(
    protectedResourceMetadataUrl("https://example.test/mcp"),
    "https://example.test/.well-known/oauth-protected-resource/mcp"
  );
});

test("public OAuth readiness requires the MCP challenge and both metadata documents", async () => {
  const base = "https://example.test";
  const metadata = `${base}/.well-known/oauth-protected-resource/mcp`;
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url) === `${base}/mcp`) {
      return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` } });
    }
    if (String(url) === metadata) {
      return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (String(url) === `${base}/.well-known/oauth-authorization-server`) {
      return Response.json({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register` });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await checkPublicOAuthReady(`${base}/mcp`, fakeFetch);
  assert.equal(result.authorizationServer, base);
  assert.deepEqual(calls, [`${base}/mcp`, metadata, `${base}/.well-known/oauth-authorization-server`]);
});

test("public OAuth readiness rejects a tunnel before its OAuth challenge is visible", async () => {
  const fakeFetch = async () => new Response("not ready", { status: 502 });
  await assert.rejects(
    checkPublicOAuthReady("https://example.test/mcp", fakeFetch),
    /not advertising OAuth yet/
  );
});
