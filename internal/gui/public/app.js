const $ = (selector) => document.querySelector(selector);
const aiLog = $("#aiLog");
const pluginLog = $("#pluginLog");
const deviceNameInput = $("#deviceNameInput");
const deviceAliasesInput = $("#deviceAliasesInput");
const deviceDefaultName = $("#deviceDefaultName");
const deviceNodeId = $("#deviceNodeId");
const clusterEnabledInput = $("#clusterEnabledInput");
const clusterPortInput = $("#clusterPortInput");
const clusterPeersInput = $("#clusterPeersInput");
const clusterKeyInput = $("#clusterKeyInput");
const copyClusterKey = $("#copyClusterKey");
const themeSelect = $("#themeSelect");
const modeSelect = $("#modeSelect");
const portInput = $("#portInput");
const autoStartInput = $("#autoStartInput");
const saveSettings = $("#saveSettings");
const settingsMessage = $("#settingsMessage");
const publicUrl = $("#publicUrl");
const settingsBackdrop = $("#settingsBackdrop");
const oauthApproval = $("#oauthApproval");
const oauthClientName = $("#oauthClientName");
const oauthRedirectHost = $("#oauthRedirectHost");
const oauthScopes = $("#oauthScopes");
const oauthDeviceName = $("#oauthDeviceName");
const approveOAuth = $("#approveOAuth");
const denyOAuth = $("#denyOAuth");

let lastOAuthPendingId = null;
let lastState = null;
let lastAiCount = -1;
let lastPluginCount = -1;
let requestBusy = false;
let settingsDirty = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function timeLabel(iso) {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date(iso));
  } catch { return "--:--:--"; }
}
function nearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 40;
}

