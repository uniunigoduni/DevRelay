export function extractTailscaleApprovalUrl(text) {
  const matches = String(text ?? "").match(/https:\/\/login\.tailscale\.com\/[^\s<>"']+/gi) || [];
  for (const candidate of matches) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ""));
      if (url.protocol === "https:" && url.hostname === "login.tailscale.com") return url.href;
    } catch {}
  }
  return null;
}

export function tailscaleApprovalMessage(url) {
  return url
    ? "Waiting for Tailscale approval in your browser..."
    : "Enabling and validating Tailscale Funnel...";
}

export function extractCloudflareApprovalUrl(text) {
  const matches = String(text ?? "").match(/https:\/\/dash\.cloudflare\.com\/argotunnel[^\s<>"']*/gi) || [];
  for (const candidate of matches) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ""));
      if (url.protocol === "https:" && url.hostname === "dash.cloudflare.com" && url.pathname.startsWith("/argotunnel")) return url.href;
    } catch {}
  }
  return null;
}

export function isTrustedSetupApprovalUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:") return false;
    if (url.hostname === "login.tailscale.com") return true;
    return url.hostname === "dash.cloudflare.com" && url.pathname.startsWith("/argotunnel");
  } catch { return false; }
}
