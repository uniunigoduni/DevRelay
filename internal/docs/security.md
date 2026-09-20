# Security model

DevRelay is intentionally powerful: an authorized MCP caller can execute arbitrary commands with the same operating-system privileges as the DevRelay process. It is not a command sandbox.

## Default network posture

HTTP mode binds to `127.0.0.1` by default. For loopback binds, DevRelay composes the MCP Node adapter's localhost Host and Origin validation in front of the MCP handler.

Remote use should normally keep this loopback listener and place a trusted tunnel, private network, or authenticated gateway in front of it. DevRelay v0.1 does not implement user accounts, bearer-token validation, or TLS.

## Operating-system permissions

Run DevRelay as the account whose development files and tools it should access. Do not elevate it merely to make a command work. Commands inherit the DevRelay environment plus any variables supplied for the individual tool call.

## Command semantics

`shell: "auto"`, `cmd`, `powershell`, and `pwsh` intentionally allow shell syntax. `shell: "direct"` bypasses shell parsing and is preferable when the executable and arguments are already structured.

## Process state

Managed process metadata and buffered output live only in memory. The Windows GUI writes a machine-local current-session audit file under `.devrelay/` containing command/process lifecycle metadata so the user can see AI command activity. It does not record stdin or command stdout/stderr in that audit file, and the file is truncated on the next GUI runtime start. Completed managed-process output is retained in memory for 10 minutes by default.

## Scope

Security policy is deliberately kept separate from the command engine. Future authentication or policy layers should wrap the MCP transport or tool invocation boundary rather than complicating the ProcessManager core.

## Visible control GUI

The Windows GUI controller binds only to `127.0.0.1:7318`, rejects state-changing requests from other browser origins, and waits for a heartbeat from the visible app window before auto-starting DevRelay. Closing the GUI or losing its heartbeat stops the launcher-managed DevRelay/tunnel process tree. There is no tray/background-only mode in the normal launchers.

## Public HTTPS mode

The configured Cloudflare Named Tunnel provides a stable public URL but does not by itself add application authentication. While HTTPS mode is running, the MCP endpoint should be treated as a powerful public command-execution endpoint. Keep the GUI visible, stop it when not in use, and add an authentication/policy layer before any unattended or permanent deployment.

## Launcher credentials

The Windows launcher never writes `CONTROL_PLANE_API_KEY` as plaintext project configuration. If the key is not already supplied through the environment, the launcher reads it as a `SecureString` and stores the encrypted representation under `.devrelay/` using Windows DPAPI. That encrypted value is tied to the Windows user context and is decrypted only when starting or validating `tunnel-client`.

The Tunnel ID is not treated as a secret and is stored in `.devrelay/launcher.json`. Both launcher state and the downloaded tunnel-client bundle are excluded from Git.
