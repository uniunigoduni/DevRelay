import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { ClusterRuntime, type OAuthProxyResponse } from "./cluster-runtime.js";
import { createDevRelayServer } from "./mcp-server.js";
import { DevRelayOAuthServer } from "./oauth-server.js";

export interface HttpServerHandle {
  close(): Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function requestIsLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function opaqueOwner(value: string | null, prefix: string): string | undefined {
  if (!value) return undefined;
  const parts = value.split(".");
  return parts.length >= 3 && parts[0] === prefix && parts[1] ? parts[1] : undefined;
}
async function readRawBody(request: IncomingMessage, limit = 256 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw new Error("OAuth request body too large.");
  }
  return body;
}

function sendProxyResponse(response: ServerResponse, proxy: OAuthProxyResponse): void {
  response.writeHead(proxy.status, proxy.headers);
  response.end(proxy.body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function createOAuthFromEnvironment(runtime: ClusterRuntime): Promise<DevRelayOAuthServer | undefined> {
  const issuer = process.env.DEVRELAY_OAUTH_ISSUER?.trim();
  if (!issuer) return undefined;
  const resource = process.env.DEVRELAY_OAUTH_RESOURCE?.trim();
  const stateDir = process.env.DEVRELAY_STATE_DIR?.trim();
  const controlSecret = process.env.DEVRELAY_OAUTH_CONTROL_SECRET?.trim();
  if (!resource || !stateDir || !controlSecret) {
    throw new Error("OAuth is enabled but DEVRELAY_OAUTH_RESOURCE, DEVRELAY_STATE_DIR, or DEVRELAY_OAUTH_CONTROL_SECRET is missing.");
  }
  return await DevRelayOAuthServer.create({
    issuer, resource, stateDir, controlSecret,
    nodeId: runtime.identity.nodeId,
    signingKey: runtime.oauthSigningKey()
  });
}
async function maybeProxyOAuth(
  runtime: ClusterRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const internalProxy = request.headers["x-devrelay-internal-oauth-proxy"] === "1" && requestIsLoopback(request);
  if (internalProxy) return false;

  if (request.method === "GET" && url.pathname === "/oauth/authorize") {
    const owner = opaqueOwner(url.searchParams.get("client_id"), "drc");
    if (owner && owner !== runtime.identity.nodeId) {
      sendProxyResponse(response, await runtime.proxyOAuth(owner, { method: "GET", path: `${url.pathname}${url.search}` }));
      return true;
    }
  }

  if (request.method === "GET" && url.pathname === "/oauth/authorize/status") {
    const owner = opaqueOwner(url.searchParams.get("id"), "par");
    if (owner && owner !== runtime.identity.nodeId) {
      sendProxyResponse(response, await runtime.proxyOAuth(owner, { method: "GET", path: `${url.pathname}${url.search}` }));
      return true;
    }
  }
  if (request.method === "POST" && url.pathname === "/oauth/token") {
    const body = await readRawBody(request);
    const form = new URLSearchParams(body);
    const owner = opaqueOwner(form.get("client_id"), "drc") ?? runtime.identity.nodeId;
    const contentType = typeof request.headers["content-type"] === "string"
      ? request.headers["content-type"]
      : "application/x-www-form-urlencoded";
    sendProxyResponse(response, await runtime.proxyOAuth(owner, {
      method: "POST",
      path: `${url.pathname}${url.search}`,
      body,
      headers: { "content-type": contentType }
    }));
    return true;
  }

  return false;
}

export async function serveHttp(runtime: ClusterRuntime, host: string, port: number): Promise<HttpServerHandle> {
  const handler = createMcpHandler(() => createDevRelayServer(runtime));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const localOnly = isLoopback(host);
  const oauth = await createOAuthFromEnvironment(runtime);
  if (oauth) runtime.attachOAuthControl({
    listPending: () => oauth.listPending(),
    decidePending: (id, approve) => oauth.decidePending(id, approve)
  });
  const httpServer = createHttpServer((request, response) => {
    void (async () => {
      if (localOnly && !validateHost(request, response)) return;
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (oauth && (url.pathname === "/oauth/internal/pending" || url.pathname === "/oauth/internal/decision")) {
        if (!requestIsLoopback(request) || !oauth.verifyControlRequest(request)) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("Forbidden\n");
          return;
        }
        if (request.method === "GET" && url.pathname === "/oauth/internal/pending") {
          sendJson(response, 200, { pending: await runtime.listOAuthPending() });
          return;
        }
        if (request.method === "POST" && url.pathname === "/oauth/internal/decision") {
          const body = JSON.parse(await readRawBody(request) || "{}");
          const ok = typeof body.id === "string" && await runtime.decideOAuthPending(body.id, body.approve === true);
          sendJson(response, ok ? 200 : 404, ok ? { ok: true } : { error: "pending_request_not_found" });
          return;
        }
      }

      if (oauth && await maybeProxyOAuth(runtime, request, response, url)) return;
      if (oauth && await oauth.handleRoute(request, response, url)) return;

      if (url.pathname !== "/mcp") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found\n");
        return;
      }

      if (localOnly && !validateOrigin(request, response)) return;
      if (oauth && !oauth.authorizeMcp(request, response)) return;
      void nodeHandler(request, response);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      if (!response.writableEnded) response.end(`Internal Server Error: ${message}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  console.error(`[DevRelay] HTTP MCP listening on http://${host}:${port}/mcp`);
  if (oauth) console.error(`[DevRelay] OAuth 2.1 required for ${oauth.resource}`);

  return {
    async close() {
      runtime.attachOAuthControl(undefined);
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
