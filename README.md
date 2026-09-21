# DevRelay

DevRelay is a deliberately small MCP server that gives an MCP client access to the command line of a development machine.

The design rule is simple: **if a task can already be done by a CLI, DevRelay does not reimplement it.** Git, npm, Python, Docker, SSH, PowerShell, ripgrep, compilers, and other tools remain ordinary processes. DevRelay only starts them, streams their output, accepts stdin, and stops them.

## Status

DevRelay is currently **v0.1.0**. The initial implementation targets development use on Windows while keeping the process layer portable to other Node.js platforms.

## Features

- MCP over stdio.
- MCP over Streamable HTTP.
- OAuth 2.1 Authorization Code + PKCE with DCR for the public HTTPS Named Tunnel launcher.
- Arbitrary one-shot command execution.
- Managed long-running pipe processes plus opt-in PTY/ConPTY terminal sessions.
- Cursor-based incremental log reads.
- Rolling in-memory output buffers.
- Process-tree termination on Windows.
- Stable per-device identity with an auto-generated hardware-based default name, editable display name, aliases, and local online metadata.
- The MCP core has no database, agent loop, general-purpose desktop automation, or embedded tunnel. The Windows launcher UI is a separate local controller.
- Five direct runtime dependencies: the MCP server SDK, its Node adapter, Zod, `iconv-lite` for explicit legacy-code-page decoding, and `node-pty` for PTY/ConPTY.

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
| `exec` | Run a command to completion, collect stdout/stderr, and optionally return images. |
| `process_start` | Start a long-running pipe process or PTY/ConPTY terminal session. |
| `process_read` | Read process output incrementally and optionally return images. |
| `process_write` | Send input; PTY sessions can also be resized. |
| `process_stop` | Stop a managed process tree and forget it. |
| `process_list` | List processes currently retained by DevRelay. |

There are intentionally no Git, filesystem, Docker, package-manager, or search-specific tools. Use their CLIs through `exec` or `process_start`. Each result identifies the local DevRelay device; `process_list` returns that device plus its locally retained processes.

## Multiple devices

DevRelay does not federate or route between devices. Run one DevRelay per machine and register each public MCP endpoint as a separate ChatGPT plugin/connector. Give each machine a clear device name such as `windows-ryzen9-3900x` or `linux-rpi5`; the name is returned in tool results so the caller can confirm which registered endpoint answered. There is no peer API, cluster key, peer discovery, or cross-device process routing.

## Shell modes

- `auto`: `cmd.exe` on Windows; `$SHELL` or `/bin/sh` elsewhere.
- `cmd`: run through `cmd.exe /d /s /c`.
- `powershell`: run through Windows PowerShell.
- `pwsh`: run through PowerShell 7 when installed.
- `direct`: execute `command` directly and pass the optional `args` array without a shell.

`direct` is the best choice when the executable and arguments are already known because it avoids another shell parser.

On Windows, non-PTY `cmd`/`auto` and Windows PowerShell output is normalized to UTF-8 before DevRelay decodes it. For a legacy executable with a known code page, set `outputEncoding` explicitly (for example `cp932`, `cp437`, `cp850`, or `system`). If one process intentionally writes multiple encodings into the same pipe, use a PTY/ConPTY session instead of relying on pipe decoding.

## Terminal sessions

Set `terminal: true` on `process_start` when a CLI owns the terminal or uses a TUI. DevRelay allocates a PTY/ConPTY and keeps that terminal independent from other managed processes, so an interactive CLI can remain open while additional commands run in parallel sessions. `process_write` sends keystrokes/data and can resize the terminal with `columns` + `rows`.

## Image output

`exec.images` and `process_read.images` can attach up to four PNG, JPEG, WebP, or GIF files to the MCP result. This lets ordinary CLIs or browser automation create screenshots while DevRelay only handles the final pixel transport to the MCP client.

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
- `DevRelay HTTPS.cmd` opens the same GUI in Cloudflare Named Tunnel mode with a fixed public HTTPS MCP URL protected by OAuth 2.1.

A compact custom-framed WPF/WebView2 window stays visible while DevRelay is available. The default 780×560 layout is native: the body contains only `Command log` and `Server log`, while Start/Stop and the settings button live in the custom title bar. The window controls use the same Segoe Fluent Icons glyph pattern as `audio-router`. The UI uses Noto Sans Mono and supports the exact `#FFFFFF Soft` (default) and `#000000 Soft` palettes from `vault-edit`. Settings stay hidden until the gear button is pressed; the local device name/aliases can be edited while stopped, and an incoming OAuth authorization request opens Settings automatically for local approval. Closing the GUI stops DevRelay and its tunnel. Each visible window launch writes a session under `internal/.devrelay/logs/`; only the latest three sessions are retained. Machine-local settings, caches, logs, tunnel state, and credentials remain under `.devrelay` and excluded from Git.

See [docs/launcher.md](internal/docs/launcher.md) for details.

