# Windows launcher

DevRelay has one normal user-facing launcher in the project root:

- `DevRelay.cmd`: opens the local control GUI without choosing a connection mode on the command line.

The launcher immediately hands off to a hidden local controller and shows a compact custom-framed WPF window hosting WebView2 instead of keeping a terminal open. The initial window is 780×560 with a 480×480 minimum; the last normal window size is remembered locally and restored on the next launch.

## Mode selection

The GUI Settings value is the single source of truth for connection mode. The first launch defaults to `HTTPS Named Tunnel`. After that, `gui-settings.json` restores the saved choice between:

- `HTTPS Named Tunnel`: Cloudflare Named Tunnel with a fixed public HTTPS MCP URL and DevRelay OAuth 2.1 protection.
- `OpenAI Secure Tunnel`: the official OpenAI Secure MCP Tunnel client in front of the local MCP endpoint.

The double-click launcher and `gui/launch.vbs` do not inject or override a mode. Changing mode therefore happens in one place: Settings while DevRelay is stopped.

## Control GUI

The GUI is intentionally part of the safety model: DevRelay should not appear to be running invisibly in the background.

- The custom title bar contains the red Start/Stop control, a settings gear, and the window controls.
- The main body contains `Command log` and `Server log`. Their divider is draggable and its ratio is remembered in WebView local storage.
- Settings stay hidden until the gear button is pressed. Theme can change while running; connection and device-name settings require the server to be stopped.
- Device Settings show the editable name, generated default name, aliases, immutable node ID, and local online/offline state.
- `#FFFFFF Soft` is the default theme and `#000000 Soft` is available from Settings.
- Noto Sans Mono is used throughout the UI. The launcher installs the official Google Fonts Noto Sans Mono for the current Windows user only when it is missing.
- The WPF host remembers the last normal window size under `.devrelay/window-state.json`.
- Closing the GUI window stops DevRelay and the active tunnel.

The local GUI controller listens only on `127.0.0.1:7318` and rejects state-changing requests from other browser origins. It uses a heartbeat from the visible app window; if that heartbeat disappears, the controller shuts down the server/tunnel process tree.

## HTTPS mode

The GUI invokes the internal PowerShell worker with `-Mode https`, starts DevRelay on `127.0.0.1:7317`, and launches the configured Cloudflare Named Tunnel. HTTPS mode also enables OAuth 2.1; incoming authorization requests automatically open Settings so the local user can Approve or Deny the connection. The fixed URL is read from `.devrelay/https-named.json`.

## OpenAI Secure Tunnel mode

The GUI invokes the same worker with `-Mode chatgpt`. The worker validates and starts the official OpenAI Secure MCP Tunnel client. The tunnel ID is stored in `.devrelay/launcher.json`; the runtime API key is stored with Windows DPAPI for the current user.

## Internal implementation

- `gui/devrelay-gui.mjs`: local GUI controller, saved-settings owner, and process owner.
- `gui/public/`: the Noto Sans Mono log/settings interface with Soft light/dark themes.
- `gui/host/`: custom WPF window chrome and WebView2 host/setup scripts.
- `gui/launch.vbs`: hidden no-argument handoff from `DevRelay.cmd`.
- `scripts/DevRelay-Launcher.ps1`: internal build, MCP, and tunnel setup/supervision worker. The GUI passes `-Mode https` or `-Mode chatgpt` explicitly.

Mutable launcher data remains under `internal/.devrelay/`: tunnel state, GUI settings, window state, WebView2 profile/SDK cache, optional font cache, OAuth state, and logs. Each visible window launch gets its own `logs/yyyyMMdd-HHmmss-xxxxxxxx/` directory; only the latest three visible launches are retained.
