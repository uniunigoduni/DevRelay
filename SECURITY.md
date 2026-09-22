# Security Policy

DevRelay intentionally provides remote access to a development machine's command-line environment. Arbitrary command execution **after successful authorization through the configured MCP access path** is expected product behavior, not by itself a vulnerability.

## Supported versions

Security fixes target the latest published GitHub Release. Development commits on `main` may contain unreleased changes and are not treated as a supported release channel.

## Reporting a vulnerability

Please do not publish exploit details, credentials, tokens, machine identifiers, or proof-of-concept commands in a public issue.

Use GitHub's private vulnerability reporting from the repository Security tab when it is available. If private reporting is not available, open a minimal public issue asking for a private contact method **without including vulnerability details**.

Useful reports include a clear impact description, affected release, reproduction conditions, and the smallest safe proof needed to confirm the issue.

## Security-sensitive areas

Examples of issues that should be reported privately include:

- bypassing OAuth, local approval, Host/Origin checks, or another intended access-control boundary;
- causing unauthenticated or unintended remote command execution;
- leaking stored credentials, OAuth material, tunnel secrets, or command data across trust boundaries;
- escaping image/file output restrictions to read unrelated local files;
- process isolation or termination behavior that crosses into unrelated processes;
- updater behavior that accepts non-release code, an unexpected remote, a dirty checkout, or a non-fast-forward update;
- persistent execution after the visible GUI is closed when the normal lifecycle should have stopped DevRelay.

## Automatic updates

The Windows GUI bootstrap checks only the latest published GitHub Release. It does not follow ordinary branch pushes or prereleases. Automatic application is limited to the official repository origin, a clean Git worktree, and a fast-forward from the current checkout to the release commit. If those conditions are not met, DevRelay starts without modifying the checkout.
