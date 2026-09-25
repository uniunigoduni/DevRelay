# DevRelay

DevRelay is a deliberately small MCP server that gives an MCP client access to the command line of a development machine.

The design rule is simple: **if a task can already be done by a CLI, DevRelay does not reimplement it.** Git, npm, Python, Docker, SSH, PowerShell, ripgrep, compilers, and other tools remain ordinary processes. DevRelay only starts them, streams their output, accepts stdin, and stops them.

## Status

DevRelay is currently **v0.2.0**. The project targets development use on Windows while keeping the process layer portable to other Node.js platforms.

## Features

- MCP over stdio.
- MCP over Streamable HTTP.
- OAuth 2.1 Authorization Code + PKCE with DCR for public HTTPS connections (Tailscale Funnel or Cloudflare).
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
cd .\internal
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
- [Security reporting](SECURITY.md)
- [AI agent guide](AGENTS.md)
- [Design decisions and non-goals](internal/docs/design.md)

## Development philosophy

DevRelay is infrastructure glue, not a remote IDE and not an autonomous agent. New first-class tools should only be added when ordinary command-line composition cannot provide the same capability cleanly.

## License

Current DevRelay source is available under the **PolyForm Noncommercial License 1.0.0**. Noncommercial use, modification, and redistribution are permitted by that license; commercial use is not granted by the public license. See [LICENSE](LICENSE).

Earlier revisions that were published under MIT remain available under the license that applied to those revisions; this license change is not retroactive.

## Upstream references

The implementation patterns and interoperability references used for v0.1 are documented in [docs/references.md](internal/docs/references.md).

## Automatic release updates

On Windows, `DevRelay.exe` (or the `DevRelay.cmd` compatibility launcher) checks for the latest **published GitHub Release** before starting the GUI. Ordinary pushes to `main`, standalone tags, drafts, and prereleases are not an update channel.

An update is applied only when the checkout uses the official DevRelay `origin`, the Git worktree is clean, and the current commit can fast-forward to the release commit. Development checkouts that are ahead of a release, diverged checkouts, forks, dirty worktrees, offline machines, and non-Git source archives are left untouched and start normally. Machine-local `.devrelay` state is not part of Git and is preserved.

## Windows double-click launcher

For normal Windows use, double-click `DevRelay.exe`. `DevRelay.cmd` remains available as a compatibility fallback. Before the main control window starts, DevRelay checks the latest published Release and then verifies machine-local connection setup. On launch, DevRelay also creates or refreshes a per-user Start Menu shortcut with the same AppUserModelID as the WPF windows so the app can be pinned to the taskbar as DevRelay rather than PowerShell.

A fresh install opens a separate light-theme **DevRelay Setup** window before the main GUI. Connection setup is chosen there rather than through a `Mode` field in the main window:

- **OpenAI Secure Tunnel** - preferred architecture, currently marked Experimental while upstream ChatGPT/tunnel-client issues #71, #57, and #41 remain relevant. The wizard shows their exact titles and refreshes OPEN/CLOSED state when GitHub is reachable.
- **HTTPS / Tailscale Funnel** - recommended HTTPS provider. It does not require a custom domain; the wizard can install the official Windows Tailscale client, use normal browser sign-in, and prepare a stable `*.ts.net` endpoint.
- **HTTPS / Cloudflare Named Tunnel** - stable hostname for users with a Cloudflare-managed domain. The wizard uses the official `cloudflared` login/create/DNS CLI flow.
- **HTTPS / Cloudflare Quick Tunnel** - no account or domain required, but the `trycloudflare.com` URL is temporary and can change after restart.

The wizard also shows the ChatGPT registration steps. Secure Tunnel uses a Tunnel connection with no MCP authentication; HTTPS endpoints use DevRelay OAuth and require the local DevRelay window to approve the OAuth request. Provider-specific live interoperability should be validated in the target account/workspace because those external services can change independently of DevRelay.

After setup, the main GUI shows the current Connection and endpoint. `Connection Setup...` reopens the separate wizard while DevRelay is stopped. The current connection stays active while a replacement is being prepared; once preparation succeeds, the new connection is committed before the ChatGPT registration guide appears. Cancel/close before that point restores the previous local connection files. Advanced Reset removes DevRelay's local connection configuration but does not uninstall Tailscale or automatically delete provider-side tunnel resources.

The GUI stays visible while DevRelay is available. The body contains `Command log` and `Server log`, with a draggable divider whose ratio is remembered locally. Start/Stop and Settings live in the custom title bar. The window remembers its last normal size, supports a 480x480 minimum, and uses Noto Sans Mono with the `#FFFFFF Soft` (default) and `#000000 Soft` palettes. Device/port/auto-start settings can be edited while stopped; an incoming HTTPS OAuth authorization request brings the main window forward and shows a blocking approval dialog over the app. Closing the GUI stops DevRelay and its active connection process.

Each visible window launch writes a session under `internal/.devrelay/logs/`; session diagnostics include server/command logs plus controller/launcher lifecycle and process-identity records used to diagnose and safely recover unclean exits. The latest three sessions are retained, plus up to five recent unclean/diagnostic sessions for postmortem analysis. Machine-local settings, setup state, caches, logs, provider state, window state, and credentials remain under `.devrelay` and are excluded from Git.

See [docs/launcher.md](internal/docs/launcher.md) for details.
