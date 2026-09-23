export const GUI_HEARTBEAT_STARTUP_GRACE_MS = 8_000;
export const GUI_HEARTBEAT_WARN_AFTER_MS = 5_000;
export const GUI_HEARTBEAT_SHUTDOWN_AFTER_MS = 20_000;

export function classifyGuiHeartbeat({
  now = Date.now(),
  windowLaunchedAt,
  lastHeartbeatAt,
  startupGraceMs = GUI_HEARTBEAT_STARTUP_GRACE_MS,
  warnAfterMs = GUI_HEARTBEAT_WARN_AFTER_MS,
  shutdownAfterMs = GUI_HEARTBEAT_SHUTDOWN_AFTER_MS
}) {
  if (!windowLaunchedAt) return { status: "healthy", ageMs: 0 };

  const sinceLaunch = Math.max(0, now - windowLaunchedAt);
  const reference = lastHeartbeatAt > 0 ? lastHeartbeatAt : windowLaunchedAt;
  const ageMs = Math.max(0, now - reference);

  if (!lastHeartbeatAt && sinceLaunch <= startupGraceMs) {
    return { status: "healthy", ageMs };
  }
  if (ageMs > shutdownAfterMs) return { status: "lost", ageMs };
  if (ageMs > warnAfterMs) return { status: "stale", ageMs };
  return { status: "healthy", ageMs };
}
