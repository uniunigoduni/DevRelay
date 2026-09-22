# Transports and remote access

## stdio

Stdio is the default core transport. An MCP host launches DevRelay and exchanges protocol messages over stdin/stdout.

```powershell
node dist/src/main.js
```

DevRelay writes runtime diagnostics to stderr so they do not corrupt the MCP channel.

## Streamable HTTP

Start the HTTP endpoint directly with:

```powershell
node dist/src/main.js --http --host 127.0.0.1 --port 7317
```

The MCP endpoint is `http://127.0.0.1:7317/mcp`. Loopback bindings use the MCP SDK's localhost Host and Origin validation helpers.

## Windows connection providers

The Windows launcher keeps the MCP server on loopback and supervises a selected remote-access provider from `.devrelay/setup.json`. The main GUI does not expose a connection Mode selector; connection selection and provider setup live in the separate Connection Setup wizard.

### OpenAI Secure Tunnel

The official OpenAI `tunnel-client` connects outbound to OpenAI and forwards the local MCP endpoint without requiring a public hostname. DevRelay stores the selected tunnel ID in machine-local setup files and the runtime API key using Windows DPAPI.

The wizard prepares a `sample_mcp_remote_no_auth` profile. At runtime DevRelay starts the local MCP listener first, then runs `tunnel-client doctor --explain` before starting the tunnel. The runtime worker remains non-interactive and refuses to prompt for missing credentials.

This path is shown as Experimental because ChatGPT-side tunnel integration has known upstream reports that can fail after the local tunnel itself is healthy. The setup wizard identifies openai/tunnel-client issues #71, #57, and #41 by number/title and refreshes their OPEN/CLOSED status when GitHub is reachable.

### HTTPS providers and OAuth

All HTTPS providers terminate public TLS outside DevRelay and forward to the loopback HTTP MCP server. DevRelay enables its OAuth 2.1 Authorization Code + PKCE + DCR layer for these connections. `/mcp` requires the `devrelay` scope and advertises `offline_access`; OAuth clients, signing key, and hashed refresh-token records live under `.devrelay/oauth/`.

The public issuer/resource values are set by the runtime worker after the provider's actual public URL is known. A public browser authorization page cannot approve access by itself: the request must be approved in the visible local DevRelay GUI through a per-runtime local control secret.

#### Tailscale Funnel

Tailscale Funnel is the recommended HTTPS provider for users without a custom domain. Setup can download/run the official Windows Tailscale installer when needed, then relies on the normal Tailscale browser sign-in flow. The prepared endpoint uses the machine's stable tailnet DNS name under `*.ts.net`.

At runtime DevRelay supervises the Funnel process with the local HTTP listener. Provider-specific account/policy requirements remain Tailscale-controlled, so live interoperability should be validated with the target tailnet.

#### Cloudflare Named Tunnel

Named Tunnel provides a stable hostname but requires a Cloudflare account and a domain already managed by Cloudflare. Setup uses the official `cloudflared` CLI browser login, tunnel creation, and DNS routing flow. The generated local config pins the origin Host to localhost so DevRelay's Host validation remains effective.

#### Cloudflare Quick Tunnel

Quick Tunnel requires no Cloudflare account/domain. DevRelay obtains a temporary `trycloudflare.com` URL each time the Quick Tunnel is created, then derives the OAuth issuer/resource and public `/mcp` endpoint from that URL.

The URL is not persistent. Restarting the tunnel can require updating the ChatGPT connection. Quick Tunnel should therefore be treated as a temporary development/testing path rather than a stable deployment.

## ChatGPT registration

For OpenAI Secure Tunnel, the setup wizard instructs the user to create a ChatGPT Developer Mode app/plugin with a **Tunnel** connection and **No authentication** at the MCP layer.

For HTTPS providers, the wizard shows the public `/mcp` endpoint and instructs the user to choose **OAuth**. ChatGPT initiates the OAuth flow and the visible DevRelay GUI presents the local Approve/Deny decision.

## HTTP Inspector test

With DevRelay already running in direct HTTP mode:

```powershell
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:7317/mcp --transport http --method tools/list --format json
```

## Protocol state

The HTTP MCP server instance is request-scoped as recommended by the current SDK. Managed process state lives in the process-wide `ProcessManager`, so a process started by one HTTP request remains readable by later requests.

## Multiple devices

Use one endpoint per device and register each endpoint separately with the MCP client. DevRelay does not proxy requests between machines and does not expose a peer-discovery port.
