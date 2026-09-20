# Changelog

All notable changes to DevRelay are documented here.

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

## Unreleased

### Added

- Windows launcher implementation moved to `scripts/DevRelay-Launcher.ps1`; user-facing entry points are `DevRelay ChatGPT.cmd` and `DevRelay HTTPS.cmd`.
- Incremental first-run preparation with `npm ci` and source-staleness-aware builds.
- Automatic download and SHA-256 verification of the latest official OpenAI `tunnel-client` Windows bundle.
- Secure MCP Tunnel profile creation, `doctor` validation, and joint process supervision.
- Windows DPAPI storage for the tunnel runtime API key.
- Launcher status, setup-only, local-only, force-setup, tunnel-reset, and port options.
- Launcher documentation in English and Japanese quick-start documentation.

## Unreleased

- Added `DevRelay ChatGPT.cmd` for one-click OpenAI Secure MCP Tunnel startup.
- Added `DevRelay HTTPS.cmd` for one-click Cloudflare Quick Tunnel startup.
- HTTPS mode copies the generated public MCP URL to the clipboard.
- Quick Tunnel origin Host is pinned to localhost so DevRelay Host validation remains enabled.
