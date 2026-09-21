# Windows launchers

DevRelay exposes two normal user-facing launchers in the project root:

- `DevRelay ChatGPT.cmd`: opens the GUI in OpenAI Secure MCP Tunnel mode.
- `DevRelay HTTPS.cmd`: opens the GUI in Cloudflare Named Tunnel mode.

Both launchers immediately hand off to a hidden local controller and show a compact custom-framed WPF window hosting WebView2 instead of keeping a terminal open. The default window is 780×560, with a 680×480 minimum.

## Control GUI

The GUI is intentionally part of the safety model: DevRelay should not appear to be running invisibly in the background.

- The custom title bar contains the red Start/Stop control, a settings gear, and the window controls. System controls use Segoe Fluent Icons glyphs: minimize `E921`, maximize `E922`, restore `E923`, and close `E8BB`, matching the `audio-router` pattern.
- The main body contains only `Command log` and `Server log`.
- Settings stay hidden until the gear button is pressed. The theme can change while running; connection, device-name, and cluster settings require the server to be stopped.
- `#FFFFFF Soft` is the default theme and `#000000 Soft` is available from Settings, using the exact `vault-edit` palette values.
- Noto Sans Mono is used throughout the UI. The launcher installs the official Google Fonts Noto Sans Mono for the current Windows user only when it is missing.
- Closing the GUI window stops DevRelay and the active tunnel.
The local GUI controller listens only on `127.0.0.1:7318` and rejects state-changing requests from other browser origins. It uses a heartbeat from the visible app window; if that heartbeat disappears, the controller shuts down the server/tunnel process tree.

The custom window chrome follows the frameless WPF/glyph pattern used by `audio-router`. Web content uses the `#FFFFFF Soft` / `#000000 Soft` colors from `vault-edit`, and scrollable regions keep the custom overlay-thumb behavior instead of native browser scrollbars. Web corner radii use the same 12px radius as the WPF window chrome.

## HTTPS mode

The GUI starts DevRelay on `127.0.0.1:7317` and launches the configured Cloudflare Named Tunnel. HTTPS mode also enables OAuth 2.1; incoming authorization requests automatically open Settings so the local user can Approve or Deny the connection. In a peer cluster, authorization requests from other nodes are also surfaced here. The fixed URL is read from `.devrelay/https-named.json`. Mutable launcher data is consolidated under `internal/.devrelay/`: tunnel state, GUI settings, WebView2 profile/SDK cache, optional font cache, and logs. Each visible window launch gets its own `logs/yyyyMMdd-HHmmss-xxxxxxxx/` directory with `command.log`, `server.log`, `audit.ndjson`, `session.json`, and the Cloudflare log; only the latest three visible launches are retained.

## ChatGPT mode

The GUI uses the same internal PowerShell launcher to validate and start the OpenAI Secure MCP Tunnel. The tunnel ID is stored in `.devrelay/launcher.json`; the runtime API key is stored with Windows DPAPI for the current user.

## Internal implementation

- `gui/devrelay-gui.mjs`: local GUI controller and process owner.
- `gui/public/`: the minimal Noto Sans Mono log/settings interface with Soft light/dark themes.
- `gui/host/`: custom WPF window chrome and WebView2 host/setup scripts.
- `gui/launch.vbs`: hidden handoff from the double-click launchers.
- `scripts/DevRelay-Launcher.ps1`: build, MCP, and tunnel setup/supervision worker.

The old generic `DevRelay.cmd` entry point remains removed so the project root presents only the two normal connection choices.

## Device and cluster settings

Settings exposes the user-facing device name and aliases while keeping the permanent node ID read-only. It also exposes the peer-routing enable switch, peer port, direct peer URLs, and a masked cluster key with a Copy action. Cluster/device changes are accepted only while the runtime is stopped.
