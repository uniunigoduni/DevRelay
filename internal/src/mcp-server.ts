import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ProcessManager } from "./process-manager.js";
import type { CommandSpec } from "./types.js";

const shellSchema = z.enum(["auto", "cmd", "powershell", "pwsh", "direct"]);
const commandSchema = z.object({
  command: z.string().min(1).describe("Shell command, or executable path when shell=direct."),
  args: z.array(z.string()).optional().describe("Arguments for shell=direct only."),
  cwd: z.string().optional().describe("Working directory. Defaults to the DevRelay process directory."),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables merged over the current environment."),
  shell: shellSchema.optional().default("auto").describe("Execution mode. auto uses cmd.exe on Windows and $SHELL or /bin/sh elsewhere.")
});

function toCommandSpec(input: z.infer<typeof commandSchema>): CommandSpec {
  return {
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    shell: input.shell
  };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

async function handled<T>(fn: () => Promise<T> | T) {
  try {
    return textResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

export function createDevRelayServer(manager: ProcessManager): McpServer {
  const server = new McpServer({ name: "devrelay", version: "0.1.0" });

  server.registerTool(
    "exec",
    {
      description: "Run a command to completion and return stdout, stderr, exit status, timeout state, and truncation state.",
      inputSchema: commandSchema.extend({
        stdin: z.string().optional().describe("Optional stdin content. stdin is closed after this content is sent."),
        timeoutMs: z.number().int().positive().max(86_400_000).optional().describe("Kill the command after this many milliseconds."),
        maxOutputChars: z.number().int().min(1024).max(4_000_000).optional().describe("Maximum retained stdout+stderr characters. Default 524288.")
      })
    },
    async (input) => handled(() => manager.execute(toCommandSpec(input), {
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      maxOutputChars: input.maxOutputChars
    }))
  );

  server.registerTool(
    "process_start",
    {
      description: "Start a long-running command and return a managed process ID. Use process_read, process_write, and process_stop afterward.",
      inputSchema: commandSchema.extend({
        maxBufferChars: z.number().int().min(16_384).max(8_000_000).optional().describe("Rolling output buffer size. Default 1048576 characters.")
      })
    },
    async (input) => handled(() => manager.start(toCommandSpec(input), input.maxBufferChars))
  );

  server.registerTool(
    "process_read",
    {
      description: "Read retained stdout/stderr events from a managed process. Reuse nextCursor on the next call to receive only new output.",
      inputSchema: z.object({
        processId: z.string().min(1),
        cursor: z.number().int().nonnegative().optional().default(0),
        maxChars: z.number().int().min(1).max(1_000_000).optional().default(65_536),
        waitMs: z.number().int().min(0).max(30_000).optional().default(0).describe("Wait for new output or process exit when no data is currently available.")
      })
    },
    async ({ processId, cursor, maxChars, waitMs }) => handled(() => manager.read(processId, { cursor, maxChars, waitMs }))
  );

  server.registerTool(
    "process_write",
    {
      description: "Write text to a managed process stdin. Set end=true to close stdin after writing.",
      inputSchema: z.object({
        processId: z.string().min(1),
        data: z.string().default(""),
        end: z.boolean().optional().default(false)
      })
    },
    async ({ processId, data, end }) => handled(() => manager.write(processId, data, end))
  );

  server.registerTool(
    "process_stop",
    {
      description: "Stop a managed process tree and remove it from the registry.",
      inputSchema: z.object({
        processId: z.string().min(1),
        force: z.boolean().optional().default(true)
      })
    },
    async ({ processId, force }) => handled(() => manager.stop(processId, force))
  );

  server.registerTool(
    "process_list",
    {
      description: "List processes started by DevRelay. Completed processes remain visible briefly so their output can still be read.",
      inputSchema: z.object({})
    },
    async () => textResult(manager.list())
  );

  return server;
}
