# Architecture

## Goal

DevRelay exposes a development machine's existing command-line environment through a very small MCP surface. It deliberately avoids duplicating capabilities already present in operating-system and developer CLIs.

```text
MCP client
   |
   | stdio or Streamable HTTP
   v
DevRelay MCP adapter
   |
   v
ProcessManager
   |
   +-- one-shot child process (`exec`)
   |
   +-- retained child process (`process_*`)
           |
           +-- stdin
           +-- stdout/stderr -> OutputBuffer
```

## ProcessManager

`ProcessManager` is process-wide state. This matters for HTTP: the MCP SDK creates a fresh `McpServer` for each HTTP request, while all of those request-scoped server instances close over the same manager. A `process_start` call can therefore be followed by `process_read` in a later HTTP request.

Managed processes are identified by random `p_<uuid>` IDs. Their state is kept only in memory. Completed sessions are retained for 10 minutes and then removed automatically.

## Output buffering

stdout and stderr are captured as ordered events. Each event receives a monotonically increasing cursor. `process_read` accepts the previous `nextCursor`, which lets clients fetch only output that appeared since the preceding read.

The buffer is rolling and bounded by characters. Old events are discarded when the configured capacity is exceeded. A read reports `truncated: true` if the requested cursor predates retained output.

## Process lifetime

`exec` creates an ephemeral process, closes stdin after the optional input, waits for completion, and returns collected output. `process_start` creates a retained process that remains addressable until it is stopped, expires after completion, or DevRelay exits.

On Windows, process stopping uses `taskkill /T` so descendants launched by a shell are included. On POSIX systems the child is started as a process group and DevRelay signals the group.

## Transport separation

MCP protocol handling belongs to the official SDK. DevRelay uses `serveStdio()` for stdio and `createMcpHandler()` plus the official Node adapter for Streamable HTTP. The transport layer and ProcessManager are independent; neither contains Git, filesystem, Docker, or language-specific logic.
