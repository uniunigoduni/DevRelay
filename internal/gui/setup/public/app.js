const $ = (selector) => document.querySelector(selector);
const content = $("#content");
const breadcrumbs = $("#breadcrumbs");
const currentCard = $("#currentCard");
const notice = $("#notice");
const busyBadge = $("#busyBadge");
const busyPanel = $("#busyPanel");
const busyTitle = $("#busyTitle");
const busyDetail = $("#busyDetail");
const busyApprovalUrl = $("#busyApprovalUrl");
const openApprovalButton = $("#openApprovalButton");
const abortSetupButton = $("#abortSetupButton");
const backButton = $("#backButton");
const cancelButton = $("#cancelButton");

let state = null;
let page = "choose";
let history = [];
let requestBusy = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
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

function connectionChoice(connection) {
  if (!connection) return null;
  if (connection.kind === "openai-secure-tunnel") return "openai";
  if (connection.provider === "tailscale") return "tailscale";
  if (connection.provider === "cloudflare" && connection.variant === "named") return "cloudflare-named";
  if (connection.provider === "cloudflare" && connection.variant === "quick") return "cloudflare-quick";
  return null;
}

function connectionEndpoint(connection) {
  if (!connection) return "";
  if (connection.kind === "openai-secure-tunnel") return "";
  if (connection.provider === "cloudflare" && connection.variant === "quick") return "";
  return connection.publicUrl || "";
}

function setNotice(message = "", error = false) {
  notice.hidden = !message;
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function setPage(next, push = true) {
  if (requestBusy || state?.busy) return;
  if (push && next !== page) history.push(page);
  page = next;
  render();
}

function goBack() {
  if (requestBusy || state?.busy) return;
  const previous = history.pop();
  page = previous || "choose";
  render();
}

function renderCurrent() {
  if (!state?.current?.completed) {
    currentCard.hidden = true;
    currentCard.innerHTML = "";
    return;
  }
  const endpoint = connectionEndpoint(state.current.connection);
  currentCard.hidden = false;
  currentCard.innerHTML = `
    <div class="label">Current</div><strong>${escapeHtml(state.currentLabel)}</strong>
    ${endpoint ? `<div class="label">Endpoint</div><code>${escapeHtml(endpoint)}</code>` : ""}`;
}

function renderBreadcrumbs() {
  const labels = {
    choose: "Connection", https: "HTTPS", cloudflare: "Cloudflare",
    openai: "Secure Tunnel", tailscale: "Tailscale",
    "cloudflare-named": "Custom hostname", "cloudflare-quick": "Temporary URL", guide: "ChatGPT"
  };
  const trail = [];
  if (page === "choose") trail.push("choose");
  else if (["https", "tailscale", "cloudflare", "cloudflare-named", "cloudflare-quick"].includes(page)) {
    trail.push("choose", "https");
    if (page === "cloudflare" || page.startsWith("cloudflare-")) trail.push("cloudflare");
    if (!["https", "cloudflare"].includes(page)) trail.push(page);
  } else if (page === "openai") trail.push("choose", "openai");
  else if (page === "guide") trail.push("guide");

  const locked = requestBusy || state?.busy;
  breadcrumbs.innerHTML = trail.map((entry, index) => {
    const last = index === trail.length - 1;
    return `${index ? '<span class="sep">&gt;</span>' : ""}${last ? `<span>${escapeHtml(labels[entry])}</span>` : `<button type="button" data-page="${entry}" ${locked ? "disabled" : ""}>${escapeHtml(labels[entry])}</button>`}`;
  }).join("");
  breadcrumbs.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => {
    if (!requestBusy && !state?.busy) setPage(button.dataset.page);
  }));
}

function choiceCard({ id, title, badge, badgeClass = "", copy = "", selected = false }) {
  return `<button class="choice-card${selected ? " selected" : ""}" type="button" data-choice="${id}">
    <div class="choice-head"><span class="choice-title">${escapeHtml(title)}</span>${badge ? `<span class="badge ${badgeClass}">${escapeHtml(badge)}</span>` : ""}</div>
    ${copy ? `<p>${copy}</p>` : ""}
  </button>`;
}

