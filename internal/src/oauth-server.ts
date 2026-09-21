import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const ACCESS_TOKEN_SECONDS = 15 * 60;
const AUTH_CODE_SECONDS = 5 * 60;
const PENDING_SECONDS = 10 * 60;
const REFRESH_TOKEN_SECONDS = 90 * 24 * 60 * 60;
const REQUIRED_SCOPE = "devrelay";
const OFFLINE_SCOPE = "offline_access";
const SUPPORTED_SCOPES = new Set([REQUIRED_SCOPE, OFFLINE_SCOPE]);

interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  clientUri?: string;
  createdAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
}
interface RefreshTokenRecord {
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

type PendingStatus = "pending" | "approved" | "denied";

interface PendingAuthorization {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  redirectHost: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state?: string;
  createdAt: number;
  expiresAt: number;
  status: PendingStatus;
  redirect?: string;
}

export interface PendingAuthorizationView {
  id: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
  createdAt: string;
}
export interface OAuthServerOptions {
  issuer: string;
  resource: string;
  stateDir: string;
  controlSecret: string;
  nodeId?: string;
  signingKey?: Uint8Array;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache"
  });
  response.end(body);
}

function oauthError(response: ServerResponse, status: number, error: string, description: string): void {
  json(response, status, { error, error_description: description });
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]!);
}
async function readBody(request: IncomingMessage, limit = 65_536): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw new Error("Request body too large.");
  }
  return body;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (!body) return {};
  const value = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
  return value as Record<string, unknown>;
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request));
}

function redirectUriAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com") ||
      host === "openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

function parseScope(value: string | null | undefined): string {
  const requested = (value?.trim() || `${REQUIRED_SCOPE} ${OFFLINE_SCOPE}`).split(/\s+/).filter(Boolean);
  if (!requested.includes(REQUIRED_SCOPE)) requested.unshift(REQUIRED_SCOPE);
  if (requested.some((scope) => !SUPPORTED_SCOPES.has(scope))) throw new Error("Unsupported OAuth scope.");
  return [...new Set(requested)].join(" ");
}
export class DevRelayOAuthServer {
  readonly issuer: string;
  readonly resource: string;
  readonly metadataUrl: string;
  private readonly controlSecret: string;
  private readonly nodeId: string;
  private readonly providedSigningKey?: Uint8Array;
  private readonly oauthDir: string;
  private readonly clientsPath: string;
  private readonly refreshPath: string;
  private readonly signingKeyPath: string;
  private signingKey: Uint8Array = new Uint8Array();
  private clients = new Map<string, OAuthClient>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly pending = new Map<string, PendingAuthorization>();

  private constructor(options: OAuthServerOptions) {
    this.issuer = options.issuer.replace(/\/$/, "");
    this.resource = options.resource;
    this.controlSecret = options.controlSecret;
    this.nodeId = options.nodeId ?? "local";
    this.providedSigningKey = options.signingKey;
    this.oauthDir = path.join(options.stateDir, "oauth");
    this.clientsPath = path.join(this.oauthDir, "clients.json");
    this.refreshPath = path.join(this.oauthDir, "refresh-tokens.json");
    this.signingKeyPath = path.join(this.oauthDir, "signing-key.txt");
    this.metadataUrl = `${this.issuer}/.well-known/oauth-protected-resource`;
  }

  static async create(options: OAuthServerOptions): Promise<DevRelayOAuthServer> {
    const server = new DevRelayOAuthServer(options);
    await server.initialize();
    return server;
  }
  private async initialize(): Promise<void> {
    await mkdir(this.oauthDir, { recursive: true });
    this.signingKey = await this.loadOrCreateSigningKey();
    this.clients = new Map((await this.readJsonArray<OAuthClient>(this.clientsPath)).map((client) => [client.clientId, client]));
    this.refreshTokens = new Map(Object.entries(await this.readJsonObject<RefreshTokenRecord>(this.refreshPath)));
    await this.pruneRefreshTokens();
  }

