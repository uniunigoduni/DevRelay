# Security model

DevRelay is intentionally powerful: an authorized MCP caller can execute arbitrary commands with the same operating-system privileges as the DevRelay process. It is not a command sandbox.

## Default network posture

HTTP mode binds to `127.0.0.1` by default. For loopback binds, DevRelay composes the MCP Node adapter's localhost Host and Origin validation in front of the MCP handler.

Remote launcher connections keep this loopback listener. OpenAI Secure Tunnel forwards it through OpenAI's tunnel layer; HTTPS providers forward it through Tailscale Funnel or Cloudflare and enable DevRelay OAuth 2.1.

## Connection Setup boundary

First-run/provider configuration lives in a separate visible Setup window. Its controller binds only to `127.0.0.1:7319` and rejects state-changing requests unless Host and Origin match that local controller, mirroring the main GUI's local API boundary.

Provider actions only run after explicit setup-button presses. Merely opening the wizard does not install Tailscale, sign in to a provider, create a tunnel, or change the active `setup.json` connection.

When an existing installation is reconfigured, DevRelay backs up local OpenAI/Cloudflare connection files for the wizard session. Cancel/close before the prepared connection is committed restores those local files. Once preparation succeeds, the new `setup.json` connection is committed before the ChatGPT registration guide is shown. Provider-side resources explicitly created by the user are not automatically deleted on Cancel or Reset.

## HTTPS OAuth

Tailscale Funnel and both Cloudflare HTTPS variants use DevRelay OAuth 2.1 Authorization Code + PKCE with DCR. The runtime worker sets the OAuth issuer/resource only after the selected provider's public URL is known. `/mcp` rejects missing or invalid Bearer tokens.

OAuth consent is deliberately local. A public authorization request remains pending until the visible normal DevRelay GUI approves it using a per-runtime control secret that is never exposed through the public endpoint.

If a machine migration loses only the DCR client file, an authorization request can reconstruct a DevRelay-issued client ID only when the ID has DevRelay's generated format, its redirect is an allowed HTTPS ChatGPT/OpenAI URI, and the request passes resource and PKCE validation. The normal local consent step still applies. This does not restore missing refresh-token records; the client must complete authorization again to receive new tokens.

## OpenAI Secure Tunnel credentials

The OpenAI runtime API key is accepted by the Setup wizard over its loopback-only local API and is forwarded to the setup action through a temporary mode-0600 file, not a command-line argument. Windows stores the key using DPAPI for the current Windows user. Linux and macOS store it in a mode-0600 file under `.devrelay/`, whose directory is restricted to the current user.

The Tunnel ID is not treated as a secret. The runtime launcher is non-interactive; missing or invalid credentials direct the user back to Connection Setup instead of opening hidden console prompts.

## Provider software

OpenAI `tunnel-client` and Cloudflare `cloudflared` are downloaded from their official release sources when missing. Where the release source supplies a SHA-256 digest, DevRelay verifies it before use.

Tailscale is not embedded into the repository. Windows setup can download the official installer, verify the published SHA-256 when available, and start it with Windows elevation/UAC. Linux users install the official package for their distribution before setup, and macOS users install the Tailscale app. DevRelay itself should continue to run as the normal user.

## Operating-system permissions

Run DevRelay as the account whose development files and tools it should access. Do not elevate the entire DevRelay process merely to make a provider or command work. Commands inherit the DevRelay environment plus any variables supplied for the individual MCP tool call.

## Command semantics

`shell: "auto"`, `cmd`, `powershell`, and `pwsh` intentionally allow shell syntax. `shell: "direct"` bypasses shell parsing and is preferable when the executable and arguments are already structured.

## PTY and image access

PTY sessions run with the same OS identity and environment privileges as ordinary child processes. Image attachment paths are also read with that identity; they are not restricted to the project directory. This does not grant a caller more authority than arbitrary command execution already provides, but it makes local image bytes directly returnable through MCP.

## Process and log state

Managed process metadata and buffered output live only in memory. Each visible normal GUI launch writes a machine-local session under `.devrelay/logs/` with command lifecycle audit metadata, separate server/command logs, append-only controller/launcher lifecycle journals, and a process-identity snapshot for the launcher-managed runtime/tunnel. The controller records a compact lifecycle heartbeat every two minutes and captures an additional process snapshot on selected anomalies; stdin is not recorded in the audit stream. On the next launch, a prior session that never recorded a clean close is marked unclean and only child processes whose saved identity still matches the live PID/creation time/executable/command line are stopped. Legacy cloudflared sessions can also be attributed by their exact session-specific logfile path. The latest three visible GUI sessions are retained, plus up to five recent unclean/diagnostic sessions for postmortem analysis. Completed managed-process output is retained in memory for 10 minutes by default.

## Visible control GUI

The Electron GUI is DevRelay's human-facing control and observation surface. It makes remote access visible and owns local setup, authorization, lifecycle, settings, and diagnostics; machine-facing execution remains on the MCP/process interface.

The GUI controller binds only to `127.0.0.1:7318` and rejects state-changing requests from other browser origins. Auto-start is gated on an Electron `window-ready` signal. Its host heartbeat is written at most once every two minutes and is diagnostic only: long gaps are logged but do not stop the runtime because the desktop may suspend the process. The Electron host process/window lifecycle remains authoritative and closes the controller when the GUI exits. The controller separately remembers whether the user wants the runtime running; after a host recovery it restarts only when that desired state is still Start. An explicit Stop clears the desired state and is never overridden by heartbeat recovery. Renderer failures do not stop the runtime. On Wayland, the desktop may block programmatic focus changes, so OAuth approval also triggers a desktop notification. Closing the GUI host invokes the stop path and then closes the controller. There is no tray/background-only mode in the normal launcher.

## Multiple-device isolation

Each DevRelay instance is an independent security boundary. There is no shared cluster key, peer API, automatic trust propagation, or cross-device command forwarding. To use multiple machines, register each machine as a separate ChatGPT app/plugin/connector and authorize that endpoint independently.
