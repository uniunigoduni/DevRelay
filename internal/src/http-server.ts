import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createDevRelayServer } from "./mcp-server.js";
import { ProcessManager } from "./process-manager.js";

export interface HttpServerHandle {
  close(): Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export async function serveHttp(manager: ProcessManager, host: string, port: number): Promise<HttpServerHandle> {
  const handler = createMcpHandler(() => createDevRelayServer(manager));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const localOnly = isLoopback(host);

  const httpServer = createHttpServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (path !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found\n");
      return;
    }

    if (localOnly && (!validateHost(request, response) || !validateOrigin(request, response))) return;
    void nodeHandler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  console.error(`[DevRelay] HTTP MCP listening on http://${host}:${port}/mcp`);

  return {
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
