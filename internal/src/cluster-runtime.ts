import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadImageContents } from "./image-content.js";
import { identityLabels, type DeviceIdentity } from "./device-identity.js";
import { ProcessManager } from "./process-manager.js";
import type { CommandSpec, ProcessSnapshot } from "./types.js";

export type RuntimeTool = "exec" | "process_start" | "process_read" | "process_write" | "process_stop" | "process_list";

export interface ClusterConfig {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  peers: string[];
}

export interface OAuthProxyRequest {
  method: "GET" | "POST";
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface OAuthProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface OAuthControlBridge {
  listPending(): Array<{ id: string; clientName: string; redirectHost: string; scopes: string[]; createdAt: string }>;
  decidePending(id: string, approve: boolean): boolean;
}

export interface ClusterPendingAuthorization {
  id: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
  createdAt: string;
  device: DeviceView;
}

export interface DeviceView {
  nodeId: string;
  name: string;
  defaultName: string;
  aliases: string[];
  platform: string;
  arch: string;
  hardware?: string;
  online: boolean;
  lastSeen?: string;
}
interface PeerState {
  url: string;
  device?: DeviceView;
  lastSeen?: string;
  lastError?: string;
}

interface RuntimeResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

interface ExecuteInput extends CommandSpec {
  device?: string;
  stdin?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  images?: string[];
}

interface StartInput extends CommandSpec {
  device?: string;
  maxBufferChars?: number;
  terminal?: boolean;
  columns?: number;
  rows?: number;
}
interface ReadInput {
  processId: string;
  cursor?: number;
  maxChars?: number;
  waitMs?: number;
  images?: string[];
}

interface WriteInput {
  processId: string;
  data?: string;
  end?: boolean;
  columns?: number;
  rows?: number;
}

interface StopInput {
  processId: string;
  force?: boolean;
}

interface ListInput {
  device?: string;
}

type ToolInput = ExecuteInput | StartInput | ReadInput | WriteInput | StopInput | ListInput;

const DEFAULT_CONFIG: ClusterConfig = {
  enabled: false,
  listenHost: "0.0.0.0",
  listenPort: 7319,
  peers: []
};
function textResult(value: unknown): RuntimeResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): RuntimeResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

function normalizePeerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported peer URL: ${value}`);
  return url.origin;
}

async function readClusterConfig(stateDir: string): Promise<ClusterConfig> {
  const filePath = path.join(stateDir, "peers.json");
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    const rawPeers: unknown[] = Array.isArray(parsed.peers) ? parsed.peers : [];
    const peers: string[] = rawPeers.filter((v): v is string => typeof v === "string").map(normalizePeerUrl);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
      listenHost: typeof parsed.listenHost === "string" ? parsed.listenHost : DEFAULT_CONFIG.listenHost,
      listenPort: Number.isInteger(parsed.listenPort) ? parsed.listenPort : DEFAULT_CONFIG.listenPort,
      peers: [...new Set(peers)]
    };
  } catch {
    await writeFile(filePath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    return { ...DEFAULT_CONFIG };
  }
}
async function loadClusterKey(stateDir: string): Promise<Buffer> {
  const fromEnv = process.env.DEVRELAY_CLUSTER_KEY?.trim();
  if (fromEnv) return Buffer.from(fromEnv, "base64url");

  const filePath = path.join(stateDir, "cluster.key");
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing) return Buffer.from(existing, "base64url");
  } catch {}

  const key = randomBytes(32);
  await writeFile(filePath, `${key.toString("base64url")}\n`, { encoding: "utf8", mode: 0o600 });
  return key;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalRequest(method: string, pathname: string, timestamp: string, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${pathname}\n${timestamp}\n${nonce}\n${sha256Hex(body)}`;
}

function deviceView(identity: DeviceIdentity, online = true, lastSeen?: string): DeviceView {
  return {
    nodeId: identity.nodeId,
    name: identity.name,
    defaultName: identity.defaultName,
    aliases: identity.aliases,
    platform: identity.facts.platform,
    arch: identity.facts.arch,
    hardware: identity.facts.boardModel ?? identity.facts.cpuModel,
    online,
    lastSeen
  };
}
async function readRequestBody(request: IncomingMessage, limit = 128 * 1024 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw new Error("Peer request body too large.");
  }
  return body;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function wrapSnapshot(snapshot: ProcessSnapshot, nodeId: string): ProcessSnapshot {
  return { ...snapshot, id: `${nodeId}:${snapshot.id}` };
}

