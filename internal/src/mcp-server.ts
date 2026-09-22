import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ProcessManager } from "./process-manager.js";
import { loadImageContents } from "./image-content.js";
import type { CommandSpec } from "./types.js";
import type { DeviceIdentity } from "./device-identity.js";

const shellSchema = z.enum(["auto", "cmd", "powershell", "pwsh", "direct"]);
const oauthToolMeta = { securitySchemes: [{ type: "oauth2", scopes: ["devrelay"] }] };
const commandSchema = z.object({
  command: z.string().min(1).describe("Shell command, or executable path when shell=direct."),
  args: z.array(z.string()).optional().describe("Arguments for shell=direct only."),
  cwd: z.string().optional().describe("Working directory. Defaults to the DevRelay process directory."),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables merged over the current environment."),
  shell: shellSchema.optional().default("auto").describe("Execution mode. auto uses cmd.exe on Windows and $SHELL or /bin/sh elsewhere."),
  outputEncoding: z.string().min(1).max(64).optional().describe("Override stdout/stderr decoding, for example utf8, cp932, cp437, or system. Normally omit this; Windows cmd/PowerShell output is normalized automatically.")
});

function toCommandSpec(input: z.infer<typeof commandSchema>): CommandSpec {
  return {
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    shell: input.shell,
    outputEncoding: input.outputEncoding
  };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function contentResult(value: unknown, images: string[] | undefined, baseDir: string) {
  return { content: [
    { type: "text" as const, text: JSON.stringify(value) },
    ...await loadImageContents(images, baseDir)
  ] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

async function handled<T>(fn: () => Promise<T> | T) {
  try {
    return textResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

function deviceView(identity: DeviceIdentity) {
  return {
    nodeId: identity.nodeId, name: identity.name, defaultName: identity.defaultName,
    aliases: identity.aliases, platform: identity.facts.platform, arch: identity.facts.arch,
    hardware: identity.facts.boardModel ?? identity.facts.cpuModel, online: true
  };
}

const detailSchema = z.enum(["compact", "full"]).optional().default("compact");

export function compactExec(device: string, value: {
  ok: boolean; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
  stdout: string; stderr: string; truncated: boolean; startedAt: string; endedAt: string | null;
}) {
  const result: Record<string, unknown> = { device, ok: value.ok };
  if (value.exitCode !== null && value.exitCode !== 0) result.exitCode = value.exitCode;
  if (value.signal) result.signal = value.signal;
  if (value.timedOut) result.timedOut = true;
  if (value.stdout) result.stdout = value.stdout;
  if (value.stderr) result.stderr = value.stderr;
  if (value.truncated) result.truncated = true;
  return result;
}

export function compactProcessStart(device: string, process: Awaited<ReturnType<ProcessManager["start"]>>) {
  const result: Record<string, unknown> = { device, processId: process.id, pid: process.pid };
  if (process.terminal) {
    result.terminal = true;
    result.columns = process.columns;
    result.rows = process.rows;
  }
  return result;
}

export function compactProcessRead(device: string, value: Awaited<ReturnType<ProcessManager["read"]>>) {
  const result: Record<string, unknown> = { device, nextCursor: value.nextCursor, running: value.process.running };
  if (value.events.length) result.events = value.events.map(({ stream, text }) => ({ stream, text }));
  if (value.truncated) { result.truncated = true; result.oldestCursor = value.oldestCursor; }
  if (!value.process.running) {
    if (value.process.exitCode !== null) result.exitCode = value.process.exitCode;
    if (value.process.signal) result.signal = value.process.signal;
  }
  return result;
}

export function compactProcessWrite(device: string, value: Awaited<ReturnType<ProcessManager["write"]>>) {
  const result: Record<string, unknown> = { device, ok: true };
  if (value.bytes) result.bytes = value.bytes;
  if (value.ended) result.ended = true;
  if (value.columns !== undefined && value.columns !== null) result.columns = value.columns;
  if (value.rows !== undefined && value.rows !== null) result.rows = value.rows;
  return result;
}

export function compactProcessStop(device: string, process: Awaited<ReturnType<ProcessManager["stop"]>>) {
  const result: Record<string, unknown> = { device, ok: true };
  if (process.exitCode !== null) result.exitCode = process.exitCode;
  if (process.signal) result.signal = process.signal;
  return result;
}

export function compactProcessListItem(process: ReturnType<ProcessManager["list"]>[number]) {
  const result: Record<string, unknown> = { processId: process.id, pid: process.pid, command: process.command };
  if (process.cwd) result.cwd = process.cwd;
  if (process.shell !== "auto") result.shell = process.shell;
  if (process.terminal) { result.terminal = true; result.columns = process.columns; result.rows = process.rows; }
  if (!process.running) {
    result.running = false;
    if (process.exitCode !== null) result.exitCode = process.exitCode;
    if (process.signal) result.signal = process.signal;
  }
  return result;
}

export function createDevRelayServer(manager: ProcessManager, identity: DeviceIdentity): McpServer {
  const server = new McpServer({ name: "devrelay", version: "0.1.0" });

  server.registerTool(
    "exec",
    {
      description: "Run a command to completion and return stdout/stderr metadata, with optional MCP image attachments.",
      _meta: oauthToolMeta,
      inputSchema: commandSchema.extend({
        stdin: z.string().optional().describe("Optional stdin content. stdin is closed after this content is sent."),
        timeoutMs: z.number().int().positive().max(86_400_000).optional().describe("Kill the command after this many milliseconds."),
        maxOutputChars: z.number().int().min(1024).max(4_000_000).optional().describe("Maximum retained stdout+stderr characters. Default 524288."),
        images: z.array(z.string().min(1)).max(4).optional().describe("Image files to return after the command completes. Relative paths resolve from cwd. PNG/JPEG/WebP/GIF only."),
        detail: detailSchema.describe("compact omits redundant/default metadata; full returns the legacy detailed result.")
      })
    },
    async (input) => {
      try {
        const value = await manager.execute(toCommandSpec(input), {
          stdin: input.stdin, timeoutMs: input.timeoutMs, maxOutputChars: input.maxOutputChars
        });
        const payload = input.detail === "full" ? { device: deviceView(identity), ...value } : compactExec(identity.name, value);
        return await contentResult(payload, input.images, input.cwd ?? process.cwd());
      } catch (error) { return errorResult(error); }
    }
  );

  server.registerTool(
    "process_start",
    {
      description: "Start a long-running managed process. Set terminal=true for a PTY/ConPTY session; multiple sessions may coexist.",
      _meta: oauthToolMeta,
      inputSchema: commandSchema.extend({
        maxBufferChars: z.number().int().min(16_384).max(8_000_000).optional().describe("Rolling output buffer size. Default 1048576 characters."),
        terminal: z.boolean().optional().default(false).describe("Run in a PTY/ConPTY for interactive terminal applications."),
        columns: z.number().int().min(20).max(500).optional().default(120),
        rows: z.number().int().min(5).max(300).optional().default(30),
        detail: detailSchema.describe("compact returns only the process handle and essential terminal metadata; full returns the detailed snapshot.")
      })
    },
    async (input) => handled(async () => {
      const process = await manager.start(toCommandSpec(input), input.maxBufferChars, { terminal: input.terminal, columns: input.columns, rows: input.rows });
      return input.detail === "full" ? { device: deviceView(identity), process } : compactProcessStart(identity.name, process);
    })
  );

  server.registerTool(
    "process_read",
    {
      description: "Read retained process/terminal output incrementally and optionally attach image files. Reuse nextCursor for only new output.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        processId: z.string().min(1),
        cursor: z.number().int().nonnegative().optional().default(0),
        maxChars: z.number().int().min(1).max(1_000_000).optional().default(65_536),
        waitMs: z.number().int().min(0).max(30_000).optional().default(0).describe("Wait for new output or process exit when no data is currently available."),
        images: z.array(z.string().min(1)).max(4).optional().describe("Image files to return with this read. Relative paths resolve from the managed process cwd."),
        detail: detailSchema.describe("compact returns new text plus cursor/status only; full returns event timestamps/cursors and the full process snapshot.")
      })
    },
    async ({ processId, cursor, maxChars, waitMs, images, detail }) => {
      try {
        const value = await manager.read(processId, { cursor, maxChars, waitMs });
        const payload = detail === "full" ? { device: deviceView(identity), ...value } : compactProcessRead(identity.name, value);
        return await contentResult(payload, images, value.process.cwd ?? process.cwd());
      } catch (error) { return errorResult(error); }
    }
  );

  server.registerTool(
    "process_write",
    {
      description: "Write data to a managed pipe or PTY session. PTY sessions can also be resized with columns and rows.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        processId: z.string().min(1),
        data: z.string().default(""),
        end: z.boolean().optional().default(false),
        columns: z.number().int().min(20).max(500).optional().describe("Resize a terminal session to this many columns. Supply rows too."),
        rows: z.number().int().min(5).max(300).optional().describe("Resize a terminal session to this many rows. Supply columns too."),
        detail: detailSchema.describe("compact returns only changed/meaningful fields; full returns the legacy write result.")
      })
    },
    async ({ processId, data, end, columns, rows, detail }) => handled(async () => {
      if ((columns === undefined) !== (rows === undefined)) throw new Error("columns and rows must be supplied together.");
      const resize = columns !== undefined && rows !== undefined ? { columns, rows } : undefined;
      const value = await manager.write(processId, data, end, resize);
      return detail === "full" ? { device: deviceView(identity), ...value } : compactProcessWrite(identity.name, value);
    })
  );

  server.registerTool(
    "process_stop",
    {
      description: "Stop a managed process tree and remove it from the registry.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        processId: z.string().min(1),
        force: z.boolean().optional().default(true),
        detail: detailSchema.describe("compact confirms the stop and exit status; full returns the detailed final snapshot.")
      })
    },
    async ({ processId, force, detail }) => handled(async () => {
      const process = await manager.stop(processId, force);
      return detail === "full" ? { device: deviceView(identity), process } : compactProcessStop(identity.name, process);
    })
  );

  server.registerTool(
    "process_list",
    {
      description: "List managed processes. Running processes are shown by default; completed retained processes can be included on demand.",
      _meta: oauthToolMeta,
      inputSchema: z.object({
        includeCompleted: z.boolean().optional().default(true).describe("Include completed processes that are still retained for reading. Set false for running processes only."),
        detail: detailSchema.describe("compact returns identification/status fields; full returns detailed process snapshots and device metadata.")
      })
    },
    async ({ includeCompleted, detail }) => {
      const processes = manager.list().filter((process) => includeCompleted || process.running);
      return detail === "full"
        ? textResult({ device: deviceView(identity), processes })
        : textResult({ device: identity.name, processes: processes.map(compactProcessListItem) });
    }
  );

  return server;
}
