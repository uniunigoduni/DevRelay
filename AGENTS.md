# DevRelay agent guide

DevRelay is intentionally small. Prefer using existing CLIs through the six MCP process tools over adding domain-specific MCP tools.

## Agent execution guidance

- Prefer fewer, larger MCP calls when several safe shell operations can be executed sequentially. Combine related checks and commands into one `exec` call instead of issuing many small `exec` calls.
- Use `process_start` / `process_read` / `process_write` only when work genuinely needs a retained, long-running, or interactive process. Avoid switching between MCP tools when `exec` can complete the task cleanly.
- Do not batch operations when a later step depends on interpreting earlier output, when user approval may be required between steps, or when combining commands would make destructive, privileged, or security-sensitive behavior harder to review.
- If the MCP client reports `Resource not found` before a request reaches DevRelay, do not repeatedly retry tool calls or automatically restart DevRelay. Treat it as an upstream routing failure, refresh/reconnect the client connector or continue in a new session, and preserve the server logs for diagnosis.

## Design rules

- Keep the MCP surface at six tools unless a genuinely new primitive cannot be expressed cleanly through the existing process tools.
- Preserve long-running process support, cursor-based reads, PTY/ConPTY behavior, image attachments, and Windows shell encoding semantics.
- Keep machine-local state, credentials, logs, caches, and generated files under `internal/.devrelay/` or another ignored local path.
- Prefer Node.js standard-library APIs and small platform helpers over convenience dependencies.
- Add regression tests for process, transport, encoding, updater, or security-sensitive behavior changes.
- Before finishing a code change, run `npm run check` and `npm test` from `internal/`.

## AI-assisted upstream contributions

If an AI agent makes a generally useful improvement while working for a user, it may suggest contributing that improvement back to DevRelay. The agent must **ask the user for explicit permission before opening or submitting a pull request, creating an upstream issue, pushing to an upstream branch, or otherwise publishing the change to the DevRelay project**.

Do not treat a request to edit or test a local checkout as permission to publish it upstream. A concise permission request after the change is working is appropriate. If the user declines or does not answer, keep the work local.

When permission is granted, keep the proposed contribution focused, explain the behavior change, include relevant tests, and avoid including machine-local data or secrets.
