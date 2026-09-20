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

Managed process metadata and buffered output live only in memory. DevRelay does not persist command history, process output, credentials, or sessions to a database. Completed process output is retained for 10 minutes by default.

## Scope

Security policy is deliberately kept separate from the command engine. Future authentication or policy layers should wrap the MCP transport or tool invocation boundary rather than complicating the ProcessManager core.

## Launcher credentials

The Windows launcher never writes `CONTROL_PLANE_API_KEY` as plaintext project configuration. If the key is not already supplied through the environment, the launcher reads it as a `SecureString` and stores the encrypted representation under `.devrelay/` using Windows DPAPI. That encrypted value is tied to the Windows user context and is decrypted only when starting or validating `tunnel-client`.

The Tunnel ID is not treated as a secret and is stored in `.devrelay/launcher.json`. Both launcher state and the downloaded tunnel-client bundle are excluded from Git.
