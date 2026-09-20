# Windows launchers

DevRelay exposes only two normal user-facing launchers in the project root.

- `DevRelay ChatGPT.cmd`: OpenAI Secure MCP Tunnel mode.
- `DevRelay HTTPS.cmd`: temporary public HTTPS mode through Cloudflare Quick Tunnel.

Both launchers delegate to the same internal implementation at `scripts/DevRelay-Launcher.ps1`, so dependency checks, builds, process supervision, and cleanup stay in one place.

## ChatGPT launcher

Double-click `DevRelay ChatGPT.cmd`.

It checks Node/npm, installs dependencies when needed, rebuilds when sources changed, validates the saved OpenAI tunnel profile, starts DevRelay on `127.0.0.1:7317`, starts `tunnel-client`, and supervises both processes.

The tunnel ID is stored in `.devrelay/launcher.json`. The runtime API key is stored with Windows DPAPI for the current user.

Press `Ctrl+C` to stop DevRelay and the OpenAI tunnel.

## HTTPS launcher

Double-click `DevRelay HTTPS.cmd`.

It performs the same local dependency/build checks, starts DevRelay, then launches the bundled `cloudflared.exe` as an account-less Quick Tunnel.
The origin Host header is rewritten to the local DevRelay listener so localhost Host validation remains enabled.

When ready, it prints and copies a URL such as:

```text
https://example.trycloudflare.com/mcp
```

Register that URL in ChatGPT as a URL-based connector with `No authentication`.

Quick Tunnel URLs change on every launch and have no uptime guarantee, so this mode is intended as a development fallback rather than a permanent public endpoint.

Press `Ctrl+C` to stop DevRelay and the HTTPS tunnel.

## Internal launcher implementation

`scripts/DevRelay-Launcher.ps1` is required because it contains the shared setup and supervision logic. It is not intended to be launched directly during normal use.

The old generic `DevRelay.cmd` entry point was removed to keep the project root unambiguous: choose either ChatGPT mode or HTTPS mode.

## Local state

- `.devrelay/`: launcher state, OpenAI tunnel profile, DPAPI-encrypted runtime key, and Quick Tunnel log.
- `tools/tunnel-client/`: the official OpenAI tunnel-client bundle and bundled `cloudflared.exe`.

Both paths are excluded from Git.
