// A bounded recovery budget is shared by consecutive short-lived tunnel processes.
// A stable connection resets the budget so later, independent outages can recover.
export const TUNNEL_RECOVERY_WINDOW_MS = 180_000;
export const TUNNEL_STABLE_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export function tunnelRetryDelayMs(attempt) {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempt - 1), RETRY_DELAYS_MS.length - 1)];
}

export function isRestartableTunnel(connection) {
  return connection?.kind === "openai-secure-tunnel" || connection?.provider === "tailscale" ||
    (connection?.provider === "cloudflare" && connection?.variant === "named");
}

export function isPermanentTunnelError(error) {
  const message = String(error?.message ?? error ?? "");
  return /\b(not installed|not signed in|missing|incomplete|invalid credentials|invalid token|authentication failed|unauthorized|permission denied|access denied|invalid configuration|no such file|unsupported)\b/i.test(message);
}

export function newRecoveryState(previous, uptimeMs, now = Date.now()) {
  if (!previous || uptimeMs >= TUNNEL_STABLE_MS) return { startedAt: now, attempts: 0 };
  return previous;
}

// Returns a newly connected tunnel or throws after the budget is exhausted.
// start() must reject if tunnel readiness cannot be established and clean up failed children.
export async function recoverTunnel({ start, runtimeAlive, shouldStop, pause, report, previous = null,
  uptimeMs = 0, now = Date.now, windowMs = TUNNEL_RECOVERY_WINDOW_MS }) {
  const state = newRecoveryState(previous, uptimeMs, now());
  report("begin", { attempts: state.attempts, deadlineMs: windowMs });
  let lastError = null;
  while (!shouldStop() && runtimeAlive()) {
    const remaining = windowMs - (now() - state.startedAt);
    if (remaining <= 0) break;
    state.attempts += 1;
    const delayMs = Math.min(tunnelRetryDelayMs(state.attempts), remaining);
    report("retry", { attempt: state.attempts, delayMs });
    if (!(await pause(delayMs)) || shouldStop() || !runtimeAlive()) return null;
    try {
      const tunnel = await start(state.attempts);
      if (shouldStop() || !runtimeAlive()) return null;
      if (now() - state.startedAt > windowMs) throw new Error("Tunnel became ready after the recovery deadline.");
      report("success", { attempt: state.attempts });
      return { tunnel, state, connectedAt: now() };
    } catch (error) {
      lastError = error;
      report("failure", { attempt: state.attempts, error: String(error?.message ?? error) });
      if (isPermanentTunnelError(error)) throw error;
    }
  }
  if (shouldStop() || !runtimeAlive()) return null;
  report("timeout", { attempts: state.attempts, windowMs });
  throw new Error(`Tunnel recovery timed out after ${windowMs}ms (${state.attempts} attempts). Last error: ${lastError?.message ?? "tunnel exited"}`);
}
