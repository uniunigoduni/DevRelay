import assert from "node:assert/strict";
import test from "node:test";
import { extractTailscaleApprovalUrl, tailscaleApprovalMessage } from "./tailscale-setup.mjs";

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