function renderLog(element, entries, emptyText) {
  const keepBottom = nearBottom(element);
  if (!entries.length) {
    element.innerHTML = `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
    return;
  }
  element.innerHTML = entries.map((entry) => {
    const level = entry.level === "error" ? " error" : entry.level === "warn" ? " warn" : "";
    return `<div class="log-line${level}"><span class="log-time">${timeLabel(entry.at)}</span>${escapeHtml(entry.text)}</div>`;
  }).join("");
  if (keepBottom) element.scrollTop = element.scrollHeight;
}

function setSettingsOpen(open) {
  settingsBackdrop.classList.toggle("open", open);
  settingsBackdrop.setAttribute("aria-hidden", String(!open));
}

window.DevRelayUi = {
  toggleSettings() { setSettingsOpen(!settingsBackdrop.classList.contains("open")); }
};

settingsBackdrop.addEventListener("click", (event) => {
  if (event.target === settingsBackdrop) setSettingsOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSettingsOpen(false);
});
function render(state) {
  lastState = state;
  const active = state.running || state.starting;
  const transition = state.starting || state.stopping;

  document.documentElement.dataset.theme = settingsDirty ? themeSelect.value : (state.theme === "black-soft" ? "black-soft" : "white-soft");
  publicUrl.textContent = state.publicUrl || "-";
  if (!settingsDirty) {
    deviceNameInput.value = state.device?.name || "";
    deviceAliasesInput.value = (state.device?.aliases || []).join(", ");
    deviceDefaultName.textContent = state.device?.defaultName || "Initializing...";
    deviceNodeId.textContent = state.device?.nodeId || "Initializing...";
    clusterEnabledInput.checked = state.cluster?.enabled !== false;
    clusterPortInput.value = state.cluster?.listenPort ?? 7319;
    clusterPeersInput.value = (state.cluster?.peers || []).join("\n");
    clusterKeyInput.value = state.cluster?.key || "";
    themeSelect.value = state.theme === "black-soft" ? "black-soft" : "white-soft";
    modeSelect.value = state.mode;
    portInput.value = state.port;
    autoStartInput.checked = state.autoStart;
  }

  const deviceLocked = active || transition || !state.device;
  deviceNameInput.disabled = deviceLocked || requestBusy;
  deviceAliasesInput.disabled = deviceLocked || requestBusy;
  clusterEnabledInput.disabled = active || transition || requestBusy;
  clusterPortInput.disabled = active || transition || requestBusy;
  clusterPeersInput.disabled = active || transition || requestBusy;
  clusterKeyInput.disabled = active || transition || requestBusy;
  copyClusterKey.disabled = !lastState?.cluster?.key || requestBusy;
  themeSelect.disabled = requestBusy;
  modeSelect.disabled = active || transition;
  portInput.disabled = active || transition;
  autoStartInput.disabled = active || transition;
  saveSettings.disabled = requestBusy;

  const pendingOAuth = state.oauthPending?.[0] ?? null;
  oauthApproval.hidden = !pendingOAuth;
  if (pendingOAuth) {
    oauthClientName.textContent = pendingOAuth.clientName || "OAuth client";
    oauthRedirectHost.textContent = pendingOAuth.redirectHost || "unknown";
    oauthScopes.textContent = (pendingOAuth.scopes || []).join(" ");
    oauthDeviceName.textContent = pendingOAuth.device?.name || state.device?.name || "local";
    approveOAuth.disabled = requestBusy;
    denyOAuth.disabled = requestBusy;
    if (pendingOAuth.id !== lastOAuthPendingId) setSettingsOpen(true);
    lastOAuthPendingId = pendingOAuth.id;
  } else {
    lastOAuthPendingId = null;
  }

  if (state.aiLogs.length !== lastAiCount) {
    renderLog(aiLog, state.aiLogs, "No commands yet.");
    lastAiCount = state.aiLogs.length;
  }
  if (state.pluginLogs.length !== lastPluginCount) {
    renderLog(pluginLog, state.pluginLogs, "Waiting for server output.");
    lastPluginCount = state.pluginLogs.length;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
async function refresh() {
  try { render(await api("/api/state")); } catch {}
}

async function decideOAuth(approve) {
  const pending = lastState?.oauthPending?.[0];
  if (!pending || requestBusy) return;
  requestBusy = true;
  approveOAuth.disabled = true; denyOAuth.disabled = true;
  try {
    await api("/api/oauth/decision", { method: "POST", body: JSON.stringify({ id: pending.id, approve }) });
  } catch (error) {
    settingsMessage.textContent = error.message; settingsMessage.classList.add("error");
  } finally { requestBusy = false; await refresh(); }
}
approveOAuth.addEventListener("click", () => { void decideOAuth(true); });
denyOAuth.addEventListener("click", () => { void decideOAuth(false); });
copyClusterKey.addEventListener("click", async () => {
  const key = lastState?.cluster?.key || clusterKeyInput.value.trim();
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    settingsMessage.classList.remove("error");
    settingsMessage.textContent = "Cluster key copied";
  } catch {
    settingsMessage.textContent = "Could not copy cluster key";
    settingsMessage.classList.add("error");
  }
});

themeSelect.addEventListener("change", () => {
  settingsDirty = true;
  document.documentElement.dataset.theme = themeSelect.value;
});
[deviceNameInput, deviceAliasesInput, clusterEnabledInput, clusterPortInput, clusterPeersInput, clusterKeyInput, modeSelect, portInput, autoStartInput].forEach((element) => {
  element.addEventListener("change", () => { settingsDirty = true; });
});

saveSettings.addEventListener("click", async () => {
  if (requestBusy) return;
  requestBusy = true;
  settingsMessage.classList.remove("error");
  settingsMessage.textContent = "Saving...";
  try {
    const value = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        deviceName: deviceNameInput.value.trim(),
        deviceAliases: deviceAliasesInput.value.split(",").map((value) => value.trim()).filter(Boolean),
        clusterEnabled: clusterEnabledInput.checked,
        clusterPort: Number(clusterPortInput.value),
        clusterPeers: clusterPeersInput.value.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
        clusterKey: clusterKeyInput.value.trim(),
        theme: themeSelect.value,
        mode: modeSelect.value,
        port: Number(portInput.value),
        autoStart: autoStartInput.checked
      })
    });
    settingsDirty = false;
    render(value);
    settingsMessage.textContent = "Saved";
  } catch (error) {
    settingsMessage.textContent = error.message;
    settingsMessage.classList.add("error");
  } finally {
    requestBusy = false;
    await refresh();
  }
});

setInterval(() => { void refresh(); }, 500);
setInterval(() => {
  void fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {});
}, 550);

window.addEventListener("pagehide", () => {
  navigator.sendBeacon("/api/window-close", "");
});

void refresh();

(() => {
  const selector = ".log-view, .settings-panel";
  const controllers = new Map();
  const edgeInset = 3;
  const minimumThumbLength = 28;
  let layer = null;
  let frame = 0;

  function createThumb(axis, scroller) {
    const thumb = document.createElement("div");
    thumb.className = `vault-scroll-thumb ${axis}`;
    thumb.dataset.scrollAxis = axis;
    thumb.setAttribute("aria-hidden", "true");
    thumb.addEventListener("pointerdown", (event) => startDrag(event, scroller, thumb, axis));
    layer.appendChild(thumb);
    return thumb;
  }

  function attach(scroller) {
    if (controllers.has(scroller)) return;
    const controller = {
      vertical: createThumb("vertical", scroller),
      horizontal: createThumb("horizontal", scroller),
      resizeObserver: new ResizeObserver(scheduleUpdate)
    };
    controllers.set(scroller, controller);
    scroller.classList.add("vault-scrollable");
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    controller.resizeObserver.observe(scroller);
  }
  function detach(scroller, controller) {
    controller.resizeObserver.disconnect();
    controller.vertical.remove();
    controller.horizontal.remove();
    controllers.delete(scroller);
  }

  function scan(root = document) {
    if (root instanceof Element && root.matches(selector)) attach(root);
    root.querySelectorAll?.(selector).forEach(attach);
    for (const [scroller, controller] of controllers) {
      if (!scroller.isConnected) detach(scroller, controller);
    }
    scheduleUpdate();
  }

  function thumbMetrics(viewportLength, contentLength, scrollPosition) {
    const trackLength = Math.max(0, viewportLength - edgeInset * 2);
    if (contentLength <= viewportLength + 1 || trackLength <= 0) return null;
    const thumbLength = Math.min(trackLength,
      Math.max(minimumThumbLength, trackLength * viewportLength / contentLength));
    const travel = Math.max(0, trackLength - thumbLength);
    const maximumScroll = Math.max(1, contentLength - viewportLength);
    return {
      length: thumbLength,
      offset: edgeInset + travel * Math.max(0, Math.min(1, scrollPosition / maximumScroll)),
      travel,
      maximumScroll
    };
  }
  function updateThumbs(scroller, controller) {
    const rect = scroller.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
    if (!visible) {
      controller.vertical.classList.remove("visible");
      controller.horizontal.classList.remove("visible");
      return;
    }

    const vertical = thumbMetrics(scroller.clientHeight, scroller.scrollHeight, scroller.scrollTop);
    if (vertical) {
      controller.vertical.style.left = `${rect.right - 11}px`;
      controller.vertical.style.top = `${rect.top + vertical.offset}px`;
      controller.vertical.style.height = `${vertical.length}px`;
      controller.vertical.classList.add("visible");
    } else {
      controller.vertical.classList.remove("visible");
    }

    const horizontal = thumbMetrics(scroller.clientWidth, scroller.scrollWidth, scroller.scrollLeft);
    if (horizontal) {
      controller.horizontal.style.left = `${rect.left + horizontal.offset}px`;
      controller.horizontal.style.top = `${rect.bottom - 11}px`;
      controller.horizontal.style.width = `${horizontal.length}px`;
      controller.horizontal.classList.add("visible");
    } else {
      controller.horizontal.classList.remove("visible");
    }
  }
  function updateAll() {
    frame = 0;
    for (const [scroller, controller] of controllers) updateThumbs(scroller, controller);
  }

  function scheduleUpdate() {
    if (frame) return;
    frame = requestAnimationFrame(updateAll);
  }

  function startDrag(event, scroller, thumb, axis) {
    if (event.button !== 0 || !thumb.classList.contains("visible")) return;
    event.preventDefault();
    event.stopPropagation();
    const vertical = axis === "vertical";
    const viewportLength = vertical ? scroller.clientHeight : scroller.clientWidth;
    const contentLength = vertical ? scroller.scrollHeight : scroller.scrollWidth;
    const scrollPosition = vertical ? scroller.scrollTop : scroller.scrollLeft;
    const metrics = thumbMetrics(viewportLength, contentLength, scrollPosition);
    if (!metrics || metrics.travel <= 0) return;
    const startPointer = vertical ? event.clientY : event.clientX;
    const startScroll = scrollPosition;
    thumb.setPointerCapture(event.pointerId);
    thumb.classList.add("dragging");
    document.body.classList.add("dragging-scroll-thumb");

    const move = (moveEvent) => {
      const pointer = vertical ? moveEvent.clientY : moveEvent.clientX;
      const next = startScroll + (pointer - startPointer) * metrics.maximumScroll / metrics.travel;
      if (vertical) scroller.scrollTop = next;
      else scroller.scrollLeft = next;
      scheduleUpdate();
    };
    const stop = (stopEvent) => {
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", stop);
      thumb.removeEventListener("pointercancel", stop);
      if (thumb.hasPointerCapture(stopEvent.pointerId)) thumb.releasePointerCapture(stopEvent.pointerId);
      thumb.classList.remove("dragging");
      document.body.classList.remove("dragging-scroll-thumb");
      scheduleUpdate();
    };

    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", stop);
    thumb.addEventListener("pointercancel", stop);
  }

  function start() {
    if (layer) return;
    layer = document.createElement("div");
    layer.className = "vault-scroll-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
    scan();

    const mutations = new MutationObserver(() => scheduleUpdate());
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    document.addEventListener("scroll", scheduleUpdate, { passive: true, capture: true });
  }

  start();
})();
