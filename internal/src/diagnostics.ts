import type { ServerResponse } from "node:http";

export type DiagnosticCategory = "transport" | "auth" | "mcp" | "tool" | "process" | "internal";

export interface McpRequestSummary {
  method: string;
  toolName?: string;
}

interface RequestState extends McpRequestSummary {
  startedAt: number;
  httpMethod: string;
  era?: "legacy" | "modern";
  toolsListCounted?: boolean;
  toolsCallCounted?: boolean;
  errorCategory?: DiagnosticCategory;
  errorCounted?: boolean;
}

interface WindowCounters {
  requests: number;
  toolsList: number;
  toolsCall: number;
  errors: number;
  infrastructureErrors: number;
}

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const SECRET_PATTERN = /(authorization|access_token|refresh_token|client_secret|code)=([^&\s]+)/gi;

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(SECRET_PATTERN, "$1=[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 600);
}

function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  const trimmed = resolved?.trim();
  return trimmed || undefined;
}

export function inspectMcpHeaders(methodValue: string | string[] | undefined, nameValue: string | string[] | undefined): McpRequestSummary {
  const method = firstHeader(methodValue);
  if (!method) return { method: "unknown" };
  const toolName = method === "tools/call" ? firstHeader(nameValue) : undefined;
  return toolName ? { method, toolName } : { method };
}

