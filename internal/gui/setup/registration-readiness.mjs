export function protectedResourceMetadataUrl(publicUrl) {
  const endpoint = new URL(publicUrl);
  if (endpoint.protocol !== "https:") throw new Error("Public MCP endpoint must use HTTPS.");
  return new URL(`/.well-known/oauth-protected-resource${endpoint.pathname}`, endpoint.origin).href;
}

export async function checkPublicOAuthReady(publicUrl, fetchImpl = fetch) {
  const endpoint = new URL(publicUrl);
  const resourceMetadataUrl = protectedResourceMetadataUrl(publicUrl);
  const requestOptions = () => ({ redirect: "manual", signal: AbortSignal.timeout(5000) });
  const mcp = await fetchImpl(endpoint.href, requestOptions());
  const challenge = mcp.headers.get("www-authenticate") || "";
  if (mcp.status !== 401 || !challenge.includes(`resource_metadata="${resourceMetadataUrl}"`)) {
    throw new Error(`MCP endpoint is not advertising OAuth yet (HTTP ${mcp.status}).`);
  }
  const resourceResponse = await fetchImpl(resourceMetadataUrl, requestOptions());
  if (!resourceResponse.ok) throw new Error(`Protected-resource metadata returned HTTP ${resourceResponse.status}.`);
  const resource = await resourceResponse.json();
  if (resource.resource !== endpoint.href) throw new Error("Protected-resource metadata describes a different MCP resource.");
  const authorizationServer = Array.isArray(resource.authorization_servers) ? resource.authorization_servers[0] : null;
  if (!authorizationServer) throw new Error("Protected-resource metadata has no authorization server.");
  const authorizationOrigin = new URL(authorizationServer).origin;
  const authMetadataUrl = new URL("/.well-known/oauth-authorization-server", authorizationOrigin).href;
  const authResponse = await fetchImpl(authMetadataUrl, requestOptions());
  if (!authResponse.ok) throw new Error(`Authorization-server metadata returned HTTP ${authResponse.status}.`);
  const auth = await authResponse.json();
  if (auth.issuer !== authorizationOrigin || !auth.authorization_endpoint || !auth.token_endpoint || !auth.registration_endpoint) {
    throw new Error("Authorization-server metadata is incomplete.");
  }
  return { publicUrl: endpoint.href, resourceMetadataUrl, authorizationServer: authorizationOrigin };
}

export async function waitForPublicOAuthReady(publicUrl, { fetchImpl = fetch, timeoutMs = 90000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { return await checkPublicOAuthReady(publicUrl, fetchImpl); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Public OAuth endpoint did not become ready in time: ${lastError?.message || "unknown error"}`);
}
