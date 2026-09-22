# DevRelay agent guide

DevRelay is intentionally small. Prefer using existing CLIs through the six MCP process tools over adding domain-specific MCP tools.

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
