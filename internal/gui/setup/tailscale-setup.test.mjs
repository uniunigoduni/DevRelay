import assert from "node:assert/strict";
import test from "node:test";
import { extractCloudflareApprovalUrl, extractTailscaleApprovalUrl, isTrustedSetupApprovalUrl, tailscaleApprovalMessage } from "./tailscale-setup.mjs";

test("extractTailscaleApprovalUrl accepts only the Tailscale login origin", () => {
  const text = [
    "Enable Funnel in your tailnet:",
    "https://login.tailscale.com/f/funnel?node=node123&foo=bar",
    "https://example.com/not-trusted"
  ].join("\n");
  assert.equal(
    extractTailscaleApprovalUrl(text),
    "https://login.tailscale.com/f/funnel?node=node123&foo=bar"
  );
});

test("extractTailscaleApprovalUrl ignores unrelated URLs", () => {
  assert.equal(extractTailscaleApprovalUrl("See https://tailscale.com/kb/1223/funnel"), null);
  assert.equal(tailscaleApprovalMessage(null), "Enabling and validating Tailscale Funnel...");
  assert.match(tailscaleApprovalMessage("https://login.tailscale.com/f/funnel"), /Waiting for Tailscale approval/);
});


test("Cloudflare approval URLs are recognized without trusting unrelated hosts", () => {
  const url = "https://dash.cloudflare.com/argotunnel?callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc";
  assert.equal(extractCloudflareApprovalUrl(`Open ${url} to continue`), url);
  assert.equal(isTrustedSetupApprovalUrl(url), true);
  assert.equal(isTrustedSetupApprovalUrl("https://example.com/argotunnel"), false);
});
