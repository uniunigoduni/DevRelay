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
