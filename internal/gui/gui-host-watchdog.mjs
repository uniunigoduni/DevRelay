export const GUI_HOST_HEARTBEAT_INTERVAL_MS = 120_000;
export const GUI_HOST_HEARTBEAT_STARTUP_GRACE_MS = 150_000;
export const GUI_HOST_HEARTBEAT_WARN_AFTER_MS = 150_000;
export const GUI_HOST_HEARTBEAT_LOST_AFTER_MS = 300_000;

export function classifyGuiHostHeartbeat({
  now = Date.now(),
  windowLaunchedAt,
  lastHeartbeatAt,
  startupGraceMs = GUI_HOST_HEARTBEAT_STARTUP_GRACE_MS,
  warnAfterMs = GUI_HOST_HEARTBEAT_WARN_AFTER_MS,
  lostAfterMs = GUI_HOST_HEARTBEAT_LOST_AFTER_MS
}) {
  if (!windowLaunchedAt) return { status: "healthy", ageMs: 0 };

  const sinceLaunch = Math.max(0, now - windowLaunchedAt);
  const reference = lastHeartbeatAt > 0 ? lastHeartbeatAt : windowLaunchedAt;
  const ageMs = Math.max(0, now - reference);

  if (!lastHeartbeatAt && sinceLaunch <= startupGraceMs) {
    return { status: "healthy", ageMs };
  }
  if (ageMs > lostAfterMs) return { status: "lost", ageMs };
  if (ageMs > warnAfterMs) return { status: "stale", ageMs };
  return { status: "healthy", ageMs };
}

export function isGuiHostRecoverySignal({
  previousStatus = "healthy",
  gapMs = 0,
  warnAfterMs = GUI_HOST_HEARTBEAT_WARN_AFTER_MS
}) {
  return previousStatus !== "healthy" || gapMs > warnAfterMs;
}

export function shouldResumeRuntimeAfterGuiRecovery({
  desiredRunning,
  running,
  starting,
  stopping,
  shuttingDown,
  windowReady,
  windowHostPresent
}) {
  return Boolean(
    desiredRunning && windowReady && windowHostPresent && !shuttingDown &&
    !running && !starting && !stopping
  );
}