function bindChoices(handler) {
  content.querySelectorAll("[data-choice]").forEach((button) => button.addEventListener("click", () => {
    if (!requestBusy && !state?.busy) handler(button.dataset.choice);
  }));
}

function renderChoose() {
  const selected = connectionChoice(state?.draft);
  content.innerHTML = `
    <h2 class="section-title">Connection</h2>
    <div class="choice-grid">
      ${choiceCard({ id: "openai", title: "OpenAI Secure Tunnel", badge: "RECOMMENDED / EXPERIMENTAL", badgeClass: "experimental", selected: selected === "openai", copy: "No third-party tunnel service is required. Known OpenAI issue #71 currently makes this option likely to fail on Windows / ChatGPT Plus." })}
      ${choiceCard({ id: "https", title: "HTTPS", selected: selected && selected !== "openai", copy: "Connect through a Tailscale or Cloudflare HTTPS tunnel." })}
    </div>
    <details class="advanced">
      <summary>Reset</summary>
      <div class="card">
        <p>Clear DevRelay connection settings on this PC.</p>
        <div class="actions"><button id="resetButton" class="button danger" type="button">Reset connection</button></div>
      </div>
    </details>`;
  bindChoices(async (choice) => {
    if (choice === "https") return setPage("https");
    await selectChoice("openai");
    setPage("openai");
  });
  $("#resetButton")?.addEventListener("click", async () => {
    if (requestBusy || state?.busy) return;
    if (!confirm("Reset DevRelay connection settings on this PC? External provider resources are not deleted.")) return;
    const result = await perform("/api/reset", { method: "POST", body: "{}" }, "Connection setup reset.");
    if (result) {
      if (result.state) state = result.state;
      history = [];
      page = "choose";
      render();
    }
  });
}

function renderHttps() {
  const selected = connectionChoice(state?.draft);
  content.innerHTML = `
    <h2 class="section-title">HTTPS provider</h2>
    <div class="choice-grid">
      ${choiceCard({ id: "tailscale", title: "Tailscale Funnel", badge: "RECOMMENDED", badgeClass: "recommended", selected: selected === "tailscale", copy: "No custom domain required. Uses a stable *.ts.net hostname." })}
      ${choiceCard({ id: "cloudflare", title: "Cloudflare", selected: selected?.startsWith("cloudflare"), copy: "Use your own Cloudflare-managed domain, or a temporary *.trycloudflare.com URL." })}
    </div>`;
  bindChoices(async (choice) => {
    if (choice === "tailscale") { await selectChoice("tailscale"); setPage("tailscale"); }
    else setPage("cloudflare");
  });
}

function renderCloudflare() {
  const selected = connectionChoice(state?.draft);
  content.innerHTML = `
    <h2 class="section-title">Cloudflare</h2>
    <div class="choice-grid">
      ${choiceCard({ id: "cloudflare-named", title: "Custom hostname", selected: selected === "cloudflare-named", copy: "Requires a domain managed by Cloudflare." })}
      ${choiceCard({ id: "cloudflare-quick", title: "Temporary URL", selected: selected === "cloudflare-quick", copy: "No account or domain. URL changes after restart." })}
    </div>`;
  bindChoices(async (choice) => { await selectChoice(choice); setPage(choice); });
}



