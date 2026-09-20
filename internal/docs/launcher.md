# Windows launchers

DevRelay exposes two normal user-facing launchers in the project root:

- `DevRelay ChatGPT.cmd`: opens the GUI in OpenAI Secure MCP Tunnel mode.
- `DevRelay HTTPS.cmd`: opens the GUI in Cloudflare Named Tunnel mode.

Both launchers immediately hand off to a hidden local controller and show a compact custom-framed WPF window hosting WebView2 instead of keeping a terminal open. The default window is 780×560, with a 680×480 minimum.

## Control GUI

The GUI is intentionally part of the safety model: DevRelay should not appear to be running invisibly in the background.

- The custom title bar contains the red Start/Stop control, a settings gear, and the window controls.
- The main body contains only `Command log` and `Server log`.
- Settings stay hidden until the gear button is pressed and can be changed while the server is stopped.
- Closing the GUI window stops DevRelay and the active tunnel.
The local GUI controller listens only on `127.0.0.1:7318` and rejects state-changing requests from other browser origins. It uses a heartbeat from the visible app window; if that heartbeat disappears, the controller shuts down the server/tunnel process tree.

The web content follows the dark Material 3 Expressive design language used by `nas-photo`, while the custom window chrome follows the frameless WPF pattern used by `audio-router`. Scrollable regions use the custom overlay-thumb approach used by `vault-edit` instead of native browser scrollbars.

## HTTPS mode

The GUI starts DevRelay on `127.0.0.1:7317` and launches the configured Cloudflare Named Tunnel. The fixed URL is read from `.devrelay/https-named.json`. The Cloudflare `config.yml`, tunnel credentials, hostname, GUI settings, and logs are machine-local and excluded from Git.

## ChatGPT mode

The GUI uses the same internal PowerShell launcher to validate and start the OpenAI Secure MCP Tunnel. The tunnel ID is stored in `.devrelay/launcher.json`; the runtime API key is stored with Windows DPAPI for the current user.

## Internal implementation

- `gui/devrelay-gui.mjs`: local GUI controller and process owner.
- `gui/public/`: the minimal Material 3 Expressive log/settings interface.
- `gui/host/`: custom WPF window chrome and WebView2 host/setup scripts.
- `gui/launch.vbs`: hidden handoff from the double-click launchers.
- `scripts/DevRelay-Launcher.ps1`: build, MCP, and tunnel setup/supervision worker.

The old generic `DevRelay.cmd` entry point remains removed so the project root presents only the two normal connection choices.
