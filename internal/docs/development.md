# Development guide

## Commands

```powershell
npm install
npm run check
npm run build
npm test
```

Tests use Node's built-in `node:test`; there is no separate test framework. TypeScript is compiled before tests run.

## Layout

```text
src/main.ts             CLI and lifecycle
src/http-server.ts      Streamable HTTP adapter
src/mcp-server.ts       MCP tool schemas and handlers
src/process-manager.ts  child-process lifecycle and registry
src/output-buffer.ts    rolling cursor-based output storage
src/types.ts            shared process types
test/                   Node test runner tests
docs/                   design and usage documentation
```

## Dependency policy

Runtime dependencies should remain minimal. Prefer Node.js standard-library APIs whenever they provide the required behavior. Protocol behavior should stay delegated to the official MCP SDK instead of being reimplemented locally.

A new dependency should provide a capability that would otherwise require substantial platform-specific code or protocol code. Convenience-only packages such as CLI parsers, logging frameworks, utility libraries, and test frameworks are intentionally avoided.

## Adding a tool

Before adding an MCP tool, check whether the same operation can be expressed reliably as a command through `exec` or `process_start`. A first-class tool is justified when it provides a primitive that command composition cannot represent cleanly, or when it materially improves model/tool semantics without duplicating a normal CLI.

## Tests

The suite covers cursor buffering, direct executable execution, stdout/stderr capture, managed stdin, incremental reads, process stopping, and command timeouts. MCP schema registration is additionally smoke-tested with the official MCP Inspector CLI.

## Release checklist

Run `npm run check`, `npm test`, the stdio Inspector `tools/list` smoke test, and the HTTP Inspector smoke test. Update the version in `package.json` and `src/main.ts`, then update `CHANGELOG.md`.
