# Windows launchers

DevRelay exposes two normal user-facing launchers in the project root:

- `DevRelay ChatGPT.cmd`: opens the GUI in OpenAI Secure MCP Tunnel mode.
- `DevRelay HTTPS.cmd`: opens the GUI in Cloudflare Named Tunnel mode.

Both launchers immediately hand off to a hidden local controller and show a compact Microsoft Edge app-mode window instead of keeping a terminal open.

## Control GUI

The GUI is intentionally part of the safety model: DevRelay should not appear to be running invisibly in the background.

- The red button at top right starts or stops DevRelay while keeping the GUI open.
- The upper-left log shows commands initiated through DevRelay (`exec` and managed processes).
- The lower-left log shows MCP server, launcher, and tunnel output.
- Settings are at bottom right and can be changed while the server is stopped.
- Closing the GUI window stops DevRelay and the active tunnel.
The local GUI controller listens only on `127.0.0.1:7318` and rejects state-changing requests from other browser origins. It uses a heartbeat from the visible app window; if that heartbeat disappears, the controller shuts down the server/tunnel process tree.

The UI follows the same dark Material 3 Expressive design language used by `nas-photo`: surface-container layers, large rounded cards, compact expressive motion, and blue primary accents. Scrollable regions use the custom overlay-thumb approach used by `vault-edit` instead of native browser scrollbars.

## HTTPS mode

The GUI starts DevRelay on `127.0.0.1:7317` and launches the configured Cloudflare Named Tunnel. The fixed URL is read from `.devrelay/https-named.json`. The Cloudflare `config.yml`, tunnel credentials, hostname, GUI settings, and logs are machine-local and excluded from Git.

## ChatGPT mode

The GUI uses the same internal PowerShell launcher to validate and start the OpenAI Secure MCP Tunnel. The tunnel ID is stored in `.devrelay/launcher.json`; the runtime API key is stored with Windows DPAPI for the current user.

## Internal implementation

- `gui/devrelay-gui.mjs`: local GUI controller and process owner.
- `gui/public/`: the local Material 3 Expressive interface.
- `gui/launch.vbs`: hidden handoff from the double-click launchers.
- `scripts/DevRelay-Launcher.ps1`: build, MCP, and tunnel setup/supervision worker.

The old generic `DevRelay.cmd` entry point remains removed so the project root presents only the two normal connection choices.