function renderOpenAI() {
  const ready = state?.draftReady && connectionChoice(state?.draft) === "openai";
  content.innerHTML = `
    <h2 class="section-title">OpenAI Secure Tunnel</h2>
    <div class="card">
      <p><strong>Known issue #71</strong></p>
      <p>[Windows / Plus / v0.0.14] Tunnel connector creation fails in both No Auth and OAuth: server/discover 424 and DCR 404</p>
      <p>This issue currently makes OpenAI Secure Tunnel likely to fail on Windows / ChatGPT Plus.</p>
      <div class="actions"><button class="button secondary" type="button" data-link="openai-issue-71">Open issue #71</button></div>
    </div>
    <div class="card">
      <label class="field">Tunnel ID<input id="tunnelId" autocomplete="off" placeholder="tunnel_................................"></label>
      <div class="actions"><button class="button secondary" type="button" data-link="openai-tunnels">Open Tunnel settings</button></div>
      <label class="field">Runtime API key<input id="openaiApiKey" type="password" autocomplete="off" placeholder="Paste key"></label>
      <div class="actions">
        <button class="button secondary" type="button" data-link="openai-api-keys">Open API key settings</button>
        <button id="configureOpenAI" class="button primary" type="button">Prepare</button>
      </div>
      ${ready ? '<div class="check-row"><span class="mark">OK</span><span>Ready</span></div>' : ""}
    </div>`;
  bindLinks();
  $("#configureOpenAI").addEventListener("click", async () => {
    if (requestBusy || state?.busy) return;
    const tunnelId = $("#tunnelId").value.trim();
    const apiKey = $("#openaiApiKey").value;
    const result = await action("openai-configure", { tunnelId, apiKey });
    if (result) { $("#openaiApiKey").value = ""; setPage("guide"); }
  });
}