function parseProcessOwner(processId: string): { owner?: string; localId: string } {
  const separator = processId.indexOf(":");
  if (separator <= 0) return { localId: processId };
  return { owner: processId.slice(0, separator), localId: processId.slice(separator + 1) };
}

function selectorKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function withoutDevice<T extends { device?: string }>(input: T): Omit<T, "device"> {
  const { device: _device, ...rest } = input;
  return rest;
}
export class ClusterRuntime {
  readonly manager: ProcessManager;
  readonly identity: DeviceIdentity;
  readonly stateDir: string;
  readonly config: ClusterConfig;
  private readonly key: Buffer;
  private readonly peers = new Map<string, PeerState>();
  private readonly seenNonces = new Map<string, number>();
  private peerServer?: Server;
  private localHttpPort?: number;
  private oauthControl?: OAuthControlBridge;

  private constructor(
    manager: ProcessManager,
    identity: DeviceIdentity,
    stateDir: string,
    config: ClusterConfig,
    key: Buffer
  ) {
    this.manager = manager;
    this.identity = identity;
    this.stateDir = stateDir;
    this.config = config;
    this.key = key;
    if (config.enabled) for (const url of config.peers) this.peers.set(url, { url });
  }

  static async create(manager: ProcessManager, identity: DeviceIdentity, stateDir: string): Promise<ClusterRuntime> {
    await mkdir(stateDir, { recursive: true });
    const [config, key] = await Promise.all([readClusterConfig(stateDir), loadClusterKey(stateDir)]);
    const runtime = new ClusterRuntime(manager, identity, stateDir, config, key);
    await runtime.loadPeerCache();
    return runtime;
  }
  setLocalHttpPort(port: number | undefined): void {
    this.localHttpPort = port;
  }

  attachOAuthControl(control: OAuthControlBridge | undefined): void {
    this.oauthControl = control;
  }

