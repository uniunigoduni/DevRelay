#!/usr/bin/env node
import path from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { serveHttp, type HttpServerHandle } from "./http-server.js";
import { createDevRelayServer } from "./mcp-server.js";
import { ProcessManager } from "./process-manager.js";
import { loadDeviceIdentity } from "./device-identity.js";

const VERSION = "0.2.0";

type Transport = "stdio" | "http";

interface CliOptions {
  transport: Transport;
  host: string;
  port: number;
}

function usage(): string {
  return `DevRelay ${VERSION}

Usage:
  devrelay [--stdio]
  devrelay --http [--host HOST] [--port PORT]

Options:
  --stdio       Serve MCP over stdin/stdout (default)
  --http        Serve MCP over Streamable HTTP
  --host HOST   HTTP bind address (default: 127.0.0.1)
  --port PORT   HTTP port (default: 7317)
  --version     Print version
  --help        Print this help`;
}

function parseArgs(argv: string[]): CliOptions | null {
  let transport: Transport = "stdio";
  let host = "127.0.0.1";
  let port = 7317;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return null;
    }
    if (arg === "--version" || arg === "-v") {
      console.log(VERSION);
      return null;
    }
    if (arg === "--stdio") transport = "stdio";
    else if (arg === "--http") transport = "http";
    else if (arg === "--host") {
      const value = argv[++index];
      if (!value) throw new Error("--host requires a value.");
      host = value;
    } else if (arg === "--port") {
      const value = argv[++index];
      if (!value) throw new Error("--port requires a value.");
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer from 1 to 65535.");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { transport, host, port };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const stateDir = process.env.DEVRELAY_STATE_DIR?.trim() || path.resolve(process.cwd(), ".devrelay");
  const manager = new ProcessManager();
  const identity = await loadDeviceIdentity(stateDir);
  let httpHandle: HttpServerHandle | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[DevRelay] shutting down (${signal})`);
    await manager.stopAll(true);
    if (httpHandle) await httpHandle.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (options.transport === "http") {
    console.error(`[DevRelay] device ${identity.name} (${identity.defaultName}) node=${identity.nodeId}`);
    httpHandle = await serveHttp(manager, identity, options.host, options.port);
    return;
  }

  console.error(`[DevRelay] device ${identity.name} (${identity.defaultName}) node=${identity.nodeId}`);
  void serveStdio(() => createDevRelayServer(manager, identity));
  console.error("[DevRelay] MCP serving over stdio");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[DevRelay] fatal: ${message}`);
  process.exitCode = 1;
});