function providerLine(label, value) {
  return `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
}

function renderTailscale() {
  const ps = state?.providerStatus || {};
  const ready = state?.draftReady && connectionChoice(state?.draft) === "tailscale";
  content.innerHTML = `
    <h2 class="section-title">Tailscale Funnel</h2>
    <p class="section-copy">Install Tailscale, sign in in your browser, then prepare Funnel.</p>
    <div class="card">
      <div class="provider-status">
        ${providerLine("Client", ps.tailscaleInstalled ? "Installed" : "Not installed")}
        ${providerLine("Sign-in", ps.tailscaleLoggedIn ? "Signed in" : "Sign-in required")}
        ${providerLine("DNS name", ps.tailscaleDnsName || "-")}
      </div>
      <div class="actions">
        <button id="installTailscale" class="button secondary" type="button" ${ps.tailscaleInstalled ? "disabled" : ""}>Install Tailscale</button>
        <button id="loginTailscale" class="button secondary" type="button" ${!ps.tailscaleInstalled || ps.tailscaleLoggedIn ? "disabled" : ""}>Sign in</button>
        <button id="refreshTailscale" class="button secondary" type="button">Check status</button>
        <button id="prepareTailscale" class="button primary" type="button" ${!ps.tailscaleLoggedIn ? "disabled" : ""}>Prepare</button>
      </div>
      ${ready ? `<div class="check-row"><span class="mark">OK</span><span>${escapeHtml(connectionEndpoint(state.draft))}</span></div>` : ""}
    </div>`;
  $("#installTailscale")?.addEventListener("click", async () => { if (await action("install-tailscale")) await refresh(); });
  $("#loginTailscale")?.addEventListener("click", async () => { if (await action("tailscale-login")) await refresh(); });
  $("#refreshTailscale")?.addEventListener("click", async () => { if (await perform("/api/recheck", { method: "POST", body: "{}" })) render(); });
  $("#prepareTailscale")?.addEventListener("click", async () => { if (await action("tailscale-prepare")) setPage("guide"); });
}

function renderCloudflareNamed() {
  const ps = state?.providerStatus || {};
  const ready = state?.draftReady && connectionChoice(state?.draft) === "cloudflare-named";
  content.innerHTML = `
    <h2 class="section-title">Cloudflare custom hostname</h2>
    <p class="section-copy">Sign in to Cloudflare in your browser before using a custom hostname.</p>
    <div class="card">
      <div class="provider-status">
        ${providerLine("cloudflared", ps.cloudflaredInstalled ? "Installed" : "Not installed")}
        ${providerLine("Sign-in", ps.cloudflareLoggedIn ? "Signed in" : "Sign-in required")}
      </div>
      <div class="actions">
        <button id="prepareCloudflared" class="button secondary" type="button" ${ps.cloudflaredInstalled ? "disabled" : ""}>Install cloudflared</button>
        <button id="loginCloudflare" class="button secondary" type="button" ${!ps.cloudflaredInstalled || ps.cloudflareLoggedIn ? "disabled" : ""}>Sign in</button>
        <button id="refreshCloudflare" class="button secondary" type="button">Check status</button>
      </div>
      <label class="field">Hostname<input id="cfHostname" autocomplete="off" placeholder="devrelay.example.com"></label>
      <div class="actions"><button id="configureCloudflare" class="button primary" type="button" ${!ps.cloudflaredInstalled || !ps.cloudflareLoggedIn ? "disabled" : ""}>Use hostname</button></div>
      ${ready ? `<div class="check-row"><span class="mark">OK</span><span>${escapeHtml(connectionEndpoint(state.draft))}</span></div>` : ""}
    </div>`;
  $("#prepareCloudflared")?.addEventListener("click", async () => { if (await action("cloudflare-install")) await refresh(); });
  $("#loginCloudflare")?.addEventListener("click", async () => { if (await action("cloudflare-login")) await refresh(); });
  $("#refreshCloudflare")?.addEventListener("click", async () => { if (await perform("/api/recheck", { method: "POST", body: "{}" })) render(); });
  $("#configureCloudflare")?.addEventListener("click", async () => {
    if (requestBusy || state?.busy) return;
    const hostname = $("#cfHostname").value.trim();
    if (await action("cloudflare-named", { hostname })) setPage("guide");
  });
}

function renderCloudflareQuick() {
  const ps = state?.providerStatus || {};
  const ready = state?.draftReady && connectionChoice(state?.draft) === "cloudflare-quick";
  content.innerHTML = `
    <h2 class="section-title">Cloudflare temporary URL</h2>
    <div class="card">
      <div class="provider-status">${providerLine("cloudflared", ps.cloudflaredInstalled ? "Installed" : "Not installed")}</div>
      <div class="actions"><button id="prepareQuick" class="button primary" type="button">Use temporary address</button></div>
      ${ready ? '<div class="check-row"><span class="mark">OK</span><span>Endpoint appears after DevRelay starts.</span></div>' : ""}
    </div>`;
  $("#prepareQuick").addEventListener("click", async () => { if (await action("cloudflare-quick")) setPage("guide"); });
}

function guideSteps(connection) {
  const choice = connectionChoice(connection);
  if (choice === "openai") return `
    <div class="guide-step">In ChatGPT, open Apps / Plugins and choose Create (+).</div>
    <div class="guide-step">Choose Connection: Tunnel and select the prepared tunnel.</div>
    <div class="guide-step">Authentication: No authentication.</div>`;
  if (choice === "cloudflare-quick") return `
    <div class="guide-step">In ChatGPT, open Apps / Plugins and choose Create (+).</div>
    <div class="guide-step">Use the endpoint shown above.</div>
    <div class="guide-step">Authentication: OAuth.</div>
    <div class="guide-step">Approve the DevRelay access request in the main window if prompted.</div>`;
  return `
    <div class="guide-step">In ChatGPT, open Apps / Plugins and choose Create (+).</div>
    <div class="guide-step">Use the endpoint shown above.</div>
    <div class="guide-step">Authentication: OAuth.</div>
    <div class="guide-step">Approve the DevRelay access request in the main window if prompted.</div>`;
}

function renderGuide() {
  const connection = state?.draft;
  const runtimeEndpoint = state?.registrationRuntime?.publicUrl || "";
  const endpoint = /^https:\/\//i.test(runtimeEndpoint) ? runtimeEndpoint : connectionEndpoint(connection);
  content.innerHTML = `
    <h2 class="section-title">ChatGPT</h2>
    <p class="section-copy">The DevRelay main window is open and the server is running. Keep it open while adding DevRelay to ChatGPT.</p>
    ${endpoint ? `<div class="endpoint-box">${escapeHtml(endpoint)}</div>` : ""}
    <div class="actions"><button class="button secondary" type="button" data-link="chatgpt-settings">Open ChatGPT settings</button></div>
    <div class="guide">${guideSteps(connection)}</div>`;
  bindLinks();
}

function bindLinks() {
  content.querySelectorAll("[data-link]").forEach((button) => button.addEventListener("click", async () => {
    if (requestBusy || state?.busy) return;
    try { await api("/api/open-link", { method: "POST", body: JSON.stringify({ target: button.dataset.link }) }); }
    catch (error) { setNotice(error.message, true); }
  }));
}

async function selectChoice(choice) {
  if (requestBusy || state?.busy) return null;
  try {
    state = await api("/api/select", { method: "POST", body: JSON.stringify({ choice }) });
    setNotice();
    return state;
  } catch (error) { setNotice(error.message, true); return null; }
}

async function refreshOperationProgress() {
  if (!requestBusy) return;
  try {
    const progress = await api("/api/progress");
    if (!requestBusy) return;
    state = { ...(state || {}), busy: progress.busy, busyMessage: progress.busyMessage, busyNeedsUser: progress.busyNeedsUser, approvalUrl: progress.approvalUrl };
    renderChrome();
  } catch {}
}

async function perform(path, options, successMessage = "") {
  if (requestBusy) return null;
  requestBusy = true;
  renderChrome();
  setNotice();
  const progressTimer = setInterval(() => { void refreshOperationProgress(); }, 400);
  try {
    const result = await api(path, options);
    if (result.state) state = result.state;
    if (successMessage) setNotice(successMessage);
    return result;
  } catch (error) {
    setNotice(error.message, true);
    return null;
  } finally {
    clearInterval(progressTimer);
    requestBusy = false;
    await refresh(false);
  }
}

async function action(name, extra = {}) {
  return await perform("/api/action", { method: "POST", body: JSON.stringify({ action: name, ...extra }) });
}

function renderChrome() {
  renderCurrent();
  renderBreadcrumbs();
  const locked = requestBusy || state?.busy;
  busyBadge.hidden = !locked;
  busyBadge.textContent = state?.busyNeedsUser ? "Action required" : "Working...";
  busyPanel.hidden = !locked;
  if (locked) {
    busyTitle.textContent = state?.busyNeedsUser ? "Action required" : "Working";
    busyDetail.textContent = state?.busyMessage || "Working...";
    const approval = state?.approvalUrl || "";
    busyApprovalUrl.hidden = !approval;
    busyApprovalUrl.textContent = approval;
    openApprovalButton.hidden = !approval;
    abortSetupButton.disabled = false;
  }
  backButton.hidden = page === "choose" || page === "guide";
  cancelButton.textContent = page === "guide" ? "Close" : "Cancel";
  cancelButton.disabled = locked;
  backButton.disabled = locked;
  content.inert = Boolean(locked);
  content.setAttribute("aria-busy", String(Boolean(locked)));
}

function render() {
  renderChrome();
  if (state?.error) setNotice(state.error, true);
  if (page === "choose") renderChoose();
  else if (page === "https") renderHttps();
  else if (page === "cloudflare") renderCloudflare();
  else if (page === "openai") renderOpenAI();
  else if (page === "tailscale") renderTailscale();
  else if (page === "cloudflare-named") renderCloudflareNamed();
  else if (page === "cloudflare-quick") renderCloudflareQuick();
  else if (page === "guide") renderGuide();
  else { page = "choose"; renderChoose(); }
}

async function refresh(repaint = true) {
  try {
    state = await api("/api/state");
    if (repaint) render(); else renderChrome();
  } catch (error) { setNotice(error.message, true); }
}

openApprovalButton.addEventListener("click", async () => {
  openApprovalButton.disabled = true;
  try { await api("/api/open-approval", { method: "POST", body: "{}" }); }
  catch (error) { setNotice(error.message, true); }
  finally { openApprovalButton.disabled = false; }
});
abortSetupButton.addEventListener("click", async () => {
  abortSetupButton.disabled = true;
  try { await api("/api/abort", { method: "POST", body: "{}" }); }
  catch (error) { setNotice(error.message, true); abortSetupButton.disabled = false; }
});

backButton.addEventListener("click", goBack);
cancelButton.addEventListener("click", async () => {
  cancelButton.disabled = true;
  try { await api("/api/cancel", { method: "POST", body: "{}" }); } catch {}
});
window.addEventListener("pagehide", () => { navigator.sendBeacon("/api/window-close", ""); });

void refresh();
