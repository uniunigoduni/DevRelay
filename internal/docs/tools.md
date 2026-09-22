# Tool reference

DevRelay keeps exactly six MCP tools. Command results are returned as compact JSON in MCP text content, and `exec` / `process_read` can additionally return requested image files as MCP image content. Compact results identify the local DevRelay by its display name; use `detail: "full"` when the complete device/process metadata is needed.

A non-zero command exit code is a normal command result, not an MCP transport error.

## `exec`

Runs a command until it exits. Inputs: `command`, optional `args`, `cwd`, `env`, `shell`, `outputEncoding`, `stdin`, `timeoutMs`, `maxOutputChars`, `images`, and `detail`.

`args` is valid only with `shell: "direct"`. Compact output always reports `ok` and only emits meaningful non-default fields such as stdout/stderr, a non-zero exit code, timeout, signal, or truncation. `detail: "full"` returns the previous complete lifecycle/device metadata including timestamps.

`images` accepts up to four PNG, JPEG, WebP, or GIF paths. Relative paths resolve from `cwd`; images are loaded after the command exits and returned as MCP `image` content. Each image is limited to 20 MiB.

## `process_start`

Starts a command without waiting for completion. It accepts the common command fields plus `maxBufferChars`.

Set `terminal: true` to allocate a PTY/ConPTY for interactive terminal applications. `columns` and `rows` default to 120×30. Multiple terminal and non-terminal sessions can coexist because every start returns an independent DevRelay process ID.

Compact output returns the DevRelay process ID and OS PID, adding terminal dimensions only for PTY sessions. Use `detail: "full"` for the complete process snapshot.

## `process_read`

Inputs are `processId`, `cursor`, `maxChars`, `waitMs`, and optional `images`. Start with cursor `0`; reuse `nextCursor` on the next call. `waitMs` can wait up to 30 seconds for output or exit.

`maxChars` is a soft response target between output events, not a strict byte/character ceiling. DevRelay does not split a retained event merely to satisfy `maxChars`, so one event can make a read exceed the requested value; this preserves cursor semantics without dropping part of an event.

Compact output is an ordered `events` array containing only `stream` and `text`, plus `nextCursor` and running/final status. Internal event cursors and timestamps remain stored; `detail: "full"` exposes them together with the full process snapshot. Pipe sessions report `stdout` and `stderr` separately. PTY sessions expose the terminal byte stream as `stdout`, including normal ANSI terminal control sequences.

`images` uses the same image limits as `exec`; relative paths resolve from the managed process working directory.

## `process_write`

Writes `data` to a retained process. For ordinary pipe sessions, `end: true` closes stdin.

For terminal sessions, `data` is written directly to the PTY. Supply `columns` and `rows` together to resize the terminal. `end: true` is intentionally rejected for PTY sessions; use `process_stop` to terminate them.

## `process_stop`

Stops a managed process and removes the session from the registry. `force` defaults to `true`. PTY sessions are terminated through the PTY backend; ordinary Windows processes use tree termination.

## `process_list`

Returns compact identification/status records for sessions retained by the local ProcessManager, including recently completed sessions by default so older output remains discoverable. Set `includeCompleted: false` to list only running sessions. Use `detail: "full"` for complete process snapshots and full device metadata.

## Common command fields

`cwd` changes the working directory. `env` overlays variables on the DevRelay process environment rather than replacing it. `shell` defaults to `auto`. In `direct` mode, `command` is the executable and `args` is passed without shell parsing.

`outputEncoding` overrides non-PTY stdout/stderr decoding. Normally omit it: on Windows, non-PTY `cmd`/`auto` and Windows PowerShell are run through a small wrapper that normalizes their output to UTF-8, while `direct`, `pwsh`, and non-Windows shells default to UTF-8. Use an explicit encoding such as `cp932`, `cp437`, `cp850`, or `system` for a legacy executable whose output encoding is known. An explicit override disables the Windows shell normalizer for that invocation.

A byte stream does not contain enough information to reliably infer arbitrary encodings. DevRelay therefore does not guess UTF-8 versus a legacy code page from content. If a command intentionally combines independently encoded producers into one pipe and cannot be normalized by the Windows shell wrapper, use `process_start(terminal: true)` so ConPTY provides a UTF-8 terminal stream.

## Examples

For a one-shot Git operation, use `exec` with `command: "git status --short"` and the repository as `cwd`.

For a dev server, use `process_start` with `command: "npm run dev"`, then follow output with `process_read` and its cursor.

For an interactive CLI such as Codex, use `process_start` with `terminal: true`, keep that process ID dedicated to the TUI, and start additional managed processes for unrelated shell work.

For a screenshot generated by a CLI, pass its path in `exec.images`. For an image produced by a long-running process, pass its path in `process_read.images`.
