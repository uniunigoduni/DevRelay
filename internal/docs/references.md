# Upstream references

DevRelay follows established patterns from active open-source projects rather than inventing a custom MCP transport or remote-shell protocol.

## Model Context Protocol TypeScript SDK

Repository: https://github.com/modelcontextprotocol/typescript-sdk

DevRelay follows the SDK v2 serving model: `serveStdio()` for local child-process hosting, `createMcpHandler()` for Streamable HTTP, and `@modelcontextprotocol/node` for the plain Node HTTP adapter and localhost Host/Origin validation. The MCP server factory remains cheap and request-scoped while process state is kept outside it.

## MCP Inspector

Repository: https://github.com/modelcontextprotocol/inspector

The Inspector CLI is used as the protocol-level smoke test for both stdio and Streamable HTTP. This checks the public MCP boundary rather than only calling DevRelay internals from unit tests.

## Desktop Commander MCP

Repository: https://github.com/wonderwhy-er/DesktopCommanderMCP

Desktop Commander demonstrates the practical value of terminal control, persistent process interaction, filesystem operations, and diff editing for model-driven development. DevRelay intentionally adopts only the generic terminal/process primitive and avoids its broader document, UI, search, and conversion feature set to keep the dependency surface small.

## node-pty

Repository: https://github.com/microsoft/node-pty

`node-pty` is the single native process dependency. DevRelay uses it only when `process_start` requests a real PTY/ConPTY; ordinary commands continue to use Node `child_process`.

## Node.js standard library

DevRelay uses `node:child_process` for execution, `node:events` for output wakeups, `node:crypto` for process IDs, `node:http` for the HTTP listener, and `node:test` for tests. No extra process supervisor, HTTP framework, CLI parser, logger, database, or test framework is required.

No upstream source code is copied into DevRelay; these projects are architectural and interoperability references.