  async listOAuthPending(): Promise<ClusterPendingAuthorization[]> {
    await this.refreshPeers();
    const localDevice = deviceView(this.identity, true, new Date().toISOString());
    const local = (this.oauthControl?.listPending() ?? []).map((item) => ({ ...item, device: localDevice }));
    const remote = await Promise.all([...this.peers.values()].map(async (peer) => {
      if (!peer.device?.online) return [] as ClusterPendingAuthorization[];
      try {
        const value = await this.peerFetch(peer, "/v1/oauth-pending", "GET") as { pending?: Array<Omit<ClusterPendingAuthorization, "device">> };
        return (value.pending ?? []).map((item) => ({ ...item, device: peer.device! }));
      } catch { return [] as ClusterPendingAuthorization[]; }
    }));
    return [...local, ...remote.flat()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  oauthSigningKey(): Buffer {
    return createHmac("sha256", this.key).update("devrelay-oauth-v1").digest();
  }

  async decideOAuthPending(id: string, approve: boolean): Promise<boolean> {
    const parts = id.split(".");
    const owner = parts.length >= 3 && parts[0] === "par" ? parts[1] : undefined;
    if (!owner || owner === this.identity.nodeId) return this.oauthControl?.decidePending(id, approve) ?? false;
    const peer = await this.peerForNode(owner);
    const value = await this.peerFetch(peer, "/v1/oauth-decision", "POST", { id, approve }) as { ok?: boolean };
    return value.ok === true;
  }

  async proxyOAuth(nodeId: string, request: OAuthProxyRequest): Promise<OAuthProxyResponse> {
    if (nodeId === this.identity.nodeId) return await this.proxyOAuthLocal(request);
    const peer = await this.peerForNode(nodeId);
    return await this.peerFetch(peer, "/v1/oauth-proxy", "POST", request) as OAuthProxyResponse;
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.peerServer) return;
    this.peerServer = createServer((request, response) => {
      void this.handlePeerRequest(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        if (!response.writableEnded) response.end(JSON.stringify({ error: message }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.peerServer!.once("error", reject);
      this.peerServer!.listen(this.config.listenPort, this.config.listenHost, () => resolve());
    });
    console.error(`[DevRelay] peer API listening on http://${this.config.listenHost}:${this.config.listenPort}`);
  }

  async close(): Promise<void> {
    if (!this.peerServer) return;
    const server = this.peerServer;
    this.peerServer = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private signature(method: string, pathname: string, timestamp: string, nonce: string, body: string): string {
    return createHmac("sha256", this.key)
      .update(canonicalRequest(method, pathname, timestamp, nonce, body))
      .digest("base64url");
  }
  private verifyPeerRequest(request: IncomingMessage, pathname: string, body: string): boolean {
    const timestamp = String(request.headers["x-devrelay-timestamp"] ?? "");
    const nonce = String(request.headers["x-devrelay-nonce"] ?? "");
    const signature = String(request.headers["x-devrelay-signature"] ?? "");
    const when = Number(timestamp);
    if (!timestamp || !nonce || !signature || !Number.isFinite(when)) return false;
    if (Math.abs(Date.now() - when) > 60_000) return false;

    const now = Date.now();
    for (const [value, expiresAt] of this.seenNonces) if (expiresAt <= now) this.seenNonces.delete(value);
    if (this.seenNonces.has(nonce)) return false;

    const expected = this.signature(request.method ?? "GET", pathname, timestamp, nonce, body);
    if (!safeEqual(signature, expected)) return false;
    this.seenNonces.set(nonce, now + 120_000);
    return true;
  }

  private signedHeaders(method: string, pathname: string, body: string): Record<string, string> {
    const timestamp = String(Date.now());
    const nonce = randomBytes(18).toString("base64url");
    return {
      "content-type": "application/json",
      "x-devrelay-node": this.identity.nodeId,
      "x-devrelay-timestamp": timestamp,
      "x-devrelay-nonce": nonce,
      "x-devrelay-signature": this.signature(method, pathname, timestamp, nonce, body)
    };
  }
  private async peerFetch(peer: PeerState, pathname: string, method = "GET", value?: unknown, timeoutMs?: number): Promise<unknown> {
    const body = value === undefined ? "" : JSON.stringify(value);
    const response = await fetch(`${peer.url}${pathname}`, {
      method,
      headers: this.signedHeaders(method, pathname, body),
      body: body || undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : `Peer HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  private async refreshPeer(peer: PeerState): Promise<void> {
    try {
      const payload = await this.peerFetch(peer, "/v1/status", "GET", undefined, 1500) as { device?: DeviceView };
      if (!payload.device?.nodeId) throw new Error("Peer status did not include a device identity.");
      const lastSeen = new Date().toISOString();
      peer.device = { ...payload.device, online: true, lastSeen };
      peer.lastSeen = lastSeen;
      peer.lastError = undefined;
    } catch (error) {
      peer.lastError = error instanceof Error ? error.message : String(error);
      if (peer.device) peer.device = { ...peer.device, online: false, lastSeen: peer.lastSeen };
    }
  }

  async refreshPeers(): Promise<void> {
    await Promise.all([...this.peers.values()].map((peer) => this.refreshPeer(peer)));
    await this.savePeerCache();
  }
  private async proxyOAuthLocal(request: OAuthProxyRequest): Promise<OAuthProxyResponse> {
    if (!this.localHttpPort) throw new Error("Local HTTP MCP endpoint is unavailable for OAuth proxying.");
    if (!["/oauth/authorize", "/oauth/authorize/status", "/oauth/token"].some((allowed) => request.path === allowed || request.path.startsWith(`${allowed}?`))) {
      throw new Error("OAuth peer proxy path is not allowed.");
    }
    const response = await fetch(`http://127.0.0.1:${this.localHttpPort}${request.path}`, {
      method: request.method,
      headers: { ...(request.headers ?? {}), "x-devrelay-internal-oauth-proxy": "1" },
      body: request.method === "POST" ? (request.body ?? "") : undefined,
      redirect: "manual"
    });
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers) if (name.toLowerCase() !== "content-length") headers[name] = value;
    return { status: response.status, headers, body: await response.text() };
  }

  private async handlePeerRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://peer.local");
    const body = request.method === "POST" ? await readRequestBody(request) : "";
    if (!this.verifyPeerRequest(request, url.pathname, body)) {
      sendJson(response, 401, { error: "Invalid peer authentication." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/status") {
      sendJson(response, 200, { device: deviceView(this.identity), now: new Date().toISOString() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/oauth-pending") {
      sendJson(response, 200, { pending: this.oauthControl?.listPending() ?? [] });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/oauth-decision") {
      const payload = JSON.parse(body || "{}") as { id?: string; approve?: boolean };
      const ok = typeof payload.id === "string" && (this.oauthControl?.decidePending(payload.id, payload.approve === true) ?? false);
      sendJson(response, ok ? 200 : 404, ok ? { ok: true } : { error: "pending_request_not_found" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/oauth-proxy") {
      const payload = JSON.parse(body || "{}") as OAuthProxyRequest;
      if ((payload.method !== "GET" && payload.method !== "POST") || typeof payload.path !== "string") {
        sendJson(response, 400, { error: "Invalid OAuth proxy request." });
        return;
      }
      sendJson(response, 200, await this.proxyOAuthLocal(payload));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/invoke") {
      const payload = JSON.parse(body || "{}") as { tool?: RuntimeTool; input?: ToolInput };
      const allowed: RuntimeTool[] = ["exec", "process_start", "process_read", "process_write", "process_stop", "process_list"];
      if (!payload.tool || !allowed.includes(payload.tool)) {
        sendJson(response, 400, { error: "Unknown peer tool." });
        return;
      }
      const result = await this.invokeLocal(payload.tool, payload.input ?? {});
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: "Not Found" });
  }
  private labelsForView(device: DeviceView): string[] {
    return [device.nodeId, device.name, device.defaultName, ...device.aliases];
  }

  private matchesSelector(device: DeviceView, selector: string): boolean {
    const key = selectorKey(selector);
    if (!key) return false;
    if (this.labelsForView(device).some((label) => selectorKey(label) === key)) return true;
    return key.length >= 8 && device.nodeId.toLocaleLowerCase().startsWith(key);
  }

  async devices(): Promise<DeviceView[]> {
    await this.refreshPeers();
    const local = deviceView(this.identity, true, new Date().toISOString());
    const remote = [...this.peers.values()]
      .filter((peer) => peer.device)
      .map((peer) => peer.device!);
    const byNode = new Map<string, DeviceView>([[local.nodeId, local]]);
    for (const device of remote) byNode.set(device.nodeId, device);
    return [...byNode.values()];
  }

  private async resolveDevice(selector: string | undefined): Promise<{ device: DeviceView; peer?: PeerState }> {
    const local = deviceView(this.identity, true, new Date().toISOString());
    if (!selector || this.matchesSelector(local, selector)) return { device: local };

    await this.refreshPeers();
    const matches = [...this.peers.values()].filter((peer) => peer.device && this.matchesSelector(peer.device, selector));
    if (matches.length === 0) throw new Error(`Unknown device: ${selector}`);
    const unique = new Map(matches.map((peer) => [peer.device!.nodeId, peer]));
    if (unique.size > 1) throw new Error(`Ambiguous device name: ${selector}`);
    const peer = [...unique.values()][0]!;
    if (!peer.device!.online) throw new Error(`Device is offline: ${peer.device!.name}`);
    return { device: peer.device!, peer };
  }
  private async invokePeer(peer: PeerState, tool: RuntimeTool, input: ToolInput): Promise<RuntimeResult> {
    try {
      const result = await this.peerFetch(peer, "/v1/invoke", "POST", { tool, input }) as RuntimeResult;
      return result;
    } catch (error) {
      peer.lastError = error instanceof Error ? error.message : String(error);
      if (peer.device) peer.device = { ...peer.device, online: false, lastSeen: peer.lastSeen };
      throw error;
    }
  }

  private async peerForNode(nodeId: string): Promise<PeerState> {
    await this.refreshPeers();
    const peer = [...this.peers.values()].find((candidate) => candidate.device?.nodeId === nodeId);
    if (!peer?.device) throw new Error(`Unknown process owner node: ${nodeId}`);
    if (!peer.device.online) throw new Error(`Process owner is offline: ${peer.device.name}`);
    return peer;
  }

  async invoke(tool: RuntimeTool, input: ToolInput): Promise<RuntimeResult> {
    try {
      if (tool === "exec" || tool === "process_start") {
        const commandInput = input as ExecuteInput | StartInput;
        const target = await this.resolveDevice(commandInput.device);
        if (!target.peer) return await this.invokeLocal(tool, withoutDevice(commandInput));
        return await this.invokePeer(target.peer, tool, withoutDevice(commandInput));
      }

      if (tool === "process_read" || tool === "process_write" || tool === "process_stop") {
        const processInput = input as ReadInput | WriteInput | StopInput;
        const parsed = parseProcessOwner(processInput.processId);
        if (!parsed.owner || parsed.owner === this.identity.nodeId) {
          return await this.invokeLocal(tool, { ...processInput, processId: parsed.localId });
        }
        const peer = await this.peerForNode(parsed.owner);
        return await this.invokePeer(peer, tool, { ...processInput, processId: parsed.localId });
      }

      return await this.invokeProcessList(input as ListInput);
    } catch (error) {
      return errorResult(error);
    }
  }
  private async invokeLocal(tool: RuntimeTool, input: ToolInput): Promise<RuntimeResult> {
    try {
      if (tool === "exec") {
        const value = input as ExecuteInput;
        const result = await this.manager.execute(this.commandSpec(value), {
          stdin: value.stdin,
          timeoutMs: value.timeoutMs,
          maxOutputChars: value.maxOutputChars
        });
        return {
          content: [
            { type: "text", text: JSON.stringify({ device: deviceView(this.identity), ...result }, null, 2) },
            ...await loadImageContents(value.images, value.cwd ?? process.cwd())
          ]
        };
      }

      if (tool === "process_start") {
        const value = input as StartInput;
        const snapshot = await this.manager.start(this.commandSpec(value), value.maxBufferChars, {
          terminal: value.terminal,
          columns: value.columns,
          rows: value.rows
        });
        return textResult({ device: deviceView(this.identity), process: wrapSnapshot(snapshot, this.identity.nodeId) });
      }
      if (tool === "process_read") {
        const value = input as ReadInput;
        const result = await this.manager.read(value.processId, {
          cursor: value.cursor,
          maxChars: value.maxChars,
          waitMs: value.waitMs
        });
        const wrapped = { ...result, process: wrapSnapshot(result.process, this.identity.nodeId) };
        return {
          content: [
            { type: "text", text: JSON.stringify({ device: deviceView(this.identity), ...wrapped }, null, 2) },
            ...await loadImageContents(value.images, result.process.cwd ?? process.cwd())
          ]
        };
      }

      if (tool === "process_write") {
        const value = input as WriteInput;
        if ((value.columns === undefined) !== (value.rows === undefined)) {
          throw new Error("columns and rows must be supplied together.");
        }
        const resize = value.columns !== undefined && value.rows !== undefined
          ? { columns: value.columns, rows: value.rows }
          : undefined;
        const result = await this.manager.write(value.processId, value.data ?? "", value.end ?? false, resize);
        return textResult({ device: deviceView(this.identity), ...result });
      }
      if (tool === "process_stop") {
        const value = input as StopInput;
        const result = await this.manager.stop(value.processId, value.force ?? true);
        return textResult({ device: deviceView(this.identity), process: wrapSnapshot(result, this.identity.nodeId) });
      }

      const processes = this.manager.list().map((snapshot) => wrapSnapshot(snapshot, this.identity.nodeId));
      return textResult({ device: deviceView(this.identity), processes });
    } catch (error) {
      return errorResult(error);
    }
  }

  private commandSpec(input: ExecuteInput | StartInput): CommandSpec {
    return {
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      shell: input.shell
    };
  }

  private parseResultValue(result: RuntimeResult): unknown {
    const text = result.content.find((item) => item.type === "text");
    if (!text || text.type !== "text") return undefined;
    try { return JSON.parse(text.text); } catch { return undefined; }
  }
  private async loadPeerCache(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.stateDir, "peer-cache.json"), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [url, value] of Object.entries(parsed)) {
        const peer = this.peers.get(url);
        if (!peer || !value || typeof value !== "object") continue;
        const cached = value as DeviceView;
        if (!cached.nodeId || !cached.name) continue;
        peer.device = { ...cached, online: false };
        peer.lastSeen = cached.lastSeen;
      }
    } catch {}
  }

  private async savePeerCache(): Promise<void> {
    const values: Record<string, DeviceView> = {};
    for (const [url, peer] of this.peers) {
      if (peer.device) values[url] = { ...peer.device, online: false, lastSeen: peer.lastSeen };
    }
    await writeFile(path.join(this.stateDir, "peer-cache.json"), `${JSON.stringify(values, null, 2)}\n`, "utf8");
  }
  private async invokeProcessList(input: ListInput): Promise<RuntimeResult> {
    const devices = await this.devices();
    if (input.device) {
      const target = await this.resolveDevice(input.device);
      const result = target.peer
        ? await this.invokePeer(target.peer, "process_list", {})
        : await this.invokeLocal("process_list", {});
      if (result.isError) return result;
      const value = this.parseResultValue(result) as { processes?: ProcessSnapshot[] } | undefined;
      return textResult({ currentDevice: deviceView(this.identity), devices, processes: value?.processes ?? [] });
    }

    const local = this.manager.list().map((snapshot) => wrapSnapshot(snapshot, this.identity.nodeId));
    const remoteLists = await Promise.all([...this.peers.values()].map(async (peer) => {
      if (!peer.device?.online) return [] as ProcessSnapshot[];
      try {
        const result = await this.invokePeer(peer, "process_list", {});
        if (result.isError) return [] as ProcessSnapshot[];
        const value = this.parseResultValue(result) as { processes?: ProcessSnapshot[] } | undefined;
        return value?.processes ?? [];
      } catch { return [] as ProcessSnapshot[]; }
    }));

    return textResult({
      currentDevice: deviceView(this.identity),
      devices,
      processes: [...local, ...remoteLists.flat()]
    });
  }
}
