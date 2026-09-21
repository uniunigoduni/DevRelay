import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createDevRelayServer } from "./mcp-server.js";
import { DevRelayOAuthServer } from "./oauth-server.js";
import { ProcessManager } from "./process-manager.js";
import type { DeviceIdentity } from "./device-identity.js";

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
  const handler = createMcpHandler(() => createDevRelayServer(manager, identity));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const localOnly = isLoopback(host);
  const oauth = await createOAuthFromEnvironment();

  const httpServer = createHttpServer((request, response) => {
    void (async () => {
      if (localOnly && !validateHost(request, response)) return;
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

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
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