  private async loadOrCreateSigningKey(): Promise<Buffer> {
    if (this.providedSigningKey?.length) return Buffer.from(this.providedSigningKey);
    try {
      const existing = (await readFile(this.signingKeyPath, "utf8")).trim();
      if (existing) return Buffer.from(existing, "base64url");
    } catch {}
    const key = randomBytes(32);
    await writeFile(this.signingKeyPath, `${key.toString("base64url")}\n`, { encoding: "utf8", mode: 0o600 });
    return key;
  }

  private async readJsonArray<T>(filePath: string): Promise<T[]> {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      return Array.isArray(value) ? value as T[] : [];
    } catch { return []; }
  }

  private async readJsonObject<T>(filePath: string): Promise<Record<string, T>> {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, T> : {};
    } catch { return {}; }
  }
  private async saveClients(): Promise<void> {
    await writeFile(this.clientsPath, `${JSON.stringify([...this.clients.values()], null, 2)}\n`, "utf8");
  }

  private async saveRefreshTokens(): Promise<void> {
    await writeFile(this.refreshPath, `${JSON.stringify(Object.fromEntries(this.refreshTokens), null, 2)}\n`, "utf8");
  }

  private cleanupEphemeral(): void {
    const now = Date.now();
    for (const [code, record] of this.codes) if (record.expiresAt <= now) this.codes.delete(code);
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now || (request.status !== "pending" && request.createdAt + PENDING_SECONDS * 1000 <= now)) {
        this.pending.delete(id);
      }
    }
  }

  private async pruneRefreshTokens(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [hash, record] of this.refreshTokens) {
      if (record.expiresAt <= now) {
        this.refreshTokens.delete(hash);
        changed = true;
      }
    }
    if (changed) await this.saveRefreshTokens();
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [REQUIRED_SCOPE, OFFLINE_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "DevRelay"
    };
  }
  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      scopes_supported: [REQUIRED_SCOPE, OFFLINE_SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: false,
      authorization_response_iss_parameter_supported: false
    };
  }

  private bearerChallenge(error = "invalid_token", description = "A valid DevRelay OAuth token is required."): string {
    const escaped = description.replace(/["\\]/g, " ");
    return `Bearer resource_metadata="${this.metadataUrl}", scope="${REQUIRED_SCOPE}", error="${error}", error_description="${escaped}"`;
  }

  rejectUnauthorized(response: ServerResponse, description?: string): void {
    response.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": this.bearerChallenge("invalid_token", description)
    });
    response.end(JSON.stringify({ error: "invalid_token", error_description: description ?? "Authentication required." }));
  }
  private signAccessToken(clientId: string, scope: string): { token: string; expiresIn: number } {
    const issuedAt = nowSeconds();
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      iss: this.issuer,
      aud: this.resource,
      sub: "owner",
      client_id: clientId,
      scope,
      iat: issuedAt,
      nbf: issuedAt - 5,
      exp: issuedAt + ACCESS_TOKEN_SECONDS,
      jti: randomToken("jti_", 16)
    }));
    const signature = createHmac("sha256", this.signingKey).update(`${header}.${payload}`).digest("base64url");
    return { token: `${header}.${payload}.${signature}`, expiresIn: ACCESS_TOKEN_SECONDS };
  }

  verifyAccessToken(token: string): { clientId: string; scope: string } | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const expected = createHmac("sha256", this.signingKey).update(`${headerPart}.${payloadPart}`).digest("base64url");
      if (!safeEqualText(signaturePart, expected)) return null;
      const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      if (header.alg !== "HS256" || payload.iss !== this.issuer || payload.aud !== this.resource) return null;
      const now = nowSeconds();
      if (!Number.isFinite(payload.exp) || payload.exp <= now || (payload.nbf && payload.nbf > now + 5)) return null;
      if (typeof payload.scope !== "string" || !payload.scope.split(/\s+/).includes(REQUIRED_SCOPE)) return null;
      if (typeof payload.client_id !== "string" || !payload.client_id) return null;
      return { clientId: payload.client_id, scope: payload.scope };
    } catch { return null; }
  }
  private async issueTokens(clientId: string, resource: string, scope: string): Promise<Record<string, unknown>> {
    const access = this.signAccessToken(clientId, scope);
    const refreshToken = randomToken("drr_", 32);
    this.refreshTokens.set(tokenHash(refreshToken), {
      clientId,
      resource,
      scope,
      expiresAt: Date.now() + REFRESH_TOKEN_SECONDS * 1000
    });
    await this.saveRefreshTokens();
    return {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: refreshToken,
      scope
    };
  }

  private clientFromRequest(clientId: string | null): OAuthClient | null {
    if (!clientId) return null;
    return this.clients.get(clientId) ?? null;
  }

  verifyControlRequest(request: IncomingMessage): boolean {
    const provided = request.headers["x-devrelay-control-secret"];
    return typeof provided === "string" && safeEqualText(provided, this.controlSecret);
  }

  listPending(): PendingAuthorizationView[] {
    this.cleanupEphemeral();
    return [...this.pending.values()]
      .filter((request) => request.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((request) => ({
        id: request.id,
        clientName: request.clientName,
        redirectHost: request.redirectHost,
        scopes: request.scope.split(/\s+/),
        createdAt: new Date(request.createdAt).toISOString()
      }));
  }
  async handleRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      json(response, 200, this.protectedResourceMetadata());
      return true;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, this.authorizationServerMetadata());
      return true;
    }
    if (request.method === "POST" && url.pathname === "/oauth/register") {
      await this.handleRegistration(request, response);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      this.handleAuthorize(response, url);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/oauth/authorize/status") {
      this.handleAuthorizeStatus(response, url);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      await this.handleToken(request, response);
      return true;
    }
    if (url.pathname.startsWith("/oauth/internal/")) {
      await this.handleInternal(request, response, url);
      return true;
    }
    return false;
  }
  private async handleRegistration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody(request);
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((value): value is string => typeof value === "string") : [];
      if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some((uri) => !redirectUriAllowed(uri))) {
        oauthError(response, 400, "invalid_redirect_uri", "DevRelay accepts only HTTPS ChatGPT/OpenAI redirect URIs.");
        return;
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
        oauthError(response, 400, "invalid_client_metadata", "Only public clients with token_endpoint_auth_method=none are supported.");
        return;
      }
      const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
      const responseTypes = Array.isArray(body.response_types) ? body.response_types : ["code"];
      if (!grantTypes.includes("authorization_code") || !responseTypes.includes("code")) {
        oauthError(response, 400, "invalid_client_metadata", "authorization_code and response_type code are required.");
        return;
      }
      const clientId = `drc.${this.nodeId}.${randomBytes(24).toString("base64url")}`;
      const client: OAuthClient = {
        clientId,
        redirectUris,
        clientName: typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : "ChatGPT",
        clientUri: typeof body.client_uri === "string" ? body.client_uri : undefined,
        createdAt: nowSeconds()
      };
      this.clients.set(clientId, client);
      await this.saveClients();
      json(response, 201, {
        client_id: clientId,
        client_id_issued_at: client.createdAt,
        redirect_uris: redirectUris,
        client_name: client.clientName,
        client_uri: client.clientUri,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: `${REQUIRED_SCOPE} ${OFFLINE_SCOPE}`
      });
    } catch (error) {
      oauthError(response, 400, "invalid_client_metadata", error instanceof Error ? error.message : "Invalid registration request.");
    }
  }

  private authorizationError(response: ServerResponse, client: OAuthClient | null, redirectUri: string | null, state: string | null, error: string, description: string): void {
    if (client && redirectUri && client.redirectUris.includes(redirectUri)) {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      if (state) target.searchParams.set("state", state);
      response.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
      response.end();
      return;
    }
    oauthError(response, 400, error, description);
  }
  private handleAuthorize(response: ServerResponse, url: URL): void {
    this.cleanupEphemeral();
    const clientId = url.searchParams.get("client_id");
    const client = this.clientFromRequest(clientId);
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!client) return this.authorizationError(response, null, null, state, "unauthorized_client", "Unknown OAuth client.");
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return this.authorizationError(response, client, null, state, "invalid_request", "redirect_uri is not registered.");
    }
    if (url.searchParams.get("response_type") !== "code") {
      return this.authorizationError(response, client, redirectUri, state, "unsupported_response_type", "Only response_type=code is supported.");
    }
    const resource = url.searchParams.get("resource");
    if (resource !== this.resource) {
      return this.authorizationError(response, client, redirectUri, state, "invalid_target", "The resource parameter must identify this DevRelay MCP server.");
    }
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return this.authorizationError(response, client, redirectUri, state, "invalid_request", "PKCE S256 is required.");
    }
    let scope: string;
    try { scope = parseScope(url.searchParams.get("scope")); }
    catch (error) {
      return this.authorizationError(response, client, redirectUri, state, "invalid_scope", error instanceof Error ? error.message : "Invalid scope.");
    }
    const id = `par.${this.nodeId}.${randomBytes(24).toString("base64url")}`;
    const createdAt = Date.now();
    const pending: PendingAuthorization = {
      id,
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      redirectHost: new URL(redirectUri).hostname,
      codeChallenge: challenge,
      resource,
      scope,
      state: state ?? undefined,
      createdAt,
      expiresAt: createdAt + PENDING_SECONDS * 1000,
      status: "pending"
    };
    this.pending.set(id, pending);
    html(response, 200, this.authorizationPage(pending));
  }

  private authorizationPage(request: PendingAuthorization): string {
    const client = escapeHtml(request.clientName);
    const host = escapeHtml(request.redirectHost);
    const requestId = JSON.stringify(request.id);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevRelay authorization</title><style>
:root{font-family:"Noto Sans Mono",ui-monospace,monospace;color:#2b2b2b;background:#fff}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(560px,100%);border:1px solid #d4d4d4;border-radius:12px;padding:28px}
h1{font-size:18px;margin:0 0 18px}p{font-size:13px;line-height:1.7;margin:10px 0}.muted{color:#707070}.client{padding:12px;border:1px solid #d4d4d4;border-radius:10px;margin:16px 0}code{overflow-wrap:anywhere}
</style></head><body><main class="card"><h1>DevRelay OAuth</h1><p><strong>${client}</strong> is requesting access to DevRelay.</p>
<div class="client"><div>Redirect: <code>${host}</code></div><div>Scope: <code>${escapeHtml(request.scope)}</code></div></div>
<p>Approve or deny this request in the visible DevRelay window on this computer.</p><p id="status" class="muted">Waiting for local approval...</p>
<script>const id=${requestId};const s=document.getElementById('status');async function poll(){try{const r=await fetch('/oauth/authorize/status?id='+encodeURIComponent(id),{cache:'no-store'});const v=await r.json();if(v.redirect){location.replace(v.redirect);return;}if(v.status==='expired'){s.textContent='This request expired. Start the connection again.';return;}}catch{}setTimeout(poll,800)}poll();</script>
</main></body></html>`;
  }
  private handleAuthorizeStatus(response: ServerResponse, url: URL): void {
    this.cleanupEphemeral();
    const id = url.searchParams.get("id") ?? "";
    const request = this.pending.get(id);
    if (!request) {
      json(response, 200, { status: "expired" });
      return;
    }
    json(response, 200, { status: request.status, redirect: request.redirect });
  }

  private async handleInternal(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!this.verifyControlRequest(request)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden\n");
      return;
    }
    if (request.method === "GET" && url.pathname === "/oauth/internal/pending") {
      json(response, 200, { pending: this.listPending() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/oauth/internal/decision") {
      try {
        const body = await readJsonBody(request);
        const id = typeof body.id === "string" ? body.id : "";
        const approve = body.approve === true;
        const result = this.decidePending(id, approve);
        json(response, result ? 200 : 404, result ? { ok: true } : { error: "pending_request_not_found" });
      } catch (error) {
        oauthError(response, 400, "invalid_request", error instanceof Error ? error.message : "Invalid request.");
      }
      return;
    }
    response.writeHead(404).end();
  }
  decidePending(id: string, approve: boolean): boolean {
    this.cleanupEphemeral();
    const request = this.pending.get(id);
    if (!request || request.status !== "pending") return false;
    const target = new URL(request.redirectUri);
    if (approve) {
      const code = randomToken("dac_", 32);
      this.codes.set(code, {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        scope: request.scope,
        expiresAt: Date.now() + AUTH_CODE_SECONDS * 1000
      });
      target.searchParams.set("code", code);
      request.status = "approved";
    } else {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "The DevRelay owner denied this request.");
      request.status = "denied";
    }
    if (request.state) target.searchParams.set("state", request.state);
    request.redirect = target.toString();
    return true;
  }

  private async handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const form = await readFormBody(request);
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") return void await this.exchangeAuthorizationCode(form, response);
      if (grantType === "refresh_token") return void await this.exchangeRefreshToken(form, response);
      oauthError(response, 400, "unsupported_grant_type", "Supported grant types are authorization_code and refresh_token.");
    } catch (error) {
      oauthError(response, 400, "invalid_request", error instanceof Error ? error.message : "Invalid token request.");
    }
  }
  private async exchangeAuthorizationCode(form: URLSearchParams, response: ServerResponse): Promise<void> {
    this.cleanupEphemeral();
    const clientId = form.get("client_id") ?? "";
    const code = form.get("code") ?? "";
    const record = this.codes.get(code);
    if (!record) return oauthError(response, 400, "invalid_grant", "Authorization code is invalid or expired.");
    this.codes.delete(code);
    if (!this.clients.has(clientId) || record.clientId !== clientId) {
      return oauthError(response, 400, "invalid_grant", "Authorization code was not issued to this client.");
    }
    if (form.get("redirect_uri") !== record.redirectUri) {
      return oauthError(response, 400, "invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (form.get("resource") !== record.resource || record.resource !== this.resource) {
      return oauthError(response, 400, "invalid_target", "resource does not match the protected resource.");
    }
    const verifier = form.get("code_verifier") ?? "";
    if (verifier.length < 43 || verifier.length > 128 || !safeEqualText(sha256(verifier), record.codeChallenge)) {
      return oauthError(response, 400, "invalid_grant", "PKCE code_verifier is invalid.");
    }
    json(response, 200, await this.issueTokens(clientId, record.resource, record.scope));
  }

  private async exchangeRefreshToken(form: URLSearchParams, response: ServerResponse): Promise<void> {
    await this.pruneRefreshTokens();
    const clientId = form.get("client_id") ?? "";
    const supplied = form.get("refresh_token") ?? "";
    const hash = tokenHash(supplied);
    const record = this.refreshTokens.get(hash);
    if (!record || !this.clients.has(clientId) || record.clientId !== clientId) {
      return oauthError(response, 400, "invalid_grant", "Refresh token is invalid or expired.");
    }
    const resource = form.get("resource") ?? record.resource;
    if (resource !== record.resource || resource !== this.resource) {
      return oauthError(response, 400, "invalid_target", "resource does not match the protected resource.");
    }
    let scope = record.scope;
    const requestedScope = form.get("scope");
    if (requestedScope) {
      try { scope = parseScope(requestedScope); }
      catch (error) {
        return oauthError(response, 400, "invalid_scope", error instanceof Error ? error.message : "Invalid scope.");
      }
      const original = new Set(record.scope.split(/\s+/));
      if (scope.split(/\s+/).some((value) => !original.has(value))) {
        return oauthError(response, 400, "invalid_scope", "Refresh cannot expand the originally granted scope.");
      }
    }
    this.refreshTokens.delete(hash);
    await this.saveRefreshTokens();
    json(response, 200, await this.issueTokens(clientId, resource, scope));
  }

  authorizeMcp(request: IncomingMessage, response: ServerResponse): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      this.rejectUnauthorized(response, "No bearer token was provided.");
      return false;
    }
    const token = header.slice("Bearer ".length).trim();
    if (!this.verifyAccessToken(token)) {
      this.rejectUnauthorized(response, "The bearer token is invalid or expired.");
      return false;
    }
    return true;
  }
}
