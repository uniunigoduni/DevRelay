# Design decisions and non-goals

## Thin remote CLI, not remote IDE

DevRelay exposes generic process primitives instead of dozens of domain tools. `git status`, `rg`, `npm test`, `python`, `docker ps`, and similar operations remain commands. This keeps the MCP surface stable even when developer tooling changes.

## Six tools are enough for v0.1

One-shot execution needs `exec`. Long-running and interactive-by-pipe execution needs start/read/write/stop, and `process_list` provides discovery. Filesystem and Git-specific APIs are intentionally omitted.

## No PTY in v0.1

A pipe-based child process supports most compilers, package managers, dev servers, scripts, and line-oriented REPLs without a native dependency. Full-screen terminal applications such as Vim, interactive fuzzy finders, and TUI programs require a real PTY/ConPTY and are outside v0.1.

The process layer is isolated so a PTY backend can be added later without changing the MCP transport architecture.

## No persistence

DevRelay does not attempt to recover or reattach managed processes after its own restart. Persistence would turn the project into a process supervisor and require durable identity, recovery rules, and additional state management.

## No built-in tunnel or web UI

Remote networking is a separate concern. DevRelay serves MCP on stdio or HTTP and lets an existing tunnel, reverse proxy, or private network provide reachability. A browser dashboard would duplicate process-management information already available through MCP and ordinary system tools.

## No agent loop

DevRelay executes requested operations but does not decide what work to perform. The MCP client supplies reasoning and orchestration; DevRelay remains a deterministic tool server.

## Dependency budget

Node standard-library facilities are preferred. The MCP SDK is used rather than implementing protocol details. A native PTY package, database, HTTP framework, CLI framework, and logging framework are intentionally absent from the initial dependency graph.
