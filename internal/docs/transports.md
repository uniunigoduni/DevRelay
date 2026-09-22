# Transports and remote access

## stdio

Stdio is the default. An MCP host launches DevRelay and exchanges protocol messages over stdin/stdout.

```powershell
node dist/src/main.js
```

DevRelay writes runtime diagnostics to stderr so they do not corrupt the MCP channel.

Reference test with the MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector --cli node dist/src/main.js --method tools/list --format json
```

## Streamable HTTP

Start the HTTP endpoint with:

```powershell
node dist/src/main.js --http --host 127.0.0.1 --port 7317
```

The MCP endpoint is `http://127.0.0.1:7317/mcp`. The implementation uses the MCP TypeScript SDK v2 `createMcpHandler()` entry and its Node adapter. Loopback bindings also use the SDK's localhost Host and Origin validation helpers.

## Remote access

DevRelay does not contain a tunnel. Keep the default loopback listener and expose it through the remote-access layer you control. For ChatGPT development, OpenAI's Developer Mode / Secure MCP Tunnel flow can be placed in front of the local `/mcp` endpoint. HTTPS Named Tunnel mode in the Windows GUI instead enables DevRelay's built-in OAuth 2.1 layer and exposes discovery, DCR, authorization, token, and protected MCP endpoints through the same fixed HTTPS hostname.

DevRelay can bind a non-loopback address with `--host`, but that is an explicit deployment choice; the built-in localhost Host/Origin guards are only applied for loopback binds.

## HTTP Inspector test

With DevRelay already running in HTTP mode:

```powershell
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:7317/mcp --transport http --method tools/list --format json
```

## Protocol state

The HTTP MCP server instance is request-scoped as recommended by the current SDK. Managed process state is not stored on that instance; it lives in the process-wide `ProcessManager`. This is why a process started by one MCP HTTP request remains readable by later requests.

## Windows launcher integration

The DevRelay server core still does not embed a tunnel protocol. On Windows, the single `DevRelay.cmd` launcher opens the GUI, and the saved Settings mode decides which supervised remote-access layer is started:

- `OpenAI Secure Tunnel`: the official OpenAI `tunnel-client` runs beside DevRelay.
- `HTTPS Named Tunnel`: bundled `cloudflared.exe` uses the machine-local Cloudflare Named Tunnel configuration for fixed-hostname HTTPS access.

The GUI passes the selected mode explicitly to the internal PowerShell worker. The launcher filename itself never selects or overrides the transport.

On first use of OpenAI Secure Tunnel mode the worker downloads the official Windows bundle, materializes a `sample_mcp_remote_no_auth` profile pointing at the local `/mcp` endpoint, runs `tunnel-client doctor --explain`, and then starts `tunnel-client run`.

## OAuth in HTTPS Named Tunnel mode

When Settings selects HTTPS Named Tunnel, the GUI sets the public issuer/resource automatically. `/mcp` requires the `devrelay` scope and advertises `offline_access`. Authorization Code + PKCE (`S256`) and DCR are supported. The browser authorization page cannot grant access by itself; the request must be approved in the visible local GUI. OAuth clients, the signing key, and hashed refresh-token records live under `.devrelay/oauth/`.

## Multiple devices

Use one endpoint per device and register each endpoint separately with the MCP client. For HTTPS Named Tunnel deployments, give each machine its own hostname/tunnel mapping. DevRelay does not proxy requests between machines and does not expose a peer-discovery port. A device that cannot be reached through its own registered endpoint is effectively offline to the client.
