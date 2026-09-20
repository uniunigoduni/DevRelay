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

DevRelay does not contain a tunnel. Keep the default loopback listener and expose it through the remote-access layer you control. For ChatGPT development, OpenAI's Developer Mode / Secure MCP Tunnel flow can be placed in front of the local `/mcp` endpoint. A conventional authenticated reverse proxy or private overlay network can serve the same role for other MCP clients.

DevRelay can bind a non-loopback address with `--host`, but that is an explicit deployment choice; the built-in localhost Host/Origin guards are only applied for loopback binds.

## HTTP Inspector test

With DevRelay already running in HTTP mode:

```powershell
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:7317/mcp --transport http --method tools/list --format json
```

## Protocol state

The HTTP MCP server instance is request-scoped as recommended by the current SDK. Managed process state is not stored on that instance; it lives in the process-wide `ProcessManager`. This is why a process started by one MCP HTTP request remains readable by later requests.

## Windows launcher integration

The DevRelay server core still does not embed a tunnel protocol. On Windows, `DevRelay ChatGPT.cmd` manages the official OpenAI `tunnel-client` beside DevRelay as a separate supervised process; `DevRelay HTTPS.cmd` uses the bundled `cloudflared.exe` with a machine-local Cloudflare Named Tunnel configuration for fixed-hostname HTTPS access.

On first use the launcher downloads the official Windows bundle, materializes a `sample_mcp_remote_no_auth` profile pointing at the local `/mcp` endpoint, runs `tunnel-client doctor --explain`, and then starts `tunnel-client run`. This keeps the MCP server itself small while making the normal user workflow one command.
