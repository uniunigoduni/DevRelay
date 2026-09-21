# Changelog

All notable changes to DevRelay are documented here.

## Unreleased

### Added

- Added `DevRelay ChatGPT.cmd` and `DevRelay HTTPS.cmd` as the two user-facing Windows launchers.
- Added a compact custom-framed WPF/WebView2 control GUI with title-bar Start/Stop control.
- Added separate `Command log` and `Server log` views with a default 780×560 layout.
- Added a gear-triggered settings panel for connection mode, MCP port, and launch-time auto-start.
- Added command audit events for `exec` and managed processes without recording stdin contents.
- Added Cloudflare Named Tunnel support with a fixed hostname and machine-local configuration.
- Added OAuth 2.1 Authorization Code + PKCE, DCR, discovery metadata, rotating refresh tokens, and GUI-local approval for HTTPS mode.
- Added GUI heartbeat shutdown: closing or losing the visible GUI stops DevRelay and the tunnel.
- Added same-origin guards for state-changing local GUI API calls.
- Added custom overlay scrollbars based on the `vault-edit` scrollbar interaction model.
- Added exact `#FFFFFF Soft` / `#000000 Soft` launcher themes from `vault-edit`, with light as the default.
- Added Noto Sans Mono throughout the launcher UI plus per-user fallback installation when the font is missing.
- Added per-window session logs under `.devrelay/logs`, retaining only the latest three visible launches.
- Added opt-in PTY/ConPTY managed sessions through `process_start(terminal: true)` while keeping the six-tool MCP surface.
- Added terminal resizing through `process_write` and terminal state in process snapshots.
- Added PNG/JPEG/WebP/GIF result attachments through `exec.images` and `process_read.images`.
- Added `node-pty` as the single native dependency required for real terminal sessions.

### Changed

- Multi-device operation now uses separate MCP/plugin registrations per device; the experimental peer cluster, cluster key, cross-device routing, and distributed OAuth forwarding were removed. Local device identity, editable naming, aliases, and online metadata remain.
- Build now cleans `dist/` first so removed tests or modules cannot remain as stale generated files.
- Windows launchers no longer keep a terminal window open during normal use.
- Custom title-bar system buttons now use the established `audio-router` Segoe Fluent Icons glyph sizes and maximize/restore behavior.
- GUI mutable state and caches, including WebView2, are consolidated under `.devrelay`.
- Named Tunnel origin Host is pinned to localhost so DevRelay Host validation remains enabled.
- Machine-local tunnel credentials, GUI settings, logs, and generated state remain excluded from Git.
## 0.1.0 - 2026-09-20

### Added

- Minimal MCP server built on the Model Context Protocol TypeScript SDK v2.
- stdio and Streamable HTTP transports.
- `exec` for one-shot arbitrary command execution.
- `process_start`, `process_read`, `process_write`, `process_stop`, and `process_list` for managed processes.
- Cursor-based rolling stdout/stderr buffers.
- Windows process-tree termination and POSIX process-group termination.
- Node built-in test suite and MCP Inspector smoke-test instructions.
- Architecture, tool, transport, development, security, design, and Japanese quick-start documentation.
