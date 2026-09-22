const $ = (selector) => document.querySelector(selector);
const content = $("#content");
const breadcrumbs = $("#breadcrumbs");
const currentCard = $("#currentCard");
const notice = $("#notice");
const busyBadge = $("#busyBadge");
const backButton = $("#backButton");
const cancelButton = $("#cancelButton");
const finishButton = $("#finishButton");

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

function connectionLabel(connection) {
  const choice = connectionChoice(connection);
  return ({
    openai: "OpenAI Secure Tunnel",
    tailscale: "HTTPS / Tailscale Funnel",
    "cloudflare-named": "HTTPS / Cloudflare Named Tunnel",
    "cloudflare-quick": "HTTPS / Cloudflare Quick Tunnel"
  })[choice] || "Not configured";
}

function connectionEndpoint(connection) {
  if (!connection) return "-";
  if (connection.kind === "openai-secure-tunnel") return "OpenAI Secure MCP Tunnel";
  if (connection.provider === "cloudflare" && connection.variant === "quick") return "Temporary URL generated at each start";
  return connection.publicUrl || "Not prepared";
}

function setNotice(message = "", error = false) {
  notice.hidden = !message;
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function setPage(next, push = true) {
  if (push && next !== page) history.push(page);
  page = next;
  render();
}

function goBack() {
  const previous = history.pop();
  page = previous || "choose";
  render();
}

function renderCurrent() {
  if (!state?.current?.completed) {
    currentCard.hidden = true;
    return;
  }
  currentCard.hidden = false;
  currentCard.innerHTML = `
    <div class="label">Current</div><strong>${escapeHtml(state.currentLabel)}</strong>
    <div class="label">Endpoint</div><code>${escapeHtml(state.currentEndpoint)}</code>`;
}

function renderBreadcrumbs() {
  const labels = {
    choose: "Connection", https: "HTTPS", cloudflare: "Cloudflare",
    openai: "Secure Tunnel", tailscale: "Tailscale",
    "cloudflare-named": "Named Tunnel", "cloudflare-quick": "Quick Tunnel", guide: "ChatGPT"
  };
  const trail = [];
  if (page === "choose") trail.push("choose");
  else if (["https", "tailscale", "cloudflare", "cloudflare-named", "cloudflare-quick"].includes(page)) {
    trail.push("choose", "https");
    if (page === "cloudflare" || page.startsWith("cloudflare-")) trail.push("cloudflare");
    if (!["https", "cloudflare"].includes(page)) trail.push(page);
  } else if (page === "openai") trail.push("choose", "openai");
  else if (page === "guide") trail.push("choose", "guide");

  breadcrumbs.innerHTML = trail.map((entry, index) => {
    const last = index === trail.length - 1;
    return `${index ? '<span class="sep">&gt;</span>' : ""}${last ? `<span>${escapeHtml(labels[entry])}</span>` : `<button type="button" data-page="${entry}">${escapeHtml(labels[entry])}</button>`}`;
  }).join("");
  breadcrumbs.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
}

function choiceCard({ id, title, badge, badgeClass = "", copy, selected = false }) {
  return `<button class="choice-card${selected ? " selected" : ""}" type="button" data-choice="${id}">
    <div class="choice-head"><span class="choice-title">${escapeHtml(title)}</span>${badge ? `<span class="badge ${badgeClass}">${escapeHtml(badge)}</span>` : ""}</div>
    <p>${copy}</p>
  </button>`;
}

function bindChoices(handler) {
  content.querySelectorAll("[data-choice]").forEach((button) => button.addEventListener("click", () => handler(button.dataset.choice)));
}

function renderChoose() {
  const selected = connectionChoice(state?.draft);
  content.innerHTML = `
    <h2 class="section-title">Choose a connection</h2>
    <p class="section-copy">The connection controls how ChatGPT reaches DevRelay. Existing settings are not replaced until setup finishes.</p>
    <div class="choice-grid">
      ${choiceCard({ id: "openai", title: "OpenAI Secure Tunnel", badge: "RECOMMENDED / EXPERIMENTAL", badgeClass: "experimental", selected: selected === "openai", copy: "Private outbound tunnel with no public hostname. Architecturally preferred, but current ChatGPT integration has known upstream issues listed before setup." })}
      ${choiceCard({ id: "https", title: "HTTPS", badge: "COMPATIBILITY", selected: selected && selected !== "openai", copy: "Expose DevRelay through HTTPS and use DevRelay OAuth. Tailscale Funnel is the recommended HTTPS provider; Cloudflare is also supported." })}
    </div>
    <details class="advanced">
      <summary>Advanced</summary>
      <div class="card">
        <h3>Reset local connection setup</h3>
        <p>Removes DevRelay's saved tunnel configuration and credentials. It does not uninstall Tailscale or delete Cloudflare/Tailscale remote resources.</p>
        <div class="actions"><button id="resetButton" class="button danger" type="button">Reset DevRelay connection</button></div>
      </div>
    </details>`;
  bindChoices(async (choice) => {
    if (choice === "https") return setPage("https");
    await selectChoice("openai");
    setPage("openai");
  });
  $("#resetButton")?.addEventListener("click", async () => {
    if (!confirm("Reset DevRelay's local connection setup? External provider resources will not be deleted.")) return;
    const result = await perform("/api/reset", { method: "POST", body: "{}" }, "Connection setup reset.");
    if (result) { history = []; page = "choose"; await refresh(); }
  });
}

function renderHttps() {
  const selected = connectionChoice(state?.draft);
  content.innerHTML = `
    <h2 class="section-title">Choose an HTTPS provider</h2>
    <p class="section-copy">HTTPS connections use DevRelay's OAuth flow when you register the endpoint in ChatGPT.</p>
    <div class="choice-grid">
      ${choiceCard({ id: "tailscale", title: "Tailscale Funnel", badge: "RECOMMENDED", badgeClass: "recommended", selected: selected === "tailscale", copy: "Stable <code>*.ts.net</code> HTTPS address without a custom domain. Requires a Tailscale account/client. Funnel is currently a Tailscale beta feature." })}
      ${choiceCard({ id: "cloudflare", title: "Cloudflare", badge: "NAMED OR QUICK", selected: selected?.startsWith("cloudflare"), copy: "Named Tunnel gives a stable address but requires a domain managed by Cloudflare. Quick Tunnel needs no account or domain but its URL changes after restart." })}
    </div>`;
  bindChoices(async (choice) => {
    if (choice === "tailscale") { await selectChoice("tailscale"); setPage("tailscale"); }
    else setPage("cloudflare");
  });
}

function renderCloudflare() {
  const selected = connectionChoice(state?.draft);
  content.innerHTML = `
    <h2 class="section-title">Choose a Cloudflare tunnel</h2>
    <p class="section-copy">Both options use the official <code>cloudflared</code> CLI. DevRelay can download it automatically.</p>
    <div class="choice-grid">
      ${choiceCard({ id: "cloudflare-named", title: "Named Tunnel", badge: "STABLE", selected: selected === "cloudflare-named", copy: "Persistent hostname. Requires a Cloudflare account and a domain already managed by Cloudflare. Browser login happens once; tunnel and DNS setup are CLI-driven." })}
      ${choiceCard({ id: "cloudflare-quick", title: "Quick Tunnel", badge: "TEMPORARY", selected: selected === "cloudflare-quick", copy: "No account and no domain required. The random trycloudflare.com URL changes whenever the tunnel is recreated, so the ChatGPT registration may need updating." })}
    </div>`;
  bindChoices(async (choice) => { await selectChoice(choice); setPage(choice); });
}

function renderIssues() {
  return `<div class="issue-list">${(state?.issues || []).map((issue) => `
    <div class="issue">
      <button type="button" class="issue-number issue-link" data-link="issue-${issue.number}">#${issue.number}</button>
      <div class="issue-title">${escapeHtml(issue.title)}</div>
      <span class="issue-state ${escapeHtml(issue.state)}">${escapeHtml(issue.state)}</span>
    </div>`).join("")}</div>`;
}

function renderOpenAI() {
  const ready = state?.draftReady && connectionChoice(state?.draft) === "openai";
  content.innerHTML = `
    <h2 class="section-title">OpenAI Secure Tunnel</h2>
    <p class="section-copy">Preferred architecture: no public hostname and the tunnel connects outbound to OpenAI. This path is marked Experimental while the upstream issues below remain relevant.</p>
    <div class="card">
      <h3>Known upstream issues</h3>
      <p>Issue numbers and titles are embedded so you can recognize fixes later. OPEN/CLOSED status is refreshed from GitHub when available and does not block setup.</p>
      ${renderIssues()}
    </div>
    <div class="card">
      <h3>1. Create or choose an OpenAI tunnel</h3>
      <p>The tunnel must be available to the ChatGPT workspace you will use.</p>
      <div class="actions"><button class="button secondary" type="button" data-link="openai-tunnels">Open Tunnel settings</button></div>
      <label class="field">Tunnel ID<input id="tunnelId" autocomplete="off" placeholder="tunnel_................................"></label>
    </div>
    <div class="card">
      <h3>2. Create a runtime API key</h3>
      <p>Use a key with Tunnels Read + Use permission. DevRelay stores it using Windows DPAPI for the current user.</p>
      <div class="actions"><button class="button secondary" type="button" data-link="openai-api-keys">Open API key settings</button></div>
      <label class="field">Runtime API key<input id="openaiApiKey" type="password" autocomplete="off" placeholder="Paste key"></label>
      <div class="actions"><button id="configureOpenAI" class="button primary" type="button">Prepare Secure Tunnel</button></div>
      ${ready ? '<div class="check-row"><span class="mark">OK</span><span>Secure Tunnel profile has been prepared locally.</span></div>' : ""}
    </div>`;
  bindLinks();
  $("#configureOpenAI").addEventListener("click", async () => {
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
    <p class="section-copy">Recommended HTTPS path. It provides a stable <code>*.ts.net</code> address without requiring your own domain.</p>
    <div class="card">
      <h3>Requirements</h3>
      <ul class="constraints"><li>Tailscale account and Windows client</li><li>MagicDNS / HTTPS and Funnel permitted for the tailnet</li><li>Funnel is currently a Tailscale beta feature</li></ul>
      <div class="provider-status">
        ${providerLine("Client", ps.tailscaleInstalled ? "Installed" : "Not installed")}
        ${providerLine("Sign-in", ps.tailscaleLoggedIn ? "Signed in" : "Not signed in")}
        ${providerLine("DNS name", ps.tailscaleDnsName || "-")}
      </div>
    </div>
    <div class="card">
      <h3>Setup</h3>
      <p>DevRelay downloads the official signed Windows installer only when requested. Installation may show UAC. Sign-in uses Tailscale's normal browser flow.</p>
      <div class="actions">
        <button id="installTailscale" class="button secondary" type="button" ${ps.tailscaleInstalled ? "disabled" : ""}>Install Tailscale</button>
        <button id="loginTailscale" class="button secondary" type="button" ${!ps.tailscaleInstalled ? "disabled" : ""}>Sign in to Tailscale</button>
        <button id="prepareTailscale" class="button primary" type="button" ${!ps.tailscaleLoggedIn ? "disabled" : ""}>Prepare and validate Funnel</button>
      </div>
      ${ready ? `<div class="check-row"><span class="mark">OK</span><span>Prepared endpoint: ${escapeHtml(connectionEndpoint(state.draft))}</span></div>` : ""}
    </div>`;
  $("#installTailscale")?.addEventListener("click", async () => { if (await action("install-tailscale")) await refresh(); });
  $("#loginTailscale")?.addEventListener("click", async () => { if (await action("tailscale-login")) await refresh(); });
  $("#prepareTailscale")?.addEventListener("click", async () => { if (await action("tailscale-prepare")) setPage("guide"); });
}

function renderCloudflareNamed() {
  const ps = state?.providerStatus || {};
  const ready = state?.draftReady && connectionChoice(state?.draft) === "cloudflare-named";
  content.innerHTML = `
    <h2 class="section-title">Cloudflare Named Tunnel</h2>
    <p class="section-copy">Stable HTTPS endpoint for users who already have a domain managed by Cloudflare.</p>
    <div class="card">
      <h3>Constraints</h3>
      <ul class="constraints"><li>Cloudflare account required</li><li>The hostname's domain must already be managed by Cloudflare</li><li>Browser sign-in and zone authorization is required once</li></ul>
      <div class="provider-status">${providerLine("cloudflared", ps.cloudflaredInstalled ? "Ready" : "Not prepared")}</div>
    </div>
    <div class="card">
      <h3>Setup</h3>
      <div class="actions">
        <button id="prepareCloudflared" class="button secondary" type="button">Prepare cloudflared</button>
        <button id="loginCloudflare" class="button secondary" type="button">Sign in to Cloudflare</button>
      </div>
      <label class="field">Public hostname<input id="cfHostname" autocomplete="off" placeholder="devrelay.example.com"></label>
      <label class="field">Tunnel name<input id="cfTunnelName" autocomplete="off" value="devrelay"></label>
      <div class="actions"><button id="configureCloudflare" class="button primary" type="button">Create tunnel and DNS route</button></div>
      ${ready ? `<div class="check-row"><span class="mark">OK</span><span>Prepared endpoint: ${escapeHtml(connectionEndpoint(state.draft))}</span></div>` : ""}
    </div>`;
  $("#prepareCloudflared").addEventListener("click", async () => { if (await action("cloudflare-install")) await refresh(); });
  $("#loginCloudflare").addEventListener("click", async () => { if (await action("cloudflare-login")) await refresh(); });
  $("#configureCloudflare").addEventListener("click", async () => {
    const hostname = $("#cfHostname").value.trim();
    const tunnelName = $("#cfTunnelName").value.trim();
    if (await action("cloudflare-named", { hostname, tunnelName })) setPage("guide");
  });
}

function renderCloudflareQuick() {
  const ps = state?.providerStatus || {};
  const ready = state?.draftReady && connectionChoice(state?.draft) === "cloudflare-quick";
  content.innerHTML = `
    <h2 class="section-title">Cloudflare Quick Tunnel</h2>
    <p class="section-copy">Lowest-friction temporary HTTPS option. It requires no account and no domain.</p>
    <div class="card">
      <h3>Important limitations</h3>
      <ul class="constraints"><li>The random <code>trycloudflare.com</code> URL changes after tunnel restart</li><li>ChatGPT registration may need to be updated after each new URL</li><li>Cloudflare positions Quick Tunnels for development/testing, not persistent production use</li></ul>
      <div class="provider-status">${providerLine("cloudflared", ps.cloudflaredInstalled ? "Ready" : "Not prepared")}</div>
      <div class="actions"><button id="prepareQuick" class="button primary" type="button">Prepare Quick Tunnel</button></div>
      ${ready ? '<div class="check-row"><span class="mark">OK</span><span>Ready. A temporary endpoint will be generated when DevRelay starts.</span></div>' : ""}
    </div>`;
  $("#prepareQuick").addEventListener("click", async () => { if (await action("cloudflare-quick")) setPage("guide"); });
}

function guideSteps(connection) {
  const choice = connectionChoice(connection);
  if (choice === "openai") return `
    <div class="guide-step">Enable <strong>Developer Mode</strong> in ChatGPT.</div>
    <div class="guide-step">Open <strong>Apps / Plugins</strong> and choose <strong>Create (+)</strong>.</div>
    <div class="guide-step">Choose <strong>Connection: Tunnel</strong>, then select the tunnel you created.</div>
    <div class="guide-step">Choose <strong>Authentication: No authentication</strong>.</div>
    <div class="guide-step">Create / Scan Tools. If registration fails while the local tunnel is healthy, check upstream issues <strong>#71, #57, #41</strong>.</div>`;
  return `
    <div class="guide-step">Enable <strong>Developer Mode</strong> in ChatGPT.</div>
    <div class="guide-step">Open <strong>Apps / Plugins</strong> and choose <strong>Create (+)</strong>.</div>
    <div class="guide-step">Enter the DevRelay MCP endpoint shown below.</div>
    <div class="guide-step">Choose <strong>Authentication: OAuth</strong>, then Create / Scan Tools.</div>
    <div class="guide-step">ChatGPT will start OAuth authorization. Approve the access request in the normal DevRelay window.</div>`;
}

function renderGuide() {
  const connection = state?.draft;
  content.innerHTML = `
    <h2 class="section-title">Connect DevRelay to ChatGPT</h2>
    <p class="section-copy">Local setup is ${state?.draftReady ? "prepared" : "not yet prepared"}. Follow the registration steps for ${escapeHtml(connectionLabel(connection))}.</p>
    <div class="card">
      <h3>${escapeHtml(connectionLabel(connection))}</h3>
      <div class="endpoint-box">${escapeHtml(connectionEndpoint(connection))}</div>
      <div class="actions"><button class="button secondary" type="button" data-link="chatgpt-settings">Open ChatGPT settings</button></div>
    </div>
    <div class="guide">${guideSteps(connection)}</div>
    ${connectionChoice(connection) === "openai" ? `<div class="card"><h3>Secure Tunnel warning</h3><p>The local tunnel can validate successfully while ChatGPT-side connector creation or refresh still fails. Keep the issue numbers below for later verification.</p>${renderIssues()}</div>` : ""}`;
  bindLinks();
}

function bindLinks() {
  content.querySelectorAll("[data-link]").forEach((button) => button.addEventListener("click", async () => {
    try { await api("/api/open-link", { method: "POST", body: JSON.stringify({ target: button.dataset.link }) }); }
    catch (error) { setNotice(error.message, true); }
  }));
}

async function selectChoice(choice) {
  try {
    state = await api("/api/select", { method: "POST", body: JSON.stringify({ choice }) });
    setNotice();
  } catch (error) { setNotice(error.message, true); }
}

async function perform(path, options, successMessage = "") {
  if (requestBusy) return null;
  requestBusy = true;
  renderChrome();
  setNotice();
  try {
    const result = await api(path, options);
    if (result.state) state = result.state;
    if (successMessage) setNotice(successMessage);
    return result;
  } catch (error) {
    setNotice(error.message, true);
    return null;
  } finally {
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
  busyBadge.hidden = !(requestBusy || state?.busy);
  busyBadge.textContent = state?.busyMessage || "Working...";
  backButton.hidden = page === "choose";
  finishButton.hidden = !(page === "guide" && state?.draftReady);
  finishButton.disabled = requestBusy || state?.busy;
  cancelButton.disabled = requestBusy || state?.busy;
  backButton.disabled = requestBusy || state?.busy;
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

backButton.addEventListener("click", goBack);
cancelButton.addEventListener("click", async () => {
  cancelButton.disabled = true;
  try { await api("/api/cancel", { method: "POST", body: "{}" }); } catch {}
});
finishButton.addEventListener("click", async () => {
  const result = await perform("/api/finish", { method: "POST", body: "{}" });
  if (result) finishButton.textContent = "Saved";
});
window.addEventListener("pagehide", () => { navigator.sendBeacon("/api/window-close", ""); });

void refresh();
