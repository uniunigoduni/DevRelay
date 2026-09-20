# DevRelay

DevRelay is a deliberately small MCP server that gives an MCP client access to the command line of a development machine.

The design rule is simple: **if a task can already be done by a CLI, DevRelay does not reimplement it.** Git, npm, Python, Docker, SSH, PowerShell, ripgrep, compilers, and other tools remain ordinary processes. DevRelay only starts them, streams their output, accepts stdin, and stops them.

## Status

DevRelay is currently **v0.1.0**. The initial implementation targets development use on Windows while keeping the process layer portable to other Node.js platforms.

## Features

- MCP over stdio.
- MCP over Streamable HTTP.
- Arbitrary one-shot command execution.
- Managed long-running processes with stdin/stdout/stderr.
- Cursor-based incremental log reads.
- Rolling in-memory output buffers.
- Process-tree termination on Windows.
- The MCP core has no database, agent loop, PTY, or embedded tunnel. The Windows launcher UI is a separate local controller.
- Three runtime dependencies only: the MCP server SDK, its Node adapter, and Zod.

## Requirements

- Node.js 20 or newer.
- npm.
- Whatever command-line tools you want DevRelay to invoke.

The MCP Inspector v2 currently requires a newer Node 22 release; DevRelay itself only requires Node 20+.

## Build

```powershell
cd C:\Users\<user>\Downloads\DevRelay\internal
npm install
npm run build
npm test
```

For a local `devrelay` command:

```powershell
npm link
```

## Run over stdio

Stdio is the default transport and is intended for an MCP host that starts DevRelay as a child process.

```powershell
devrelay
# or
node dist/src/main.js
```

Do not write application logs to stdout while using stdio. DevRelay itself logs transport status to stderr because stdout is the MCP protocol channel.

## Run over HTTP

```powershell
devrelay --http
```

The default endpoint is:

```text
http://127.0.0.1:7317/mcp
```

You can change the bind address and port explicitly:

```powershell
devrelay --http --host 127.0.0.1 --port 7317
```

The normal remote-access pattern is to keep DevRelay bound to loopback and place a tunnel or authenticated gateway in front of it. See [docs/transports.md](internal/docs/transports.md).

## MCP tools

| Tool | Purpose |
| --- | --- |
| `exec` | Run a command to completion and collect stdout/stderr. |
| `process_start` | Start a long-running managed process. |
| `process_read` | Read process output incrementally with a cursor. |
| `process_write` | Send text to process stdin and optionally close stdin. |
| `process_stop` | Stop a managed process tree and forget it. |
| `process_list` | List processes currently retained by DevRelay. |

There are intentionally no Git, filesystem, Docker, package-manager, or search-specific tools. Use their CLIs through `exec` or `process_start`.

## Shell modes

- `auto`: `cmd.exe` on Windows; `$SHELL` or `/bin/sh` elsewhere.
- `cmd`: run through `cmd.exe /d /s /c`.
- `powershell`: run through Windows PowerShell.
- `pwsh`: run through PowerShell 7 when installed.
- `direct`: execute `command` directly and pass the optional `args` array without a shell.

`direct` is the best choice when the executable and arguments are already known because it avoids another shell parser.

## Managed-process workflow

A typical long-running workflow is:

1. Call `process_start` with `npm run dev` and a working directory.
2. Call `process_read` with `cursor: 0` and optionally `waitMs`.
3. Keep the returned `nextCursor`.
4. Call `process_write` when the program needs stdin.
5. Call `process_read` again with the previous `nextCursor` to receive only new output.
6. Call `process_stop` when the process is no longer needed.

Completed managed processes remain in memory for 10 minutes so their final output can still be read. DevRelay does not persist or reattach process sessions across its own restart.

## Documentation

- [Architecture](internal/docs/architecture.md)
- [Tool reference](internal/docs/tools.md)
- [Transports and remote access](internal/docs/transports.md)
- [Development guide](internal/docs/development.md)
- [Security model](internal/docs/security.md)
- [Design decisions and non-goals](internal/docs/design.md)

## Development philosophy

DevRelay is infrastructure glue, not a remote IDE and not an autonomous agent. New first-class tools should only be added when ordinary command-line composition cannot provide the same capability cleanly.

## License

MIT. See [LICENSE](LICENSE).

## Upstream references

The implementation patterns and interoperability references used for v0.1 are documented in [docs/references.md](internal/docs/references.md).

## Windows double-click launchers

For normal Windows use, two no-argument launchers are provided:

- `DevRelay ChatGPT.cmd` opens the local control GUI in OpenAI Secure MCP Tunnel mode.
- `DevRelay HTTPS.cmd` opens the same GUI in Cloudflare Named Tunnel mode with a fixed public HTTPS MCP URL.

The compact Edge app-mode window stays visible while DevRelay is available. Its top-right red button starts/stops the server without closing the GUI, the left side separates AI command activity from MCP/tunnel logs, and settings live at bottom right. Closing the GUI stops DevRelay and its tunnel. Machine-local tunnel settings and credentials remain excluded from Git.

See [docs/launcher.md](internal/docs/launcher.md) for details.

