# Tool reference

All tools return JSON inside an MCP text content block. A non-zero command exit code is a normal command result, not an MCP transport error.

## `exec`

Runs a command until it exits. Inputs: `command`, optional `args`, `cwd`, `env`, `shell`, `stdin`, `timeoutMs`, and `maxOutputChars`. `args` is valid only with `shell: "direct"`.

The result contains `ok`, `exitCode`, `signal`, `timedOut`, `stdout`, `stderr`, `truncated`, `startedAt`, and `endedAt`. The default retained output limit is 524,288 characters.

## `process_start`

Starts a command without waiting for completion. It accepts the common command fields plus `maxBufferChars`, which defaults to 1,048,576 characters. The result includes a DevRelay `id` and operating-system `pid`.

## `process_read`

Inputs are `processId`, `cursor`, `maxChars`, and `waitMs`. Start with cursor `0`; reuse `nextCursor` from each response on the next call. `waitMs` can wait up to 30 seconds for output or exit, which avoids tight polling loops.

Output is an ordered `events` array. Each event has `cursor`, `stream` (`stdout` or `stderr`), `text`, and `timestamp`. The response also includes `oldestCursor`, `nextCursor`, `truncated`, and the current process snapshot.

## `process_write`

Writes `data` to the retained process stdin. Set `end: true` to close stdin after the write. This is useful for programs that wait for EOF as well as REPL-style programs that consume line input.

## `process_stop`

Stops a process and its child tree, then removes the session from the registry. `force` defaults to `true`. After successful removal the process cannot be read again.

## `process_list`

Returns all sessions retained by the ProcessManager, including recently completed sessions whose output is still available.

## Common command fields

`cwd` changes the working directory. `env` overlays variables on the DevRelay process environment rather than replacing it. `shell` defaults to `auto`. In `direct` mode, `command` is the executable and `args` is passed without shell parsing.

## Examples

For a one-shot Git operation, use `exec` with `command: "git status --short"` and the repository as `cwd`. For a dev server, use `process_start` with `command: "npm run dev"`, then follow output with `process_read` and its cursor.
