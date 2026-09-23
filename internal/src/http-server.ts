import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { McpDiagnostics, inspectMcpHeaders } from "./diagnostics.js";
import { createDevRelayServer } from "./mcp-server.js";
import { DevRelayOAuthServer } from "./oauth-server.js";
import { ProcessManager } from "./process-manager.js";
import type { DeviceIdentity } from "./device-identity.js";
import { VERSION } from "./version.js";

export interface HttpServerHandle {
  close(): Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function createOAuthFromEnvironment(): Promise<DevRelayOAuthServer | undefined> {
  const issuer = process.env.DEVRELAY_OAUTH_ISSUER?.trim();
  if (!issuer) return undefined;
  const resource = process.env.DEVRELAY_OAUTH_RESOURCE?.trim();
  const stateDir = process.env.DEVRELAY_STATE_DIR?.trim();
  const controlSecret = process.env.DEVRELAY_OAUTH_CONTROL_SECRET?.trim();
  if (!resource || !stateDir || !controlSecret) {
    throw new Error("OAuth is enabled but DEVRELAY_OAUTH_RESOURCE, DEVRELAY_STATE_DIR, or DEVRELAY_OAUTH_CONTROL_SECRET is missing.");
  }
  return await DevRelayOAuthServer.create({ issuer, resource, stateDir, controlSecret });
}

export async function serveHttp(manager: ProcessManager, identity: DeviceIdentity, host: string, port: number): Promise<HttpServerHandle> {
  const diagnostics = new McpDiagnostics(VERSION, () => manager.list().filter((process) => process.running).length);
  const handler = createMcpHandler((context) => {
    const requestId = context.requestInfo?.headers.get("x-devrelay-request-id") ?? `r_${randomUUID()}`;
    diagnostics.routeRequest(requestId, context.era);
    return createDevRelayServer(manager, identity, { diagnostics, requestId });
  }, {
    onerror: (error) => diagnostics.reportError("mcp", error)
  });
  const nodeHandler = toNodeHandler(handler);
  const validateOrigin = localhostOriginValidation();
  const localOnly = isLoopback(host);
  const oauth = await createOAuthFromEnvironment();
  const allowedHosts = ["localhost", "127.0.0.1", "[::1]"];
  if (oauth) allowedHosts.push(new URL(oauth.issuer).hostname);
  const validateHost = hostHeaderValidation(allowedHosts);

  const httpServer = createHttpServer((request, response) => {
    const requestId = `r_${randomUUID()}`;
    request.headers["x-devrelay-request-id"] = requestId;
    let mcpRequest = false;

    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/mcp") {
        mcpRequest = true;
        diagnostics.beginRequest(
          requestId,
          request.method ?? "UNKNOWN",
          inspectMcpHeaders(request.headers["mcp-method"], request.headers["mcp-name"])
        );
        let responseFinished = false;
        response.once("finish", () => {
          responseFinished = true;
          diagnostics.finishRequest(requestId, response);
        });
        response.once("close", () => {
          if (!responseFinished) diagnostics.abortRequest(requestId, new Error("MCP response closed before completion."));
        });
      }

      if (localOnly && !validateHost(request, response)) {
        if (mcpRequest) diagnostics.markErrorCategory(requestId, "transport");
        return;
      }

      if (oauth && await oauth.handleRoute(request, response, url)) return;

      if (url.pathname !== "/mcp") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found\n");
        return;
      }

      if (localOnly && !validateOrigin(request, response)) {
        diagnostics.markErrorCategory(requestId, "transport");
        return;
      }
      if (oauth && !oauth.authorizeMcp(request, response)) {
        diagnostics.markErrorCategory(requestId, "auth");
        return;
      }
      void nodeHandler(request, response);
    })().catch((error: unknown) => {
      if (mcpRequest) diagnostics.reportError("internal", error, { requestId });
      else diagnostics.reportError("internal", error);
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      if (!response.writableEnded) response.end(`Internal Server Error: ${message}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  diagnostics.startHeartbeat();
  console.error(`[DevRelay] HTTP MCP listening on http://${host}:${port}/mcp`);
  if (oauth) console.error(`[DevRelay] OAuth 2.1 required for ${oauth.resource}`);

  return {
    async close() {
      diagnostics.stop();
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
