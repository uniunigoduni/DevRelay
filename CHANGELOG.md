# Changelog

All notable changes to DevRelay are documented here.

## Unreleased

### Added

- Added `DevRelay ChatGPT.cmd` and `DevRelay HTTPS.cmd` as the two user-facing Windows launchers.
- Added a compact local Edge app-mode control GUI with a top-right Start/Stop control.
- Added separate AI command activity and MCP/tunnel server log views.
- Added local GUI settings for connection mode, MCP port, and launch-time auto-start.
- Added command audit events for `exec` and managed processes without recording stdin contents.
- Added Cloudflare Named Tunnel support with a fixed hostname and machine-local configuration.
- Added GUI heartbeat shutdown: closing or losing the visible GUI stops DevRelay and the tunnel.
- Added same-origin guards for state-changing local GUI API calls.
- Added Material 3 Expressive-inspired launcher styling based on the `nas-photo` design language.
- Added custom overlay scrollbars based on the `vault-edit` scrollbar interaction model.
- Added opt-in PTY/ConPTY managed sessions through `process_start(terminal: true)` while keeping the six-tool MCP surface.
- Added terminal resizing through `process_write` and terminal state in process snapshots.
- Added PNG/JPEG/WebP/GIF result attachments through `exec.images` and `process_read.images`.
- Added `node-pty` as the single native dependency required for real terminal sessions.

### Changed

- Windows launchers no longer keep a terminal window open during normal use.
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
