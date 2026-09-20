# Design decisions and non-goals

## Thin remote CLI, not remote IDE

DevRelay exposes generic process primitives instead of dozens of domain tools. Git, ripgrep, npm, Python, Docker, browser automation CLIs, and similar capabilities remain ordinary commands.

## Six tools remain enough

One-shot execution uses `exec`. Long-running and interactive work uses `process_start`, `process_read`, `process_write`, and `process_stop`; `process_list` provides discovery. PTY support and image return are options on those existing primitives rather than new MCP tools.

## PTY only where pipes are insufficient

Pipe-based children remain the default because they are simpler and cover most compilers, scripts, dev servers, and line-oriented programs.

`process_start(terminal: true)` switches that one session to PTY/ConPTY for terminal-owning applications such as Codex CLI and TUIs. Multiple PTY and pipe sessions may coexist. `node-pty` is the only native process dependency added for this exception.

## Images are transport output, not a filesystem API

DevRelay does not add image browsing or file-management tools. A command can create or locate an image, then `exec.images` or `process_read.images` returns that file as MCP image content. This fills the one gap where stdout alone cannot convey pixels to the MCP client.

## No persistence

DevRelay does not attempt to recover or reattach managed processes after its own restart. Persistence would turn the project into a durable process supervisor and require recovery rules and additional state management.

## No general-purpose GUI automation

The Windows launcher has a local control GUI so the user can visibly see when remote command access is enabled. That GUI is lifecycle/status UI, not a remote-desktop API.

DevRelay intentionally does not expose mouse, keyboard, window-focus, screenshot, or arbitrary desktop-control MCP tools. Browser automation and screenshot generation should use existing CLIs where practical.

## No agent loop

DevRelay executes requested operations but does not decide what work to perform. The MCP client supplies reasoning and orchestration; DevRelay remains the hands.

## Dependency budget

Node standard-library facilities are preferred. The MCP SDK and Zod handle protocol/schema work; `node-pty` is accepted specifically for real PTY/ConPTY sessions. Database, HTTP-framework, CLI-framework, and general GUI-automation dependencies remain out of scope.
