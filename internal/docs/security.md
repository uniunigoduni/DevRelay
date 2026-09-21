# Security model

DevRelay is intentionally powerful: an authorized MCP caller can execute arbitrary commands with the same operating-system privileges as the DevRelay process. It is not a command sandbox.

## Default network posture

HTTP mode binds to `127.0.0.1` by default. For loopback binds, DevRelay composes the MCP Node adapter's localhost Host and Origin validation in front of the MCP handler.

Remote use keeps this loopback listener. The Windows HTTPS Named Tunnel launcher enables DevRelay OAuth 2.1 and requires a Bearer token on `/mcp`; raw local HTTP and stdio do not enable OAuth unless its environment is configured.

## Operating-system permissions

Run DevRelay as the account whose development files and tools it should access. Do not elevate it merely to make a command work. Commands inherit the DevRelay environment plus any variables supplied for the individual tool call.

## Command semantics

`shell: "auto"`, `cmd`, `powershell`, and `pwsh` intentionally allow shell syntax. `shell: "direct"` bypasses shell parsing and is preferable when the executable and arguments are already structured.

## PTY and image access

PTY sessions run with the same OS identity and environment privileges as ordinary child processes. Image attachment paths are also read with that identity; they are not restricted to the project directory. This does not grant a caller more authority than arbitrary command execution already provides, but it makes local image bytes directly returnable through MCP.

## Process state

Managed process metadata and buffered output live only in memory. Each visible Windows GUI launch writes a machine-local session under `.devrelay/logs/` with command lifecycle audit metadata and separate server/command logs; stdin is not recorded in the audit stream. Only the latest three visible GUI sessions are retained. Completed managed-process output is retained in memory for 10 minutes by default.

## Scope

Security policy remains separate from the command engine. HTTPS OAuth wraps the HTTP transport boundary instead of complicating the `ProcessManager` core.

## Visible control GUI

The Windows GUI controller binds only to `127.0.0.1:7318`, rejects state-changing requests from other browser origins, and waits for a heartbeat from the visible app window before auto-starting DevRelay. Closing the GUI or losing its heartbeat stops the launcher-managed DevRelay/tunnel process tree. There is no tray/background-only mode in the normal launchers.

## Public HTTPS mode

The Cloudflare Named Tunnel provides TLS and a stable public URL. DevRelay adds OAuth 2.1 Authorization Code + PKCE on top: discovery metadata, DCR, short-lived signed access tokens, and rotating refresh tokens. `/mcp` rejects missing or invalid Bearer tokens. OAuth consent is local: a public authorization request remains pending until the visible DevRelay GUI approves it with a per-runtime secret that is never exposed publicly.

## Launcher credentials

The Windows launcher never writes `CONTROL_PLANE_API_KEY` as plaintext project configuration. If the key is not already supplied through the environment, the launcher reads it as a `SecureString` and stores the encrypted representation under `.devrelay/` using Windows DPAPI. That encrypted value is tied to the Windows user context and is decrypted only when starting or validating `tunnel-client`.

The Tunnel ID is not treated as a secret and is stored in `.devrelay/launcher.json`. Both launcher state and the downloaded tunnel-client bundle are excluded from Git.

## Multiple-device isolation

Each DevRelay instance is an independent security boundary. There is no shared cluster key, peer API, automatic trust propagation, or cross-device command forwarding. To use multiple machines, register each machine as a separate MCP plugin/connector and authorize that endpoint independently.
