# Contributing

DevRelay intentionally keeps a narrow scope and a small dependency graph.

Before proposing a feature, check whether the same capability can be expressed through an existing command-line tool using `exec` or the managed-process tools. Prefer improving generic process primitives over adding domain-specific MCP tools.

## Local verification

```powershell
cd internal
npm install
npm run check
npm test
npx @modelcontextprotocol/inspector --cli node dist/src/main.js --method tools/list --format json
```

Changes to transport code should also be verified in HTTP mode with the MCP Inspector. Changes to process behavior should include a `node:test` regression test.

## Style

Use strict TypeScript and ESM imports. Prefer Node standard-library APIs. Avoid stdout logging in MCP stdio mode. Keep comments focused on non-obvious invariants rather than restating code.

## Dependencies

New runtime dependencies require a clear reason. Convenience packages for argument parsing, logging, file utilities, or test orchestration should generally not be added when a small standard-library implementation is sufficient.

## Contribution license

Contributions are accepted under the project license in effect when they are submitted. Do not submit code that you do not have the right to contribute. If maintainers need additional rights for a particular contribution, they will request them separately before merging.

AI-assisted changes are welcome, but an AI agent must not open or submit an upstream pull request on a user's behalf without that user's explicit permission. See [AGENTS.md](AGENTS.md).