function extractRpc(value: unknown, depth = 0): McpRequestSummary | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractRpc(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.method === "string") {
    const summary: McpRequestSummary = { method: record.method };
    if (record.method === "tools/call" && record.params && typeof record.params === "object" && !Array.isArray(record.params)) {
      const name = (record.params as Record<string, unknown>).name;
      if (typeof name === "string" && name) summary.toolName = name;
    }
    return summary;
  }
  for (const key of ["request", "message", "body", "payload"]) {
    if (key in record) {
      const found = extractRpc(record[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function inspectMcpPayload(value: unknown): McpRequestSummary {
  return extractRpc(value) ?? { method: "unknown" };
}

export async function inspectMcpRequest(request: Request | undefined): Promise<McpRequestSummary> {
  if (!request || request.method === "GET" || request.method === "DELETE") return { method: request?.method ?? "unknown" };
  try {
    return inspectMcpPayload(await request.clone().json());
  } catch {
    return { method: "unknown" };
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function compactTime(value: number | null): string {
  return value === null ? "-" : new Date(value).toISOString();
}

export class McpDiagnostics {
  private readonly startedAt: number;
  private readonly requests = new Map<string, RequestState>();
  private counters: WindowCounters = { requests: 0, toolsList: 0, toolsCall: 0, errors: 0, infrastructureErrors: 0 };
  private lastRequestAt: number | null = null;
  private lastToolsListAt: number | null = null;
  private lastToolsCallAt: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly version: string,
    private readonly activeProcessCount: () => number,
    private readonly output: (line: string) => void = (line) => console.error(line),
    private readonly now: () => number = () => Date.now()
  ) {
    this.startedAt = this.now();
  }

  startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), intervalMs);
    this.heartbeatTimer.unref();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  beginRequest(requestId: string, httpMethod = "UNKNOWN", summary: McpRequestSummary = { method: "unknown" }): void {
    const now = this.now();
    const state: RequestState = { method: "unknown", httpMethod, startedAt: now };
    this.requests.set(requestId, state);
    this.applySummary(state, summary);
    this.counters.requests += 1;
    this.lastRequestAt = now;
    this.output(`[MCP] request id=${requestId} http=${httpMethod} method=${state.method}${state.toolName ? ` tool=${state.toolName}` : ""}`);
  }

  identifyRequest(requestId: string, summary: McpRequestSummary): void {
    const state = this.requests.get(requestId);
    if (!state) return;
    this.applySummary(state, summary);
  }

  routeRequest(requestId: string, era: "legacy" | "modern"): void {
    const state = this.requests.get(requestId);
    if (state) state.era = era;
    this.output(`[MCP] route id=${requestId} era=${era}`);
  }

  enterTool(requestId: string, tool: string): void {
    const state = this.requests.get(requestId);
    if (state) this.applySummary(state, { method: "tools/call", toolName: tool });
    this.output(`[MCP] tool-enter id=${requestId} tool=${tool}`);
  }

  markErrorCategory(requestId: string, category: DiagnosticCategory): void {
    const state = this.requests.get(requestId);
    if (state) state.errorCategory = category;
  }

  finishRequest(requestId: string, response: ServerResponse): void {
    const state = this.requests.get(requestId);
    const elapsed = state ? this.now() - state.startedAt : 0;
    const method = state?.method ?? "unknown";
    const tool = state?.toolName ? ` tool=${state.toolName}` : "";
    const era = state?.era ? ` era=${state.era}` : "";
    const expectedStatelessMethodRejection = response.statusCode === 405 && method === "unknown" &&
      (state?.httpMethod === "GET" || state?.httpMethod === "DELETE");
    if (response.statusCode >= 400 && !expectedStatelessMethodRejection) {
      const category = state?.errorCategory ?? (response.statusCode >= 500 ? "internal" : "mcp");
      if (!state?.errorCounted) this.countError(category);
      this.output(`[ERROR][${category}] response id=${requestId} status=${response.statusCode} durationMs=${elapsed} method=${method}${tool}${era}`);
    } else {
      const expected = expectedStatelessMethodRejection ? " expected=true" : "";
      const resolvedMethod = expectedStatelessMethodRejection ? `HTTP_${state?.httpMethod}` : method;
      this.output(`[MCP] response id=${requestId} status=${response.statusCode} durationMs=${elapsed} method=${resolvedMethod}${tool}${era}${expected}`);
    }
    this.requests.delete(requestId);
  }

  abortRequest(requestId: string, error: unknown): void {
    const state = this.requests.get(requestId);
    if (state?.method === "subscriptions/listen") {
      this.output(`[MCP] stream-closed id=${requestId} method=subscriptions/listen${state.era ? ` era=${state.era}` : ""} expected=true`);
      this.requests.delete(requestId);
      return;
    }
    this.reportError("transport", error, { requestId });
    this.requests.delete(requestId);
  }

  reportError(category: DiagnosticCategory, error: unknown, context: { requestId?: string; tool?: string } = {}): void {
    this.countError(category);
    if (context.requestId) {
      const state = this.requests.get(context.requestId);
      if (state) { state.errorCategory = category; state.errorCounted = true; }
    }
    const request = context.requestId ? ` request=${context.requestId}` : "";
    const tool = context.tool ? ` tool=${context.tool}` : "";
    this.output(`[ERROR][${category}]${request}${tool} message=${JSON.stringify(errorMessage(error))}`);
  }

  emitHeartbeat(): string {
    let activeProcesses = 0;
    try { activeProcesses = this.activeProcessCount(); }
    catch (error) { this.reportError("internal", error); }
    const now = this.now();
    const status = this.counters.infrastructureErrors > 0 ? "degraded" : "healthy";
    const line = `[Heartbeat] status=${status} version=${this.version} uptime=${formatDuration(now - this.startedAt)}` +
      ` requests_30m=${this.counters.requests} tools_list_30m=${this.counters.toolsList} tools_call_30m=${this.counters.toolsCall}` +
      ` errors_30m=${this.counters.errors} active_processes=${activeProcesses}` +
      ` last_request=${compactTime(this.lastRequestAt)} last_tools_list=${compactTime(this.lastToolsListAt)} last_tools_call=${compactTime(this.lastToolsCallAt)}`;
    this.output(line);
    this.counters = { requests: 0, toolsList: 0, toolsCall: 0, errors: 0, infrastructureErrors: 0 };
    return line;
  }

  private applySummary(state: RequestState, summary: McpRequestSummary): void {
    if (summary.method !== "unknown") state.method = summary.method;
    if (summary.toolName) state.toolName = summary.toolName;
    const now = this.now();
    if (state.method === "tools/list" && !state.toolsListCounted) {
      state.toolsListCounted = true;
      this.counters.toolsList += 1;
      this.lastToolsListAt = now;
    } else if (state.method === "tools/call" && !state.toolsCallCounted) {
      state.toolsCallCounted = true;
      this.counters.toolsCall += 1;
      this.lastToolsCallAt = now;
    }
  }

  private countError(category: DiagnosticCategory): void {
    this.counters.errors += 1;
    if (category === "transport" || category === "mcp" || category === "internal") {
      this.counters.infrastructureErrors += 1;
    }
  }
}
