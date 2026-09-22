# Architecture

## Goal

DevRelay exposes a development machine's existing command-line environment through a very small MCP surface. It avoids duplicating capabilities already present in operating-system and developer CLIs.

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
   +-- one-shot pipe child (`exec`)
   |
   +-- retained pipe child (`process_*`)
   |
   +-- retained PTY/ConPTY session (`process_*`, terminal=true)
   |
   +-- bounded OutputBuffer per retained session
```

The MCP surface remains six tools. PTY and image return are capabilities of existing tools rather than separate domain APIs.

## ProcessManager

`ProcessManager` is process-wide state. This matters for HTTP: request-scoped MCP server instances all close over the same manager, so a `process_start` call can be followed by later `process_read` / `process_write` requests.

Managed sessions use random `p_<uuid>` IDs and live only in memory. Completed sessions are retained for 10 minutes.

Pipe sessions use Node `child_process.spawn()`. Terminal sessions use `node-pty`, which maps to ConPTY on supported Windows systems. Each session records whether it is a terminal plus its current columns and rows.

## Output buffering

Pipe stdout/stderr are captured as ordered events. PTY output is a single terminal stream and is represented as `stdout`, including ANSI control sequences.

Every event receives a monotonically increasing cursor. `process_read` accepts the previous `nextCursor`; buffers are rolling and bounded by characters. Compact MCP responses omit per-event cursor/timestamp metadata while preserving event order and `nextCursor`; `detail: "full"` exposes the stored metadata.

## Image return

`exec` and `process_read` can load explicitly requested PNG, JPEG, WebP, or GIF files and append them as MCP `image` content. This is intentionally an output adapter, not a filesystem browsing API.

## Process lifetime

`exec` creates an ephemeral pipe process, closes stdin after optional input, waits for completion, and returns collected output.

`process_start` creates a retained pipe or terminal session. Ordinary Windows pipe sessions stop with process-tree termination. PTY sessions are terminated through the PTY backend so ConPTY receives a proper close and exit event.

## Transport separation

MCP protocol handling belongs to the official SDK. DevRelay uses stdio or Streamable HTTP independently of ProcessManager. Neither transport contains Git, filesystem, Docker, browser, or language-specific logic.

## Device identity and multi-device model

Each DevRelay owns one local `DeviceIdentity`, persisted under `.devrelay/device.json`. The immutable `nodeId` is separate from the editable display name; `defaultName` is recomputed from OS/hardware facts and aliases are optional. Compact tool results identify the endpoint by display name; full identity metadata remains available through `detail: "full"`.

DevRelay has no built-in device federation. Multiple machines are represented by multiple independently registered MCP plugins/connectors. Process IDs remain local to the DevRelay instance that created them, and there is no peer listener, cluster secret, discovery protocol, or cross-device forwarding.
