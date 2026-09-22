# Changelog

All notable changes to DevRelay are documented here.

## Unreleased

### Added

- Added a separate first-run/reconfiguration Setup Wizard using the existing light WPF/WebView2 visual language. It guides OpenAI Secure Tunnel, recommended HTTPS/Tailscale Funnel, Cloudflare Named Tunnel, Cloudflare Quick Tunnel, and ChatGPT registration.
- Added live non-blocking status display for known OpenAI Secure Tunnel upstream issues #71, #57, and #41, while keeping their exact issue numbers/titles visible offline.
- Added provider helpers for official OpenAI tunnel-client/cloudflared acquisition, optional official Tailscale Windows installation, browser sign-in handoffs, DPAPI secret storage, and local connection reset.
- Added a thin taskbar-friendly `DevRelay.exe` Windows launcher with the same AppUserModelID as the WPF host; `DevRelay.cmd` remains as a compatibility fallback.

### Changed

- Removed connection `Mode` from the main Settings panel and runtime launcher. Connection selection now lives in `.devrelay/setup.json` and is changed through `Connection Setup...` while stopped. Existing HTTPS/OpenAI settings migrate automatically.
- The runtime launcher is now non-interactive and connection-driven. HTTPS OAuth issuer/resource are derived from the selected provider URL; Cloudflare Quick Tunnel URLs are resolved per launch.
- Setup reconfiguration commits a successfully prepared connection before the ChatGPT registration guide; the guide now closes with a single Close action. Cancel/close before commit restores backed-up local provider files.
- Incoming HTTPS OAuth authorization requests now bring the main window forward and use a blocking approval modal instead of appearing inside Settings.

## 0.2.0 - 2026-09-22

### Added

- Added a release-only Windows bootstrap updater that checks GitHub's latest published release and applies only safe official-origin clean-worktree fast-forwards before the GUI starts.
- Added `AGENTS.md` guidance requiring explicit user permission before AI agents publish upstream pull requests or issues, plus a root `SECURITY.md` for private vulnerability reporting guidance.

- Added `DevRelay.cmd` as the single user-facing Windows launcher; connection mode is selected and persisted in GUI Settings.
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

### Fixed

- GUI window size is now remembered locally and restored on the next launch, while maximized or minimized exits preserve the last normal size.

- GUI window resizing no longer gets blocked by the WebView2 child surface on the left, right, bottom, or lower corners.

- GUI log panes can now be resized with a draggable splitter, and the split ratio is remembered locally. The minimum window width was reduced from 680px to 480px.
- GUI custom scrollbars now follow the active surface: log scrollbars stay hidden while Settings is open, and the Settings scrollbar stays hidden on the default log view.

### Changed

- Changed the current public source license from MIT to PolyForm Noncommercial 1.0.0. Previously published MIT revisions keep their original license; the change is not retroactive.

- MCP tool results now default to compact JSON that omits repeated device/default metadata while preserving full results through `detail=full`; managed-process retention and output limits are unchanged. `process_list` now shows running processes by default and can include retained completed processes on demand.
- Added a tracked self-restart helper for safely handing GUI/controller/runtime restart outside the current DevRelay process tree.

- Consolidated the former mode-specific Windows launchers and GUI command-line mode overrides into one saved Settings-driven launch flow. The internal PowerShell worker now uses explicit `-Mode https|chatgpt` selection.
- Windows PowerShell normalization now executes the decoded command from an ephemeral UTF-16LE script file, preserving quoting, variable expansion, readable error output, and exit semantics without re-parsing through a nested native `powershell.exe -Command` call.

- Windows non-PTY `cmd`/`auto` and Windows PowerShell output is now normalized to UTF-8 instead of guessing encodings from byte content. Added explicit `outputEncoding` overrides backed by `iconv-lite` for known legacy/OEM code pages such as CP932, CP437, and CP850.
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
