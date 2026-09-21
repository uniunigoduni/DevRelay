# Device identity and peer cluster

DevRelay can present several machines through the same six MCP tools without a central DevRelay gateway. Each node keeps its own processes and forwards only requests that belong to another node.

## Device identity

Every node stores a permanent random `nodeId` in `.devrelay/device.json`. The ID is routing state and does not change when the user renames the device or replaces hardware.

The same file contains:

- `name`: the user-facing name, editable in the GUI.
- `defaultName`: regenerated from OS and hardware facts.
- `aliases`: optional human-friendly alternatives.
- `facts`: platform, architecture, CPU model, and board model when available.

Typical generated names are `windows-ryzen9-3900x`, `windows-core-i7-13700k`, `linux-rpi5`, and `macos-m4-pro`. Raspberry Pi board identity is preferred over its generic ARM CPU name.

If the user has never customized `name`, a hardware change updates it together with `defaultName`. A customized name is preserved.

## Routing names

`exec` and `process_start` accept an optional `device`. It can be the configured name, generated default name, alias, full node ID, or a unique node-ID prefix.

If two nodes expose the same label, DevRelay reports the selector as ambiguous instead of guessing. Rename one node or add a unique alias.

Managed process IDs include their owning node ID. `process_read`, `process_write`, and `process_stop` therefore route automatically without another `device` argument.
## Peer network

Peer routing is disabled by default. When enabled, peer traffic uses a separate HTTP API, port `7319` by default. It is authenticated with HMAC-SHA256 using a 32-byte cluster key stored in `.devrelay/cluster.key`.

Peer requests include a timestamp, one-time nonce, body hash, and signature. Requests outside the timestamp window, replayed nonces, or invalid signatures are rejected.

`internal/.devrelay/peers.json` contains the peer listener and direct peer URLs. The current implementation is intentionally static rather than a discovery service: configure every node with direct URLs for the other nodes it must reach. A full mesh is recommended for a small cluster.

Use the peer API only on a trusted LAN, WireGuard, Tailscale, ZeroTier, or another private network. HMAC authentication is not a reason to expose port 7319 directly to the public Internet.

The GUI Settings panel can edit the device name, aliases, cluster enable switch, peer port, peer URLs, and cluster key while DevRelay is stopped. The Copy button copies the cluster key so the same value can be placed on another trusted node.

## Online state

`process_list` returns the current node, known devices, their online/offline state, and managed processes. Peer status is checked directly; the latest identity is cached in `.devrelay/peer-cache.json` so an offline machine does not disappear from the cluster view.

There is deliberately no globally authoritative presence database. Online state is the view from whichever DevRelay node handled the MCP request.

## One public endpoint

Several machines may run connectors for the same Cloudflare Named Tunnel. ChatGPT can therefore keep one MCP endpoint while Cloudflare sends requests to any available connector:

```text
ChatGPT -> https://devrelay.knctt.com/mcp -> Cloudflare -> any DevRelay node
                                                |
                                                +-> private peer routing
```
All nodes behind one public endpoint must use the same cluster key and the same OAuth issuer/resource. Access tokens are signed from a key derived from the cluster key, so a token issued on one node is accepted by the others.

OAuth client IDs and pending authorization IDs encode their owner node. If an OAuth request lands on another connector, DevRelay forwards it to the owner over the authenticated peer API. Pending authorization requests are aggregated across peers, so any running DevRelay GUI can display and approve or deny them.

The current OAuth state is not a consensus database. Client registrations and rotating refresh-token records remain owned by the node that created them. If that owner is offline when a refresh is required, reconnecting OAuth through an available node may be necessary. This is an explicit availability tradeoff of the no-central-state design.

## Adding another node

For a small cluster:

1. Install/build DevRelay on the new machine and start it once so `.devrelay/device.json` exists.
2. Stop DevRelay before changing identity or cluster settings.
3. Give the machine a useful name and aliases. The generated default remains visible for identification.
4. Copy the cluster key from an existing trusted node into the new node's Cluster key field.
5. Add direct private peer URLs such as `http://100.64.0.2:7319` on both sides. For three or more nodes, configure a small full mesh.
6. If the machines share one public MCP hostname, configure each machine as a connector for that same Cloudflare Named Tunnel.
7. Start the nodes and call `process_list` to verify that every expected device appears and that online state is correct.

The public MCP tool count stays six. No separate status, discovery, or routing tool is added.
