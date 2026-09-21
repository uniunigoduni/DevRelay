import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ClusterRuntime } from "./cluster-runtime.js";

const shellSchema = z.enum(["auto", "cmd", "powershell", "pwsh", "direct"]);
const oauthToolMeta = { securitySchemes: [{ type: "oauth2", scopes: ["devrelay"] }] };

const deviceField = z.string().min(1).optional().describe(
  "Target device by user name, auto-generated default name, alias, node ID, or unique node-ID prefix. Omit to use the node that received this request."
);

const commandSchema = z.object({
  device: deviceField,
  command: z.string().min(1).describe("Shell command, or executable path when shell=direct."),
  args: z.array(z.string()).optional().describe("Arguments for shell=direct only."),
  cwd: z.string().optional().describe("Working directory. Defaults to the target DevRelay process directory."),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables merged over the target device environment."),
  shell: shellSchema.optional().default("auto").describe("Execution mode. auto uses cmd.exe on Windows and $SHELL or /bin/sh elsewhere.")
});

export function createDevRelayServer(runtime: ClusterRuntime): McpServer {
  const server = new McpServer({ name: "devrelay", version: "0.1.0" });
  server.registerTool(
    "exec",
    {
      description: "Run a command to completion on a selected DevRelay device and return stdout/stderr metadata, with optional MCP image attachments.",
      _meta: oauthToolMeta,
      inputSchema: commandSchema.extend({
        stdin: z.string().optional().describe("Optional stdin content. stdin is closed after this content is sent."),
        timeoutMs: z.number().int().positive().max(86_400_000).optional().describe("Kill the command after this many milliseconds."),
        maxOutputChars: z.number().int().min(1024).max(4_000_000).optional().describe("Maximum retained stdout+stderr characters. Default 524288."),
        images: z.array(z.string().min(1)).max(4).optional().describe("Image files to return after the command completes. Relative paths resolve from cwd on the target device.")
      })
    },
    async (input) => await runtime.invoke("exec", input) as any
  );

  server.registerTool(
    "process_start",
    {
      description: "Start a long-running managed process on a selected device. Set terminal=true for a PTY/ConPTY session; multiple sessions may coexist.",
      _meta: oauthToolMeta,
      inputSchema: commandSchema.extend({
        maxBufferChars: z.number().int().min(16_384).max(8_000_000).optional().describe("Rolling output buffer size. Default 1048576 characters."),
        terminal: z.boolean().optional().default(false).describe("Run in a PTY/ConPTY for interactive terminal applications."),
        columns: z.number().int().min(20).max(500).optional().default(120),
        rows: z.number().int().min(5).max(300).optional().default(30)
      })
    },
    async (input) => await runtime.invoke("process_start", input) as any
  );
  server.registerTool(
    "process_read",
    {
      description: "Read retained output from a managed process. The process ID identifies its owning device, so cross-device reads are routed automatically.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        processId: z.string().min(1),
        cursor: z.number().int().nonnegative().optional().default(0),
        maxChars: z.number().int().min(1).max(1_000_000).optional().default(65_536),
        waitMs: z.number().int().min(0).max(30_000).optional().default(0).describe("Wait for new output or process exit when no data is currently available."),
        images: z.array(z.string().min(1)).max(4).optional().describe("Image files to return with this read from the process-owning device.")
      })
    },
    async (input) => await runtime.invoke("process_read", input) as any
  );

  server.registerTool(
    "process_write",
    {
      description: "Write data to a managed pipe or PTY session. The owning device is inferred from processId. PTY sessions can also be resized.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        processId: z.string().min(1),
        data: z.string().default(""),
        end: z.boolean().optional().default(false),
        columns: z.number().int().min(20).max(500).optional().describe("Resize a terminal session to this many columns. Supply rows too."),
        rows: z.number().int().min(5).max(300).optional().describe("Resize a terminal session to this many rows. Supply columns too.")
      })
    },
    async (input) => await runtime.invoke("process_write", input) as any
  );
  server.registerTool(
    "process_stop",
    {
      description: "Stop a managed process tree and remove it from the registry. The owning device is inferred from processId.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        processId: z.string().min(1),
        force: z.boolean().optional().default(true)
      })
    },
    async (input) => await runtime.invoke("process_stop", input) as any
  );

  server.registerTool(
    "process_list",
    {
      description: "List the DevRelay cluster view: online/offline devices plus retained managed processes. Optionally limit processes to one device.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        device: deviceField
      })
    },
    async (input) => await runtime.invoke("process_list", input) as any
  );

  return server;
}
