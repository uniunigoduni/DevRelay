# Security model

DevRelay is intentionally powerful: an authorized MCP caller can execute arbitrary commands with the same operating-system privileges as the DevRelay process. It is not a command sandbox.

## Default network posture

HTTP mode binds to `127.0.0.1` by default. For loopback binds, DevRelay composes the MCP Node adapter's localhost Host and Origin validation in front of the MCP handler.

Remote launcher connections keep this loopback listener. OpenAI Secure Tunnel forwards it through OpenAI's tunnel layer; HTTPS providers forward it through Tailscale Funnel or Cloudflare and enable DevRelay OAuth 2.1.

## Connection Setup boundary

First-run/provider configuration lives in a separate visible Setup window. Its controller binds only to `127.0.0.1:7319` and rejects state-changing requests unless Host and Origin match that local controller, mirroring the main GUI's local API boundary.

Provider actions only run after explicit setup-button presses. Merely opening the wizard does not install Tailscale, sign in to a provider, create a tunnel, or change the active `setup.json` connection.

When an existing installation is reconfigured, DevRelay backs up local OpenAI/Cloudflare connection files for the wizard session. Cancel/close restores those local files; Finish commits the new `setup.json`. Provider-side resources explicitly created by the user are not automatically deleted on Cancel or Reset.

## HTTPS OAuth

Tailscale Funnel and both Cloudflare HTTPS variants use DevRelay OAuth 2.1 Authorization Code + PKCE with DCR. The runtime worker sets the OAuth issuer/resource only after the selected provider's public URL is known. `/mcp` rejects missing or invalid Bearer tokens.

OAuth consent is deliberately local. A public authorization request remains pending until the visible normal DevRelay GUI approves it using a per-runtime control secret that is never exposed through the public endpoint.

## OpenAI Secure Tunnel credentials

The OpenAI runtime API key is accepted by the Setup wizard over its loopback-only local API and is forwarded to the setup PowerShell action through stdin, not a command-line argument. DevRelay stores the key under `.devrelay/` using Windows DPAPI for the current Windows user.

The Tunnel ID is not treated as a secret. The runtime launcher is non-interactive; missing or invalid credentials direct the user back to Connection Setup instead of opening hidden console prompts.

## Provider software

OpenAI `tunnel-client` and Cloudflare `cloudflared` are downloaded from their official release sources when missing. Where the release source supplies a SHA-256 digest, DevRelay verifies it before use.

Tailscale is not embedded into the repository. Setup downloads the official Windows installer on request, verifies the published SHA-256 when available, and starts that installer with Windows elevation/UAC. DevRelay itself should continue to run as the normal user.

## Operating-system permissions

Run DevRelay as the account whose development files and tools it should access. Do not elevate the entire DevRelay process merely to make a provider or command work. Commands inherit the DevRelay environment plus any variables supplied for the individual MCP tool call.

## Command semantics

`shell: "auto"`, `cmd`, `powershell`, and `pwsh` intentionally allow shell syntax. `shell: "direct"` bypasses shell parsing and is preferable when the executable and arguments are already structured.

## PTY and image access

PTY sessions run with the same OS identity and environment privileges as ordinary child processes. Image attachment paths are also read with that identity; they are not restricted to the project directory. This does not grant a caller more authority than arbitrary command execution already provides, but it makes local image bytes directly returnable through MCP.

## Process and log state

Managed process metadata and buffered output live only in memory. Each visible normal GUI launch writes a machine-local session under `.devrelay/logs/` with command lifecycle audit metadata and separate server/command logs; stdin is not recorded in the audit stream. Only the latest three visible GUI sessions are retained. Completed managed-process output is retained in memory for 10 minutes by default.

## Visible control GUI

The normal Windows GUI controller binds only to `127.0.0.1:7318`, rejects state-changing requests from other browser origins, and waits for a heartbeat from the visible app window before auto-starting DevRelay. A brief heartbeat stall is logged as a warning; sustained loss is required before the launcher-managed DevRelay/provider process tree is stopped. Closing the GUI host still stops the runtime immediately. There is no tray/background-only mode in the normal launcher.

## Multiple-device isolation

Each DevRelay instance is an independent security boundary. There is no shared cluster key, peer API, automatic trust propagation, or cross-device command forwarding. To use multiple machines, register each machine as a separate ChatGPT app/plugin/connector and authorize that endpoint independently.
