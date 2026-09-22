import https from "node:https";
import dns from "node:dns/promises";

export function protectedResourceMetadataUrl(publicUrl) {
  const endpoint = new URL(publicUrl);
  if (endpoint.protocol !== "https:") throw new Error("Public MCP endpoint must use HTTPS.");
  return new URL(`/.well-known/oauth-protected-resource${endpoint.pathname}`, endpoint.origin).href;
}

async function resolveFreshAddress(hostname) {
  const ipv4 = await dns.resolve4(hostname).catch(() => []);
  if (ipv4.length) return { address: ipv4[0], family: 4 };
  const ipv6 = await dns.resolve6(hostname).catch(() => []);
  if (ipv6.length) return { address: ipv6[0], family: 6 };
  throw new Error(`DNS did not return an address for ${hostname}.`);
}

export async function fetchPublicHttpsFreshDns(url, { timeoutMs = 5000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("Public readiness requests must use HTTPS.");
  const resolved = await resolveFreshAddress(target.hostname);
  return await new Promise((resolve, reject) => {
    const req = https.request(target, {
      method: "GET",
      servername: target.hostname,
      timeout: timeoutMs,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
        else callback(null, resolved.address, resolved.family);
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          headers: { get(name) {
            const value = res.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value ?? null;
          } },
          async json() { return JSON.parse(body); },
          async text() { return body; }
        });
      });
    });
    req.once("timeout", () => req.destroy(new Error(`HTTPS request to ${target.hostname} timed out.`)));
    req.once("error", reject);
    req.end();
  });
}

export async function checkPublicOAuthReady(publicUrl, fetchImpl = fetchPublicHttpsFreshDns) {
  const endpoint = new URL(publicUrl);
  const resourceMetadataUrl = protectedResourceMetadataUrl(publicUrl);
  const requestOptions = () => ({ redirect: "manual", signal: AbortSignal.timeout(5000), timeoutMs: 5000 });
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

export async function waitForPublicOAuthReady(publicUrl, { fetchImpl = fetchPublicHttpsFreshDns, timeoutMs = 90000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { return await checkPublicOAuthReady(publicUrl, fetchImpl); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Public OAuth endpoint did not become ready in time: ${lastError?.message || "unknown error"}`);
}
